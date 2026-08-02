'use strict';

// Same walk-forward discipline as session_breakout_walkforward.js, applied to
// the two newly-built session-anchored candidates (liquidity_sweep_engine.js,
// session_reversion_engine.js), each tested against both Asia and London
// anchors. Nothing here is wired into server.js yet — this is pure
// validation, exactly like every other candidate strategy tested this
// session (vwap_reversion, trend_pullback, the regime-filtered breakout).

const http = require('http');
const { runLiquiditySweepBacktest } = require('./liquidity_sweep_engine');
const { runSessionReversionBacktest } = require('./session_reversion_engine');

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

function buildSweepGrid(anchor) {
  const grid = [];
  for (const sweepEpsilonPts of [1, 2, 5]) {
    for (const confirmBars of [1, 3, 5]) {
      for (const targetMultiple of [0.5, 1, 1.5, 2]) {
        for (const slBufferPct of [0.05, 0.1]) {
          for (const minRangeSize of [0, 60]) {
            for (const [dayFilterName, allowedDaysOfWeek] of Object.entries(DAY_FILTERS)) {
              grid.push({ anchor, sweepEpsilonPts, confirmBars, targetMultiple, slBufferPct, minRangeSize, allowedDaysOfWeek, dayFilterName });
            }
          }
        }
      }
    }
  }
  return grid;
}

function buildReversionGrid(anchor) {
  const grid = [];
  for (const targetFraction of [0.3, 0.5, 0.7, 1.0]) {
    for (const slBufferPct of [0.05, 0.1, 0.15]) {
      for (const minRangeSize of [0, 60]) {
        for (const [dayFilterName, allowedDaysOfWeek] of Object.entries(DAY_FILTERS)) {
          grid.push({ anchor, targetFraction, slBufferPct, minRangeSize, allowedDaysOfWeek, dayFilterName });
        }
      }
    }
  }
  return grid;
}

const MIN_TRAIN_TRADES = 12; // both candidates fire less often than plain breakout (require a sweep/touch, not just any range) — lower floor, still meaningful
const NUM_FOLDS = 6;

function walkForward(bars, label, runner, grid) {
  const windowSize = Math.floor(bars.length / NUM_FOLDS);
  const fmtDate = t => new Date(t * 1000).toDateString();
  const foldResults = [];

  const naive = runner(bars, {});
  console.log(`\n=== ${label} — NAIVE (default params) ===`);
  console.log(`traded: ${naive.tradedDays}, wins: ${naive.wins}, losses: ${naive.losses}, totalR: ${naive.totalR}, avgR: ${naive.avgR}`);
  console.log(`Grid: ${grid.length} combos.`);

  for (let f = 1; f < NUM_FOLDS; f++) {
    const train = bars.slice(0, f * windowSize);
    const test = bars.slice(f * windowSize, (f + 1) * windowSize);
    if (!test.length) break;

    const scored = grid.map(params => {
      const r = runner(train, params);
      return { params, trades: r.tradedDays, avgR: r.tradedDays ? r.totalR / r.tradedDays : -Infinity };
    }).filter(s => s.trades >= MIN_TRAIN_TRADES);
    scored.sort((a, b) => b.avgR - a.avgR);
    const best = scored[0];
    if (!best) { console.log(`  Fold ${f}: no config met the trade-count floor on train — skipping.`); continue; }

    const testR = runner(test, best.params);
    const result = {
      fold: f, testRange: `${fmtDate(test[0].time)} -> ${fmtDate(test[test.length - 1].time)}`,
      picked: best.params, trainAvgR: +best.avgR.toFixed(3),
      testTrades: testR.tradedDays, testTotalR: testR.totalR, testAvgR: testR.avgR,
    };
    foldResults.push(result);
    console.log(`  Fold ${f} [${result.testRange}] picked ${JSON.stringify(best.params)} (train avgR ${result.trainAvgR})`);
    console.log(`    OUT-OF-SAMPLE: ${result.testTrades} trades, totalR ${result.testTotalR}, avgR ${result.testAvgR}`);
  }

  const allR = foldResults.reduce((a, f) => a + f.testTotalR, 0);
  const allN = foldResults.reduce((a, f) => a + f.testTrades, 0);
  const positive = foldResults.filter(f => f.testAvgR > 0).length;
  const configs = foldResults.map(f => JSON.stringify(f.picked));
  const uniqueConfigs = new Set(configs).size;
  console.log(`  --- ${label} VERDICT: ${positive}/${foldResults.length} folds profitable OOS, combined R ${allR.toFixed(2)} over ${allN} trades (avg ${allN ? (allR / allN).toFixed(3) : 'n/a'}), ${uniqueConfigs}/${foldResults.length} distinct configs ---`);
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
  for (const anchor of ['asia', 'london']) {
    results[`sweep-${anchor}`] = walkForward(bars, `LIQUIDITY-SWEEP ${anchor.toUpperCase()}`, (b, p) => runLiquiditySweepBacktest(b, { ...p, anchor }), buildSweepGrid(anchor));
    results[`reversion-${anchor}`] = walkForward(bars, `SESSION-REVERSION ${anchor.toUpperCase()}`, (b, p) => runSessionReversionBacktest(b, { ...p, anchor }), buildReversionGrid(anchor));
  }

  console.log('\n\n=== SUMMARY: NEW SESSION CANDIDATES vs PREMARKET BASELINE ===');
  for (const [label, r] of Object.entries(results)) {
    console.log(`${label.padEnd(18)} naive avgR=${r.naive.avgR ?? 'n/a'}  |  OOS ${r.verdict.positive}/${r.verdict.total} folds, avg ${r.verdict.avgR ?? 'n/a'}R/trade (n=${r.verdict.combinedN}), ${r.verdict.uniqueConfigs}/${r.verdict.total} distinct configs`);
  }
  console.log(`premarket          (established baseline) 5/5 folds, +0.4-0.5R avg/trade`);

  const fs = require('fs');
  const path = require('path');
  fs.writeFileSync(path.join(__dirname, 'session_alt_strategies_results.json'), JSON.stringify(results, null, 2));
  console.log('\nWritten to backtest/session_alt_strategies_results.json');
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
