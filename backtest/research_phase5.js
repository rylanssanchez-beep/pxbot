'use strict';

// Part 5/7 — disciplined research over the session-specific candidate
// engines already built in this codebase (trend_pullback_engine.js,
// vwap_reversion_engine.js, liquidity_sweep_engine.js,
// session_reversion_engine.js, session_breakout_engine.js with the Asia/
// London anchors the baseline never covered). Uses REAL stored data (not a
// live server dependency, unlike the old *_walkforward.js scripts this
// replaces the role of), routes every candidate trade through
// engine/replay_engine.js for realistic costs, and follows the mission's
// required discipline:
//   1. Expanding-window walk-forward (6 folds) over the first 80% of history
//      — parameter selection happens ONLY on train-so-far, scored ONLY on
//      each fold's held-out test window.
//   2. A stability gate: the SAME picked config (or nothing) must recur
//      across folds — a different "best" every fold is treated as evidence
//      of noise, not signal, and the candidate is rejected regardless of
//      aggregate OOS R.
//   3. A completely untouched final holdout (the most recent 20% of
//      history) — touched exactly once, after the walk-forward verdict is
//      already decided, never used for any parameter selection.
//   4. Every run (accepted or rejected) is logged to the experiments
//      registry with its rejection reason if any — nothing is silently
//      dropped.
//
// Usage: node backtest/research_phase5.js

const crypto = require('crypto');
const { MarketDataStore } = require('../data/store');
const { simulateTrade } = require('../engine/replay_engine');
const { computeMetrics } = require('./metrics');
const trendPullback = require('./trend_pullback_engine');
const vwapReversion = require('./vwap_reversion_engine');
const liquiditySweep = require('./liquidity_sweep_engine');
const sessionReversion = require('./session_reversion_engine');
const orbEngine = require('./orb_engine');
const sessionBreakout = require('./session_breakout_engine');

const SYMBOL = 'NAS100';
const COST_MODEL = { spreadPts: 2, slippagePts: 1, commissionR: 0.01 }; // same 'base' assumptions as the baseline
const NUM_FOLDS = 6;
const MIN_TRAIN_TRADES = 12;
const HOLDOUT_FRACTION = 0.20;

function codeHash(files) {
  const fs = require('fs');
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(fs.readFileSync(f));
  return h.digest('hex').slice(0, 16);
}

// ── Convert each engine's own "days" output into replay_engine trades ─────
// Every candidate engine already exposes a day/trade record with an entry
// price/index and a bias — this glue mirrors run_baseline.js's approach
// (reuse the engine's own untouched entry logic, route only execution
// through the shared engine) rather than re-deriving each engine's signal
// logic a second time.

function tradesFromTrendPullback(bars, params) {
  const result = trendPullback.runTrendPullbackBacktest(bars, params);
  const out = [];
  for (const d of result.days) {
    if (!d.entryPrice) continue;
    const idx = bars.findIndex(b => b.time === d.time);
    if (idx === -1) continue;
    const direction = d.bias === 'BUY' ? 'LONG' : 'SHORT';
    const forward = bars.slice(idx); // execution array starting at the signal bar itself
    const r = simulateTrade({
      bars: forward, signalIndex: 0, direction, orderType: 'preComputedFill',
      precomputedEntryIndex: 0, precomputedEntryPriceRaw: d.entryPrice,
      stopPrice: d.sl, targetPrice: d.target,
      exitPlan: { maxHoldingBars: (params.maxHoldBars || trendPullback.DEFAULT_THRESHOLDS.maxHoldBars) },
      costModel: COST_MODEL,
    });
    if (r.filled) out.push(r);
  }
  return out;
}

