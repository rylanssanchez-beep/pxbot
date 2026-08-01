'use strict';

// Opening Range Breakout — a genuinely different mechanism from the ICT
// session-sweep/retracement idea already tested exhaustively. This one bets
// on CONTINUATION of an initial move, not a fade of it: define a range from
// the NY-open hour, then trade the breakout of that range in the breakout's
// direction, riding it with a stop at the opposite side of the range.
//
// Tradeoff being made explicitly: this uses hourly bars for the range
// definition (a true ORB usually uses 5-30min), because that's what's
// available across the FULL ~2.3-year history (14,000+ bars) instead of the
// ~267-day window fine resolution is limited to. Coarser range definition,
// much bigger real sample size — the opposite tradeoff from the ICT tests.

function ctParts(unixSecs) {
  const d = new Date(new Date(unixSecs * 1000).toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  return { hour: d.getHours() + d.getMinutes() / 60, dateKey: d.toISOString().slice(0, 10) };
}

// The expensive part (toLocaleString per bar) doesn't depend on rangeHour —
// cache the per-bar CT parts by array identity so a sweep across many
// rangeHour/target/stop combos on the SAME bars array only pays for it once.
const _partsCache = new WeakMap();
function ctPartsForAll(bars) {
  if (_partsCache.has(bars)) return _partsCache.get(bars);
  const parts = bars.map(b => ({ bar: b, ...ctParts(b.time) }));
  _partsCache.set(bars, parts);
  return parts;
}

const DEFAULT_ORB = {
  rangeHour: 8,       // CT hour bucket used as the opening range (8:00-9:00, pre/into the 8:30 cash open)
  targetMultiple: 1,  // target = range size * this multiple, measured from the breakout point
  slBufferPct: 0.05,  // stop sits this fraction of range size beyond the opposite side
  minRangeSize: 0,    // points — skip tiny/noisy ranges (selectivity)
  maxHoldHours: 8,    // give up (timeout) after this many bars past the range hour
};

// Groups bars by date; each date gets { rangeBar, breakoutCandidates (bars after the range hour, same day, through afterhours) }.
function sliceByDate(bars, opts) {
  const parts = ctPartsForAll(bars);
  const byDate = new Map();
  for (const { bar: b, hour, dateKey } of parts) {
    if (!byDate.has(dateKey)) byDate.set(dateKey, { rangeBar: null, forward: [] });
    const entry = byDate.get(dateKey);
    if (Math.floor(hour) === opts.rangeHour) entry.rangeBar = b;
    else if (hour > opts.rangeHour && hour < 19) entry.forward.push(b); // through NY + afterhours, before next Asia
  }
  return byDate;
}

function simulateOrbDay(rangeBar, forwardBars, th) {
  const size = rangeBar.high - rangeBar.low;
  if (size <= 0 || size < th.minRangeSize) return null;

  let bias = null, entryPrice = null, entryIdx = -1;
  const scan = forwardBars.slice(0, th.maxHoldHours);
  for (let i = 0; i < scan.length; i++) {
    const b = scan[i];
    if (b.high > rangeBar.high) { bias = 'BUY'; entryPrice = rangeBar.high; entryIdx = i; break; }
    if (b.low < rangeBar.low)   { bias = 'SELL'; entryPrice = rangeBar.low; entryIdx = i; break; }
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

function runOrbBacktest(bars, opts = {}) {
  const th = { ...DEFAULT_ORB, ...opts };
  const byDate = sliceByDate(bars, th);
  const days = [];
  for (const [date, entry] of byDate.entries()) {
    if (!entry.rangeBar || !entry.forward.length) continue;
    const sim = simulateOrbDay(entry.rangeBar, entry.forward, th);
    if (!sim) continue;
    days.push({ date, ...sim });
  }
  const traded = days.filter(d => d.entered);
  const wins = traded.filter(d => d.r > 0.001).length;
  const losses = traded.filter(d => d.r < -0.001).length;
  const totalR = +traded.reduce((a, d) => a + (d.r || 0), 0).toFixed(2);
  return { totalDays: days.length, tradedDays: traded.length, wins, losses, totalR, avgR: traded.length ? +(totalR / traded.length).toFixed(3) : null, days };
}

module.exports = { DEFAULT_ORB, sliceByDate, simulateOrbDay, runOrbBacktest };
