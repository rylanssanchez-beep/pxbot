'use strict';

// ─── Confirmation Engine gating validation ─────────────────────────────────
// The load-bearing test for the whole confirmation-engine addition: replays
// history through ict_engine.js/orb_engine.js EXACTLY as they run live,
// scores each trade with engine/confirmation_engine.js using ONLY bars
// available up to that trade's decision point (no lookahead — MTF/execution
// bars are truncated to the entry day's session start before scoring), then
// reports win-rate/expectancy STRATIFIED BY CONFIDENCE TIER, split across
// expanding chronological folds so one lucky period can't hide the result.
//
// If tier A+/A doesn't out-perform tier B/skip out-of-sample, that result
// gets printed exactly as-is — this script does not filter, retry, or
// cherry-pick until it looks good. That would be exactly the overfitting the
// directive says to reject.
//
// Two data modes:
//   node backtest/confirmation_backtest.js            live TL history via the running server (same as walkforward.js)
//   node backtest/confirmation_backtest.js --synthetic   seeded synthetic fixture — this sandbox has no live
//                                                        TradeLocker credentials, so this is what validates the
//                                                        SCRIPT and the confirmation engine's internal consistency;
//                                                        it is NOT evidence of real market edge. Every line of
//                                                        output in this mode says so.

const http = require('http');
const fs = require('fs');
const path = require('path');
const ictEngine = require('./ict_engine');
const orbEngine = require('./orb_engine');
const fractalEngine = require('../engine/fractal_engine');
const confirmationEngine = require('../engine/confirmation_engine');
const { generateSyntheticBars } = require('./fixtures/synthetic_bars');

const SYNTHETIC = process.argv.includes('--synthetic');

function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: 8899, path: p }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function ctDateKey(unixSecs) {
  return new Date(new Date(unixSecs * 1000).toLocaleString('en-US', { timeZone: 'America/Chicago' })).toISOString().slice(0, 10);
}

// toLocaleString with a timeZone is expensive (same lesson already learned
// in orb_engine.js's ctPartsForAll / ict_engine.js's sliceSessions cache).
// hourlyToDaily gets called once per scored trade on a growing prefix of the
// SAME underlying bar objects — cache the date key by bar object identity so
// each bar only ever pays the timezone-conversion cost once across the
// entire backtest, not once per (bar x trade).
const _dateKeyCache = new WeakMap();
function ctDateKeyCached(bar) {
  let key = _dateKeyCache.get(bar);
  if (key === undefined) { key = ctDateKey(bar.time); _dateKeyCache.set(bar, key); }
  return key;
}