function tradesFromVwapReversion(bars, params) {
  const result = vwapReversion.runVwapReversionBacktest(bars, params);
  const out = [];
  for (const d of result.days) {
    if (!d.entryPrice) continue;
    const idx = bars.findIndex(b => b.time === d.time);
    if (idx === -1) continue;
    const direction = d.bias === 'BUY' ? 'LONG' : 'SHORT';
    const forward = bars.slice(idx);
    const r = simulateTrade({
      bars: forward, signalIndex: 0, direction, orderType: 'preComputedFill',
      precomputedEntryIndex: 0, precomputedEntryPriceRaw: d.entryPrice,
      stopPrice: d.sl, targetPrice: d.target,
      exitPlan: { maxHoldingBars: (params.maxHoldBars || vwapReversion.DEFAULT_THRESHOLDS.maxHoldBars) },
      costModel: COST_MODEL,
    });
    if (r.filled) out.push(r);
  }
  return out;
}

// liquiditySweep/sessionReversion/sessionBreakout are session-anchored
// (Asia/London) and already do their own entry+exit simulation internally
// without exposing a raw entry index into the full bars array the way the
// hourly-walk engines above do — re-run their signal-finding step directly
// (findSweepReversal / the reversion touch-scan / the breakout scan) against
// each day's own forward-bar slice, exactly mirroring run_baseline.js's ORB
// pattern, so the entry logic itself is still the engine's own untouched code.
function tradesFromLiquiditySweep(bars, params) {
  const th = { ...liquiditySweep.DEFAULT_THRESHOLDS, ...params };
  const byDate = sessionBreakout.sliceSessions(bars);
  const FORWARD_AFTER = { asia: ['london', 'premarket', 'ny', 'forward'], london: ['premarket', 'ny', 'forward'] };
  const forwardBuckets = FORWARD_AFTER[th.anchor];
  const out = [];
  for (const [date, sess] of byDate.entries()) {
    if (!th.allowedDaysOfWeek.includes(sess.dow)) continue;
    const anchorBars = sess[th.anchor];
    if (!anchorBars || !anchorBars.length) continue;
    const range = { high: Math.max(...anchorBars.map(b => b.high)), low: Math.min(...anchorBars.map(b => b.low)) };
    const forward = forwardBuckets.flatMap(k => sess[k] || []);
    if (!forward.length) continue;
    const sig = liquiditySweep.findSweepReversal(range, forward, th);
    if (!sig) continue;
    const size = range.high - range.low;
    const sl = sig.bias === 'SELL' ? range.high + size * th.slBufferPct : range.low - size * th.slBufferPct;
    const risk = Math.abs(sig.entryPrice - sl);
    if (!(risk > 0)) continue;
    const target = sig.bias === 'BUY' ? sig.entryPrice + risk * th.targetMultiple : sig.entryPrice - risk * th.targetMultiple;
    const execBars = forward.slice(sig.entryIdx);
    const r = simulateTrade({
      bars: execBars, signalIndex: 0, direction: sig.bias === 'BUY' ? 'LONG' : 'SHORT', orderType: 'preComputedFill',
      precomputedEntryIndex: 0, precomputedEntryPriceRaw: sig.entryPrice,
      stopPrice: sl, targetPrice: target, exitPlan: { maxHoldingBars: th.maxTradeBars }, costModel: COST_MODEL,
    });
    if (r.filled) out.push(r);
  }
  return out;
}

