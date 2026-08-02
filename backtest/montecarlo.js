'use strict';

// ─── Monte Carlo drawdown/risk analysis ────────────────────────────────────
// Bootstrap-resamples the R-multiple trade sequence (with replacement, same
// length as the original) many times to build a distribution of terminal
// equity and max drawdown — the honest way to answer "how bad could this
// realistically get," since any single historical sequence is only one
// draw from the underlying process.
//
// Compares two populations from the SAME underlying trade set:
//   - baseline:  every ICT/ORB trade that would have entered, regardless of
//                confirmation-engine tier (i.e. today's behavior — no
//                selectivity filter)
//   - selective: only trades tier B or better (i.e. behavior WITH the new
//                confirmation engine gating out weaker setups)
// This directly tests the directive's central capital-preservation claim —
// "missing average trades is acceptable, taking unnecessary trades is not" —
// by comparing drawdown distributions, not just average R.
//
// Usage: node backtest/montecarlo.js [--synthetic] [--iterations=5000] [--riskPct=0.01]

const fs = require('fs');
const path = require('path');
const { runConfirmationBacktest, loadBars } = require('./confirmation_backtest');

const SYNTHETIC = process.argv.includes('--synthetic');
const ITER = +(process.argv.find(a => a.startsWith('--iterations=')) || '').split('=')[1] || 5000;
const RISK_PCT = +(process.argv.find(a => a.startsWith('--riskPct=')) || '').split('=')[1] || 0.01;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function equityPath(rMultiples, riskPct) {
  let equity = 1, peak = 1, maxDD = 0;
  for (const r of rMultiples) {
    equity *= (1 + r * riskPct);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return { finalEquity: equity, maxDrawdownPct: maxDD };
}

function bootstrap(rMultiples, iterations, riskPct, seed) {
  const rand = mulberry32(seed);
  const n = rMultiples.length;
  const finals = [], drawdowns = [];
  for (let it = 0; it < iterations; it++) {
    const sample = new Array(n);
    for (let i = 0; i < n; i++) sample[i] = rMultiples[Math.floor(rand() * n)];
    const { finalEquity, maxDrawdownPct } = equityPath(sample, riskPct);
    finals.push(finalEquity);
    drawdowns.push(maxDrawdownPct);
  }
  finals.sort((a, b) => a - b);
  drawdowns.sort((a, b) => a - b);
  const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
  return {
    n, iterations,
    finalEquity: { p5: pct(finals, 0.05), p25: pct(finals, 0.25), p50: pct(finals, 0.5), p75: pct(finals, 0.75), p95: pct(finals, 0.95) },
    maxDrawdown: { p50: pct(drawdowns, 0.5), p75: pct(drawdowns, 0.75), p90: pct(drawdowns, 0.9), p95: pct(drawdowns, 0.95), p99: pct(drawdowns, 0.99) },
    probNetLoss: +(finals.filter(f => f < 1).length / iterations).toFixed(3),
    probDrawdownOver20pct: +(drawdowns.filter(d => d > 0.20).length / iterations).toFixed(3),
    probDrawdownOver35pct: +(drawdowns.filter(d => d > 0.35).length / iterations).toFixed(3),
  };
}

function fmtPct(x) { return (x * 100).toFixed(1) + '%'; }

(async () => {
  if (SYNTHETIC) {
    console.log('*** --synthetic mode: seeded synthetic fixture, NOT real market data — see confirmation_backtest.js for why. ***');
    console.log('*** This validates the Monte Carlo MACHINERY, not real risk-of-ruin for this strategy.                       ***\n');
  }
  const bars = await loadBars(SYNTHETIC);
  const trades = runConfirmationBacktest(bars);
  console.log(`${trades.length} total trades in the underlying set.\n`);

  const baselineR = trades.map(t => t.r);
  const selectiveR = trades.filter(t => t.tier === 'B' || t.tier === 'A' || t.tier === 'A+').map(t => t.r);

  console.log(`Assumptions: ${RISK_PCT * 100}% of account risked per trade, ${ITER} bootstrap resamples, compounding equity.\n`);

  console.log(`=== BASELINE (all ${baselineR.length} trades, no confirmation-engine filter — today's behavior) ===`);
  const baseline = bootstrap(baselineR, ITER, RISK_PCT, 1);
  console.log(`  Terminal equity: p5=${fmtPct(baseline.finalEquity.p5 - 1)} p25=${fmtPct(baseline.finalEquity.p25 - 1)} p50=${fmtPct(baseline.finalEquity.p50 - 1)} p75=${fmtPct(baseline.finalEquity.p75 - 1)} p95=${fmtPct(baseline.finalEquity.p95 - 1)}`);
  console.log(`  Max drawdown:    p50=${fmtPct(baseline.maxDrawdown.p50)} p75=${fmtPct(baseline.maxDrawdown.p75)} p90=${fmtPct(baseline.maxDrawdown.p90)} p95=${fmtPct(baseline.maxDrawdown.p95)}`);
  console.log(`  P(net loss)=${fmtPct(baseline.probNetLoss)}  P(drawdown>20%)=${fmtPct(baseline.probDrawdownOver20pct)}  P(drawdown>35%)=${fmtPct(baseline.probDrawdownOver35pct)}`);

  console.log(`\n=== SELECTIVE (tier B+ only, ${selectiveR.length} trades — confirmation-engine gated) ===`);
  if (selectiveR.length < 10) {
    console.log('  Too few tier-B+ trades in this dataset for a meaningful bootstrap — reporting raw count only, not fabricating a distribution.');
  } else {
    const selective = bootstrap(selectiveR, ITER, RISK_PCT, 2);
    console.log(`  Terminal equity: p5=${fmtPct(selective.finalEquity.p5 - 1)} p25=${fmtPct(selective.finalEquity.p25 - 1)} p50=${fmtPct(selective.finalEquity.p50 - 1)} p75=${fmtPct(selective.finalEquity.p75 - 1)} p95=${fmtPct(selective.finalEquity.p95 - 1)}`);
    console.log(`  Max drawdown:    p50=${fmtPct(selective.maxDrawdown.p50)} p75=${fmtPct(selective.maxDrawdown.p75)} p90=${fmtPct(selective.maxDrawdown.p90)} p95=${fmtPct(selective.maxDrawdown.p95)}`);
    console.log(`  P(net loss)=${fmtPct(selective.probNetLoss)}  P(drawdown>20%)=${fmtPct(selective.probDrawdownOver20pct)}  P(drawdown>35%)=${fmtPct(selective.probDrawdownOver35pct)}`);

    console.log('\n=== COMPARISON (reported as-is, not adjusted to favor either side) ===');
    console.log(`  Median drawdown: baseline ${fmtPct(baseline.maxDrawdown.p50)} vs selective ${fmtPct(selective.maxDrawdown.p50)}`);
    console.log(`  P(drawdown>20%): baseline ${fmtPct(baseline.probDrawdownOver20pct)} vs selective ${fmtPct(selective.probDrawdownOver20pct)}`);
    console.log(`  P(net loss):     baseline ${fmtPct(baseline.probNetLoss)} vs selective ${fmtPct(selective.probNetLoss)}`);

    const outPath = path.join(__dirname, SYNTHETIC ? 'montecarlo_synthetic_results.json' : 'montecarlo_results.json');
    fs.writeFileSync(outPath, JSON.stringify({ synthetic: SYNTHETIC, riskPct: RISK_PCT, iterations: ITER, baseline, selective }, null, 2));
    console.log(`\nFull results written to ${outPath}`);
  }
})().catch(e => { console.error('Monte Carlo run failed:', e.message); process.exit(1); });
