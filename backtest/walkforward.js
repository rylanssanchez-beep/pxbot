'use strict';

// Walk-forward validation — the rigorous version of "test it endlessly."
// Splits history into sequential folds with an EXPANDING training window:
//   fold 1: train on window 1,        test on window 2
//   fold 2: train on windows 1-2,     test on window 3
//   fold 3: train on windows 1-3,     test on window 4
//   ...
// Each fold re-runs the full parameter grid on train-so-far, picks the best
// config, and scores it on test data it has never seen. This is the honest
// way to answer "does this ever really work" — one lucky split can't hide in
// six independent ones. If the picked "best" config keeps changing every
// fold with no consistency, that itself is evidence of noise, not edge.

const http = require('http');
const { runBacktest } = require('./ict_engine');

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

(async () => {
  const resolution = process.argv[2] || '60';
  const count       = process.argv[3] || '19000';
  const NUM_FOLDS   = 6;
  const MIN_TRAIN_TRADES = 10;

  const health = await get('/api/health');
  if (!health.authenticated) {
    console.error('Not connected to TradeLocker — log in via the app UI first, then re-run this.');
    process.exit(1);
  }

  console.log(`Pulling resolution=${resolution}m count=${count}...`);
  const data = await get(`/api/candles?resolution=${resolution}&count=${count}`);
  if (!data.bars || !data.bars.length) { console.error('No bars:', data.error); process.exit(1); }
  const bars = data.bars;
  const maxForwardBars = resolution === '60' ? 30 : 200;
  const grid = buildGrid();
  const fmtDate = t => new Date(t * 1000).toDateString();

  const windowSize = Math.floor(bars.length / NUM_FOLDS);
  console.log(`${bars.length} bars total, ${NUM_FOLDS} windows of ~${windowSize} bars each, grid=${grid.length} combos/fold.\n`);

  const foldResults = [];
  for (let f = 1; f < NUM_FOLDS; f++) {
    const train = bars.slice(0, f * windowSize);
    const test  = bars.slice(f * windowSize, (f + 1) * windowSize);
    if (!test.length) break;

    const scored = grid.map(params => {
      const r = runBacktest(train, { thresholds: toThresholds(params), maxForwardBars });
      return { params, trades: r.tradedDays, avgR: r.tradedDays ? r.totalR / r.tradedDays : -Infinity };
    }).filter(s => s.trades >= MIN_TRAIN_TRADES);

    scored.sort((a, b) => b.avgR - a.avgR);
    const best = scored[0];
    if (!best) { console.log(`Fold ${f}: no config met the trade-count floor on train — skipping.`); continue; }

    const testR = runBacktest(test, { thresholds: toThresholds(best.params), maxForwardBars });
    const result = {
      fold: f,
      trainRange: `${fmtDate(train[0].time)} -> ${fmtDate(train[train.length - 1].time)}`,
      testRange:  `${fmtDate(test[0].time)} -> ${fmtDate(test[test.length - 1].time)}`,
      pickedConfig: { dirRatio: best.params.directionalRatio, sweepPts: best.params.sweepEpsilonPts, slBuf: best.params.slBufferPct, ote: `${best.params.oteLo}-${best.params.oteHi}`, days: best.params.dayFilterName },
      trainAvgR: +best.avgR.toFixed(3),
      testTrades: testR.tradedDays,
      testTotalR: testR.totalR,
      testAvgR: testR.tradedDays ? +(testR.totalR / testR.tradedDays).toFixed(3) : null,
    };
    foldResults.push(result);
    console.log(`Fold ${f} [test: ${result.testRange}]`);
    console.log(`  picked on train (avgR ${result.trainAvgR}): ${JSON.stringify(result.pickedConfig)}`);
    console.log(`  OUT-OF-SAMPLE: ${result.testTrades} trades, totalR ${result.testTotalR}, avgR ${result.testAvgR}`);
  }

  const allTestR   = foldResults.reduce((a, f) => a + f.testTotalR, 0);
  const allTestN    = foldResults.reduce((a, f) => a + f.testTrades, 0);
  const positiveFolds = foldResults.filter(f => f.testAvgR > 0).length;

  console.log('\n=== WALK-FORWARD VERDICT (across all folds, all genuinely out-of-sample) ===');
  console.log(`Folds run: ${foldResults.length}. Folds where the picked config was profitable out-of-sample: ${positiveFolds}/${foldResults.length}`);
  console.log(`Combined out-of-sample trades: ${allTestN}, combined R: ${allTestR.toFixed(2)}, avg R/trade: ${allTestN ? (allTestR / allTestN).toFixed(3) : 'n/a'}`);
  const configs = foldResults.map(f => JSON.stringify(f.pickedConfig));
  const uniqueConfigs = new Set(configs).size;
  console.log(`Distinct configs picked across folds: ${uniqueConfigs} of ${foldResults.length} — ${uniqueConfigs === foldResults.length ? 'a different "best" every time is a strong sign of noise, not a stable edge.' : 'some repeat configs — mild consistency signal.'}`);

  const fs = require('fs');
  const path = require('path');
  fs.writeFileSync(path.join(__dirname, 'walkforward_results.json'), JSON.stringify(foldResults, null, 2));
  console.log(`\nFull fold-by-fold results written to backtest/walkforward_results.json`);
})().catch(e => { console.error('Walk-forward failed:', e.message); process.exit(1); });