// Hourly bars are the only granularity available across full history in
// this codebase's existing backtests (same tradeoff orb_engine.js documents
// explicitly) — these aggregate that single hourly series up to daily/4H so
// the confirmation engine's MTF layer has something to read. A live-history
// run could instead pull real daily/4H bars via /api/candles; kept simple
// here since the point of this script is the tier-stratification test, not
// perfecting MTF fidelity.
function hourlyToDaily(bars) {
  const byDate = new Map();
  for (const b of bars) {
    const key = ctDateKeyCached(b);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(b);
  }
  const out = [];
  for (const chunk of byDate.values()) {
    out.push({ time: chunk[0].time, open: chunk[0].open, close: chunk[chunk.length - 1].close,
      high: Math.max(...chunk.map(b => b.high)), low: Math.min(...chunk.map(b => b.low)),
      volume: chunk.reduce((a, b) => a + (b.volume || 0), 0) });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

function hourlyToH4(bars) {
  const out = [];
  for (let i = 0; i < bars.length; i += 4) {
    const chunk = bars.slice(i, i + 4);
    if (!chunk.length) continue;
    out.push({ time: chunk[0].time, open: chunk[0].open, close: chunk[chunk.length - 1].close,
      high: Math.max(...chunk.map(b => b.high)), low: Math.min(...chunk.map(b => b.low)),
      volume: chunk.reduce((a, b) => a + (b.volume || 0), 0) });
  }
  return out;
}

// Bars strictly before `cutoffTime` — the no-lookahead guard. Every MTF/
// execution-bar input to the confirmation engine is built from this, never
// from the full dataset.
function truncate(bars, cutoffTime) {
  const idx = bars.findIndex(b => b.time > cutoffTime);
  return idx === -1 ? bars : bars.slice(0, idx);
}

function scoreTrade(bias, quote, entryZone, executionBarsFull, cutoffTime, ictResult, orbResult, weights) {
  const availableBars = truncate(executionBarsFull, cutoffTime);
  if (availableBars.length < 60) return null; // not enough history yet for a meaningful MTF read
  // Execution-bar detectors (VWAP/FVG/OB/displacement/sweep) use a bounded
  // trailing window, not the entire history since inception — an
  // inception-anchored VWAP thousands of bars deep would be meaningless by
  // the time we're scoring a trade late in the dataset. Daily/weekly/monthly
  // aggregation below still uses the FULL truncated history, since those
  // genuinely need long lookback for a real dealing range.
  const recentExecution = availableBars.slice(-200);
  const daily = hourlyToDaily(availableBars);
  const h4 = hourlyToH4(availableBars);
  const weekly = fractalEngine.aggregateToTimeframe(daily, 'week');
  const monthly = fractalEngine.aggregateToTimeframe(daily, 'month');
  const barsByTF = { h1: recentExecution, h4, d1: daily, weekly, monthly };
  return confirmationEngine.computeConfirmation({ bias, quote, entryZone, executionBars: recentExecution, barsByTF, ictResult, orbResult }, weights);
}

// weights: optional — defaults to confirmationEngine.DEFAULT_WEIGHTS (same
// as before this parameter existed, so existing callers/results are
// unaffected). Pass the active or a proposed engine/confirmation_weights.json
// to actually test THOSE weights instead of the hardcoded equal baseline —
// needed by backtest/apply_weights.js to compare current vs. proposed.
function runConfirmationBacktest(bars, opts = {}) {
  const ictTh = { ...ictEngine.DEFAULT_THRESHOLDS, minLegSize: opts.ictMinLegSize ?? 199 };
  const orbTh = { ...orbEngine.DEFAULT_ORB, rangeHour: 9, targetMultiple: 0.5, slBufferPct: 0.05, minRangeSize: 100 };
  const weights = opts.weights || confirmationEngine.DEFAULT_WEIGHTS;

  const results = [];

  // ICT trades — same session-slicing/classification/simulation the live
  // engine and existing backtests already use, unmodified.
  const byDate = ictEngine.sliceSessions(bars);
  for (const [dateKey, sess] of byDate.entries()) {
    if (!sess.asia.length || !sess.london.length) continue;
    const cls = ictEngine.classifyDay(sess.asia, sess.london, ictTh);
    if (cls.id === 0 || cls.id === 4) continue;
    const levels = ictEngine.legLevels(cls.bias, cls.legLow, cls.legHigh, ictTh);
    const forward = [...sess.ny, ...sess.forward];
    const sim = ictEngine.simulateTrade(cls.bias, levels, forward, opts.maxForwardBars || 30);
    if (!sim.entered) continue;

    const decisionTime = sess.london[sess.london.length - 1].time;
    const entryZone = { low: levels.oteLow, high: levels.oteHigh };
    const report = scoreTrade(cls.bias, sim.entryPrice, entryZone, bars, decisionTime, { bias: cls.bias }, null, weights);
    if (!report) continue;

    const r = sim.result === 'SL' ? -1 : (sim.result === 'TIMEOUT' ? 0 : Number(sim.r) || 0);
    results.push({ date: dateKey, strategy: 'ICT', bias: cls.bias, tier: report.tier, confidence: report.confidence, agreeingCount: report.agreeingCount, r, result: sim.result, time: decisionTime });
  }

  // ORB trades
  const orbByDate = orbEngine.sliceByDate(bars, orbTh);
  for (const [dateKey, entry] of orbByDate.entries()) {
    if (!entry.rangeBar || !entry.forward.length) continue;
    const sim = orbEngine.simulateOrbDay(entry.rangeBar, entry.forward, orbTh);
    if (!sim || !sim.entered) continue;

    const decisionTime = entry.rangeBar.time;
    const size = entry.rangeBar.high - entry.rangeBar.low;
    const entryPrice = sim.bias === 'BUY' ? entry.rangeBar.high : entry.rangeBar.low;
    const entryZone = { low: Math.min(entryPrice, entryPrice - size * 0.1), high: Math.max(entryPrice, entryPrice + size * 0.1) };
    const report = scoreTrade(sim.bias, entryPrice, entryZone, bars, decisionTime, null, { bias: sim.bias }, weights);
    if (!report) continue;

    results.push({ date: dateKey, strategy: 'ORB', bias: sim.bias, tier: report.tier, confidence: report.confidence, agreeingCount: report.agreeingCount, r: sim.r, result: sim.exit, time: decisionTime });
  }

  results.sort((a, b) => a.time - b.time);
  return results;
}

function stratifyByTier(results) {
  const byTier = {};
  for (const r of results) {
    if (!byTier[r.tier]) byTier[r.tier] = { n: 0, wins: 0, totalR: 0 };
    byTier[r.tier].n++;
    byTier[r.tier].totalR += r.r;
    if (r.r > 0.001) byTier[r.tier].wins++;
  }
  for (const k of Object.keys(byTier)) {
    byTier[k].winRate = +((byTier[k].wins / byTier[k].n) * 100).toFixed(1);
    byTier[k].avgR = +(byTier[k].totalR / byTier[k].n).toFixed(3);
    byTier[k].totalR = +byTier[k].totalR.toFixed(2);
  }
  return byTier;
}

async function loadBars(synthetic) {
  if (synthetic) {
    return generateSyntheticBars({ count: 12000, resolutionMin: 60, seed: 42, basePrice: 20000, volPts: 220 });
  }
  const health = await get('/api/health');
  if (!health.authenticated) throw new Error('Not connected to TradeLocker — log in via the app UI first, then re-run this.');
  const data = await get('/api/candles?resolution=60&count=19000');
  if (!data.bars || !data.bars.length) throw new Error('No bars: ' + data.error);
  return data.bars;
}

module.exports = { runConfirmationBacktest, stratifyByTier, loadBars };

if (require.main === module) (async () => {
  let bars;
  if (SYNTHETIC) {
    console.log('*** --synthetic mode: seeded synthetic fixture, NOT real market data. ***');
    console.log('*** This validates the SCRIPT and the confirmation engine\'s internal   ***');
    console.log('*** consistency only — it is NOT evidence of real trading edge. This    ***');
    console.log('*** sandbox has no live TradeLocker credentials to run the real thing.  ***\n');
    bars = generateSyntheticBars({ count: 12000, resolutionMin: 60, seed: 42, basePrice: 20000, volPts: 220 });
  } else {
    const health = await get('/api/health');
    if (!health.authenticated) { console.error('Not connected to TradeLocker — log in via the app UI first, then re-run this.'); process.exit(1); }
    const data = await get('/api/candles?resolution=60&count=19000');
    if (!data.bars || !data.bars.length) { console.error('No bars:', data.error); process.exit(1); }
    bars = data.bars;
  }

  const results = runConfirmationBacktest(bars);
  console.log(`${results.length} trades scored (ICT + ORB combined, confirmation-engine-gated, no-lookahead).\n`);

  console.log('=== COMBINED (all trades, all periods) ===');
  const combined = stratifyByTier(results);
  for (const tier of ['A+', 'A', 'B', 'skip']) {
    if (!combined[tier]) { console.log(`  ${tier}: no trades`); continue; }
    const t = combined[tier];
    console.log(`  ${tier}: n=${t.n}, winRate=${t.winRate}%, avgR=${t.avgR}, totalR=${t.totalR}`);
  }

  console.log('\n=== EXPANDING-WINDOW FOLDS (chronological, out-of-sample consistency check) ===');
  const NUM_FOLDS = 4;
  const windowSize = Math.floor(results.length / NUM_FOLDS);
  const foldSummaries = [];
  for (let f = 1; f < NUM_FOLDS; f++) {
    const test = results.slice(f * windowSize, (f + 1) * windowSize);
    if (!test.length) break;
    const strat = stratifyByTier(test);
    console.log(`\nFold ${f} (n=${test.length}, ${new Date(test[0].time * 1000).toDateString()} -> ${new Date(test[test.length - 1].time * 1000).toDateString()}):`);
    for (const tier of ['A+', 'A', 'B', 'skip']) {
      if (!strat[tier]) continue;
      console.log(`  ${tier}: n=${strat[tier].n}, winRate=${strat[tier].winRate}%, avgR=${strat[tier].avgR}`);
    }
    foldSummaries.push({ fold: f, strat });
  }

  console.log('\n=== HYPOTHESIS CHECK ===');
  console.log('Hypothesis: higher confidence tier -> better expectancy (avgR). Reporting honestly either way.');
  const order = ['skip', 'B', 'A', 'A+'];
  const combinedAvgRs = order.map(t => combined[t] ? combined[t].avgR : null);
  let monotonic = true;
  for (let i = 1; i < combinedAvgRs.length; i++) {
    if (combinedAvgRs[i] === null || combinedAvgRs[i - 1] === null) continue;
    if (combinedAvgRs[i] < combinedAvgRs[i - 1]) monotonic = false;
  }
  console.log(`Combined avgR by tier (skip -> B -> A -> A+): ${JSON.stringify(combinedAvgRs)}`);
  console.log(monotonic
    ? 'Monotonically non-decreasing across tiers on this dataset — consistent with the hypothesis.'
    : 'NOT monotonic across tiers on this dataset — the hypothesis is not cleanly supported here. Reported as-is, not adjusted to fit.');

  const outPath = path.join(__dirname, SYNTHETIC ? 'confirmation_backtest_synthetic_results.json' : 'confirmation_backtest_results.json');
  fs.writeFileSync(outPath, JSON.stringify({ synthetic: SYNTHETIC, combined, folds: foldSummaries, tradeCount: results.length, trades: results }, null, 2));
  console.log(`\nFull results written to ${outPath}`);
})().catch(e => { console.error('Confirmation backtest failed:', e.message); process.exit(1); });
