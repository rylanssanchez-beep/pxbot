'use strict';

// ─── Calibrate confirmation weights from REAL 1-minute-execution trades ───
// journal_review.js calibrates from live signals as they accumulate in
// backtest/signal_journal.json — which is thin right now (server-side
// logging only just started). This script calibrates from the SAME evidence
// method against the 146 real trades already available at true 1-minute
// execution granularity (backtest/confirmation_backtest_finegrain.js,
// backed by backtest/deep_1m.json's 206.7 days of real bars), so there's an
// actual calibrated starting point now instead of waiting weeks for the live
// journal to fill up. Same discipline as journal_review.js's evidence-based
// step function — duplicated here (not shared) because the input shape
// differs (flat trade array with `factors` vs. a resolved-journal object),
// but the method and thresholds are identical on purpose.
//
// Writes engine/confirmation_weights.proposed.json (same schema
// backtest/apply_weights.js already reads) — does NOT touch the active
// weights file. Then re-validates: baseline equal weights vs. calibrated
// weights, AND a real gating comparison (take-everything vs. tier-B+-only)
// under the calibrated weights — real numbers, on real trades, reported
// honestly either way.
//
// Usage: node backtest/calibrate_weights.js

const fs = require('fs');
const path = require('path');
const confirmationEngine = require('../engine/confirmation_engine');
const { runFinegrainConfirmationBacktest, stratifyByTier, loadFinegrainData } = require('./confirmation_backtest_finegrain');

const MIN_SAMPLES_PER_SIDE = 10;
const WEIGHT_MIN = 0.25, WEIGHT_MAX = 2.5;
const proposedWeightsPath = path.join(__dirname, '..', 'engine', 'confirmation_weights.proposed.json');
const weightsPath = path.join(__dirname, '..', 'engine', 'confirmation_weights.json');

function calibrate(trades, currentWeights) {
  const byFactor = {};
  for (const t of trades) {
    if (!Array.isArray(t.factors)) continue;
    for (const f of t.factors) {
      if (f.excluded || f.agrees === null || f.agrees === undefined) continue;
      if (!byFactor[f.name]) byFactor[f.name] = { agree: { n: 0, wins: 0, totalR: 0 }, disagree: { n: 0, wins: 0, totalR: 0 } };
      const bucket = byFactor[f.name][f.agrees ? 'agree' : 'disagree'];
      bucket.n++;
      bucket.totalR += t.r;
      if (t.r > 0.001) bucket.wins++;
    }
  }

  const proposedWeights = { ...currentWeights };
  const factorReport = {};
  for (const [name, buckets] of Object.entries(byFactor)) {
    const { agree, disagree } = buckets;
    const agreeAvgR = agree.n ? agree.totalR / agree.n : null;
    const disagreeAvgR = disagree.n ? disagree.totalR / disagree.n : null;
    const current = currentWeights[name] ?? 1;
    let proposed = current, note = 'not enough samples on both sides yet — weight unchanged';
    if (agree.n >= MIN_SAMPLES_PER_SIDE && disagree.n >= MIN_SAMPLES_PER_SIDE) {
      const separation = agreeAvgR - disagreeAvgR;
      let step = 0;
      if (separation > 0.15) step = 0.5;
      else if (separation > 0) step = 0.25;
      else if (separation > -0.15) step = -0.25;
      else step = -0.5;
      proposed = Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, current + step));
      note = `separation=${separation.toFixed(3)}R -> step ${step >= 0 ? '+' : ''}${step}`;
    }
    proposedWeights[name] = +proposed.toFixed(2);
    factorReport[name] = { agreeN: agree.n, agreeAvgR: agreeAvgR !== null ? +agreeAvgR.toFixed(3) : null,
      disagreeN: disagree.n, disagreeAvgR: disagreeAvgR !== null ? +disagreeAvgR.toFixed(3) : null,
      currentWeight: current, proposedWeight: +proposed.toFixed(2), note };
  }
  return { proposedWeights, factorReport };
}

function printTiers(label, byTier) {
  console.log(`  ${label}:`);
  for (const tier of ['A+', 'A', 'B', 'skip']) {
    if (!byTier[tier]) { console.log(`    ${tier}: no trades`); continue; }
    const t = byTier[tier];
    console.log(`    ${tier}: n=${t.n}, winRate=${t.winRate}%, avgR=${t.avgR}, totalR=${t.totalR}`);
  }
}