function tradesFromSessionReversion(bars, params) {
  const th = { ...sessionReversion.DEFAULT_THRESHOLDS, ...params };
  const byDate = sessionBreakout.sliceSessions(bars);
  const FORWARD_AFTER = { asia: ['london', 'premarket', 'ny', 'forward'], london: ['premarket', 'ny', 'forward'] };
  const forwardBuckets = FORWARD_AFTER[th.anchor];
  const out = [];
  for (const [date, sess] of byDate.entries()) {
    if (!th.allowedDaysOfWeek.includes(sess.dow)) continue;
    const anchorBars = sess[th.anchor];
    if (!anchorBars || !anchorBars.length) continue;
    const range = { high: Math.max(...anchorBars.map(b => b.high)), low: Math.min(...anchorBars.map(b => b.low)) };
    const size = range.high - range.low;
    if (size <= 0 || size < th.minRangeSize) continue;
    const forward = forwardBuckets.flatMap(k => sess[k] || []);
    if (!forward.length) continue;
    const scan = forward.slice(0, th.maxHoldBars);
    let bias = null, entryIdx = -1, entryPrice = null;
    for (let i = 0; i < scan.length; i++) {
      const b = scan[i];
      if (b.high >= range.high) { bias = 'SELL'; entryPrice = range.high; entryIdx = i; break; }
      if (b.low <= range.low) { bias = 'BUY'; entryPrice = range.low; entryIdx = i; break; }
    }
    if (!bias) continue;
    const mid = (range.high + range.low) / 2;
    const sl = bias === 'SELL' ? range.high + size * th.slBufferPct : range.low - size * th.slBufferPct;
    const target = bias === 'SELL' ? entryPrice - (entryPrice - mid) * th.targetFraction : entryPrice + (mid - entryPrice) * th.targetFraction;
    const risk = Math.abs(entryPrice - sl);
    if (!(risk > 0)) continue;
    const execBars = forward.slice(entryIdx);
    const r = simulateTrade({
      bars: execBars, signalIndex: 0, direction: bias === 'BUY' ? 'LONG' : 'SHORT', orderType: 'preComputedFill',
      precomputedEntryIndex: 0, precomputedEntryPriceRaw: entryPrice,
      stopPrice: sl, targetPrice: target, exitPlan: { maxHoldingBars: th.maxTradeBars }, costModel: COST_MODEL,
    });
    if (r.filled) out.push(r);
  }
  return out;
}

const regimeEngine = require('../engine/regime_engine');

function tradesFromSessionBreakout(bars, params) {
  const th = { ...sessionBreakout.DEFAULT_THRESHOLDS, ...params };
  const byDate = sessionBreakout.sliceSessions(bars);
  const FORWARD_AFTER = { asia: ['london', 'premarket', 'ny', 'forward'], london: ['premarket', 'ny', 'forward'], premarket: ['ny', 'forward'] };
  const forwardBuckets = FORWARD_AFTER[th.anchor];
  const out = [];
  // Same regime pre-filter session_breakout_engine.js's own
  // runSessionBreakoutBacktest supports (minTrendEfficiency>0) — round 1
  // never swept this; round 2 does. Only built when actually in use.
  let timeToIndex = null;
  if (th.minTrendEfficiency > 0) {
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
    const range = { high: Math.max(...anchorBars.map(b => b.high)), low: Math.min(...anchorBars.map(b => b.low)) };
    const size = range.high - range.low;
    if (size <= 0 || size < th.minRangeSize) continue;
    const forward = forwardBuckets.flatMap(k => sess[k] || []);
    if (!forward.length) continue;
    const scan = forward.slice(0, th.maxHoldBars);
    let bias = null, entryIdx = -1, entryPrice = null;
    for (let i = 0; i < scan.length; i++) {
      const b = scan[i];
      if (b.high > range.high) { bias = 'LONG'; entryPrice = range.high; entryIdx = i; break; }
      if (b.low < range.low) { bias = 'SHORT'; entryPrice = range.low; entryIdx = i; break; }
    }
    if (!bias) continue;
    const sl = bias === 'LONG' ? range.low - size * th.slBufferPct : range.high + size * th.slBufferPct;
    const target = bias === 'LONG' ? entryPrice + size * th.targetMultiple : entryPrice - size * th.targetMultiple;
    const execBars = forward.slice(entryIdx);
    const r = simulateTrade({
      bars: execBars, signalIndex: 0, direction: bias, orderType: 'preComputedFill',
      precomputedEntryIndex: 0, precomputedEntryPriceRaw: entryPrice,
      stopPrice: sl, targetPrice: target, exitPlan: { maxHoldingBars: th.maxHoldBars }, costModel: COST_MODEL,
    });
    if (r.filled) out.push(r);
  }
  return out;
}

