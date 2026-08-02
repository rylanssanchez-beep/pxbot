'use strict';

// ─── Session-Range Mean-Reversion — a FOURTH, mechanically distinct market ─
// assumption: a completed session's range acts as support/resistance, and
// the next session's first touch of that range's high or low fades back
// toward the range midpoint — no sweep/rejection confirmation required
// (that's liquidity_sweep_engine.js), no VWAP (that's vwap_reversion_engine.js,
// already tested and rejected: 2/4 folds, -0.075R avg). Anchored to Asia/
// London session ranges specifically, since those are the sessions this
// round of testing targets, rather than a rolling VWAP.
//
// Reuses session_breakout_engine.js's sliceSessions — no change to that file.

const { sliceSessions } = require('./session_breakout_engine');

const DEFAULT_THRESHOLDS = {
  anchor: 'asia',            // 'asia' | 'london' — whose completed range is the support/resistance reference
  targetFraction: 0.5,       // target = this fraction of the distance from entry to the range midpoint
  slBufferPct: 0.1,          // stop sits this fraction of range size beyond the actual touch extreme
  minRangeSize: 0,
  maxHoldBars: 40,           // forward bars scanned for a first touch at all
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

function simulateReversion(rangeBar, forwardBars, th) {
  const size = rangeBar.high - rangeBar.low;
  if (size <= 0 || size < th.minRangeSize) return null;
  const mid = (rangeBar.high + rangeBar.low) / 2;
  const scan = forwardBars.slice(0, th.maxHoldBars);

  let bias = null, entryPrice = null, entryIdx = -1;
  for (let i = 0; i < scan.length; i++) {
    const b = scan[i];
    if (b.high >= rangeBar.high) { bias = 'SELL'; entryPrice = rangeBar.high; entryIdx = i; break; }
    if (b.low <= rangeBar.low) { bias = 'BUY'; entryPrice = rangeBar.low; entryIdx = i; break; }
  }
  if (!bias) return { entered: false };

  // Stop buffered off the touched RANGE LEVEL itself, not off the touching
  // bar's own realized high/low — sizing the stop from that same bar's full
  // excursion is a lookahead bug (the stop can never be "surprised" by a
  // move the backtest already knows happened). This was the actual cause of
  // this engine's first-draft numbers looking implausibly good (avg
  // 1.0-1.4R/trade, ~85% win rate) — a same-bar overshoot beyond the fixed
  // level+buffer stop now correctly resolves as an immediate SL below,
  // exactly as a resting stop-order would behave live.
  const sl = bias === 'SELL' ? rangeBar.high + size * th.slBufferPct : rangeBar.low - size * th.slBufferPct;
  const target = bias === 'SELL' ? entryPrice - (entryPrice - mid) * th.targetFraction : entryPrice + (mid - entryPrice) * th.targetFraction;
  const risk = Math.abs(entryPrice - sl);
  if (risk <= 0) return { entered: false };

  const trade = scan.slice(entryIdx, entryIdx + th.maxTradeBars);
  for (const b of trade) {
    const hitSL = bias === 'BUY' ? b.low <= sl : b.high >= sl;
    const hitTarget = bias === 'BUY' ? b.high >= target : b.low <= target;
    if (hitSL) return { entered: true, bias, r: -1, exit: 'SL' };
    if (hitTarget) return { entered: true, bias, r: Math.abs(target - entryPrice) / risk, exit: 'TARGET' };
  }
  return { entered: true, bias, r: 0, exit: 'TIMEOUT' };
}

function runSessionReversionBacktest(bars, opts = {}) {
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

    const sim = simulateReversion(range, forward, th);
    if (!sim) continue;
    days.push({ date, ...sim });
  }

  const traded = days.filter(d => d.entered);
  const wins = traded.filter(d => d.r > 0.001).length;
  const losses = traded.filter(d => d.r < -0.001).length;
  const totalR = +traded.reduce((a, d) => a + (d.r || 0), 0).toFixed(2);
  return { totalDays: days.length, tradedDays: traded.length, wins, losses, totalR, avgR: traded.length ? +(totalR / traded.length).toFixed(3) : null, days };
}

module.exports = { DEFAULT_THRESHOLDS, runSessionReversionBacktest };
