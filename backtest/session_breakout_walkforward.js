'use strict';

// Same walk-forward discipline as orb_walkforward.js, run separately per
// session anchor (Asia / London / NY premarket) so each gets its own honest
// verdict rather than being averaged together.

const http = require('http');
const { runSessionBreakoutBacktest } = require('./session_breakout_engine');

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

function buildGrid(anchor) {
  const grid = [];
  for (const targetMultiple of [0.5, 1, 1.5, 2, 3]) {
    for (const slBufferPct of [0.02, 0.05, 0.1]) {
      for (const minRangeSize of [0, 30, 60, 100]) {
        for (const [dayFilterName, allowedDaysOfWeek] of Object.entries(DAY_FILTERS)) {
          grid.push({ anchor, targetMultiple, slBufferPct, minRangeSize, allowedDaysOfWeek, dayFilterName });
        }
      }
    }
  }
  return grid;
}

const MIN_TRAIN_TRADES = 25;
const NUM_FOLDS = 6;

function walkForwardForAnchor(bars, anchor) {
  const grid = buildGrid(anchor);
  const windowSize = Math.floor(bars.length / NUM_FOLDS);
  const fmtDate = t => new Date(t * 1000).toDateString();
  const foldResults = [];

  const naive = runSessionBreakoutBacktest(bars, { anchor });
  console.log(`\n=== ${anchor.toUpperCase()} — NAIVE (default params) ===`);
  console.log(`traded: ${naive.tradedDays}, wins: ${naive.wins}, losses: ${naive.losses}, totalR: ${naive.totalR}, avgR: ${naive.avgR}`);
  console.log(`Grid: ${grid.length} combos.`);

  for (let f = 1; f < NUM_FOLDS; f++) {
    const train = bars.slice(0, f * windowSize);
    const test = bars.slice(f * windowSize, (f + 1) * windowSize);
    if (!test.length) break;

    const scored = grid.map(params => {
      const r = runSessionBreakoutBacktest(train, params);
      return { params, trades: r.tradedDays, avgR: r.tradedDays ? r.totalR / r.tradedDays : -Infinity };
    }).filter(s => s.trades >= MIN_TRAIN_TRADES);
    scored.sort((a, b) => b.avgR - a.avgR);
    const best = scored[0];
    if (!best) { console.log(`  Fold ${f}: no config met the trade-count floor on train — skipping.`); continue; }

    const testR = runSessionBreakoutBacktest(test, best.params);
    const result = {
      fold: f, testRange: `${fmtDate(test[0].time)} -> ${fmtDate(test[test.length - 1].time)}`,
      picked: best.params, trainAvgR: +best.avgR.toFixed(3),
      testTrades: testR.tradedDays, testTotalR: testR.totalR, testAvgR: testR.avgR,
    };
    foldResults.push(result);
    console.log(`  Fold ${f} [${result.testRange}] picked {tgt:${best.params.targetMultiple}, slBuf:${best.params.slBufferPct}, minRange:${best.params.minRangeSize}, days:${best.params.dayFilterName}} (train avgR ${result.trainAvgR})`);
    console.log(`    OUT-OF-SAMPLE: ${result.testTrades} trades, totalR ${result.testTotalR}, avgR ${result.testAvgR}`);
  }

  const allR = foldResults.reduce((a, f) => a + f.testTotalR, 0);
  const allN = foldResults.reduce((a, f) => a + f.testTrades, 0);
  const positive = foldResults.filter(f => f.testAvgR > 0).length;
  const configs = foldResults.map(f => JSON.stringify(f.picked));
  const uniqueConfigs = new Set(configs).size;
  console.log(`  --- ${anchor.toUpperCase()} VERDICT: ${positive}/${foldResults.length} folds profitable OOS, combined R ${allR.toFixed(2)} over ${allN} trades (avg ${allN ? (allR / allN).toFixed(3) : 'n/a'}), ${uniqueConfigs}/${foldResults.length} distinct configs picked ---`);
  return { naive, foldResults, verdict: { positive, total: foldResults.length, combinedR: +allR.toFixed(2), combinedN: allN, avgR: allN ? +(allR / allN).toFixed(3) : null, uniqueConfigs } };
}

(async () => {
  const health = await get('/api/health');
  if (!health.authenticated) { console.error('Not connected.'); process.exit(1); }
  const data = await get('/api/candles?resolution=60&count=19000');
  if (!data.bars || !data.bars.length) { console.error('No bars.'); process.exit(1); }
  const bars = data.bars;
  console.log(`${bars.length} hourly bars, ${((bars[bars.length - 1].time - bars[0].time) / 86400).toFixed(0)} days.`);

  const results = {};
  for (const anchor of ['asia', 'london', 'premarket']) {
    results[anchor] = walkForwardForAnchor(bars, anchor);
  }

  console.log('\n\n=== SUMMARY ACROSS ALL SESSION ANCHORS ===');
  for (const [anchor, r] of Object.entries(results)) {
    console.log(`${anchor.padEnd(10)} naive avgR=${r.naive.avgR ?? 'n/a'}  |  OOS ${r.verdict.positive}/${r.verdict.total} folds, avg ${r.verdict.avgR ?? 'n/a'}R/trade, ${r.verdict.uniqueConfigs}/${r.verdict.total} distinct configs`);
  }

  const fs = require('fs');
  const path = require('path');
  fs.writeFileSync(path.join(__dirname, 'session_breakout_results.json'), JSON.stringify(results, null, 2));
  console.log('\nWritten to backtest/session_breakout_results.json');
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
