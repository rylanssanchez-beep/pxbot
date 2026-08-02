'use strict';

// ─── Liquidity-Sweep Reversal — a THIRD, mechanically distinct market ─────
// assumption from session_breakout_engine.js (continuation past the range)
// and session_reversion_engine.js (fade without a sweep). This is the
// classic ICT "liquidity raid" model: a completed session's range is a pool
// of resting stops/orders. When the NEXT session pushes price beyond that
// pool's high or low and then closes back inside within a short confirm
// window, that's read as a stop-run, not a real breakout — trade the
// REVERSAL, not the continuation. Generalizes ict_engine.js's scenario 2/3
// sweep logic (which only checks Asia-swept-by-London) to any
// session-pair, so it can be tested against London-swept-by-NY and
// Asia-swept-by-NY too, which ict_engine.js never covers.
//
// Reuses session_breakout_engine.js's sliceSessions (identical session
// bucketing, including the premarket bucket) rather than reimplementing it
// — no change to that file.

const { sliceSessions } = require('./session_breakout_engine');

const DEFAULT_THRESHOLDS = {
  anchor: 'asia',            // 'asia' | 'london' — whose completed range is the liquidity pool
  sweepEpsilonPts: 1,        // must clear the anchor extreme by more than this to count as a sweep
  confirmBars: 3,            // must close back inside the anchor range within this many bars of the sweep bar
  targetMultiple: 1,
  slBufferPct: 0.1,          // stop sits this fraction of range size beyond the sweep extreme
  minRangeSize: 0,
  maxHoldBars: 40,           // forward bars scanned for a sweep+confirm signal at all
  maxTradeBars: 30,          // forward bars given to the trade itself once entered
  allowedDaysOfWeek: [0, 1, 2, 3, 4, 5, 6],
};

const FORWARD_AFTER = {
  asia: ['london', 'premarket', 'ny', 'forward'],
  london: ['premarket', 'ny', 'forward'],
};

function rangeOf(bars) {
  if (!bars.length) return null;
  return { high: Math.max(...bars.map(b => b.high)), low: Math.min(...bars.map(b => b.low)) };
}

// Scan forward bars for the first sweep-then-close-back-inside signal.
// Returns { bias, entryPrice, entryIdx, sweepExtreme } or null.
function findSweepReversal(rangeBar, forwardBars, th) {
  const size = rangeBar.high - rangeBar.low;
  if (size <= 0 || size < th.minRangeSize) return null;
  const scan = forwardBars.slice(0, th.maxHoldBars);

  for (let i = 0; i < scan.length; i++) {
    const b = scan[i];
    const sweptHigh = b.high > rangeBar.high + th.sweepEpsilonPts;
    const sweptLow = b.low < rangeBar.low - th.sweepEpsilonPts;
    if (!sweptHigh && !sweptLow) continue;
    if (sweptHigh && sweptLow) continue; // swept both sides in one bar — no clean read, skip this bar

    const sweepExtreme = sweptHigh ? b.high : b.low;
    // Confirmation: within confirmBars of the sweep bar (including the sweep
    // bar itself), price must CLOSE back inside the anchor range.
    const confirmWindow = scan.slice(i, i + th.confirmBars);
    for (let k = 0; k < confirmWindow.length; k++) {
      const cb = confirmWindow[k];
      const closedBackIn = sweptHigh ? cb.close < rangeBar.high : cb.close > rangeBar.low;
      if (closedBackIn) {
        return {
          bias: sweptHigh ? 'SELL' : 'BUY',
          entryPrice: cb.close,
          entryIdx: i + k,
          sweepExtreme,
        };
      }
    }
    // No confirmation within the window — this particular sweep failed to
    // reject; keep scanning forward bars for a later, cleaner sweep.
  }
  return null;
}

function simulateFromEntry(sig, rangeBar, forwardBars, th) {
  const size = rangeBar.high - rangeBar.low;
  // Stop is buffered off the swept RANGE LEVEL, not off sig.sweepExtreme (the
  // triggering bar's own high/low) — sizing the stop from the same bar's
  // fully-realized excursion is a lookahead bug (it "knows" in advance how
  // far that bar would wick before the stop is ever placed). Same
  // level-anchored convention session_breakout_engine.js already uses
  // correctly. A big same-bar overshoot beyond this level+buffer stop will
  // now correctly resolve as an immediate SL in the loop below, exactly as
  // a resting stop-order would have behaved live.
  const sl = sig.bias === 'SELL' ? rangeBar.high + size * th.slBufferPct : rangeBar.low - size * th.slBufferPct;
  const risk = Math.abs(sig.entryPrice - sl);
  if (risk <= 0) return null;
  const target = sig.bias === 'BUY' ? sig.entryPrice + risk * th.targetMultiple : sig.entryPrice - risk * th.targetMultiple;

  const trade = forwardBars.slice(sig.entryIdx, sig.entryIdx + th.maxTradeBars);
  for (const b of trade) {
    const hitSL = sig.bias === 'BUY' ? b.low <= sl : b.high >= sl;
    const hitTarget = sig.bias === 'BUY' ? b.high >= target : b.low <= target;
    if (hitSL) return { entered: true, bias: sig.bias, r: -1, exit: 'SL' };
    if (hitTarget) return { entered: true, bias: sig.bias, r: Math.abs(target - sig.entryPrice) / risk, exit: 'TARGET' };
  }
  return { entered: true, bias: sig.bias, r: 0, exit: 'TIMEOUT' };
}

function runLiquiditySweepBacktest(bars, opts = {}) {
  const th = { ...DEFAULT_THRESHOLDS, ...opts };
  const byDate = sliceSessions(bars);
  const days = [];
  const forwardBuckets = FORWARD_AFTER[th.anchor];
  if (!forwardBuckets) throw new Error(`Unknown anchor: ${th.anchor}`);

  for (const [date, sess] of byDate.entries()) {
    if (!th.allowedDaysOfWeek.includes(sess.dow)) continue;
    const anchorBars = sess[th.anchor];
    if (!anchorBars || !anchorBars.length) continue;
    const range = rangeOf(anchorBars);
    if (!range) continue;
    const forward = forwardBuckets.flatMap(k => sess[k] || []);
    if (!forward.length) continue;

    const sig = findSweepReversal(range, forward, th);
    if (!sig) continue;
    const sim = simulateFromEntry(sig, range, forward, th);
    if (!sim) continue;
    days.push({ date, ...sim });
  }

  const traded = days.filter(d => d.entered);
  const wins = traded.filter(d => d.r > 0.001).length;
  const losses = traded.filter(d => d.r < -0.001).length;
  const totalR = +traded.reduce((a, d) => a + (d.r || 0), 0).toFixed(2);
  return { totalDays: days.length, tradedDays: traded.length, wins, losses, totalR, avgR: traded.length ? +(totalR / traded.length).toFixed(3) : null, days };
}

module.exports = { DEFAULT_THRESHOLDS, findSweepReversal, runLiquiditySweepBacktest };
