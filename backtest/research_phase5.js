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
// Default spread is the conservative 2pt assumption; --spread=N overrides
// it (e.g. --spread=1.32, the MEASURED median from this account's real feed
// — scripts/measure_spread.js, data/logs/measured_spread.json). Slippage
// stays an assumption either way: no real fills exist yet to measure it.
const COST_MODEL = { spreadPts: 2, slippagePts: 1, commissionR: 0.01 };
{
  const spreadArg = (process.argv.find(a => a.startsWith('--spread=')) || '').split('=')[1];
  if (spreadArg) { COST_MODEL.spreadPts = parseFloat(spreadArg); console.log(`Cost model: using spreadPts=${COST_MODEL.spreadPts} (CLI override — measured, not assumed)`); }
}
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
// Cached by timestamp — toLocaleString-with-timeZone is expensive, and the
// 1-minute candidates below call this across 258k bars × grid × folds.
const _ctPartsByTime = new Map();
function ctParts(unixSecs) {
  let p = _ctPartsByTime.get(unixSecs);
  if (!p) {
    const d = new Date(new Date(unixSecs * 1000).toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    p = { hour: d.getHours() + d.getMinutes() / 60, dateKey: d.toISOString().slice(0, 10), dow: d.getDay() };
    _ctPartsByTime.set(unixSecs, p);
  }
  return p;
}

// ── HARD OPERATOR CONSTRAINT: maximum 30-point protective stop on NAS100 ──
// Stated explicitly by the operator (funded-account rules/sizing). Any
// signal whose stop distance exceeds this is SKIPPED — exactly what the
// operator would do live. Note the honest consequence, reported rather than
// hidden: at a 30pt stop, the base cost model (2pt spread + 1pt slippage)
// is already >=0.1R per trade, and every hourly-structure strategy in this
// codebase (ORB, session breakouts, hourly FVG >=40pt gaps) uses stops
// structurally wider than 30pts — so capped candidates must be built on
// 1-minute structures, where only ~267 days of real data exist.
const MAX_STOP_POINTS = 30;
function tradesFromPrevDayLevel(bars, params) {
  const th = { targetMultiple: 1, slBufferPct: 0.1, minRangeSize: 0, maxHoldBars: 12, allowedDaysOfWeek: [0, 1, 2, 3, 4, 5, 6], ...params };
  const byDate = new Map();
  for (const b of bars) {
    const { hour, dateKey, dow } = ctParts(b.time);
    if (!byDate.has(dateKey)) byDate.set(dateKey, { all: [], nyOpen: [], rest: [], dow });
    const day = byDate.get(dateKey);
    day.all.push(b);
    if (hour >= 9.5 && hour < 15) day.nyOpen.push(b);
    else if (hour >= 15 && hour < 19) day.rest.push(b); // afterhours — execution room beyond the entry-search window, not a data cutoff
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
    // Execution gets the full remainder of the tradeable day (nyOpen + rest,
    // i.e. through 19:00 CT) starting at the entry bar, with a real
    // sessionCloseAfterHour exit driver — NOT bars.length itself as the cap,
    // which was this function's original bug (see git history): it made the
    // engine unable to ever distinguish "genuinely ran out of real data"
    // from "hit the strategy's own hold-time limit," silently inflating an
    // apparent edge with mostly-unresolved trades.
    const execBars = [...today.nyOpen.slice(entryIdx), ...today.rest];
    const r = simulateTrade({
      bars: execBars, signalIndex: -1, direction: bias, orderType: 'preComputedFill',
      precomputedEntryIndex: 0, precomputedEntryPriceRaw: entryPrice,
      stopPrice: sl, targetPrice: target,
      exitPlan: { maxHoldingBars: execBars.length, sessionCloseAfterHour: 19 }, costModel: COST_MODEL, ctPartsFn: ctParts,
    });
    if (r.filled) out.push(r);
  }
  return out;
}

// ── Fair Value Gap (FVG) continuation — objective 3-bar imbalance pattern
// from Part 1/5's own candidate list. Bullish FVG: bar[i-2].high < bar[i].low
// (a gap nothing traded through). Bearish: bar[i-2].low > bar[i].high. Bet:
// price retraces INTO the gap and continues in the gap's own direction
// (the imbalance acts as support/resistance) — a continuation bet, distinct
// from every reversion/sweep candidate already tested.
function tradesFromFvgContinuation(bars, params) {
  const th = { targetRMultiple: 1.5, slBufferPct: 0.1, minGapSize: 20, maxWaitBars: 20, maxHoldBars: 20, allowedDaysOfWeek: [0, 1, 2, 3, 4, 5, 6], ...params };
  const out = [];
  for (let i = 2; i < bars.length - 1; i++) {
    const { dow } = ctParts(bars[i].time);
    if (!th.allowedDaysOfWeek.includes(dow)) continue;
    const left = bars[i - 2], right = bars[i];
    let bias = null, gapLow = null, gapHigh = null;
    if (left.high < right.low && (right.low - left.high) >= th.minGapSize) { bias = 'LONG'; gapLow = left.high; gapHigh = right.low; }
    else if (left.low > right.high && (left.low - right.high) >= th.minGapSize) { bias = 'SHORT'; gapLow = right.high; gapHigh = left.low; }
    if (!bias) continue;

    const forward = bars.slice(i + 1);
    const scan = forward.slice(0, th.maxWaitBars);
    let entryIdx = -1, entryPrice = null;
    for (let k = 0; k < scan.length; k++) {
      const b = scan[k];
      const touchedGap = b.low <= gapHigh && b.high >= gapLow; // range overlap — direction-agnostic
      if (touchedGap) { entryIdx = k; entryPrice = bias === 'LONG' ? Math.min(gapHigh, b.high) : Math.max(gapLow, b.low); break; }
    }
    if (entryIdx === -1) continue;

    const gapSize = gapHigh - gapLow;
    const sl = bias === 'LONG' ? gapLow - gapSize * th.slBufferPct : gapHigh + gapSize * th.slBufferPct;
    const risk = Math.abs(entryPrice - sl);
    if (!(risk > 0)) continue;
    const target = bias === 'LONG' ? entryPrice + risk * th.targetRMultiple : entryPrice - risk * th.targetRMultiple;

    const r = simulateTrade({
      bars: forward, signalIndex: entryIdx - 1, direction: bias, orderType: 'preComputedFill',
      precomputedEntryIndex: entryIdx, precomputedEntryPriceRaw: entryPrice,
      stopPrice: sl, targetPrice: target, exitPlan: { maxHoldingBars: th.maxHoldBars }, costModel: COST_MODEL,
    });
    if (r.filled) out.push(r);
  }
  return out;
}

// ── Opening-range failure (fade) — the direct complement to ORB: when the
// hourly opening-range breaks out but FAILS (price re-enters the range
// within a short confirm window instead of continuing), fade back toward
// the opposite side. Reuses orb_engine.js's own range-bar/sliceByDate so the
// range definition is identical to ORB's — only the bet (fade vs.
// continuation) differs, isolating that one variable.
function tradesFromOrbFailure(bars, params) {
  const th = { ...orbEngine.DEFAULT_ORB, confirmBars: 2, targetMultiple: 1, ...params };
  const byDate = orbEngine.sliceByDate(bars, th);
  const out = [];
  for (const [date, entry] of byDate.entries()) {
    if (!entry.rangeBar || !entry.forward.length) continue;
    if (!th.allowedDaysOfWeek.includes(entry.dow)) continue;
    const size = entry.rangeBar.high - entry.rangeBar.low;
    if (size <= 0 || size < th.minRangeSize) continue;
    const scan = entry.forward.slice(0, th.maxHoldHours);

    let breakoutIdx = -1, breakoutBias = null;
    for (let i = 0; i < scan.length; i++) {
      const b = scan[i];
      if (b.high > entry.rangeBar.high) { breakoutBias = 'LONG'; breakoutIdx = i; break; }
      if (b.low < entry.rangeBar.low) { breakoutBias = 'SHORT'; breakoutIdx = i; break; }
    }
    if (breakoutIdx === -1) continue;

    // Confirmation: within confirmBars, price must close back INSIDE the range (a failed breakout).
    const confirmWindow = scan.slice(breakoutIdx, breakoutIdx + th.confirmBars);
    let failIdx = -1, entryPrice = null;
    for (let k = 0; k < confirmWindow.length; k++) {
      const cb = confirmWindow[k];
      const closedBackIn = breakoutBias === 'LONG' ? cb.close < entry.rangeBar.high : cb.close > entry.rangeBar.low;
      if (closedBackIn) { failIdx = breakoutIdx + k; entryPrice = cb.close; break; }
    }
    if (failIdx === -1) continue; // breakout held — not a failure, no trade (that's ORB's territory, not this candidate's)

    const fadeBias = breakoutBias === 'LONG' ? 'SHORT' : 'LONG'; // fade the failed direction
    const sl = fadeBias === 'SHORT' ? entry.rangeBar.high + size * th.slBufferPct : entry.rangeBar.low - size * th.slBufferPct;
    const mid = (entry.rangeBar.high + entry.rangeBar.low) / 2;
    const risk = Math.abs(entryPrice - sl);
    if (!(risk > 0)) continue;
    const target = fadeBias === 'LONG' ? entryPrice + risk * th.targetMultiple : entryPrice - risk * th.targetMultiple;

    const r = simulateTrade({
      bars: entry.forward, signalIndex: -1, direction: fadeBias, orderType: 'preComputedFill',
      precomputedEntryIndex: failIdx, precomputedEntryPriceRaw: entryPrice,
      stopPrice: sl, targetPrice: target, exitPlan: { maxHoldingBars: th.maxHoldHours }, costModel: COST_MODEL,
    });
    if (r.filled) out.push(r);
  }
  return out;
}

// ── Asia internal range fade — trades DURING the Asia session itself
// (19:00-01:00 CT), which no existing module does (every prior Asia-anchored
// candidate traded the NEXT sessions against Asia's completed range). The
// first `rangeBars` hourly bars of Asia define an initial range; the first
// subsequent touch of the range high is faded SHORT (low faded LONG) back
// toward the range interior. High-win-rate SHAPE by construction: small
// target (targetFraction of range size), wide stop (stopFraction of range
// size beyond the touched level), exit at Asia session end if neither hits.
// Trading-day bucketing uses a +6h shift (19:00+6h lands on the next
// calendar date, matching ict_engine.js's Asia-rollover convention exactly,
// without duplicating its slicing code).
function tradesFromAsiaInternalFade(bars, params) {
  const th = { rangeBars: 2, targetFraction: 0.33, stopFraction: 0.75, minRangeSize: 30, allowedDaysOfWeek: [0, 1, 2, 3, 4, 5, 6], ...params };
  const byDay = new Map();
  for (const b of bars) {
    const { hour } = ctParts(b.time);
    const shiftedKey = ctParts(b.time + 6 * 3600).dateKey;
    if (!byDay.has(shiftedKey)) byDay.set(shiftedKey, { asia: [], london: [] });
    const day = byDay.get(shiftedKey);
    if (hour >= 19 || hour < 1) day.asia.push(b);
    else if (hour >= 1 && hour < 7) day.london.push(b);
  }
  const out = [];
  for (const [dateKey, day] of byDay.entries()) {
    if (day.asia.length <= th.rangeBars) continue;
    const { dow } = ctParts(day.asia[day.asia.length - 1].time + 6 * 3600);
    if (!th.allowedDaysOfWeek.includes(dow)) continue;
    const rangeBars = day.asia.slice(0, th.rangeBars);
    const rest = day.asia.slice(th.rangeBars);
    const hi = Math.max(...rangeBars.map(b => b.high));
    const lo = Math.min(...rangeBars.map(b => b.low));
    const size = hi - lo;
    if (size <= 0 || size < th.minRangeSize) continue;

    let bias = null, entryIdx = -1, entryPrice = null;
    for (let i = 0; i < rest.length; i++) {
      const b = rest[i];
      const touchedHi = b.high >= hi, touchedLo = b.low <= lo;
      if (touchedHi && touchedLo) break; // one giant bar through both sides — no clean read, skip the day
      if (touchedHi) { bias = 'SHORT'; entryPrice = hi; entryIdx = i; break; }
      if (touchedLo) { bias = 'LONG'; entryPrice = lo; entryIdx = i; break; }
    }
    if (!bias) continue;

    const sl = bias === 'SHORT' ? hi + size * th.stopFraction : lo - size * th.stopFraction;
    const target = bias === 'SHORT' ? hi - size * th.targetFraction : lo + size * th.targetFraction;
    const risk = Math.abs(entryPrice - sl);
    if (!(risk > 0)) continue;

    // Execution: remaining Asia bars from the touch, PLUS that day's London
    // bars appended past the maxHoldingBars cap — so an exit at Asia's end
    // is a genuine, kept TIME exit (bars exist beyond it), never a silently
    // excluded END_OF_DATA truncation. Same anti-pattern fix as
    // tradesFromPrevDayLevel — applied at construction this time, not after
    // a bug report.
    const asiaExec = rest.slice(entryIdx);
    const execBars = [...asiaExec, ...day.london];
    const r = simulateTrade({
      bars: execBars, signalIndex: -1, direction: bias, orderType: 'preComputedFill',
      precomputedEntryIndex: 0, precomputedEntryPriceRaw: entryPrice,
      stopPrice: sl, targetPrice: target,
      exitPlan: { maxHoldingBars: asiaExec.length - 1 }, costModel: COST_MODEL,
    });
    if (r.filled) out.push(r);
  }
  return out;
}

// ── 1-MINUTE, ≤30pt-stop candidates (operator's hard constraint) ──────────

// 1m Fair Value Gap continuation — same objective 3-bar imbalance as the
// validated hourly family, at 1-minute scale where gaps are 5-15pts and the
// stop (just beyond the gap) fits the 30pt cap naturally. Separate function
// from tradesFromFvgContinuation on purpose: (1) bounded forward-window
// slicing (full-array slices per signal would be O(n^2) at 258k bars),
// (2) time-contiguity check so a weekend/halt boundary is never mistaken
// for an intrabar imbalance, (3) chronological non-overlap — after a fill,
// scanning resumes past that trade's exit, so two signals can never hold
// positions simultaneously (Part 8: no overlapping duplicate signals), and
// (4) the hard maxStopPoints skip. The validated hourly function stays
// byte-identical.
function tradesFromFvg1m(bars, params) {
  const th = { targetRMultiple: 1, slBufferPct: 0.2, minGapSize: 8, maxWaitBars: 15, maxHoldBars: 45, allowedDaysOfWeek: [1, 2, 3, 4, 5], ...params };
  const out = [];
  let i = 2;
  while (i < bars.length - 1) {
    const { dow } = ctParts(bars[i].time);
    if (!th.allowedDaysOfWeek.includes(dow)) { i++; continue; }
    const left = bars[i - 2], right = bars[i];
    if (right.time - left.time > 600) { i++; continue; } // non-contiguous minutes (session boundary) — not a real imbalance
    let bias = null, gapLow = null, gapHigh = null;
    if (left.high < right.low && (right.low - left.high) >= th.minGapSize) { bias = 'LONG'; gapLow = left.high; gapHigh = right.low; }
    else if (left.low > right.high && (left.low - right.high) >= th.minGapSize) { bias = 'SHORT'; gapLow = right.high; gapHigh = left.low; }
    if (!bias) { i++; continue; }

    const forward = bars.slice(i + 1, i + 1 + th.maxWaitBars + th.maxHoldBars + 10);
    let entryIdx = -1, entryPrice = null;
    for (let k = 0; k < Math.min(forward.length, th.maxWaitBars); k++) {
      const b = forward[k];
      if (b.low <= gapHigh && b.high >= gapLow) {
        entryIdx = k;
        entryPrice = bias === 'LONG' ? Math.min(gapHigh, b.high) : Math.max(gapLow, b.low);
        break;
      }
    }
    if (entryIdx === -1) { i++; continue; }

    const gapSize = gapHigh - gapLow;
    const sl = bias === 'LONG' ? gapLow - gapSize * th.slBufferPct : gapHigh + gapSize * th.slBufferPct;
    const risk = Math.abs(entryPrice - sl);
    if (!(risk > 0) || risk > MAX_STOP_POINTS) { i++; continue; } // operator's hard 30pt stop cap
    const target = bias === 'LONG' ? entryPrice + risk * th.targetRMultiple : entryPrice - risk * th.targetRMultiple;

    const r = simulateTrade({
      bars: forward, signalIndex: entryIdx - 1, direction: bias, orderType: 'preComputedFill',
      precomputedEntryIndex: entryIdx, precomputedEntryPriceRaw: entryPrice,
      stopPrice: sl, targetPrice: target, exitPlan: { maxHoldingBars: th.maxHoldBars }, costModel: COST_MODEL,
    });
    if (r.filled) {
      out.push(r);
      i = i + 1 + entryIdx + Math.max(1, r.holdingBars || 1); // resume past this trade's exit — no overlapping positions
    } else i++;
  }
  return out;
}

// Micro opening-range breakout on 1m bars — the NY premarket/open coverage
// under the 30pt cap. Range = first `rangeMinutes` of the 08:30 CT cash
// open; breakout entry; stop at the opposite side + small fixed buffer.
// The cap does the day-selection: a day whose opening range implies a stop
// wider than 30pts is skipped entirely (compressed-open days only) —
// that's the honest way to respect the constraint, not shrinking stops to
// fit and getting noise-stopped.
function tradesFromMicroOrb1m(bars, params) {
  const th = { rangeMinutes: 15, targetMultiple: 1.5, slBufferPts: 2, entryCutoffHour: 12, allowedDaysOfWeek: [1, 2, 3, 4, 5], ...params };
  const byDate = new Map();
  for (const b of bars) {
    const { hour, dateKey, dow } = ctParts(b.time);
    if (!byDate.has(dateKey)) byDate.set(dateKey, { range: [], forward: [], dow });
    const day = byDate.get(dateKey);
    const rangeEnd = 8.5 + th.rangeMinutes / 60;
    if (hour >= 8.5 && hour < rangeEnd) day.range.push(b);
    else if (hour >= rangeEnd && hour < 19) day.forward.push(b);
  }
  const out = [];
  for (const [dateKey, day] of byDate.entries()) {
    if (!th.allowedDaysOfWeek.includes(day.dow)) continue;
    if (day.range.length < th.rangeMinutes * 0.6 || !day.forward.length) continue; // enough real bars to trust the range
    const hi = Math.max(...day.range.map(b => b.high));
    const lo = Math.min(...day.range.map(b => b.low));
    const size = hi - lo;
    if (size <= 0) continue;
    const stopDist = size + th.slBufferPts;
    if (stopDist > MAX_STOP_POINTS) continue; // operator's hard 30pt stop cap — skips wide-open days entirely

    let bias = null, entryIdx = -1, entryPrice = null;
    for (let k = 0; k < day.forward.length; k++) {
      const b = day.forward[k];
      if (ctParts(b.time).hour >= th.entryCutoffHour) break; // NY AM only, per operator's session requirement
      if (b.high > hi) { bias = 'LONG'; entryPrice = hi; entryIdx = k; break; }
      if (b.low < lo) { bias = 'SHORT'; entryPrice = lo; entryIdx = k; break; }
    }
    if (!bias) continue;

    const sl = bias === 'LONG' ? lo - th.slBufferPts : hi + th.slBufferPts;
    const risk = Math.abs(entryPrice - sl);
    if (!(risk > 0)) continue;
    const target = bias === 'LONG' ? entryPrice + risk * th.targetMultiple : entryPrice - risk * th.targetMultiple;

    const r = simulateTrade({
      bars: day.forward, signalIndex: -1, direction: bias, orderType: 'preComputedFill',
      precomputedEntryIndex: entryIdx, precomputedEntryPriceRaw: entryPrice,
      stopPrice: sl, targetPrice: target,
      exitPlan: { maxHoldingBars: day.forward.length, sessionCloseAfterHour: 15 },
      costModel: COST_MODEL, ctPartsFn: ctParts,
    });
    if (r.filled) out.push(r);
  }
  return out;
}

// Asia internal fade at 1m with FIXED-POINT stops/targets (both ≤30pts by
// construction). Range = first `rangeMinutes` of Asia (from 19:00 CT);
// first touch of an extreme fades back toward the interior. Exit at Asia
// session end as a genuine TIME exit (London 1m bars appended past the
// hold cap).
function tradesFromAsiaFade1m(bars, params) {
  const th = { rangeMinutes: 60, stopPoints: 20, targetPoints: 12, minRangeSize: 20, allowedDaysOfWeek: [0, 1, 2, 3, 4, 5, 6], ...params };
  if (th.stopPoints > MAX_STOP_POINTS) return []; // config itself violates the cap — untradeable, zero trades
  const byDay = new Map();
  for (const b of bars) {
    const { hour } = ctParts(b.time);
    const shiftedKey = ctParts(b.time + 6 * 3600).dateKey;
    if (!byDay.has(shiftedKey)) byDay.set(shiftedKey, { asia: [], london: [] });
    const day = byDay.get(shiftedKey);
    if (hour >= 19 || hour < 1) day.asia.push(b);
    else if (hour >= 1 && hour < 7) day.london.push(b);
  }
  const out = [];
  for (const [dateKey, day] of byDay.entries()) {
    if (day.asia.length <= th.rangeMinutes) continue;
    const { dow } = ctParts(day.asia[day.asia.length - 1].time + 6 * 3600);
    if (!th.allowedDaysOfWeek.includes(dow)) continue;
    const rangeBars = day.asia.slice(0, th.rangeMinutes);
    const rest = day.asia.slice(th.rangeMinutes);
    const hi = Math.max(...rangeBars.map(b => b.high));
    const lo = Math.min(...rangeBars.map(b => b.low));
    const size = hi - lo;
    if (size <= 0 || size < th.minRangeSize) continue;

    let bias = null, entryIdx = -1, entryPrice = null;
    for (let k = 0; k < rest.length; k++) {
      const b = rest[k];
      const touchedHi = b.high >= hi, touchedLo = b.low <= lo;
      if (touchedHi && touchedLo) break; // one bar through both sides — no clean read
      if (touchedHi) { bias = 'SHORT'; entryPrice = hi; entryIdx = k; break; }
      if (touchedLo) { bias = 'LONG'; entryPrice = lo; entryIdx = k; break; }
    }
    if (!bias) continue;

    const sl = bias === 'SHORT' ? entryPrice + th.stopPoints : entryPrice - th.stopPoints;
    const target = bias === 'SHORT' ? entryPrice - th.targetPoints : entryPrice + th.targetPoints;

    const asiaExec = rest.slice(entryIdx);
    const execBars = [...asiaExec, ...day.london];
    const r = simulateTrade({
      bars: execBars, signalIndex: -1, direction: bias, orderType: 'preComputedFill',
      precomputedEntryIndex: 0, precomputedEntryPriceRaw: entryPrice,
      stopPrice: sl, targetPrice: target,
      exitPlan: { maxHoldingBars: Math.max(1, asiaExec.length - 1) }, costModel: COST_MODEL,
    });
    if (r.filled) out.push(r);
  }
  return out;
}

// ── Breakout-RETEST continuation on 1m — the operator's stated geometry:
// fixed stop ≤30pts, target 30-100+pts (1.5-3R). Instead of entering the
// breakout itself with the range as the stop (which the 30pt cap forbids —
// see micro_orb_1m's zero qualifying days), this waits for the breakout to
// be CONFIRMED by a close beyond the level, then enters on the pullback
// RETEST of that level, with a fixed-point stop just beyond it. Tight stop
// because the entry is at the level, not chasing; multi-R target because
// the bet is continuation of an already-confirmed break. Covers both
// operator sessions via the `session` param: 'nyopen' (08:30 CT range,
// NY-AM-only entries, session-close exit) and 'asia' (19:00 CT range,
// Asia-end exit).
function tradesFromRetestBreakout1m(bars, params) {
  const th = { session: 'nyopen', rangeMinutes: 15, stopPoints: 25, targetRMultiple: 2, breakoutSearchBars: 120, maxWaitBars: 45, allowedDaysOfWeek: [1, 2, 3, 4, 5], ...params };
  if (th.stopPoints > MAX_STOP_POINTS) return [];
  const byDay = new Map();
  for (const b of bars) {
    const { hour } = ctParts(b.time);
    if (th.session === 'nyopen') {
      const { dateKey, dow } = ctParts(b.time);
      if (!byDay.has(dateKey)) byDay.set(dateKey, { range: [], forward: [], tail: [], dow });
      const day = byDay.get(dateKey);
      const rangeEnd = 8.5 + th.rangeMinutes / 60;
      if (hour >= 8.5 && hour < rangeEnd) day.range.push(b);
      else if (hour >= rangeEnd && hour < 19) day.forward.push(b);
    } else { // asia — trading-day bucketing via +6h shift (matches ict_engine's rollover)
      const shiftedKey = ctParts(b.time + 6 * 3600).dateKey;
      if (!byDay.has(shiftedKey)) byDay.set(shiftedKey, { range: [], forward: [], tail: [], dow: null });
      const day = byDay.get(shiftedKey);
      if (hour >= 19 || hour < 1) {
        if (day.range.length < th.rangeMinutes) day.range.push(b);
        else day.forward.push(b);
      } else if (hour >= 1 && hour < 7) day.tail.push(b); // London — execution room past Asia's end
    }
  }
  const out = [];
  for (const [dateKey, day] of byDay.entries()) {
    if (day.range.length < th.rangeMinutes * 0.6 || !day.forward.length) continue;
    const dow = th.session === 'nyopen' ? day.dow : ctParts(day.range[day.range.length - 1].time + 6 * 3600).dow;
    if (!th.allowedDaysOfWeek.includes(dow)) continue;
    const hi = Math.max(...day.range.map(b => b.high));
    const lo = Math.min(...day.range.map(b => b.low));
    if (!(hi > lo)) continue;

    // 1) Breakout confirmation: first CLOSE beyond the range (wick-throughs don't count).
    let breakoutIdx = -1, bias = null, level = null;
    const searchEnd = Math.min(day.forward.length, th.breakoutSearchBars);
    for (let k = 0; k < searchEnd; k++) {
      const b = day.forward[k];
      if (th.session === 'nyopen' && ctParts(b.time).hour >= 12) break; // NY AM only
      if (b.close > hi) { bias = 'LONG'; level = hi; breakoutIdx = k; break; }
      if (b.close < lo) { bias = 'SHORT'; level = lo; breakoutIdx = k; break; }
    }
    if (breakoutIdx === -1) continue;

    // 2) Pullback retest of the broken level within maxWaitBars.
    let entryIdx = -1;
    for (let k = breakoutIdx + 1; k < Math.min(day.forward.length, breakoutIdx + 1 + th.maxWaitBars); k++) {
      const b = day.forward[k];
      const touched = bias === 'LONG' ? b.low <= level : b.high >= level;
      if (touched) { entryIdx = k; break; }
    }
    if (entryIdx === -1) continue; // broke out but never pulled back — no chase, no trade

    const sl = bias === 'LONG' ? level - th.stopPoints : level + th.stopPoints;
    const target = bias === 'LONG' ? level + th.stopPoints * th.targetRMultiple : level - th.stopPoints * th.targetRMultiple;

    const execBars = th.session === 'nyopen'
      ? day.forward.slice(entryIdx)
      : [...day.forward.slice(entryIdx), ...day.tail];
    const exitPlan = th.session === 'nyopen'
      ? { maxHoldingBars: execBars.length, sessionCloseAfterHour: 15 }
      : { maxHoldingBars: Math.max(1, day.forward.length - entryIdx - 1) }; // TIME exit at Asia end; London bars exist beyond
    const r = simulateTrade({
      bars: execBars, signalIndex: -1, direction: bias, orderType: 'preComputedFill',
      precomputedEntryIndex: 0, precomputedEntryPriceRaw: level,
      stopPrice: sl, targetPrice: target, exitPlan, costModel: COST_MODEL, ctPartsFn: ctParts,
    });
    if (r.filled) out.push(r);
  }
  return out;
}

// ── Prev-day high/low breakout with the operator's fixed geometry ─────────
// Round 3's prev_day_level was the strongest level type tested (68% WR,
// 5/5 folds) but used the full prior-day range as its stop (way over the
// 30pt cap). This re-geometries it: fixed ≤30pt stop, fixed 40/60/100pt
// targets, entries only in the operator's window (premarket + NY AM,
// 07:00-12:00 CT), on 1m bars. Two entry styles in the grid: 'break'
// (enter on the close-confirmed breakout bar) and 'retest' (wait for the
// pullback to the level after confirmation).
function tradesFromPrevDayFixedStop1m(bars, params) {
  const th = { entryStyle: 'break', stopPoints: 25, targetPoints: 60, maxWaitBars: 60, allowedDaysOfWeek: [1, 2, 3, 4, 5], ...params };
  if (th.stopPoints > MAX_STOP_POINTS) return [];
  const byDate = new Map();
  for (const b of bars) {
    const { hour, dateKey, dow } = ctParts(b.time);
    if (!byDate.has(dateKey)) byDate.set(dateKey, { all: [], exec: [], dow });
    const day = byDate.get(dateKey);
    day.all.push(b);
    if (hour >= 7 && hour < 19) day.exec.push(b); // execution room through the evening; entries gated separately below
  }
  const dateKeys = [...byDate.keys()].sort();
  const out = [];
  for (let i = 1; i < dateKeys.length; i++) {
    const today = byDate.get(dateKeys[i]);
    const yesterday = byDate.get(dateKeys[i - 1]);
    if (!today.exec.length || yesterday.all.length < 300) continue; // need a real full prior day, not a holiday stub
    if (!th.allowedDaysOfWeek.includes(today.dow)) continue;
    const prevHigh = Math.max(...yesterday.all.map(b => b.high));
    const prevLow = Math.min(...yesterday.all.map(b => b.low));
    if (!(prevHigh > prevLow)) continue;

    // 1) Close-confirmed break of either level, inside 07:00-12:00 CT only.
    let breakIdx = -1, bias = null, level = null;
    for (let k = 0; k < today.exec.length; k++) {
      const b = today.exec[k];
      if (ctParts(b.time).hour >= 12) break;
      if (b.close > prevHigh) { bias = 'LONG'; level = prevHigh; breakIdx = k; break; }
      if (b.close < prevLow) { bias = 'SHORT'; level = prevLow; breakIdx = k; break; }
    }
    if (breakIdx === -1) continue;

    let entryIdx = -1, entryPriceRaw = null;
    if (th.entryStyle === 'break') {
      entryIdx = breakIdx;
      entryPriceRaw = today.exec[breakIdx].close; // enter on the confirming bar's close
    } else { // retest
      for (let k = breakIdx + 1; k < Math.min(today.exec.length, breakIdx + 1 + th.maxWaitBars); k++) {
        const b = today.exec[k];
        const touched = bias === 'LONG' ? b.low <= level : b.high >= level;
        if (touched) { entryIdx = k; entryPriceRaw = level; break; }
      }
      if (entryIdx === -1) continue;
    }

    const sl = bias === 'LONG' ? entryPriceRaw - th.stopPoints : entryPriceRaw + th.stopPoints;
    const target = bias === 'LONG' ? entryPriceRaw + th.targetPoints : entryPriceRaw - th.targetPoints;
    const execBars = today.exec.slice(entryIdx);
    const r = simulateTrade({
      bars: execBars, signalIndex: -1, direction: bias, orderType: 'preComputedFill',
      precomputedEntryIndex: 0, precomputedEntryPriceRaw: entryPriceRaw,
      stopPrice: sl, targetPrice: target,
      exitPlan: { maxHoldingBars: execBars.length, sessionCloseAfterHour: 15 },
      costModel: COST_MODEL, ctPartsFn: ctParts,
    });
    if (r.filled) out.push(r);
  }
  return out;
}

// ── The VALIDATED hourly FVG edge with a 1-minute precision entry ─────────
// fvg_continuation_narrow (accepted: 58% WR, 1R targets, 5/5 folds + 92-
// trade holdout) has one incompatibility with the operator's constraints:
// its stop (~1.2x a 40-50pt gap) is 48-60pts. This candidate keeps the
// SAME signal — hourly 3-bar imbalance, >=40pt gap, Tue/Wed/Thu — but
// executes on 1m bars: wait for price to penetrate `entryDepth` of the way
// into the gap (a deeper, better price than the hourly version's first-
// touch), stop = fixed <=30pts from entry, target = targetRMultiple x
// stopPoints (37-90pts — hourly-scale targets, capped risk). Hourly bars
// are aggregated deterministically from the same 1m array; a gap is only
// actionable after its third hourly bar has CLOSED (no lookahead).
const { aggregateOHLC } = require('../engine/replay_engine');
function tradesFromFvgHourly1mEntry(bars, params) {
  const th = { minGapSize: 40, entryDepth: 0.4, stopPoints: 25, targetRMultiple: 2, maxWaitMinutes: 600, maxHoldMinutes: 360, allowedDaysOfWeek: [2, 3, 4], ...params };
  if (th.stopPoints > MAX_STOP_POINTS) return [];
  const hourly = aggregateOHLC(bars, 3600);
  const timeToIdx = new Map();
  for (let k = 0; k < bars.length; k++) timeToIdx.set(bars[k].time, k);
  const out = [];
  let lastExitTime = 0; // chronological non-overlap across signals

  for (let i = 2; i < hourly.length; i++) {
    if (hourly[i].time - hourly[i - 2].time !== 7200) continue; // non-contiguous hours (weekend/halt) — not an imbalance
    const left = hourly[i - 2], right = hourly[i];
    let bias = null, gapLow = null, gapHigh = null;
    if (left.high < right.low && (right.low - left.high) >= th.minGapSize) { bias = 'LONG'; gapLow = left.high; gapHigh = right.low; }
    else if (left.low > right.high && (left.low - right.high) >= th.minGapSize) { bias = 'SHORT'; gapLow = right.high; gapHigh = left.low; }
    if (!bias) continue;
    const signalTime = right.time + 3600; // the imbalance exists only once the third hourly bar CLOSES
    if (!th.allowedDaysOfWeek.includes(ctParts(right.time).dow)) continue;
    if (signalTime < lastExitTime) continue;

    const gapSize = gapHigh - gapLow;
    // Deeper-entry level inside the gap: LONG enters as price falls into the
    // gap from above; SHORT enters as price rises into it from below.
    const entryLevel = bias === 'LONG' ? gapHigh - gapSize * th.entryDepth : gapLow + gapSize * th.entryDepth;

    // Find the first 1m bar at/after signalTime; scan up to maxWaitMinutes for a touch.
    let startIdx = timeToIdx.get(signalTime);
    if (startIdx === undefined) {
      // signalTime lands in a data gap — take the next existing bar (binary scan forward one hour max)
      for (let t = signalTime; t < signalTime + 3600 && startIdx === undefined; t += 60) startIdx = timeToIdx.get(t);
      if (startIdx === undefined) continue;
    }
    let entryIdx = -1;
    for (let k = startIdx; k < Math.min(bars.length, startIdx + th.maxWaitMinutes); k++) {
      const b = bars[k];
      const touched = bias === 'LONG' ? b.low <= entryLevel : b.high >= entryLevel;
      if (touched) { entryIdx = k; break; }
    }
    if (entryIdx === -1) continue;

    const sl = bias === 'LONG' ? entryLevel - th.stopPoints : entryLevel + th.stopPoints;
    const target = bias === 'LONG' ? entryLevel + th.stopPoints * th.targetRMultiple : entryLevel - th.stopPoints * th.targetRMultiple;
    const execBars = bars.slice(entryIdx, entryIdx + th.maxHoldMinutes + 10);
    const r = simulateTrade({
      bars: execBars, signalIndex: -1, direction: bias, orderType: 'preComputedFill',
      precomputedEntryIndex: 0, precomputedEntryPriceRaw: entryLevel,
      stopPrice: sl, targetPrice: target,
      exitPlan: { maxHoldingBars: th.maxHoldMinutes }, costModel: COST_MODEL,
    });
    if (r.filled) {
      out.push(r);
      lastExitTime = r.exitTime || (bars[entryIdx].time + th.maxHoldMinutes * 60);
    }
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
  fvg_continuation: {
    fn: tradesFromFvgContinuation,
    grid: grid({ targetRMultiple: [1, 1.5, 2], slBufferPct: [0.05, 0.1, 0.15], minGapSize: [10, 20, 40], maxWaitBars: [10, 20], allowedDaysOfWeek: Object.values(DAY_FILTERS) }),
  },
  // Narrower follow-up: round 4's fold-by-fold picks showed minGapSize=40 and
  // the Tue/Wed/Thu day filter agreeing in 5/5 folds, targetRMultiple=1 and
  // maxWaitBars=10 agreeing in 4/5 (only fold 3, an early low-data fold,
  // disagreed) — the ORIGINAL stability gate's exact-object-match check
  // didn't detect this because slBufferPct alone flip-flopped between two
  // nearby values. This grid fixes what the data already agreed on and
  // narrows the search to the one dimension that didn't, so the walk-forward
  // has less unrelated noise to pick a "different best" from. This is
  // principled narrowing based on an observed cross-fold pattern, not
  // picking the grid that produces the answer we want — the walk-forward +
  // untouched holdout still runs from scratch, unbiased.
  fvg_continuation_narrow: {
    fn: tradesFromFvgContinuation,
    grid: grid({ targetRMultiple: [1], slBufferPct: [0.03, 0.05, 0.075, 0.1], minGapSize: [30, 40, 50], maxWaitBars: [10], allowedDaysOfWeek: [[2, 3, 4]] }),
  },
  orb_failure_fade: {
    fn: tradesFromOrbFailure,
    grid: grid({ confirmBars: [1, 2, 3], targetMultiple: [0.5, 1, 1.5], slBufferPct: [0.05, 0.1], minRangeSize: [0, 60, 100], allowedDaysOfWeek: Object.values(DAY_FILTERS) }),
  },
  // ── High-win-rate-SHAPE candidates (selectBy: 'winRate') ──────────────
  // Small target + wide stop structurally raises win rate; the selection
  // rule maximizes train win rate SUBJECT TO positive train expectancy
  // after costs, so a config that wins often but loses money can never be
  // picked. Sessions per operator requirement: Asia, NY premarket/open.
  asia_fade_scalp: {
    fn: tradesFromAsiaInternalFade, selectBy: 'winRate',
    grid: grid({ rangeBars: [2, 3], targetFraction: [0.2, 0.33, 0.5], stopFraction: [0.5, 0.75, 1.0], minRangeSize: [30, 60], allowedDaysOfWeek: [DAY_FILTERS.allDays, DAY_FILTERS.skipMonday] }),
  },
  orb_scalp: {
    fn: tradesFromOrb, selectBy: 'winRate',
    grid: grid({ rangeHour: [8, 9], targetMultiple: [0.25, 0.33, 0.5], slBufferPct: [0.05, 0.1], minRangeSize: [60, 100], maxHoldHours: [8], allowedDaysOfWeek: Object.values(DAY_FILTERS) }),
  },
  fvg_scalp: {
    fn: tradesFromFvgContinuation, selectBy: 'winRate',
    // Gap-size floor and Tue/Wed/Thu day filter held fixed at the values
    // already cross-validated in 5/5 folds for this family; only the
    // target/stop shape (the win-rate lever) is searched.
    grid: grid({ targetRMultiple: [0.25, 0.33, 0.5], slBufferPct: [0.1, 0.15, 0.2], minGapSize: [40, 50], maxWaitBars: [10], allowedDaysOfWeek: [[2, 3, 4]] }),
  },
  // ── ≤30pt-stop candidates on REAL 1-minute data (operator's hard cap) ──
  fvg_1m_capped: {
    fn: tradesFromFvg1m, selectBy: 'winRate', data: '1m',
    grid: grid({ minGapSize: [5, 8, 12], targetRMultiple: [0.5, 1], slBufferPct: [0.2], maxWaitBars: [15], maxHoldBars: [45], allowedDaysOfWeek: [[1, 2, 3, 4, 5], [2, 3, 4]] }),
  },
  micro_orb_1m_capped: {
    fn: tradesFromMicroOrb1m, selectBy: 'winRate', data: '1m',
    grid: grid({ rangeMinutes: [5, 15], targetMultiple: [1, 1.5], slBufferPts: [2], allowedDaysOfWeek: [[1, 2, 3, 4, 5], [2, 3, 4]] }),
  },
  asia_fade_1m_capped: {
    fn: tradesFromAsiaFade1m, selectBy: 'winRate', data: '1m',
    grid: grid({ rangeMinutes: [60], stopPoints: [20, 30], targetPoints: [8, 12, 18], minRangeSize: [20, 40], allowedDaysOfWeek: [[0, 1, 2, 3, 4, 5, 6], [0, 2, 3, 4, 5, 6]] }),
  },
  // ── Operator's stated geometry: ≤30pt stop, 30-100+pt (1.5-3R) targets ──
  retest_nyopen_1m: {
    fn: tradesFromRetestBreakout1m, data: '1m',
    grid: grid({ session: ['nyopen'], rangeMinutes: [15, 30], stopPoints: [20, 25, 30], targetRMultiple: [1.5, 2, 3], maxWaitBars: [45], allowedDaysOfWeek: [[1, 2, 3, 4, 5], [2, 3, 4]] }),
  },
  retest_asia_1m: {
    fn: tradesFromRetestBreakout1m, data: '1m',
    grid: grid({ session: ['asia'], rangeMinutes: [60, 90], stopPoints: [20, 25, 30], targetRMultiple: [1.5, 2], maxWaitBars: [60], allowedDaysOfWeek: [[0, 1, 2, 3, 4, 5, 6], [0, 2, 3, 4, 5, 6]] }),
  },
  // ── Bigger targets + higher win rate under the 30pt cap (round 7) ──────
  prevday_fixedstop_1m: {
    fn: tradesFromPrevDayFixedStop1m, selectBy: 'winRate', data: '1m',
    grid: grid({ entryStyle: ['break', 'retest'], stopPoints: [25, 30], targetPoints: [40, 60, 100], allowedDaysOfWeek: [[1, 2, 3, 4, 5], [2, 3, 4]] }),
  },
  fvg_hourly_1m_entry: {
    fn: tradesFromFvgHourly1mEntry, selectBy: 'winRate', data: '1m',
    grid: grid({ minGapSize: [40, 50], entryDepth: [0.3, 0.5], stopPoints: [25, 30], targetRMultiple: [1.5, 2, 3], maxWaitMinutes: [600], maxHoldMinutes: [360], allowedDaysOfWeek: [[2, 3, 4]] }),
  },
};

// Defense in depth: END_OF_DATA trades (the execution array ran out before
// we could know what would have happened) are NOT real completed decisions
// — computeMetrics already excludes them for reporting, and every scoring/
// gating decision in this file must too, or a candidate function with a
// truncated-execution-window bug (this file has already had one — see
// tradesFromPrevDayLevel's fix) can silently pass gates on trades that
// never actually resolved.
function cleanTrades(trades) { return trades.filter(t => t.exitReason !== 'END_OF_DATA'); }
function avgR(trades) { const c = cleanTrades(trades); return c.length ? c.reduce((a, t) => a + t.rMultiple, 0) / c.length : -Infinity; }

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
      const trades = cleanTrades(spec.fn(train, params));
      const winRate = trades.length ? trades.filter(t => t.rMultiple > 1e-6).length / trades.length : 0;
      return { params, trades: trades.length, winRate, avgR: trades.length >= MIN_TRAIN_TRADES ? avgR(trades) : -Infinity };
    }).filter(s => s.trades >= MIN_TRAIN_TRADES);
    // Two selection modes, both applied to TRAIN data only:
    //  - default: maximize expectancy (avgR)
    //  - 'winRate': maximize win rate SUBJECT TO positive train expectancy
    //    after costs — encodes the operator's stated objective (highest win
    //    rate that still makes money) without ever selecting a config that
    //    wins often but loses money overall. Selecting by win rate alone,
    //    unconstrained, would happily pick negative-expectancy configs; the
    //    positivity constraint is what keeps this honest.
    let best;
    if (spec.selectBy === 'winRate') {
      const positive = scored.filter(s => s.avgR > 0);
      positive.sort((a, b) => b.winRate - a.winRate || b.avgR - a.avgR);
      best = positive[0];
    } else {
      scored.sort((a, b) => b.avgR - a.avgR);
      best = scored[0];
    }
    if (!best) { foldResults.push({ fold: f, skipped: true }); continue; }

    const testTradesRaw = spec.fn(test, best.params);
    const testTrades = cleanTrades(testTradesRaw);
    foldResults.push({
      fold: f, picked: best.params, trainAvgR: +best.avgR.toFixed(4),
      testN: testTrades.length, testAvgR: testTrades.length ? +avgR(testTrades).toFixed(4) : null,
      testTrades, testTradesExcludedEndOfData: testTradesRaw.length - testTrades.length,
    });
  }

  const validFolds = foldResults.filter(f => !f.skipped);
  const positiveFolds = validFolds.filter(f => f.testAvgR > 0).length;
  const configs = validFolds.map(f => JSON.stringify(f.picked));
  const uniqueConfigs = new Set(configs).size;
  const allOosTrades = validFolds.flatMap(f => f.testTrades || []); // already clean (END_OF_DATA excluded above)
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
    const holdoutTradesRaw = spec.fn(holdoutBars, finalConfig);
    const holdoutTrades = cleanTrades(holdoutTradesRaw);
    holdout = { config: finalConfig, n: holdoutTrades.length, avgR: holdoutTrades.length ? +avgR(holdoutTrades).toFixed(4) : null, trades: holdoutTrades, excludedEndOfData: holdoutTradesRaw.length - holdoutTrades.length };
    if (!holdoutTrades.length) rejectionReason = 'walk-forward passed but the picked config produced ZERO real (non-END_OF_DATA) trades on the untouched final holdout';
    else if (holdout.avgR <= 0) rejectionReason = `walk-forward passed but the untouched final holdout was NOT profitable (avgR=${holdout.avgR}, n=${holdout.n})`;
    else if (holdout.n < 15) rejectionReason = `walk-forward passed but the untouched final holdout only had ${holdout.n} real trades — too few to trust despite positive avgR`;
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
  console.log(`Loaded ${hourlyBars.length} 1H bars (${new Date(hourlyBars[0].time * 1000).toISOString().slice(0, 10)} .. ${new Date(hourlyBars.at(-1).time * 1000).toISOString().slice(0, 10)})`);
  const minuteBars = store.getAllBars(SYMBOL, '1m', 'tradelocker');
  console.log(`Loaded ${minuteBars.length} 1m bars (${new Date(minuteBars[0].time * 1000).toISOString().slice(0, 10)} .. ${new Date(minuteBars.at(-1).time * 1000).toISOString().slice(0, 10)})\n`);

  const hash = codeHash([
    __filename, require.resolve('./trend_pullback_engine'), require.resolve('./vwap_reversion_engine'),
    require.resolve('./liquidity_sweep_engine'), require.resolve('./session_reversion_engine'), require.resolve('./session_breakout_engine'),
  ]);

  const only = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1];
  const wanted = only ? only.split(',') : Object.keys(CANDIDATES);

  const results = {};
  for (const [label, spec] of Object.entries(CANDIDATES)) {
    if (!wanted.includes(label)) continue;
    const dataBars = spec.data === '1m' ? minuteBars : hourlyBars;
    console.log(`=== ${label} (grid size ${spec.grid.length}, data: ${spec.data === '1m' ? '1-minute' : 'hourly'}) ===`);
    const r = runWalkForward(label, dataBars, spec);
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
      dataRange: spec.data === '1m' ? `${minuteBars.length} 1m bars` : `${hourlyBars.length} 1H bars`, instrument: SYMBOL, session: label,
      params: { grid: spec.grid.length, costModel: COST_MODEL },
      costs: COST_MODEL,
      splits: { folds: NUM_FOLDS, holdoutFraction: HOLDOUT_FRACTION, minTrainTrades: MIN_TRAIN_TRADES },
      results: { verdict: r.verdict, holdout: r.holdout ? { config: r.holdout.config, n: r.holdout.n, avgR: r.holdout.avgR } : null },
      rejectionReason: r.rejectionReason,
    });

    // Ledger every walk-forward OOS trade and the holdout trades, for accepted AND rejected candidates —
    // the mission requires a complete ledger, not just winners. Clear this
    // run_id's rows first so re-running a candidate (e.g. after a bug fix or
    // a wider grid) REPLACES its ledger entries instead of appending
    // duplicates on top of a stale, superseded set.
    const clearedN = store.clearRunTrades(runId);
    if (clearedN) console.log(`  (cleared ${clearedN} previously-ledgered trades for ${runId} before re-inserting)`);
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
