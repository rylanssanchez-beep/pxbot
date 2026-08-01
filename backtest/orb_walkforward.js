'use strict';

// Same walk-forward discipline as the ICT tests: expanding train window,
// grid-search on train only, score the picked config on unseen test data.

const http = require('http');
const { runOrbBacktest } = require('./orb_engine');

function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: 8899, path: p }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function buildGrid() {
  const grid = [];
  for (const rangeHour of [7, 8, 9]) {
    for (const targetMultiple of [0.5, 1, 1.5, 2, 3]) {
      for (const slBufferPct of [0.02, 0.05, 0.1]) {
        for (const minRangeSize of [0, 30, 60, 100]) {
          grid.push({ rangeHour, targetMultiple, slBufferPct, minRangeSize, maxHoldHours: 8 });
        }
      }
    }
  }
  return grid;
}

const MIN_TRAIN_TRADES = 25;

(async () => {
  const health = await get('/api/health');
  if (!health.authenticated) { console.error('Not connected.'); process.exit(1); }
  const data = await get('/api/candles?resolution=60&count=19000');
  if (!data.bars || !data.bars.length) { console.error('No bars.'); process.exit(1); }
  const bars = data.bars;
  console.log(`${bars.length} hourly bars, ${((bars[bars.length-1].time - bars[0].time)/86400).toFixed(0)} days.`);

  const grid = buildGrid();
  console.log(`Grid: ${grid.length} combos.\n`);

  // --- Single pass on the FULL history first, no tuning, sanity check ---
  const naive = runOrbBacktest(bars, {});
  console.log('=== NAIVE (default params, no tuning) ===');
  console.log(`days classified: ${naive.totalDays}, traded: ${naive.tradedDays}, wins: ${naive.wins}, losses: ${naive.losses}, totalR: ${naive.totalR}, avgR: ${naive.avgR}\n`);

  // --- Walk-forward: 6 expanding folds ---
  const NUM_FOLDS = 6;
  const windowSize = Math.floor(bars.length / NUM_FOLDS);
  const fmtDate = t => new Date(t * 1000).toDateString();
  const foldResults = [];

  for (let f = 1; f < NUM_FOLDS; f++) {
    const train = bars.slice(0, f * windowSize);
    const test  = bars.slice(f * windowSize, (f + 1) * windowSize);
    if (!test.length) break;

    const scored = grid.map(params => {
      const r = runOrbBacktest(train, params);
      return { params, trades: r.tradedDays, avgR: r.tradedDays ? r.totalR / r.tradedDays : -Infinity };
    }).filter(s => s.trades >= MIN_TRAIN_TRADES);
    scored.sort((a, b) => b.avgR - a.avgR);
    const best = scored[0];
    if (!best) { console.log(`Fold ${f}: no config met trade floor.`); continue; }

    const testR = runOrbBacktest(test, best.params);
    const result = {
      fold: f, testRange: `${fmtDate(test[0].time)} -> ${fmtDate(test[test.length-1].time)}`,
      picked: best.params, trainAvgR: +best.avgR.toFixed(3),
      testTrades: testR.tradedDays, testTotalR: testR.totalR, testAvgR: testR.avgR,
    };
    foldResults.push(result);
    console.log(`Fold ${f} [${result.testRange}] picked ${JSON.stringify(best.params)} (train avgR ${result.trainAvgR})`);
    console.log(`  OUT-OF-SAMPLE: ${result.testTrades} trades, totalR ${result.testTotalR}, avgR ${result.testAvgR}`);
  }

  const allR = foldResults.reduce((a, f) => a + f.testTotalR, 0);
  const allN = foldResults.reduce((a, f) => a + f.testTrades, 0);
  const positive = foldResults.filter(f => f.testAvgR > 0).length;
  console.log(`\n=== ORB WALK-FORWARD VERDICT ===`);
  console.log(`Folds profitable out-of-sample: ${positive}/${foldResults.length}`);
  console.log(`Combined OOS trades: ${allN}, combined R: ${allR.toFixed(2)}, avg: ${allN ? (allR/allN).toFixed(3) : 'n/a'}`);

  const fs = require('fs');
  const path = require('path');
  fs.writeFileSync(path.join(__dirname, 'orb_results.json'), JSON.stringify({ naive, foldResults }, null, 2));
  console.log('\nWritten to backtest/orb_results.json');
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
