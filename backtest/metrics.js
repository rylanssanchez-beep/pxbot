'use strict';

// Standard performance-metrics module — computes every metric Part 4 of the
// mission requires from an array of trade records (the shape returned by
// engine/replay_engine.js's simulateTrade, plus { session, entryTime,
// exitTime, holdingBars }). Used by the baseline runner and every research
// candidate afterward, so every reported number is computed the same way
// everywhere — no per-script reinvention, no silently-different definitions.
//
// Every metric with a non-obvious definition is documented inline. Where the
// mission asks for something this module cannot yet honestly compute (e.g.
// "probability of breaching funded-account limits" needs Part 10's
// simulator, which doesn't exist yet), the field is explicitly null with a
// `_notes` entry explaining why — never a fabricated number.

const EPS = 1e-6;

function isWin(t) { return t.rMultiple > EPS; }
function isLoss(t) { return t.rMultiple < -EPS; }
function isBreakeven(t) { return !isWin(t) && !isLoss(t); }

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function stddev(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
}
function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)));
  return s[idx];
}

// Equity path in R-space (starting at 0, additive — NOT compounding, since
// R-multiples are risk-normalized and this project reports risk-adjusted
// performance independent of a specific account-sizing/compounding model;
// Part 10's funded-account simulator applies real position sizing on top of
// this).
function equityCurveR(trades) {
  let equity = 0;
  const curve = [];
  for (const t of trades) { equity += t.rMultiple; curve.push({ time: t.exitTime, equity }); }
  return curve;
}

