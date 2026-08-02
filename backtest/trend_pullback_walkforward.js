'use strict';

// Same walk-forward discipline as orb_walkforward.js/vwap_reversion_walkforward.js.

const http = require('http');
const { runTrendPullbackBacktest } = require('./trend_pullback_engine');

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
  tueThuOnly: [2, 3, 4],
};

function buildGrid() {
  const grid = [];
  for (const minTrendEfficiency of [0.35, 0.4, 0.5, 0.6]) {
    for (const pullbackAtrMultiple of [0.5, 1.0, 1.5]) {
      for (const targetRMultiple of [1, 1.5, 2, 3]) {
        for (const slBufferPct of [0.05, 0.1, 0.2]) {
          for (const [dayFilterName, allowedDaysOfWeek] of Object.entries(DAY_FILTERS)) {
            grid.push({ minTrendEfficiency, pullbackAtrMultiple, targetRMultiple, slBufferPct, allowedDaysOfWeek, dayFilterName });
          }
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
  console.log(`${bars.length} hourly bars, ${((bars[bars.length - 1].time - bars[0].time) / 86400).toFixed(0)} days.`);

  const naive = runTrendPullbackBacktest(bars, {});
  console.log('\n=== NAIVE (default params, no tuning) ===');
  console.log(`traded: ${naive.tradedDays}, wins: ${naive.wins}, losses: ${naive.losses}, totalR: ${naive.totalR}, avgR: ${naive.avgR}`);

  const grid = buildGrid();
  console.log(`\nGrid: ${grid.length} combos.\n`);

  const NUM_FOLDS = 6;
  const windowSize = Math.floor(bars.length / NUM_FOLDS);
  const fmtDate = t => new Date(t * 1000).toDateString();
  const foldResults = [];

  for (let f = 1; f < NUM_FOLDS; f++) {
    const train = bars.slice(0, f * windowSize);
    const test = bars.slice(f * windowSize, (f + 1) * windowSize);
    if (!test.length) break;

    const scored = grid.map(params => {
      const r = runTrendPullbackBacktest(train, params);
      return { params, trades: r.tradedDays, avgR: r.tradedDays ? r.totalR / r.tradedDays : -Infinity };
    }).filter(s => s.trades >= MIN_TRAIN_TRADES);
    scored.sort((a, b) => b.avgR - a.avgR);
    const best = scored[0];
    if (!best) { console.log(`Fold ${f}: no config met the trade-count floor on train — skipping.`); continue; }

    const testR = runTrendPullbackBacktest(test, best.params);
    const result = {
      fold: f, testRange: `${fmtDate(test[0].time)} -> ${fmtDate(test[test.length - 1].time)}`,
      picked: best.params, trainAvgR: +best.avgR.toFixed(3),
      testTrades: testR.tradedDays, testTotalR: testR.totalR, testAvgR: testR.avgR,
    };
    foldResults.push(result);
    console.log(`Fold ${f} [${result.testRange}] picked ${JSON.stringify({ minER: best.params.minTrendEfficiency, pb: best.params.pullbackAtrMultiple, tgt: best.params.targetRMultiple, slBuf: best.params.slBufferPct, days: best.params.dayFilterName })} (train avgR ${result.trainAvgR})`);
    console.log(`  OUT-OF-SAMPLE: ${result.testTrades} trades, totalR ${result.testTotalR}, avgR ${result.testAvgR}`);
  }

  const allR = foldResults.reduce((a, f) => a + f.testTotalR, 0);
  const allN = foldResults.reduce((a, f) => a + f.testTrades, 0);
  const positive = foldResults.filter(f => f.testAvgR > 0).length;
  console.log(`\n=== TREND PULLBACK WALK-FORWARD VERDICT ===`);
  console.log(`Folds profitable out-of-sample: ${positive}/${foldResults.length}`);
  console.log(`Combined OOS trades: ${allN}, combined R: ${allR.toFixed(2)}, avg: ${allN ? (allR / allN).toFixed(3) : 'n/a'}`);
  const configs = foldResults.map(f => JSON.stringify(f.picked));
  const uniqueConfigs = new Set(configs).size;
  console.log(`Distinct configs picked across folds: ${uniqueConfigs} of ${foldResults.length}`);

  const fs = require('fs');
  const path = require('path');
  fs.writeFileSync(path.join(__dirname, 'trend_pullback_results.json'), JSON.stringify({ naive, foldResults }, null, 2));
  console.log('\nWritten to backtest/trend_pullback_results.json');
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