// ── ORB refinement: same mechanism as the frozen baseline (breakout of an
// hourly range bar) but with a wider parameter grid — different range-
// defining hour, target multiple, stop buffer, day filters — to see if a
// BETTER-tuned ORB variant exists, tested through the identical walk-
// forward + holdout discipline as every other candidate here, not swapped
// into the live config without validation.
function tradesFromOrb(bars, params) {
  const th = { ...orbEngine.DEFAULT_ORB, ...params };
  const byDate = orbEngine.sliceByDate(bars, th);
  const out = [];
  for (const [date, entry] of byDate.entries()) {
    if (!entry.rangeBar || !entry.forward.length) continue;
    if (!th.allowedDaysOfWeek.includes(entry.dow)) continue;
    const size = entry.rangeBar.high - entry.rangeBar.low;
    if (size <= 0 || size < th.minRangeSize) continue;
    const scan = entry.forward.slice(0, th.maxHoldHours);
    let bias = null, entryIdx = -1, entryPriceRaw = null;
    for (let i = 0; i < scan.length; i++) {
      const b = scan[i];
      if (b.high > entry.rangeBar.high) { bias = 'LONG'; entryPriceRaw = entry.rangeBar.high; entryIdx = i; break; }
      if (b.low < entry.rangeBar.low) { bias = 'SHORT'; entryPriceRaw = entry.rangeBar.low; entryIdx = i; break; }
    }
    if (!bias) continue;
    const sl = bias === 'LONG' ? entry.rangeBar.low - size * th.slBufferPct : entry.rangeBar.high + size * th.slBufferPct;
    const target = bias === 'LONG' ? entryPriceRaw + size * th.targetMultiple : entryPriceRaw - size * th.targetMultiple;
    const r = simulateTrade({
      bars: entry.forward, signalIndex: -1, direction: bias, orderType: 'preComputedFill',
      precomputedEntryIndex: entryIdx, precomputedEntryPriceRaw: entryPriceRaw,
      stopPrice: sl, targetPrice: target, exitPlan: { maxHoldingBars: th.maxHoldHours }, costModel: COST_MODEL,
    });
    if (r.filled) out.push(r);
  }
  return out;
}

