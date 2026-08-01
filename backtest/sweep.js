'use strict';

// Parameter sweep with train/test split — the honest version of "test it
// thousands of times." Grid-searches every meaningful threshold combination
// on the FIRST 70% of history (train), then reports how the best-looking
// train configs actually perform on the LAST 30% (test, never seen during
// tuning). In-sample numbers are always inflated by overfitting; only the
// out-of-sample number means anything for whether this has real edge.
//
// Usage: node backtest/sweep.js [resolution] [count]

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

const MIN_TRAIN_TRADES = 25; // floor so a "great" 3-trade result can't win the sweep

(async () => {
  const resolution = process.argv[2] || '60';
  const count       = process.argv[3] || '19000';

  const health = await get('/api/health');
  if (!health.authenticated) {
    console.error('Not connected to TradeLocker — log in via the app UI first, then re-run this.');
    process.exit(1);
  }

  console.log(`Pulling resolution=${resolution}m count=${count} from the live account...`);
  const data = await get(`/api/candles?resolution=${resolution}&count=${count}`);
  if (!data.bars || !data.bars.length) {
    console.error('No bars came back:', data.error || data.source);
    process.exit(1);
  }
  if (data.source !== 'tradelocker') {
    console.warn(`WARNING: source="${data.source}" — this run may include NDX-fallback data.`);
  }

  const bars = data.bars;
  const splitIdx = Math.floor(bars.length * 0.7);
  const train = bars.slice(0, splitIdx);
  const test  = bars.slice(splitIdx);
  const fmtDate = t => new Date(t * 1000).toDateString();
  console.log(`Total bars: ${bars.length}`);
  console.log(`TRAIN: ${train.length} bars, ${fmtDate(train[0].time)} -> ${fmtDate(train[train.length-1].time)}`);
  console.log(`TEST:  ${test.length} bars, ${fmtDate(test[0].time)} -> ${fmtDate(test[test.length-1].time)} (never used for tuning)`);

  const grid = buildGrid();
  console.log(`\nSweeping ${grid.length} parameter combinations on TRAIN data...`);
  const maxForwardBars = resolution === '60' ? 30 : 200;

  const results = grid.map(params => {
    const th = { directionalRatio: params.directionalRatio, sweepEpsilonPts: params.sweepEpsilonPts,
                 slBufferPct: params.slBufferPct, oteLo: params.oteLo, oteHi: params.oteHi,
                 allowedDaysOfWeek: params.allowedDaysOfWeek };
    const r = runBacktest(train, { thresholds: th, maxForwardBars });
    return { params, trainTrades: r.tradedDays, trainTotalR: r.totalR, trainAvgR: r.tradedDays ? +(r.totalR / r.tradedDays).toFixed(3) : -Infinity };
  });

  const eligible = results.filter(r => r.trainTrades >= MIN_TRAIN_TRADES);
  console.log(`${eligible.length} of ${results.length} combinations had >= ${MIN_TRAIN_TRADES} trades on train data.`);

  eligible.sort((a, b) => b.trainAvgR - a.trainAvgR);
  const top = eligible.slice(0, 10);

  console.log('\n=== TOP 10 BY TRAIN AVG-R (in-sample — expect this to be optimistic) ===');
  const finalRows = top.map(({ params }) => {
    const th = { directionalRatio: params.directionalRatio, sweepEpsilonPts: params.sweepEpsilonPts,
                 slBufferPct: params.slBufferPct, oteLo: params.oteLo, oteHi: params.oteHi,
                 allowedDaysOfWeek: params.allowedDaysOfWeek };
    const trainR = runBacktest(train, { thresholds: th, maxForwardBars });
    const testR  = runBacktest(test,  { thresholds: th, maxForwardBars });
    return {
      params: { dirRatio: params.directionalRatio, sweepPts: params.sweepEpsilonPts, slBuf: params.slBufferPct, ote: `${params.oteLo}-${params.oteHi}`, days: params.dayFilterName },
      train: { trades: trainR.tradedDays, totalR: trainR.totalR, avgR: trainR.tradedDays ? +(trainR.totalR / trainR.tradedDays).toFixed(2) : null },
      test:  { trades: testR.tradedDays,  totalR: testR.totalR,  avgR: testR.tradedDays  ? +(testR.totalR / testR.tradedDays).toFixed(2)  : null },
    };
  });

  for (const row of finalRows) {
    console.log(JSON.stringify(row.params), '  TRAIN:', row.train, '  TEST:', row.test);
  }

  const survived = finalRows.filter(r => r.test.trades >= 10 && r.test.avgR > 0);
  console.log(`\n=== HONEST VERDICT ===`);
  console.log(`${survived.length} of the top 10 train configs were ALSO profitable on held-out test data.`);
  if (!survived.length) {
    console.log('None of the best in-sample configurations held up out-of-sample. That is a real, important');
    console.log('result: this exact rule framework does not show a robust edge on this instrument/timeframe');
    console.log('within the tested parameter space. The honest move is NOT to pick the best in-sample number');
    console.log('and call it done — that number is overfit noise, not edge.');
  } else {
    console.log('Best surviving config:', JSON.stringify(survived[0], null, 2));
    console.log('Still only one out-of-sample slice — treat this as a promising lead, not proof, before');
    console.log('risking real capital on it.');
  }

  const fs = require('fs');
  const path = require('path');
  fs.writeFileSync(path.join(__dirname, 'sweep_results.json'), JSON.stringify({ finalRows, gridSize: grid.length, eligibleCount: eligible.length }, null, 2));
  console.log(`\nFull results written to backtest/sweep_results.json`);
})().catch(e => {
  console.error('Sweep failed:', e.message);
  process.exit(1);
});
