'use strict';

// ─── Stress test: edge sensitivity to slippage and stop-buffer assumptions ─
// Re-runs ict_engine.js/orb_engine.js UNMODIFIED (no changes to those files,
// no changes to their entry/exit logic) across a grid of adverse execution
// assumptions — added slippage in points, and wider stop buffers — to show
// how much the backtested edge degrades under less-friendly-than-ideal fills.
// An edge that only survives with zero slippage and a razor-thin stop buffer
// isn't a real edge; this is the check for that.
//
// Slippage degradation is computed from each engine's own public outputs
// (levels/entry geometry) rather than by modifying the engines — risk in
// points is derived the same way server.js/app.js already do for display
// (entryMid = midpoint of the OTE zone for ICT; entry/sl geometry for ORB),
// then `slippagePts / risk` is subtracted from that trade's R.
//
// Usage: node backtest/stress_test.js [--synthetic]

const fs = require('fs');
const path = require('path');
const ictEngine = require('./ict_engine');
const orbEngine = require('./orb_engine');
const { loadBars } = require('./confirmation_backtest');

const SYNTHETIC = process.argv.includes('--synthetic');

function stressIct(bars, slippagePts, slBufferPct) {
  const th = { ...ictEngine.DEFAULT_THRESHOLDS, minLegSize: 199, slBufferPct };
  const result = ictEngine.runBacktest(bars, { thresholds: th });
  let adjTotalR = 0, n = 0, wins = 0;
  for (const d of result.days) {
    if (!d.entered) continue;
    n++;
    const entryMid = (d.levels.oteLow + d.levels.oteHigh) / 2;
    const risk = Math.abs(entryMid - d.levels.sl);
    const rSlip = risk > 0 ? slippagePts / risk : 0;
    const adjR = (Number(d.r) || 0) - rSlip;
    adjTotalR += adjR;
    if (adjR > 0.001) wins++;
  }
  return { n, totalR: +adjTotalR.toFixed(2), avgR: n ? +(adjTotalR / n).toFixed(3) : null, winRate: n ? +((wins / n) * 100).toFixed(1) : null };
}

function stressOrb(bars, slippagePts, slBufferPct) {
  const th = { ...orbEngine.DEFAULT_ORB, rangeHour: 9, targetMultiple: 0.5, slBufferPct, minRangeSize: 100 };
  const byDate = orbEngine.sliceByDate(bars, th);
  let totalR = 0, n = 0, wins = 0;
  for (const entry of byDate.values()) {
    if (!entry.rangeBar || !entry.forward.length) continue;
    const sim = orbEngine.simulateOrbDay(entry.rangeBar, entry.forward, th);
    if (!sim || !sim.entered) continue;
    const size = entry.rangeBar.high - entry.rangeBar.low;
    const risk = size * (1 + th.slBufferPct);
    const rSlip = risk > 0 ? slippagePts / risk : 0;
    const adjR = (sim.r || 0) - rSlip;
    totalR += adjR;
    n++;
    if (adjR > 0.001) wins++;
  }
  return { n, totalR: +totalR.toFixed(2), avgR: n ? +(totalR / n).toFixed(3) : null, winRate: n ? +((wins / n) * 100).toFixed(1) : null };
}

(async () => {
  if (SYNTHETIC) {
    console.log('*** --synthetic mode: seeded synthetic fixture, NOT real market data — see confirmation_backtest.js for why. ***');
    console.log('*** This validates the stress-test MACHINERY, not real edge decay for this strategy.                        ***\n');
  }
  const bars = await loadBars(SYNTHETIC);

  const slippageGrid = [0, 1, 2, 5, 10];
  const slBufferGrid = [0.05, 0.10, 0.15, 0.20];

  console.log('=== ICT engine: edge decay vs. added slippage (stop buffer fixed at baseline 0.05) ===');
  const ictSlippage = slippageGrid.map(s => ({ slippagePts: s, ...stressIct(bars, s, 0.05) }));
  for (const r of ictSlippage) console.log(`  slippage=${r.slippagePts}pt: n=${r.n}, winRate=${r.winRate}%, avgR=${r.avgR}, totalR=${r.totalR}`);

  console.log('\n=== ICT engine: edge decay vs. wider stop buffer (slippage fixed at 0) ===');
  const ictStopBuffer = slBufferGrid.map(b => ({ slBufferPct: b, ...stressIct(bars, 0, b) }));
  for (const r of ictStopBuffer) console.log(`  slBufferPct=${r.slBufferPct}: n=${r.n}, winRate=${r.winRate}%, avgR=${r.avgR}, totalR=${r.totalR}`);

  console.log('\n=== ORB engine: edge decay vs. added slippage (stop buffer fixed at baseline 0.05) ===');
  const orbSlippage = slippageGrid.map(s => ({ slippagePts: s, ...stressOrb(bars, s, 0.05) }));
  for (const r of orbSlippage) console.log(`  slippage=${r.slippagePts}pt: n=${r.n}, winRate=${r.winRate}%, avgR=${r.avgR}, totalR=${r.totalR}`);

  console.log('\n=== ORB engine: edge decay vs. wider stop buffer (slippage fixed at 0) ===');
  const orbStopBuffer = slBufferGrid.map(b => ({ slBufferPct: b, ...stressOrb(bars, 0, b) }));
  for (const r of orbStopBuffer) console.log(`  slBufferPct=${r.slBufferPct}: n=${r.n}, winRate=${r.winRate}%, avgR=${r.avgR}, totalR=${r.totalR}`);

  const zeroCrossIct = ictSlippage.find(r => r.avgR !== null && r.avgR <= 0);
  const zeroCrossOrb = orbSlippage.find(r => r.avgR !== null && r.avgR <= 0);
  console.log('\n=== VERDICT (reported as-is) ===');
  console.log(zeroCrossIct ? `ICT edge turns non-positive at slippage >= ${zeroCrossIct.slippagePts}pt.` : `ICT edge stayed positive across the full ${Math.max(...slippageGrid)}pt slippage grid tested.`);
  console.log(zeroCrossOrb ? `ORB edge turns non-positive at slippage >= ${zeroCrossOrb.slippagePts}pt.` : `ORB edge stayed positive across the full ${Math.max(...slippageGrid)}pt slippage grid tested.`);

  const outPath = path.join(__dirname, SYNTHETIC ? 'stress_test_synthetic_results.json' : 'stress_test_results.json');
  fs.writeFileSync(outPath, JSON.stringify({ synthetic: SYNTHETIC, ictSlippage, ictStopBuffer, orbSlippage, orbStopBuffer }, null, 2));
  console.log(`\nFull results written to ${outPath}`);
})().catch(e => { console.error('Stress test failed:', e.message); process.exit(1); });
