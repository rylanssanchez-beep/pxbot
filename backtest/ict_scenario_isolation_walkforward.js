'use strict';

// Same walk-forward discipline as walkforward.js, but testing scenario 2
// (London sweep-then-continuation) and scenario 3 (Asia ranged, London
// directional without sweep -> NY reversal) ISOLATED from scenario 1 (pure
// Asia-directional) — real production-config numbers showed them behaving
// very differently (S2: 85.7% win rate, +0.09R avg, n=7; S1: 50% win rate,
// -0.23R avg, n=16) and combining them into one "ICT" signal diluted the
// good one with the bad one. ict_engine.js's runBacktest is unmodified
// except for the new optional allowedScenarios filter (defaults to [1,2,3],
// so nothing existing changed) — this script is the first caller to use it.

const http = require('http');
const { runBacktest, DEFAULT_THRESHOLDS } = require('./ict_engine');

function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: 8899, path: p }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const DAY_FILTERS = {
  allDays:    [0, 1, 2, 3, 4, 5, 6],
  skipMonday: [0, 2, 3, 4, 5, 6],
  skipFriday: [0, 1, 2, 3, 4, 6],
  tueThuOnly: [2, 3, 4],
};
const OTE_BANDS = [[0.5, 0.618], [0.618, 0.705], [0.705, 0.79]];

function buildGrid() {
  const grid = [];
  for (const directionalRatio of [0.45, 0.5, 0.55, 0.6, 0.65, 0.7]) {
    for (const sweepEpsilonPts of [0.5, 1, 2, 5, 10]) {
      for (const slBufferPct of [0.02, 0.05, 0.1, 0.15]) {
        for (const [oteLo, oteHi] of OTE_BANDS) {
          for (const [dayFilterName, allowedDaysOfWeek] of Object.entries(DAY_FILTERS)) {
            grid.push({ directionalRatio, sweepEpsilonPts, slBufferPct, oteLo, oteHi, allowedDaysOfWeek, dayFilterName });
          }
        }
      }
    }
  }
  return grid;
}

function toThresholds(p) {
  return { directionalRatio: p.directionalRatio, sweepEpsilonPts: p.sweepEpsilonPts, slBufferPct: p.slBufferPct,
           oteLo: p.oteLo, oteHi: p.oteHi, allowedDaysOfWeek: p.allowedDaysOfWeek };
}

const MIN_TRAIN_TRADES = 8; // lower than walkforward.js's implicit floor — isolating one scenario means far fewer trades, but still needs enough to mean something
const NUM_FOLDS = 6;

