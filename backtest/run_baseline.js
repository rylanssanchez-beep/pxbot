'use strict';

// Part 4 — freeze the CURRENT production strategy exactly as it runs live in
// server.js's handleSignal, and run it unchanged through the new engine
// against REAL stored TradeLocker data (data/pxbot_market_data.sqlite).
//
// This script does NOT change ict_engine.js/orb_engine.js/
// session_breakout_engine.js's classification/entry logic — it reuses their
// exported functions exactly (sliceSessions, classifyDay, legLevels,
// sliceByDate) to determine WHEN and WHERE a signal fires, precisely
// mirroring server.js's SIGNAL_ICT_MIN_LEG/SIGNAL_ORB_CONFIG/
// SIGNAL_PREMARKET_CONFIG. Only the EXECUTION step (fill cost, MAE/MFE,
// ambiguous-fill flagging, ledger row) is routed through the new
// engine/replay_engine.js instead of each engine's own ad-hoc zero-cost
// simulator — the gap DATA_AUDIT.md §5 identified.
//
// Usage: node backtest/run_baseline.js [--costModel=base|zero]

const path = require('path');
const crypto = require('crypto');
const { MarketDataStore } = require('../data/store');
const { simulateTrade } = require('../engine/replay_engine');
const { computeMetrics } = require('./metrics');
const ictEngine = require('./ict_engine');
const orbEngine = require('./orb_engine');

const SYMBOL = 'NAS100';
const RUN_ID_PREFIX = 'baseline_v1';

// ── Cost model scenarios ────────────────────────────────────────────────
// NAS100 CFD spread/slippage are not yet measured from real fills (no trade
// history on this account) — these are documented, configurable ASSUMPTIONS
// consistent with typical retail NAS100 CFD conditions, not measured facts.
// Part 10 will replace this with a proper optimistic/base/adverse/severe
// grid; this baseline runs 'base' as the headline number and 'zero' as a
// transparency comparison showing exactly how much cost assumptions matter.
const COST_MODELS = {
  zero: { spreadPts: 0, slippagePts: 0, commissionR: 0 },
  base: { spreadPts: 2, slippagePts: 1, commissionR: 0.01 }, // ~2pt spread, 1pt slippage, small flat commission-in-R
};

