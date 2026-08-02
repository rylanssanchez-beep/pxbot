'use strict';

// ─── VWAP Mean-Reversion — a genuinely different mechanism from ICT ───────
// (session-sweep/retracement) and ORB (breakout-continuation). This one
// bets on REVERSION: when price stretches far from session VWAP, fade it
// back toward the mean — the opposite market assumption from ORB's
// continuation bet. Filtered by engine/regime_engine.js's efficiency ratio
// so it only fires when the market isn't strongly trending (fading VWAP
// into a real trend is how mean-reversion strategies die).
//
// Same tradeoff ORB documents explicitly: hourly bars for full ~2.3-year
// history depth, at the cost of intrabar precision.

const regimeEngine = require('../engine/regime_engine');

function ctParts(unixSecs) {
  const d = new Date(new Date(unixSecs * 1000).toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  return { dateKey: d.toISOString().slice(0, 10), dow: d.getDay() };
}

const DEFAULT_THRESHOLDS = {
  deviationAtrMultiple: 2.0,  // price must be this many ATRs away from session VWAP to trigger a fade
  atrPeriod: 14,
  targetVwapFraction: 0.5,    // target = this fraction of the way back from entry to VWAP (partial reversion, not a full round-trip bet)
  slBufferPct: 0.1,           // stop sits this fraction of the entry-to-VWAP distance beyond the recent extreme
  lookbackForExtreme: 5,      // bars back to find the recent high/low for stop placement
  maxTrendEfficiency: 0.4,    // skip the trade if regime_engine's efficiency ratio (recent lookback) exceeds this — market is trending too hard to fade
  regimeLookback: 20,
  maxHoldBars: 20,
  minRegimeBars: 30,          // minimum bars of history needed before a regime read is trusted
  allowedDaysOfWeek: [0, 1, 2, 3, 4, 5, 6],
};

// True range / ATR, same simple rolling average structure_engine.atr uses —
// duplicated locally (not imported) since this needs a running per-bar value
// as VWAP/ATR are recomputed incrementally while walking forward, not a
// single trailing-window snapshot.
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

// Session-anchored VWAP, resetting at each new CT calendar date (a
// simplifying, explicit choice for this standalone strategy — distinct from
// ict_engine.js's Asia/London/NY session split, which this doesn't need).
function sessionVwapSeries(bars) {
  const out = new Array(bars.length).fill(null);
  let cumPV = 0, cumVol = 0, curDate = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const dateKey = ctParts(b.time).dateKey;
    if (dateKey !== curDate) { curDate = dateKey; cumPV = 0; cumVol = 0; }
    const typical = (b.high + b.low + b.close) / 3;
    const vol = b.volume || 1; // fall back to 1 (equal-weighted average) if volume is missing/zero, rather than dividing by zero
    cumPV += typical * vol;
    cumVol += vol;
    out[i] = cumVol > 0 ? cumPV / cumVol : typical;
  }
  return out;
}

function runVwapReversionBacktest(bars, opts = {}) {
  const th = { ...DEFAULT_THRESHOLDS, ...opts };
  const atr = atrSeries(bars, th.atrPeriod);
  const vwap = sessionVwapSeries(bars);
  const days = [];

  let i = Math.max(th.atrPeriod, th.minRegimeBars, th.lookbackForExtreme);
  while (i < bars.length) {
    const b = bars[i];
    const { dow } = ctParts(b.time);
    if (!th.allowedDaysOfWeek.includes(dow) || !atr[i] || !vwap[i]) { i++; continue; }

    const deviation = (b.close - vwap[i]) / atr[i];
    if (Math.abs(deviation) < th.deviationAtrMultiple) { i++; continue; }

    const regime = regimeEngine.classifyRegime(bars.slice(0, i + 1).slice(-th.regimeLookback - 5), { ...regimeEngine.DEFAULT_THRESHOLDS, erLookback: th.regimeLookback });
    if (regime.efficiencyRatio !== null && regime.efficiencyRatio > th.maxTrendEfficiency) { i++; continue; } // trending too hard to fade

    const bias = deviation > 0 ? 'SELL' : 'BUY'; // price above VWAP -> fade down; below -> fade up
    const entryPrice = b.close;
    const extremeWindow = bars.slice(Math.max(0, i - th.lookbackForExtreme), i + 1);
    const recentExtreme = bias === 'SELL' ? Math.max(...extremeWindow.map(x => x.high)) : Math.min(...extremeWindow.map(x => x.low));
    const distToVwap = Math.abs(entryPrice - vwap[i]);
    const sl = bias === 'SELL' ? recentExtreme + distToVwap * th.slBufferPct : recentExtreme - distToVwap * th.slBufferPct;
    const target = bias === 'SELL' ? entryPrice - distToVwap * th.targetVwapFraction : entryPrice + distToVwap * th.targetVwapFraction;
    const risk = Math.abs(entryPrice - sl);
    if (risk <= 0) { i++; continue; }

    const forward = bars.slice(i + 1, i + 1 + th.maxHoldBars);
    let result = 'TIMEOUT', r = 0, exitIdx = forward.length;
    for (let k = 0; k < forward.length; k++) {
      const fb = forward[k];
      const hitSL = bias === 'BUY' ? fb.low <= sl : fb.high >= sl;
      const hitTarget = bias === 'BUY' ? fb.high >= target : fb.low <= target;
      if (hitSL) { result = 'SL'; r = -1; exitIdx = k; break; }
      if (hitTarget) { result = 'TARGET'; r = Math.abs(target - entryPrice) / risk; exitIdx = k; break; }
    }
    days.push({ date: ctParts(b.time).dateKey, time: b.time, bias, entryPrice, sl, target, result, r, deviation: +deviation.toFixed(2) });
    i += Math.max(1, exitIdx + 1); // don't re-enter mid-trade on the same move
  }

  const traded = days;
  const wins = traded.filter(d => d.r > 0.001).length;
  const losses = traded.filter(d => d.r < -0.001).length;
  const totalR = +traded.reduce((a, d) => a + d.r, 0).toFixed(2);
  return { tradedDays: traded.length, wins, losses, totalR, avgR: traded.length ? +(totalR / traded.length).toFixed(3) : null, days };
}

module.exports = { DEFAULT_THRESHOLDS, atrSeries, sessionVwapSeries, runVwapReversionBacktest };