function walkForwardForScenarios(bars, allowedScenarios, label) {
  const grid = buildGrid();
  const maxForwardBars = 30;
  const windowSize = Math.floor(bars.length / NUM_FOLDS);
  const fmtDate = t => new Date(t * 1000).toDateString();

  const naive = runBacktest(bars, { thresholds: { ...DEFAULT_THRESHOLDS, minLegSize: 199 }, allowedScenarios, maxForwardBars });
  console.log(`\n=== ${label} — NAIVE (production minLeg=199, no other tuning) ===`);
  console.log(`traded: ${naive.tradedDays}, wins: ${naive.wins}, losses: ${naive.losses}, timeouts: ${naive.timeouts}, totalR: ${naive.totalR}, avgR: ${naive.tradedDays ? (naive.totalR/naive.tradedDays).toFixed(3) : 'n/a'}`);

  const foldResults = [];
  for (let f = 1; f < NUM_FOLDS; f++) {
    const train = bars.slice(0, f * windowSize);
    const test = bars.slice(f * windowSize, (f + 1) * windowSize);
    if (!test.length) break;

    const scored = grid.map(params => {
      const r = runBacktest(train, { thresholds: toThresholds(params), allowedScenarios, maxForwardBars });
      return { params, trades: r.tradedDays, avgR: r.tradedDays ? r.totalR / r.tradedDays : -Infinity };
    }).filter(s => s.trades >= MIN_TRAIN_TRADES);
    scored.sort((a, b) => b.avgR - a.avgR);
    const best = scored[0];
    if (!best) { console.log(`  Fold ${f}: no config met the trade-count floor on train — skipping.`); continue; }

    const testR = runBacktest(test, { thresholds: toThresholds(best.params), allowedScenarios, maxForwardBars });
    const result = {
      fold: f, testRange: `${fmtDate(test[0].time)} -> ${fmtDate(test[test.length - 1].time)}`,
      picked: { dirRatio: best.params.directionalRatio, sweepPts: best.params.sweepEpsilonPts, slBuf: best.params.slBufferPct, ote: `${best.params.oteLo}-${best.params.oteHi}`, days: best.params.dayFilterName },
      trainAvgR: +best.avgR.toFixed(3),
      testTrades: testR.tradedDays, testTotalR: testR.totalR, testAvgR: testR.tradedDays ? +(testR.totalR / testR.tradedDays).toFixed(3) : null,
    };
    foldResults.push(result);
    console.log(`  Fold ${f} [${result.testRange}] picked ${JSON.stringify(result.picked)} (train avgR ${result.trainAvgR})`);
    console.log(`    OUT-OF-SAMPLE: ${result.testTrades} trades, totalR ${result.testTotalR}, avgR ${result.testAvgR}`);
  }

  const allR = foldResults.reduce((a, f) => a + f.testTotalR, 0);
  const allN = foldResults.reduce((a, f) => a + f.testTrades, 0);
  const positive = foldResults.filter(f => f.testAvgR > 0).length;
  const configs = foldResults.map(f => JSON.stringify(f.picked));
  const uniqueConfigs = new Set(configs).size;
  console.log(`  --- ${label} VERDICT: ${positive}/${foldResults.length} folds profitable OOS, combined R ${allR.toFixed(2)} over ${allN} trades (avg ${allN ? (allR/allN).toFixed(3) : 'n/a'}), ${uniqueConfigs}/${foldResults.length} distinct configs ---`);
  return { naive, foldResults, verdict: { positive, total: foldResults.length, combinedR: +allR.toFixed(2), combinedN: allN, avgR: allN ? +(allR/allN).toFixed(3) : null, uniqueConfigs } };
}

(async () => {
  const health = await get('/api/health');
  if (!health.authenticated) { console.error('Not connected.'); process.exit(1); }
  const data = await get('/api/candles?resolution=60&count=19000');
  if (!data.bars || !data.bars.length) { console.error('No bars.'); process.exit(1); }
  const bars = data.bars;
  console.log(`${bars.length} hourly bars, ${((bars[bars.length - 1].time - bars[0].time) / 86400).toFixed(0)} days.`);

  const results = {};
  results['S2 only (London sweep-continuation)'] = walkForwardForScenarios(bars, [2], 'S2-ONLY');
  results['S3 only (NY reversal)'] = walkForwardForScenarios(bars, [3], 'S3-ONLY');
  results['S2+S3 (sweep-driven, exclude S1)'] = walkForwardForScenarios(bars, [2, 3], 'S2+S3');
  results['S1 only (pure Asia-directional, for comparison)'] = walkForwardForScenarios(bars, [1], 'S1-ONLY');

  console.log('\n\n=== SUMMARY ===');
  for (const [label, r] of Object.entries(results)) {
    console.log(`${label}: naive avgR=${r.naive.tradedDays ? (r.naive.totalR/r.naive.tradedDays).toFixed(3) : 'n/a'} (n=${r.naive.tradedDays}) | OOS ${r.verdict.positive}/${r.verdict.total} folds, avg ${r.verdict.avgR ?? 'n/a'}R/trade (n=${r.verdict.combinedN}), ${r.verdict.uniqueConfigs}/${r.verdict.total} distinct configs`);
  }

  const fs = require('fs');
  const path = require('path');
  fs.writeFileSync(path.join(__dirname, 'ict_scenario_isolation_results.json'), JSON.stringify(results, null, 2));
  console.log('\nWritten to backtest/ict_scenario_isolation_results.json');
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