// ── Previous-day high/low breakout — a new family (Part 5's own list:
// "Previous day high and low"), not tested in round 1/2. Objective,
// mechanically distinct from ORB (prior CALENDAR DAY's full range, not a
// single opening hour): once NY regular hours begin, the first break of
// yesterday's high or low is traded as continuation.
function ctParts(unixSecs) {
  const d = new Date(new Date(unixSecs * 1000).toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  return { hour: d.getHours() + d.getMinutes() / 60, dateKey: d.toISOString().slice(0, 10), dow: d.getDay() };
}
function tradesFromPrevDayLevel(bars, params) {
  const th = { targetMultiple: 1, slBufferPct: 0.1, minRangeSize: 0, maxHoldBars: 12, allowedDaysOfWeek: [0, 1, 2, 3, 4, 5, 6], ...params };
  const byDate = new Map();
  for (const b of bars) {
    const { hour, dateKey, dow } = ctParts(b.time);
    if (!byDate.has(dateKey)) byDate.set(dateKey, { all: [], nyOpen: [], dow });
    const day = byDate.get(dateKey);
    day.all.push(b);
    if (hour >= 9.5 && hour < 15) day.nyOpen.push(b);
  }
  const dateKeys = [...byDate.keys()].sort();
  const out = [];
  for (let i = 1; i < dateKeys.length; i++) {
    const today = byDate.get(dateKeys[i]);
    const yesterday = byDate.get(dateKeys[i - 1]);
    if (!today.nyOpen.length || !yesterday.all.length) continue;
    if (!th.allowedDaysOfWeek.includes(today.dow)) continue;
    const prevHigh = Math.max(...yesterday.all.map(b => b.high));
    const prevLow = Math.min(...yesterday.all.map(b => b.low));
    const size = prevHigh - prevLow;
    if (size <= 0 || size < th.minRangeSize) continue;
    const scan = today.nyOpen.slice(0, th.maxHoldBars);
    let bias = null, entryIdx = -1, entryPrice = null;
    for (let k = 0; k < scan.length; k++) {
      const b = scan[k];
      if (b.high > prevHigh) { bias = 'LONG'; entryPrice = prevHigh; entryIdx = k; break; }
      if (b.low < prevLow) { bias = 'SHORT'; entryPrice = prevLow; entryIdx = k; break; }
    }
    if (!bias) continue;
    const sl = bias === 'LONG' ? prevLow - size * th.slBufferPct : prevHigh + size * th.slBufferPct;
    const target = bias === 'LONG' ? entryPrice + size * th.targetMultiple : entryPrice - size * th.targetMultiple;
    const r = simulateTrade({
      bars: today.nyOpen, signalIndex: -1, direction: bias, orderType: 'preComputedFill',
      precomputedEntryIndex: entryIdx, precomputedEntryPriceRaw: entryPrice,
      stopPrice: sl, targetPrice: target, exitPlan: { maxHoldingBars: today.nyOpen.length }, costModel: COST_MODEL,
    });
    if (r.filled) out.push(r);
  }
  return out;
}

// ── Candidate registry: family label -> { tradeFn, grid } ─────────────────
const DAY_FILTERS = {
  allDays: [0, 1, 2, 3, 4, 5, 6], skipMonday: [0, 2, 3, 4, 5, 6], tueThuOnly: [2, 3, 4],
};

function grid(paramLists) {
  const keys = Object.keys(paramLists);
  let combos = [{}];
  for (const key of keys) {
    const next = [];
    for (const combo of combos) for (const val of paramLists[key]) next.push({ ...combo, [key]: val });
    combos = next;
  }
  return combos;
}

const CANDIDATES = {
  trend_pullback: {
    fn: tradesFromTrendPullback,
    grid: grid({ minTrendEfficiency: [0.2, 0.3, 0.4, 0.5, 0.6], pullbackAtrMultiple: [0.5, 1.0, 1.5], targetRMultiple: [1, 1.5, 2], allowedDaysOfWeek: Object.values(DAY_FILTERS) }),
  },
  vwap_reversion: {
    fn: tradesFromVwapReversion,
    grid: grid({ deviationAtrMultiple: [1.5, 2.0, 2.5], targetVwapFraction: [0.3, 0.5, 0.7], allowedDaysOfWeek: Object.values(DAY_FILTERS) }),
  },
  liquidity_sweep_asia: {
    fn: tradesFromLiquiditySweep,
    grid: grid({ anchor: ['asia'], sweepEpsilonPts: [1, 2, 5], confirmBars: [1, 3], targetMultiple: [0.5, 1, 1.5], allowedDaysOfWeek: Object.values(DAY_FILTERS) }),
  },
  liquidity_sweep_london: {
    fn: tradesFromLiquiditySweep,
    grid: grid({ anchor: ['london'], sweepEpsilonPts: [1, 2, 5], confirmBars: [1, 3], targetMultiple: [0.5, 1, 1.5], allowedDaysOfWeek: Object.values(DAY_FILTERS) }),
  },
  session_reversion_asia: {
    fn: tradesFromSessionReversion,
    grid: grid({ anchor: ['asia'], targetFraction: [0.3, 0.5, 0.7], slBufferPct: [0.05, 0.1], allowedDaysOfWeek: Object.values(DAY_FILTERS) }),
  },
  session_reversion_london: {
    fn: tradesFromSessionReversion,
    grid: grid({ anchor: ['london'], targetFraction: [0.3, 0.5, 0.7], slBufferPct: [0.05, 0.1], allowedDaysOfWeek: Object.values(DAY_FILTERS) }),
  },
  session_breakout_asia: {
    fn: tradesFromSessionBreakout,
    grid: grid({ anchor: ['asia'], targetMultiple: [0.5, 1, 1.5], slBufferPct: [0.05, 0.1], minRangeSize: [0, 60], allowedDaysOfWeek: Object.values(DAY_FILTERS), minTrendEfficiency: [0, 0.3, 0.4, 0.5], regimeLookback: [20] }),
  },
  session_breakout_london: {
    fn: tradesFromSessionBreakout,
    grid: grid({ anchor: ['london'], targetMultiple: [0.5, 1, 1.5], slBufferPct: [0.05, 0.1], minRangeSize: [0, 60], allowedDaysOfWeek: Object.values(DAY_FILTERS), minTrendEfficiency: [0, 0.3, 0.4, 0.5], regimeLookback: [20] }),
  },
  orb_refine: {
    fn: tradesFromOrb,
    grid: grid({ rangeHour: [7, 8, 9, 10], targetMultiple: [0.5, 1, 1.5, 2], slBufferPct: [0.05, 0.1, 0.15], minRangeSize: [0, 60, 100], maxHoldHours: [8], allowedDaysOfWeek: Object.values(DAY_FILTERS) }),
  },
  prev_day_level: {
    fn: tradesFromPrevDayLevel,
    grid: grid({ targetMultiple: [0.5, 1, 1.5], slBufferPct: [0.05, 0.1], minRangeSize: [0, 100], maxHoldBars: [6, 12], allowedDaysOfWeek: Object.values(DAY_FILTERS) }),
  },
};

function avgR(trades) { return trades.length ? trades.reduce((a, t) => a + t.rMultiple, 0) / trades.length : -Infinity; }

function runWalkForward(label, bars, spec) {
  const holdoutStart = Math.floor(bars.length * (1 - HOLDOUT_FRACTION));
  const devBars = bars.slice(0, holdoutStart);
  const holdoutBars = bars.slice(holdoutStart);
  const windowSize = Math.floor(devBars.length / NUM_FOLDS);

  const foldResults = [];
  for (let f = 1; f < NUM_FOLDS; f++) {
    const train = devBars.slice(0, f * windowSize);
    const test = devBars.slice(f * windowSize, (f + 1) * windowSize);
    if (!test.length) break;

    const scored = spec.grid.map(params => {
      const trades = spec.fn(train, params);
      return { params, trades: trades.length, avgR: trades.length >= MIN_TRAIN_TRADES ? avgR(trades) : -Infinity };
    }).filter(s => s.trades >= MIN_TRAIN_TRADES);
    scored.sort((a, b) => b.avgR - a.avgR);
    const best = scored[0];
    if (!best) { foldResults.push({ fold: f, skipped: true }); continue; }

    const testTrades = spec.fn(test, best.params);
    foldResults.push({
      fold: f, picked: best.params, trainAvgR: +best.avgR.toFixed(4),
      testN: testTrades.length, testAvgR: testTrades.length ? +avgR(testTrades).toFixed(4) : null,
      testTrades,
    });
  }

  const validFolds = foldResults.filter(f => !f.skipped);
  const positiveFolds = validFolds.filter(f => f.testAvgR > 0).length;
  const configs = validFolds.map(f => JSON.stringify(f.picked));
  const uniqueConfigs = new Set(configs).size;
  const allOosTrades = validFolds.flatMap(f => f.testTrades || []);
  const combinedOosAvgR = allOosTrades.length ? avgR(allOosTrades) : null;

  // Stability gate: require a config to repeat in at least half the valid
  // folds (not "every fold identical" — some parameter drift across an
  // expanding window is expected — but a genuinely different pick every
  // single time is the mission's own definition of noise, not edge).
  const configCounts = {};
  for (const c of configs) configCounts[c] = (configCounts[c] || 0) + 1;
  const mostCommonCount = Math.max(0, ...Object.values(configCounts));
  const stable = validFolds.length > 0 && mostCommonCount >= Math.ceil(validFolds.length / 2);

  const verdict = {
    validFolds: validFolds.length, positiveFolds, uniqueConfigs, mostCommonCount, stable,
    combinedOosTrades: allOosTrades.length, combinedOosAvgR: combinedOosAvgR !== null ? +combinedOosAvgR.toFixed(4) : null,
  };

  let holdout = null;
  let rejectionReason = null;
  if (validFolds.length < 3) rejectionReason = 'fewer than 3 valid walk-forward folds (insufficient trade volume for this grid/window)';
  else if (positiveFolds < Math.ceil(validFolds.length / 2)) rejectionReason = `only ${positiveFolds}/${validFolds.length} folds profitable OOS — not a majority`;
  else if (!stable) rejectionReason = `no config repeated in >=half of folds (${mostCommonCount}/${validFolds.length}) — looks like noise, not a stable edge`;
  else if (allOosTrades.length < 20) rejectionReason = `only ${allOosTrades.length} combined OOS trades — too few to trust`;

  if (!rejectionReason) {
    // Pick the most-common config across folds (the stable one) for the final holdout check.
    const mostCommonConfigStr = Object.entries(configCounts).sort((a, b) => b[1] - a[1])[0][0];
    const finalConfig = JSON.parse(mostCommonConfigStr);
    const holdoutTrades = spec.fn(holdoutBars, finalConfig);
    holdout = { config: finalConfig, n: holdoutTrades.length, avgR: holdoutTrades.length ? +avgR(holdoutTrades).toFixed(4) : null, trades: holdoutTrades };
    if (!holdoutTrades.length) rejectionReason = 'walk-forward passed but the picked config produced ZERO trades on the untouched final holdout';
    else if (holdout.avgR <= 0) rejectionReason = `walk-forward passed but the untouched final holdout was NOT profitable (avgR=${holdout.avgR}, n=${holdout.n})`;
  }

  return {
    label, verdict,
    foldResults: validFolds.map(f => ({ fold: f.fold, picked: f.picked, trainAvgR: f.trainAvgR, testN: f.testN, testAvgR: f.testAvgR })),
    rawFolds: validFolds, // kept separately (with testTrades intact) for ledger-writing — foldResults above is the stripped display copy
    holdout, accepted: !rejectionReason, rejectionReason,
  };
}

(async () => {
  const store = new MarketDataStore();
  const hourlyBars = store.getAllBars(SYMBOL, '1H', 'tradelocker');
  console.log(`Loaded ${hourlyBars.length} 1H bars (${new Date(hourlyBars[0].time * 1000).toISOString().slice(0, 10)} .. ${new Date(hourlyBars.at(-1).time * 1000).toISOString().slice(0, 10)})\n`);

  const hash = codeHash([
    __filename, require.resolve('./trend_pullback_engine'), require.resolve('./vwap_reversion_engine'),
    require.resolve('./liquidity_sweep_engine'), require.resolve('./session_reversion_engine'), require.resolve('./session_breakout_engine'),
  ]);

  const only = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1];
  const wanted = only ? only.split(',') : Object.keys(CANDIDATES);

  const results = {};
  for (const [label, spec] of Object.entries(CANDIDATES)) {
    if (!wanted.includes(label)) continue;
    console.log(`=== ${label} (grid size ${spec.grid.length}) ===`);
    const r = runWalkForward(label, hourlyBars, spec);
    results[label] = r;
    console.log(`  Walk-forward: ${r.verdict.positiveFolds}/${r.verdict.validFolds} folds profitable OOS, ${r.verdict.uniqueConfigs} distinct configs (most common repeated ${r.verdict.mostCommonCount}x), combined OOS avgR=${r.verdict.combinedOosAvgR} (n=${r.verdict.combinedOosTrades})`);

    // Full stats (wins/losses/win rate/RR), as requested — computed from the
    // SAME combined-OOS + holdout trade set the verdict itself used, never a
    // different, more-flattering slice.
    const allOosTrades = r.rawFolds.flatMap(f => f.testTrades || []);
    const oosMetrics = computeMetrics(allOosTrades, {});
    console.log(`  OOS stats: n=${oosMetrics.totalTrades}, wins=${oosMetrics.wins}, losses=${oosMetrics.losses}, winRate=${oosMetrics.winRatePct}%, avgWin=${oosMetrics.avgWinR}R, avgLoss=${oosMetrics.avgLossR}R, RR(payoff)=${oosMetrics.payoffRatio}, expectancy=${oosMetrics.expectancyR}R, PF=${oosMetrics.profitFactor}`);

    if (r.holdout) {
      const holdoutMetrics = computeMetrics(r.holdout.trades, {});
      console.log(`  Final holdout: n=${holdoutMetrics.totalTrades}, wins=${holdoutMetrics.wins}, losses=${holdoutMetrics.losses}, winRate=${holdoutMetrics.winRatePct}%, RR(payoff)=${holdoutMetrics.payoffRatio}, expectancy=${holdoutMetrics.expectancyR}R`);
    }
    console.log(`  VERDICT: ${r.accepted ? 'ACCEPTED' : 'REJECTED — ' + r.rejectionReason}\n`);

    const runId = `phase5_${label}`;
    store.insertExperiment({
      runId, strategyId: label, strategyVersion: 'v1', codeHash: hash,
      dataRange: `${hourlyBars.length} 1H bars`, instrument: SYMBOL, session: label,
      params: { grid: spec.grid.length, costModel: COST_MODEL },
      costs: COST_MODEL,
      splits: { folds: NUM_FOLDS, holdoutFraction: HOLDOUT_FRACTION, minTrainTrades: MIN_TRAIN_TRADES },
      results: { verdict: r.verdict, holdout: r.holdout ? { config: r.holdout.config, n: r.holdout.n, avgR: r.holdout.avgR } : null },
      rejectionReason: r.rejectionReason,
    });

    // Ledger every walk-forward OOS trade and the holdout trades, for accepted AND rejected candidates —
    // the mission requires a complete ledger, not just winners.
    for (const fold of r.rawFolds) {
      for (const t of (fold.testTrades || [])) {
        store.insertTrade({ ...t, runId, strategyId: label, strategyVersion: 'v1', symbol: SYMBOL, session: label, split: `walkforward_fold${fold.fold}` });
      }
    }
    if (r.holdout) for (const t of r.holdout.trades) store.insertTrade({ ...t, runId, strategyId: label, strategyVersion: 'v1', symbol: SYMBOL, session: label, split: 'holdout' });
  }

  const fs = require('fs');
  const path = require('path');
  fs.writeFileSync(path.join(__dirname, 'phase5_results.json'), JSON.stringify(results, (k, v) => k === 'trades' || k === 'testTrades' ? undefined : v, 2));
  console.log(`\nWritten to backtest/phase5_results.json (trade arrays omitted from the file — they're in the trade ledger; summary only here).`);

  const accepted = Object.entries(results).filter(([, r]) => r.accepted);
  console.log(`\n=== SUMMARY: ${accepted.length}/${Object.keys(results).length} candidates accepted ===`);
  for (const [label, r] of Object.entries(results)) {
    console.log(`  ${r.accepted ? '✓ ACCEPTED' : '✗ rejected '}  ${label.padEnd(28)} OOS avgR=${r.verdict.combinedOosAvgR ?? 'n/a'} (n=${r.verdict.combinedOosTrades})${r.holdout ? `, holdout avgR=${r.holdout.avgR} (n=${r.holdout.n})` : ''}`);
  }

  store.close();
})().catch(e => { console.error('Phase 5 research run failed:', e.stack); process.exit(1); });