function maxDrawdownR(curve) {
  let peak = 0, maxDD = 0, peakEquity = 0;
  for (const pt of curve) {
    if (pt.equity > peakEquity) peakEquity = pt.equity;
    const dd = peakEquity - pt.equity;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function maxStreak(trades, predicate) {
  let max = 0, cur = 0;
  for (const t of trades) { if (predicate(t)) { cur++; max = Math.max(max, cur); } else cur = 0; }
  return max;
}

function ctDateKey(unixSecs) {
  const d = new Date(new Date(unixSecs * 1000).toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  return d.toISOString().slice(0, 10);
}
function ctWeekKey(unixSecs) {
  const d = new Date(new Date(unixSecs * 1000).toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const dow = d.getDay();
  const weekStart = new Date(d); weekStart.setDate(weekStart.getDate() - dow);
  return weekStart.toISOString().slice(0, 10);
}
function ctMonthKey(unixSecs) {
  const d = new Date(new Date(unixSecs * 1000).toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function ctYearKey(unixSecs) {
  const d = new Date(new Date(unixSecs * 1000).toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  return String(d.getFullYear());
}

// trades: array of { rMultiple, rMultipleGross, maeR, mfeR, holdingBars,
//   entryTime, exitTime, filled, direction, ambiguousFill, commissionCostR }
// opts: { totalPeriodDays: span of the tested window, for exposure/Calmar
//   annualization. } Wall-clock holding time is computed directly from
//   exitTime-entryTime (always correct regardless of execution resolution)
//   rather than holdingBars * an assumed bar size — holdingBars is bar-count
//   units specific to whatever resolution that trade executed at (1-minute
//   for one strategy, 1-hour for another), so multiplying by one shared
//   "barMinutes" silently corrupts exposure/holding-time whenever trades
//   from different execution resolutions are combined in one call (exactly
//   what happens for the cross-strategy overall/session/year breakdowns).
function computeMetrics(allTrades, opts = {}) {
  const totalPeriodDays = opts.totalPeriodDays || null;

  const filled = allTrades.filter(t => t.filled);
  const missed = allTrades.filter(t => !t.filled);
  const clean = filled.filter(t => t.exitReason !== 'END_OF_DATA'); // exclude runs that fell off the end of available data — not a real completed decision

  const n = clean.length;
  if (n === 0) {
    return { totalTrades: 0, filledTrades: filled.length, missedOrders: missed.length,
      _notes: ['No completed trades (excluding END_OF_DATA truncations) in this set — all metrics below are null.'] };
  }

  const wins = clean.filter(isWin);
  const losses = clean.filter(isLoss);
  const breakevens = clean.filter(isBreakeven);
  const rMultiples = clean.map(t => t.rMultiple);
  const grossProfit = wins.reduce((a, t) => a + t.rMultiple, 0);
  const grossLoss = losses.reduce((a, t) => a + t.rMultiple, 0); // negative
  const netR = rMultiples.reduce((a, b) => a + b, 0);

  const curve = equityCurveR(clean.slice().sort((a, b) => a.exitTime - b.exitTime));
  const maxDD = maxDrawdownR(curve);

  const avgWinR = mean(wins.map(t => t.rMultiple));
  const avgLossR = mean(losses.map(t => t.rMultiple));
  const stdR = stddev(rMultiples);
  const meanR = mean(rMultiples);

  const sharpePerTrade = stdR ? +(meanR / stdR).toFixed(3) : null;
  const tradesPerYear = totalPeriodDays ? n / (totalPeriodDays / 365) : null;
  const sharpeAnnualized = sharpePerTrade !== null && tradesPerYear ? +(sharpePerTrade * Math.sqrt(tradesPerYear)).toFixed(3) : null;

  const downside = rMultiples.filter(r => r < 0);
  const downsideDev = downside.length ? Math.sqrt(downside.reduce((a, r) => a + r * r, 0) / rMultiples.length) : null;
  const sortino = downsideDev && downsideDev > 0 ? +(meanR / downsideDev).toFixed(3) : (downside.length === 0 ? null : null);

  const calmar = (maxDD > 0 && totalPeriodDays) ? +((netR / (totalPeriodDays / 365)) / maxDD).toFixed(3) : null;
  const recoveryFactor = maxDD > 0 ? +(netR / maxDD).toFixed(3) : null;
  const payoffRatio = (avgWinR && avgLossR) ? +(avgWinR / Math.abs(avgLossR)).toFixed(3) : null;

  const holdingBarsArr = clean.map(t => t.holdingBars).filter(h => h != null);
  const holdingMinutesArr = clean.map(t => (t.exitTime != null && t.entryTime != null) ? (t.exitTime - t.entryTime) / 60 : null).filter(v => v != null);
  const maeRArr = clean.map(t => t.maeR).filter(v => v != null);
  const mfeRArr = clean.map(t => t.mfeR).filter(v => v != null);

  // "Reached 1R before stopping": trades whose MFE (best excursion reached
  // during the trade, regardless of final result) was >= 1R.
  const reached1RBeforeStop = clean.filter(t => (t.mfeR || 0) >= 1).length;

  // "Later reverses after entry" has no single standard definition — this is
  // an explicit, documented proxy: trades whose MAE reached >= 0.3R (a
  // meaningful adverse move) at some point before their final result,
  // regardless of whether they ultimately won or lost. Not claimed as the
  // only valid definition.
  const laterReverseProxy = clean.filter(t => (t.maeR || 0) >= 0.3).length;

  // Monthly / weekly consistency.
  const byMonth = new Map(), byWeek = new Map(), byYear = new Map();
  for (const t of clean) {
    const mk = ctMonthKey(t.exitTime), wk = ctWeekKey(t.exitTime), yk = ctYearKey(t.exitTime);
    byMonth.set(mk, (byMonth.get(mk) || 0) + t.rMultiple);
    byWeek.set(wk, (byWeek.get(wk) || 0) + t.rMultiple);
    byYear.set(yk, (byYear.get(yk) || 0) + t.rMultiple);
  }
  const profitableMonths = [...byMonth.values()].filter(r => r > 0).length;
  const profitableWeeks = [...byWeek.values()].filter(r => r > 0).length;

  // Exposure: sum of real wall-clock holding time / total elapsed calendar
  // minutes of the tested window.
  const totalHoldingMinutes = holdingMinutesArr.reduce((a, b) => a + b, 0);
  const exposure = totalPeriodDays ? +((totalHoldingMinutes / (totalPeriodDays * 24 * 60)) * 100).toFixed(2) : null;

  const totalCommissionR = clean.reduce((a, t) => a + (t.commissionCostR || 0), 0);
  const ambiguousCount = clean.filter(t => t.ambiguousFill).length;

  return {
    totalTrades: n,
    filledTrades: filled.length,
    missedOrders: missed.length,
    excludedEndOfDataTruncations: filled.length - n,
    wins: wins.length, losses: losses.length, breakevens: breakevens.length,
    winRatePct: +((wins.length / n) * 100).toFixed(2),
    lossRatePct: +((losses.length / n) * 100).toFixed(2),
    breakevenRatePct: +((breakevens.length / n) * 100).toFixed(2),
    avgWinR: avgWinR !== null ? +avgWinR.toFixed(3) : null,
    avgLossR: avgLossR !== null ? +avgLossR.toFixed(3) : null,
    expectancyR: +meanR.toFixed(4),
    profitFactor: grossLoss !== 0 ? +Math.abs(grossProfit / grossLoss).toFixed(3) : (grossProfit > 0 ? Infinity : null),
    grossProfitR: +grossProfit.toFixed(3),
    grossLossR: +grossLoss.toFixed(3),
    netR: +netR.toFixed(3),
    maxDrawdownR: +maxDD.toFixed(3),
    sharpePerTrade, sharpeAnnualized,
    sortino,
    calmar, recoveryFactor, payoffRatio,
    medianR: +median(rMultiples).toFixed(4),
    stdDevR: stdR !== null ? +stdR.toFixed(4) : null,
    maxConsecutiveWins: maxStreak(clean, isWin),
    maxConsecutiveLosses: maxStreak(clean, isLoss),
    avgHoldingBars: mean(holdingBarsArr) !== null ? +mean(holdingBarsArr).toFixed(1) : null,
    avgHoldingMinutes: mean(holdingMinutesArr) !== null ? +mean(holdingMinutesArr).toFixed(1) : null,
    maxHoldingBars: holdingBarsArr.length ? Math.max(...holdingBarsArr) : null,
    maxHoldingMinutes: holdingMinutesArr.length ? +Math.max(...holdingMinutesArr).toFixed(1) : null,
    avgMaeR: mean(maeRArr) !== null ? +mean(maeRArr).toFixed(3) : null,
    avgMfeR: mean(mfeRArr) !== null ? +mean(mfeRArr).toFixed(3) : null,
    p75MaeR: +((percentile(maeRArr, 0.75) ?? 0)).toFixed(3),
    p90MaeR: +((percentile(maeRArr, 0.90) ?? 0)).toFixed(3),
    p95MaeR: +((percentile(maeRArr, 0.95) ?? 0)).toFixed(3),
    pctReached1RBeforeStop: +((reached1RBeforeStop / n) * 100).toFixed(2),
    pctLaterReverseProxy: +((laterReverseProxy / n) * 100).toFixed(2),
    monthsTracked: byMonth.size, profitableMonths, monthlyConsistencyPct: byMonth.size ? +((profitableMonths / byMonth.size) * 100).toFixed(2) : null,
    weeksTracked: byWeek.size, profitableWeeks, pctProfitableWeeks: byWeek.size ? +((profitableWeeks / byWeek.size) * 100).toFixed(2) : null,
    netRByYear: Object.fromEntries([...byYear.entries()].map(([k, v]) => [k, +v.toFixed(3)])),
    exposurePct: exposure,
    totalCommissionCostR: +totalCommissionR.toFixed(3),
    ambiguousFillCount: ambiguousCount, ambiguousFillPct: +((ambiguousCount / n) * 100).toFixed(2),
    fundedAccountBreachProbability: null,
    _notes: [
      'fundedAccountBreachProbability requires Part 10\'s funded-account Monte Carlo simulator, not yet built — INSUFFICIENT EVIDENCE, not zero.',
      'sharpePerTrade/sharpeAnnualized/sortino/calmar use R-multiples as the return series (risk-normalized, not $ P&L) — see FINAL_STRATEGY_SPEC.md for the exact formulas once written.',
      'pctLaterReverseProxy uses an explicit proxy definition (MAE >= 0.3R at any point) — "reverses after entry" has no single standard definition.',
      'END_OF_DATA-truncated trades are excluded from all metrics above (they are not real completed decisions) but counted separately in excludedEndOfDataTruncations.',
    ],
  };
}

module.exports = { computeMetrics, isWin, isLoss, isBreakeven, ctDateKey, ctWeekKey, ctMonthKey, ctYearKey, mean, median, stddev, percentile };
