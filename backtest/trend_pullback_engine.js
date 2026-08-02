'use strict';

// ─── Trend-Following Pullback — the opposite market assumption from the ──
// VWAP mean-reversion candidate, and mechanically distinct from ICT
// (session-sweep/retracement) and ORB (fixed-time-of-day breakout). Bets
// WITH a confirmed trend (engine/regime_engine.js efficiency ratio above
// threshold), entering on a shallow pullback against that trend rather than
// chasing strength — buy dips in an uptrend, sell rips in a downtrend.
//
// Same tradeoff ORB/VWAP-reversion document explicitly: hourly bars for
// full ~2.3-year history depth, at the cost of intrabar precision.

const regimeEngine = require('../engine/regime_engine');

// Cache by bar object identity — toLocaleString-with-timeZone is expensive,
// same lesson from orb_engine.js/confirmation_backtest.js/
// vwap_reversion_engine.js, applied from the start here.
const _ctPartsCache = new WeakMap();
function ctParts(bar) {
  let parts = _ctPartsCache.get(bar);
  if (parts === undefined) {
    const d = new Date(new Date(bar.time * 1000).toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    parts = { dateKey: d.toISOString().slice(0, 10), dow: d.getDay() };
    _ctPartsCache.set(bar, parts);
  }
  return parts;
}

const DEFAULT_THRESHOLDS = {
  minTrendEfficiency: 0.4,   // regime_engine efficiency ratio must exceed this to count as "trending" (opposite direction of vwap_reversion_engine's filter)
  regimeLookback: 20,
  pullbackAtrMultiple: 1.0,  // price must pull back at least this many ATRs from the recent trend extreme to count as a dip
  atrPeriod: 14,
  lookbackForExtreme: 10,    // bars back to find the trend's recent extreme (the high in an uptrend, low in a downtrend)
  targetRMultiple: 1.5,      // fixed reward:risk target, simplest comparable exit to the other two candidates
  slBufferPct: 0.1,          // stop sits this fraction of the pullback depth beyond the pullback's own extreme
  maxHoldBars: 20,
  minRegimeBars: 30,
  allowedDaysOfWeek: [0, 1, 2, 3, 4, 5, 6],
};

function atrSeries(bars, period) {
  const out = new Array(bars.length).fill(null);
  const trs = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const tr = i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close));
    trs.push(tr);
    if (i >= period - 1) {
      const window = trs.slice(i - period + 1, i + 1);
      out[i] = window.reduce((a, v) => a + v, 0) / period;
    }
  }
  return out;
}

function runTrendPullbackBacktest(bars, opts = {}) {
  const th = { ...DEFAULT_THRESHOLDS, ...opts };
  const atr = atrSeries(bars, th.atrPeriod);
  const days = [];

  let i = Math.max(th.atrPeriod, th.minRegimeBars, th.lookbackForExtreme);
  while (i < bars.length) {
    const b = bars[i];
    const { dow } = ctParts(b);
    if (!th.allowedDaysOfWeek.includes(dow) || !atr[i]) { i++; continue; }

    const regimeWindow = bars.slice(Math.max(0, i + 1 - (th.regimeLookback + 5)), i + 1);
    const regime = regimeEngine.classifyRegime(regimeWindow, { ...regimeEngine.DEFAULT_THRESHOLDS, erLookback: th.regimeLookback });
    if (regime.efficiencyRatio === null || regime.efficiencyRatio < th.minTrendEfficiency) { i++; continue; }
    if (regime.direction !== 'trending-up' && regime.direction !== 'trending-down') { i++; continue; }

    const bias = regime.direction === 'trending-up' ? 'BUY' : 'SELL';
    const extremeWindow = bars.slice(Math.max(0, i + 1 - th.lookbackForExtreme), i + 1);
    const trendExtreme = bias === 'BUY' ? Math.max(...extremeWindow.map(x => x.high)) : Math.min(...extremeWindow.map(x => x.low));
    const pullbackDepth = Math.abs(trendExtreme - b.close) / atr[i];
    if (pullbackDepth < th.pullbackAtrMultiple) { i++; continue; } // not pulled back enough yet

    // Entry: current bar must be closing back in the trend direction (a bullish
    // bar in an uptrend pullback, bearish in a downtrend pullback) — the
    // "bounce confirmation" bar, not just "price is low."
    const closingInTrendDirection = bias === 'BUY' ? b.close > b.open : b.close < b.open;
    if (!closingInTrendDirection) { i++; continue; }

    const entryPrice = b.close;
    const pullbackExtreme = bias === 'BUY' ? Math.min(...extremeWindow.map(x => x.low)) : Math.max(...extremeWindow.map(x => x.high));
    const riskDist = Math.abs(entryPrice - pullbackExtreme);
    const sl = bias === 'BUY' ? pullbackExtreme - riskDist * th.slBufferPct : pullbackExtreme + riskDist * th.slBufferPct;
    const risk = Math.abs(entryPrice - sl);
    if (risk <= 0) { i++; continue; }
    const target = bias === 'BUY' ? entryPrice + risk * th.targetRMultiple : entryPrice - risk * th.targetRMultiple;

    const forward = bars.slice(i + 1, i + 1 + th.maxHoldBars);
    let result = 'TIMEOUT', r = 0, exitIdx = forward.length;
    for (let k = 0; k < forward.length; k++) {
      const fb = forward[k];
      const hitSL = bias === 'BUY' ? fb.low <= sl : fb.high >= sl;
      const hitTarget = bias === 'BUY' ? fb.high >= target : fb.low <= target;
      if (hitSL) { result = 'SL'; r = -1; exitIdx = k; break; }
      if (hitTarget) { result = 'TARGET'; r = th.targetRMultiple; exitIdx = k; break; }
    }
    days.push({ date: ctParts(b).dateKey, time: b.time, bias, entryPrice, sl, target, result, r, efficiencyRatio: regime.efficiencyRatio });
    i += Math.max(1, exitIdx + 1);
  }

  const traded = days;
  const wins = traded.filter(d => d.r > 0.001).length;
  const losses = traded.filter(d => d.r < -0.001).length;
  const totalR = +traded.reduce((a, d) => a + d.r, 0).toFixed(2);
  return { tradedDays: traded.length, wins, losses, totalR, avgR: traded.length ? +(totalR / traded.length).toFixed(3) : null, days };
}

module.exports = { DEFAULT_THRESHOLDS, atrSeries, runTrendPullbackBacktest };