function gatedStats(trades, label) {
  const gated = trades.filter(t => t.tier === 'B' || t.tier === 'A' || t.tier === 'A+');
  const n = trades.length, gn = gated.length;
  const allR = trades.reduce((a, t) => a + t.r, 0);
  const gatedR = gated.reduce((a, t) => a + t.r, 0);
  const allWins = trades.filter(t => t.r > 0.001).length;
  const gatedWins = gated.filter(t => t.r > 0.001).length;
  console.log(`  ${label}:`);
  console.log(`    Take everything: n=${n}, winRate=${n ? (100 * allWins / n).toFixed(1) : 'n/a'}%, avgR=${n ? (allR / n).toFixed(3) : 'n/a'}, totalR=${allR.toFixed(2)}`);
  console.log(`    Gate to tier B+: n=${gn}, winRate=${gn ? (100 * gatedWins / gn).toFixed(1) : 'n/a'}%, avgR=${gn ? (gatedR / gn).toFixed(3) : 'n/a'}, totalR=${gatedR.toFixed(2)}`);
}

(async () => {
  console.log('Loading real hourly + real 1-minute execution data...\n');
  const { hourlyBars, m1Bars } = await loadFinegrainData();

  const currentWeights = confirmationEngine.DEFAULT_WEIGHTS;
  console.log('Scoring real trades with EQUAL baseline weights...');
  const baselineTrades = runFinegrainConfirmationBacktest(hourlyBars, m1Bars, { weights: currentWeights });
  console.log(`${baselineTrades.length} real trades scored at 1-minute execution granularity.\n`);

  const { proposedWeights, factorReport } = calibrate(baselineTrades, currentWeights);

  console.log('=== PER-FACTOR EVIDENCE (from real 1-minute-execution trades) ===');
  for (const [name, r] of Object.entries(factorReport)) {
    console.log(`  ${name}: agree n=${r.agreeN} avgR=${r.agreeAvgR ?? 'n/a'} | disagree n=${r.disagreeN} avgR=${r.disagreeAvgR ?? 'n/a'} | weight ${r.currentWeight} -> ${r.proposedWeight} (${r.note})`);
  }

  const anyChanged = Object.values(factorReport).some(r => r.currentWeight !== r.proposedWeight);
  if (!anyChanged) {
    console.log('\nNo factor has enough real samples on both sides yet to justify a weight change — this is an honest limit of a 146-trade sample, not a bug.');
    console.log('Reporting the equal-weight baseline gating comparison below anyway, since that still tells you something.\n');
  }

  console.log('\nRe-scoring with CALIBRATED weights for a real apples-to-apples comparison...');
  const calibratedTrades = anyChanged ? runFinegrainConfirmationBacktest(hourlyBars, m1Bars, { weights: proposedWeights }) : baselineTrades;

  console.log('\n=== TIER STRATIFICATION: baseline (equal weights) vs. calibrated ===');
  printTiers('BASELINE (equal weights)', stratifyByTier(baselineTrades));
  printTiers('CALIBRATED weights', stratifyByTier(calibratedTrades));

  console.log('\n=== GATING COMPARISON: take everything vs. gate to tier B+ ===');
  gatedStats(baselineTrades, 'Under BASELINE (equal) weights');
  gatedStats(calibratedTrades, 'Under CALIBRATED weights');

  if (anyChanged) {
    const proposal = {
      generatedAt: new Date().toISOString(),
      basedOnResolvedSignals: baselineTrades.length,
      source: 'backtest/calibrate_weights.js — real 1-minute-execution trades (backtest/deep_1m.json), not the live signal_journal',
      minSamplesPerSide: MIN_SAMPLES_PER_SIDE,
      currentWeights, proposedWeights, factorReport,
      note: 'PROPOSAL ONLY — never auto-applied. Review the evidence above, then run backtest/apply_weights.js if you want to promote this.',
    };
    fs.writeFileSync(proposedWeightsPath, JSON.stringify(proposal, null, 2));
    console.log(`\nProposal written to engine/confirmation_weights.proposed.json — review, then run backtest/apply_weights.js to promote if you agree with it.`);
  }
})().catch(e => { console.error('calibrate_weights failed:', e.message, e.stack); process.exit(1); });
