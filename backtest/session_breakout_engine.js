'use strict';

// ─── Session-Anchored Breakout — range/breakout logic anchored to the ─────
// REAL session boundaries (Asia, London, NY premarket) instead of ORB's
// single fixed NY-hour anchor. Same continuation bet as ORB (trade the
// break, not the fade), same day-of-week/target/stop mechanics for a fair
// comparison — only the range-defining window changes.
//
// Reimplements session bucketing locally (same day-rollover convention
// ict_engine.js's sliceSessions already uses and proved correct — Asia bars
// after 19:00 CT belong to the NEXT calendar day) rather than importing it,
// because this needs an extra bucket (07:00-09:30 CT "premarket") that
// ict_engine.js's sliceSessions doesn't have — that gap between London's
// close and NY's 9:30 open isn't in any of ict_engine's buckets today. No
// change to ict_engine.js itself.

const _ctPartsCache = new WeakMap();
function ctParts(bar) {
  let parts = _ctPartsCache.get(bar);
  if (parts === undefined) {
    const d = new Date(new Date(bar.time * 1000).toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    parts = { hour: d.getHours() + d.getMinutes() / 60, dateKey: d.toISOString().slice(0, 10), dow: d.getDay(), jsDate: d };
    _ctPartsCache.set(bar, parts);
  }
  return parts;
}

function sliceSessions(bars) {
  const byDate = new Map();
  const ensure = (key, dow) => {
    if (!byDate.has(key)) byDate.set(key, { asia: [], london: [], premarket: [], ny: [], forward: [], dow });
    return byDate.get(key);
  };
  for (const b of bars) {
    const { hour, dateKey, jsDate, dow } = ctParts(b);
    if (hour >= 19) {
      const next = new Date(jsDate); next.setDate(next.getDate() + 1);
      const key = next.toISOString().slice(0, 10);
      ensure(key, next.getDay()).asia.push(b);
    } else if (hour < 1) {
      ensure(dateKey, dow).asia.push(b);
    } else if (hour >= 1 && hour < 7) {
      ensure(dateKey, dow).london.push(b);
    } else if (hour >= 7 && hour < 9.5) {
      ensure(dateKey, dow).premarket.push(b);
    } else if (hour >= 9.5 && hour < 15) {
      ensure(dateKey, dow).ny.push(b);
    } else if (hour >= 15) {
      ensure(dateKey, dow).forward.push(b);
    }
  }
  return byDate;
}

const DEFAULT_THRESHOLDS = {
  anchor: 'asia',            // 'asia' | 'london' | 'premarket' — which session's range to trade the breakout of
  targetMultiple: 1,
  slBufferPct: 0.05,
  minRangeSize: 0,
  maxHoldBars: 40,           // forward BARS (hourly), not hours — generous since some anchors (asia) leave a long forward window
  allowedDaysOfWeek: [0, 1, 2, 3, 4, 5, 6],
  minTrendEfficiency: 0,     // 0 = no filter (unchanged behavior). >0 requires engine/regime_engine's
                             // efficiency ratio, measured on the bars leading INTO the anchor session,
                             // to clear this bar before the breakout is even considered — a breakout/
                             // continuation bet only makes sense when the market already has momentum
                             // going into the range, same rationale as trend_pullback_engine.js.
  regimeLookback: 20,        // bars fed to the efficiency-ratio calc when minTrendEfficiency > 0
};

// Which session buckets count as "forward" (breakout candidates) after each anchor.
const FORWARD_AFTER = {
  asia: ['london', 'premarket', 'ny', 'forward'],
  london: ['premarket', 'ny', 'forward'],
  premarket: ['ny', 'forward'],
};

function rangeOf(bars) {
  if (!bars.length) return null;
  return { high: Math.max(...bars.map(b => b.high)), low: Math.min(...bars.map(b => b.low)) };
}

function simulateBreakout(rangeBar, forwardBars, th) {
  const size = rangeBar.high - rangeBar.low;
  if (size <= 0 || size < th.minRangeSize) return null;
  let bias = null, entryPrice = null, entryIdx = -1;
  const scan = forwardBars.slice(0, th.maxHoldBars);
  for (let i = 0; i < scan.length; i++) {
    const b = scan[i];
    if (b.high > rangeBar.high) { bias = 'BUY'; entryPrice = rangeBar.high; entryIdx = i; break; }
    if (b.low < rangeBar.low) { bias = 'SELL'; entryPrice = rangeBar.low; entryIdx = i; break; }
  }
  if (!bias) return { entered: false };
  const sl = bias === 'BUY' ? rangeBar.low - size * th.slBufferPct : rangeBar.high + size * th.slBufferPct;
  const target = bias === 'BUY' ? entryPrice + size * th.targetMultiple : entryPrice - size * th.targetMultiple;
  const risk = Math.abs(entryPrice - sl);
  if (risk <= 0) return { entered: false };
  for (let i = entryIdx; i < scan.length; i++) {
    const b = scan[i];
    const hitSL = bias === 'BUY' ? b.low <= sl : b.high >= sl;
    const hitTarget = bias === 'BUY' ? b.high >= target : b.low <= target;
    if (hitSL) return { entered: true, bias, r: -1, exit: 'SL' };
    if (hitTarget) return { entered: true, bias, r: Math.abs(target - entryPrice) / risk, exit: 'TARGET' };
  }
  return { entered: true, bias, r: 0, exit: 'TIMEOUT' };
}

function runSessionBreakoutBacktest(bars, opts = {}) {
  const th = { ...DEFAULT_THRESHOLDS, ...opts };
  const byDate = sliceSessions(bars);
  const days = [];
  const forwardBuckets = FORWARD_AFTER[th.anchor];
  if (!forwardBuckets) throw new Error(`Unknown anchor: ${th.anchor}`);

  // Only built (and only pays the cost) when the regime filter is actually
  // in use — global time->index lookup so we can pull the trailing window
  // of bars leading INTO the anchor session for each day without lookahead.
  let timeToIndex = null;
  let regimeEngine = null;
  if (th.minTrendEfficiency > 0) {
    regimeEngine = require('../engine/regime_engine');
    timeToIndex = new Map();
    for (let i = 0; i < bars.length; i++) timeToIndex.set(bars[i].time, i);
  }

  for (const [date, sess] of byDate.entries()) {
    if (!th.allowedDaysOfWeek.includes(sess.dow)) continue;
    const anchorBars = sess[th.anchor];
    if (!anchorBars || !anchorBars.length) continue;

    if (th.minTrendEfficiency > 0) {
      const lastAnchorBar = anchorBars[anchorBars.length - 1];
      const idx = timeToIndex.get(lastAnchorBar.time);
      if (idx === undefined) continue;
      const regimeWindow = bars.slice(Math.max(0, idx + 1 - th.regimeLookback), idx + 1);
      const regime = regimeEngine.classifyRegime(regimeWindow, { ...regimeEngine.DEFAULT_THRESHOLDS, erLookback: th.regimeLookback });
      if (regime.efficiencyRatio === null || regime.efficiencyRatio < th.minTrendEfficiency) continue;
    }

    const range = rangeOf(anchorBars);
    if (!range) continue;
    const forward = forwardBuckets.flatMap(k => sess[k] || []);
    if (!forward.length) continue;
    const rangeBar = { high: range.high, low: range.low };
    const sim = simulateBreakout(rangeBar, forward, th);
    if (!sim) continue;
    days.push({ date, ...sim });
  }

  const traded = days.filter(d => d.entered);
  const wins = traded.filter(d => d.r > 0.001).length;
  const losses = traded.filter(d => d.r < -0.001).length;
  const totalR = +traded.reduce((a, d) => a + (d.r || 0), 0).toFixed(2);
  return { totalDays: days.length, tradedDays: traded.length, wins, losses, totalR, avgR: traded.length ? +(totalR / traded.length).toFixed(3) : null, days };
}

module.exports = { DEFAULT_THRESHOLDS, sliceSessions, runSessionBreakoutBacktest };