function ctParts(unixSecs) {
  const d = new Date(new Date(unixSecs * 1000).toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  return { hour: d.getHours() + d.getMinutes() / 60, dateKey: d.toISOString().slice(0, 10), dow: d.getDay() };
}

// Canonical session vocabulary — matches server.js's buildMarketContext()
// windows exactly, so baseline reporting uses the same session labels the
// rest of the app already shows the operator.
function sessionTag(unixSecs) {
  const { hour } = ctParts(unixSecs);
  if (hour >= 19 || hour < 1) return 'asia';
  if (hour >= 1 && hour < 6) return 'london';
  if (hour >= 6 && hour < 8.5) return 'ny_premarket';
  if (hour >= 8.5 && hour < 10) return 'ny_open';
  if (hour >= 10 && hour < 12) return 'ny_am';
  if (hour >= 12 && hour < 13.5) return 'ny_midday';
  if (hour >= 13.5 && hour < 15) return 'ny_pm';
  return 'afterhours';
}

function codeHash(files) {
  const fs = require('fs');
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(fs.readFileSync(f));
  return h.digest('hex').slice(0, 16);
}

function datasetHash(bars) {
  const h = crypto.createHash('sha256');
  h.update(String(bars.length));
  if (bars.length) { h.update(String(bars[0].time)); h.update(String(bars[bars.length - 1].time)); }
  return h.digest('hex').slice(0, 16);
}

// ── ICT: reproduce SIGNAL_ICT_MIN_LEG / managed breakeven-ladder exit ─────
// exactly as server.js's handleSignal computes it (minLegSize=199, managed
// exit — stop rides through breakeven at TP1, TP1-lock at TP2, target TP3).
function runIctBaseline(hourlyBars, costModel, runId) {
  const th = { ...ictEngine.DEFAULT_THRESHOLDS, minLegSize: 199 };
  const byDate = ictEngine.sliceSessions(hourlyBars);
  const trades = [];

  for (const [dateKey, sess] of byDate.entries()) {
    if (!sess.asia.length || !sess.london.length) continue;
    const cls = ictEngine.classifyDay(sess.asia, sess.london, th);
    if (cls.id === 0 || cls.id === 4) continue;

    const levels = ictEngine.legLevels(cls.bias, cls.legLow, cls.legHigh, th);
    const forward = [...sess.ny, ...sess.forward];
    if (!forward.length) continue;

    // Entry scan — exactly ict_engine.js's simulateTradeManaged entry logic
    // (OTE-zone touch), stopping here so the engine takes over for execution.
    const maxForwardBars = 30; // matches ict_engine.js's runBacktest/runBacktestManaged default
    const scan = forward.slice(0, maxForwardBars);
    let entryIdx = -1, entryPriceRaw = null;
    for (let i = 0; i < scan.length; i++) {
      const b = scan[i];
      if (b.low <= levels.oteHigh && b.high >= levels.oteLow) {
        entryIdx = i;
        entryPriceRaw = cls.bias === 'BUY' ? Math.min(levels.oteHigh, b.high) : Math.max(levels.oteLow, b.low);
        break;
      }
    }
    if (entryIdx === -1) continue;

    // Execution is given the FULL forward array (not the entry-search-only
    // `scan` truncation) so the engine can tell "the strategy's own 30-bar
    // cap was reached while more real data existed" (a genuine TIME exit)
    // apart from "this day's session literally had fewer than 30 bars past
    // entry" (a real data-insufficiency edge case, correctly END_OF_DATA).
    // Entry itself is still only ever searched for within the first 30 bars,
    // exactly matching ict_engine.js's own maxForwardBars truncation.
    const result = simulateTrade({
      bars: forward, signalIndex: -1, direction: cls.bias === 'BUY' ? 'LONG' : 'SHORT',
      orderType: 'preComputedFill', precomputedEntryIndex: entryIdx, precomputedEntryPriceRaw: entryPriceRaw,
      stopPrice: levels.sl, targetPrice: levels.tp3,
      exitPlan: {
        stopSteps: [
          { triggerPrice: levels.tp1, newStopPrice: entryPriceRaw, stageName: 'breakeven' },
          { triggerPrice: levels.tp2, newStopPrice: levels.tp1, stageName: 'tp1_lock' },
        ],
        maxHoldingBars: maxForwardBars,
      },
      costModel,
    });
    if (!result.filled) continue;

    trades.push({
      ...result, runId, strategyId: 'ICT', strategyVersion: 'minLeg199_managed',
      symbol: SYMBOL, session: sessionTag(result.entryTime), split: 'baseline',
    });
  }
  return trades;
}

// ── ORB: reproduce SIGNAL_ORB_CONFIG exactly ───────────────────────────
function runOrbBaseline(hourlyBars, costModel, runId) {
  const th = { ...orbEngine.DEFAULT_ORB, rangeHour: 8, targetMultiple: 1, slBufferPct: 0.1, minRangeSize: 100, allowedDaysOfWeek: [0, 2, 3, 4, 5, 6] };
  const byDate = orbEngine.sliceByDate(hourlyBars, th);
  const trades = [];

  for (const [date, entry] of byDate.entries()) {
    if (!entry.rangeBar || !entry.forward.length) continue;
    if (!th.allowedDaysOfWeek.includes(entry.dow)) continue;
    const size = entry.rangeBar.high - entry.rangeBar.low;
    if (size <= 0 || size < th.minRangeSize) continue;

    const scan = entry.forward.slice(0, th.maxHoldHours); // exactly orb_engine.js's simulateOrbDay truncation
    let bias = null, entryIdx = -1, entryPriceRaw = null;
    for (let i = 0; i < scan.length; i++) {
      const b = scan[i];
      if (b.high > entry.rangeBar.high) { bias = 'LONG'; entryPriceRaw = entry.rangeBar.high; entryIdx = i; break; }
      if (b.low < entry.rangeBar.low) { bias = 'SHORT'; entryPriceRaw = entry.rangeBar.low; entryIdx = i; break; }
    }
    if (!bias) continue;

    const sl = bias === 'LONG' ? entry.rangeBar.low - size * th.slBufferPct : entry.rangeBar.high + size * th.slBufferPct;
    const target = bias === 'LONG' ? entryPriceRaw + size * th.targetMultiple : entryPriceRaw - size * th.targetMultiple;

    // Same fix as ICT: full forward array for execution visibility, real
    // th.maxHoldHours cap so a genuine TIME exit isn't mislabeled END_OF_DATA
    // just because more of the day's bars happened to exist past the cap.
    const result = simulateTrade({
      bars: entry.forward, signalIndex: -1, direction: bias, orderType: 'preComputedFill',
      precomputedEntryIndex: entryIdx, precomputedEntryPriceRaw: entryPriceRaw,
      stopPrice: sl, targetPrice: target, exitPlan: { maxHoldingBars: th.maxHoldHours }, costModel,
    });
    if (!result.filled) continue;

    trades.push({
      ...result, runId, strategyId: 'ORB', strategyVersion: 'rangeHour8_target1x_skipMonday',
      symbol: SYMBOL, session: sessionTag(result.entryTime), split: 'baseline',
    });
  }
  return trades;
}

// ── NY-premarket breakout: reproduce SIGNAL_PREMARKET_CONFIG on REAL
// 1-minute bars (the live signal handler's actual execution granularity for
// this strategy). Hold-time: the original 1-minute-precision validation's
// exact bar-count parameter is not recoverable from the committed codebase
// (session_breakout_regime_walkforward.js and siblings all validated on
// HOURLY bars, not 1-minute — see run_baseline's header comment).
//
// scripts/diagnose_premarket.js isolated this precisely (see its output /
// the git log): forcing an early 15:00 CT close vs. letting the trade ride
// to 19:00 CT (the same "forward" session boundary ict_engine.js/
// orb_engine.js already use — hour>=15 is "afterhours", still part of the
// tradeable day, not excluded, in both those engines) is the dominant
// factor, NOT data recency (first-207-days vs full-267-day vs last-60-days
// all show the same sign under either exit rule). 15:00 was an
// inconsistent, less-justified cutoff for this one strategy; this baseline
// now uses 19:00, matching the session boundary already established
// elsewhere in this codebase. This does not fully reproduce the old
// PREMARKET_TRACK_RECORD number (still below it, and cost assumptions
// explain another real chunk of the gap) but the sign and the mechanism
// are now understood and reproducible, not a mystery.
function runPremarketBaseline(minuteBars, costModel, runId) {
  const th = { targetMultiple: 0.5, slBufferPct: 0.05, minRangeSize: 100, allowedDaysOfWeek: [2, 3, 4] };
  const byDate = new Map();
  for (const b of minuteBars) {
    const { hour, dateKey, dow } = ctParts(b.time);
    if (!byDate.has(dateKey)) byDate.set(dateKey, { premarket: [], forward: [], dow });
    const entry = byDate.get(dateKey);
    if (hour >= 7 && hour < 9.5) entry.premarket.push(b);
    else if (hour >= 9.5) entry.forward.push(b);
  }

  const trades = [];
  for (const [dateKey, day] of byDate.entries()) {
    if (!th.allowedDaysOfWeek.includes(day.dow)) continue;
    if (!day.premarket.length || !day.forward.length) continue;
    const pmHigh = Math.max(...day.premarket.map(b => b.high));
    const pmLow = Math.min(...day.premarket.map(b => b.low));
    const size = pmHigh - pmLow;
    if (size <= 0 || size < th.minRangeSize) continue;

    // Entry can trigger any time the premarket range hasn't yet broken,
    // matching the live inline handler's behavior (no explicit later cutoff
    // on entry itself).
    let bias = null, entryIdx = -1, entryPriceRaw = null;
    for (let i = 0; i < day.forward.length; i++) {
      const b = day.forward[i];
      if (b.high > pmHigh) { bias = 'LONG'; entryPriceRaw = pmHigh; entryIdx = i; break; }
      if (b.low < pmLow) { bias = 'SHORT'; entryPriceRaw = pmLow; entryIdx = i; break; }
    }
    if (!bias) continue;

    const sl = bias === 'LONG' ? pmLow - size * th.slBufferPct : pmHigh + size * th.slBufferPct;
    const target = bias === 'LONG' ? entryPriceRaw + size * th.targetMultiple : entryPriceRaw - size * th.targetMultiple;

    // Session-close exit (19:00 CT, see header note) via the engine's own
    // mechanism — a clearly labeled SESSION_CLOSE exit, not lumped into
    // END_OF_DATA/TIME. maxHoldingBars is just a large safety cap;
    // sessionCloseAfterHour is the real, intended exit driver.
    const result = simulateTrade({
      bars: day.forward, signalIndex: -1, direction: bias, orderType: 'preComputedFill',
      precomputedEntryIndex: entryIdx, precomputedEntryPriceRaw: entryPriceRaw,
      stopPrice: sl, targetPrice: target,
      exitPlan: { maxHoldingBars: day.forward.length, sessionCloseAfterHour: 19 },
      costModel, ctPartsFn: ctParts,
    });
    if (!result.filled) continue;

    trades.push({
      ...result, runId, strategyId: 'PREMARKET', strategyVersion: 'target0.5x_tueWedThu_sessionClose',
      symbol: SYMBOL, session: sessionTag(result.entryTime), split: 'baseline',
    });
  }
  return trades;
}

function breakdownBy(trades, keyFn, opts) {
  const groups = new Map();
  for (const t of trades) {
    const k = keyFn(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const out = {};
  for (const [k, ts] of groups.entries()) out[k] = computeMetrics(ts, opts);
  return out;
}

(async () => {
  const scenario = (process.argv.find(a => a.startsWith('--costModel=')) || '--costModel=base').split('=')[1];
  const costModel = COST_MODELS[scenario];
  if (!costModel) { console.error(`Unknown cost model "${scenario}". Use base or zero.`); process.exit(1); }

  const store = new MarketDataStore();
  const hourlyBars = store.getAllBars(SYMBOL, '1H', 'tradelocker');
  const minuteBars = store.getAllBars(SYMBOL, '1m', 'tradelocker');
  console.log(`Loaded ${hourlyBars.length} 1H bars (${new Date(hourlyBars[0].time * 1000).toISOString().slice(0, 10)} .. ${new Date(hourlyBars.at(-1).time * 1000).toISOString().slice(0, 10)})`);
  console.log(`Loaded ${minuteBars.length} 1m bars (${new Date(minuteBars[0].time * 1000).toISOString().slice(0, 10)} .. ${new Date(minuteBars.at(-1).time * 1000).toISOString().slice(0, 10)})`);

  const runId = `${RUN_ID_PREFIX}_${scenario}`;
  const ictTrades = runIctBaseline(hourlyBars, costModel, runId);
  const orbTrades = runOrbBaseline(hourlyBars, costModel, runId);
  const premarketTrades = runPremarketBaseline(minuteBars, costModel, runId);
  const allTrades = [...ictTrades, ...orbTrades, ...premarketTrades];

  console.log(`\nICT: ${ictTrades.length} trades, ORB: ${orbTrades.length} trades, PREMARKET: ${premarketTrades.length} trades. Total: ${allTrades.length}.`);

  for (const t of allTrades) store.insertTrade(t);

  const hourlySpanDays = (hourlyBars.at(-1).time - hourlyBars[0].time) / 86400;
  const minuteSpanDays = (minuteBars.at(-1).time - minuteBars[0].time) / 86400;

  const overall = computeMetrics(allTrades, { totalPeriodDays: hourlySpanDays });
  const perStrategy = {
    ICT: computeMetrics(ictTrades, { totalPeriodDays: hourlySpanDays }),
    ORB: computeMetrics(orbTrades, { totalPeriodDays: hourlySpanDays }),
    PREMARKET: computeMetrics(premarketTrades, { totalPeriodDays: minuteSpanDays }),
  };
  const bySession = breakdownBy(allTrades, t => t.session, { totalPeriodDays: Math.max(hourlySpanDays, minuteSpanDays) });
  const byDirection = breakdownBy(allTrades, t => t.direction, { totalPeriodDays: Math.max(hourlySpanDays, minuteSpanDays) });
  const byYear = breakdownBy(allTrades, t => new Date(t.entryTime * 1000).getUTCFullYear(), { totalPeriodDays: Math.max(hourlySpanDays, minuteSpanDays) });
  const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const byDow = breakdownBy(allTrades, t => dowNames[ctParts(t.entryTime).dow], { totalPeriodDays: Math.max(hourlySpanDays, minuteSpanDays) });

  const report = {
    runId, scenario, costModel, generatedAt: new Date().toISOString(),
    dataWindow: {
      hourly: { bars: hourlyBars.length, from: hourlyBars[0].time, to: hourlyBars.at(-1).time, spanDays: +hourlySpanDays.toFixed(1) },
      minute: { bars: minuteBars.length, from: minuteBars[0].time, to: minuteBars.at(-1).time, spanDays: +minuteSpanDays.toFixed(1) },
    },
    codeHash: codeHash([
      path.join(__dirname, 'ict_engine.js'), path.join(__dirname, 'orb_engine.js'),
      path.join(__dirname, 'run_baseline.js'), path.join(__dirname, '..', 'engine', 'replay_engine.js'),
    ]),
    datasetHashHourly: datasetHash(hourlyBars), datasetHashMinute: datasetHash(minuteBars),
    overall, perStrategy, bySession, byDirection, byYear, byDow,
  };

  store.insertExperiment({
    runId, strategyId: 'ALL_BASELINE', strategyVersion: 'v1',
    codeHash: report.codeHash, datasetHash: report.datasetHashHourly, dataRange: `${report.dataWindow.hourly.spanDays}d hourly / ${report.dataWindow.minute.spanDays}d 1m`,
    instrument: SYMBOL, session: 'all', params: { costModel, scenario }, costs: costModel,
    splits: { note: 'frozen baseline, no tuning performed — train/validation/holdout split applies to Phase 5 candidates, not this baseline' },
    results: { overall, perStrategy },
  });

  const fs = require('fs');
  const outPath = path.join(__dirname, `baseline_report_${scenario}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nWrote full report to ${outPath}`);
  console.log(`\n=== OVERALL (${scenario} costs) ===`);
  console.log(`Trades: ${overall.totalTrades}, WinRate: ${overall.winRatePct}%, Expectancy: ${overall.expectancyR}R, ProfitFactor: ${overall.profitFactor}, NetR: ${overall.netR}, MaxDD: ${overall.maxDrawdownR}R`);

  store.close();
})().catch(e => { console.error('Baseline run failed:', e.stack); process.exit(1); });
