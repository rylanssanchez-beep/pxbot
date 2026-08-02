'use strict';

// ─── The ONLY path that promotes proposed confirmation weights to active ──
// journal_review.js's factor analysis writes engine/confirmation_weights.proposed.json
// from real resolved-signal evidence — it never touches the active
// engine/confirmation_weights.json. This script is the deliberate, manual
// human step that can. It:
//   1. Prints a clear diff of current vs. proposed weights and the evidence behind each.
//   2. Re-validates BOTH weight sets against real history with
//      confirmation_backtest.js's tier stratification, so you can see
//      whether the proposed weights actually look better out-of-sample
//      before promoting — not just trust the raw per-factor separation.
//   3. Only writes engine/confirmation_weights.json if you pass --confirm.
//      Without it, this is a dry run — nothing is written.
//
// Usage:
//   node backtest/apply_weights.js              # dry run: show diff + re-validation, write nothing
//   node backtest/apply_weights.js --confirm     # actually promote proposed -> active
//   node backtest/apply_weights.js --synthetic [--confirm]   # re-validate against the synthetic
//                                                              fixture instead of live history (no
//                                                              live TradeLocker connection needed,
//                                                              but NOT evidence of real edge — see
//                                                              confirmation_backtest.js)

const fs = require('fs');
const path = require('path');
const confirmationEngine = require('../engine/confirmation_engine');
const { runConfirmationBacktest, stratifyByTier, loadBars } = require('./confirmation_backtest');

const CONFIRM = process.argv.includes('--confirm');
const SYNTHETIC = process.argv.includes('--synthetic');

const weightsPath = path.join(__dirname, '..', 'engine', 'confirmation_weights.json');
const proposedPath = path.join(__dirname, '..', 'engine', 'confirmation_weights.proposed.json');

function printTiers(label, byTier) {
  console.log(`  ${label}:`);
  for (const tier of ['A+', 'A', 'B', 'skip']) {
    if (!byTier[tier]) { console.log(`    ${tier}: no trades`); continue; }
    const t = byTier[tier];
    console.log(`    ${tier}: n=${t.n}, winRate=${t.winRate}%, avgR=${t.avgR}`);
  }
}

(async () => {
  if (!fs.existsSync(proposedPath)) {
    console.error('No engine/confirmation_weights.proposed.json found. Run backtest/journal_review.js first to generate one from real resolved signals.');
    process.exit(1);
  }
  const proposal = JSON.parse(fs.readFileSync(proposedPath, 'utf8'));
  const active = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));

  console.log(`Proposal generated ${proposal.generatedAt}, based on ${proposal.basedOnResolvedSignals} resolved live signals.\n`);
  console.log('=== WEIGHT DIFF ===');
  const names = new Set([...Object.keys(proposal.currentWeights), ...Object.keys(proposal.proposedWeights)]);
  for (const name of names) {
    const cur = proposal.currentWeights[name];
    const prop = proposal.proposedWeights[name];
    const changed = cur !== prop ? '  <-- CHANGED' : '';
    console.log(`  ${name}: ${cur} -> ${prop}${changed}`);
  }
  console.log('\n=== EVIDENCE BEHIND EACH CHANGE ===');
  for (const [name, r] of Object.entries(proposal.factorReport)) {
    if (r.currentWeight === r.proposedWeight) continue;
    console.log(`  ${name}: agree n=${r.agreeN} avgR=${r.agreeAvgR} | disagree n=${r.disagreeN} avgR=${r.disagreeAvgR} | ${r.note}`);
  }

  console.log(`\n=== RE-VALIDATION (${SYNTHETIC ? 'synthetic fixture — machinery check only' : 'live TradeLocker history'}) ===`);
  if (SYNTHETIC) console.log('*** Synthetic mode: NOT evidence of real edge, see confirmation_backtest.js for why. ***');
  const bars = await loadBars(SYNTHETIC);

  const currentResults = runConfirmationBacktest(bars, { weights: proposal.currentWeights });
  const proposedResults = runConfirmationBacktest(bars, { weights: proposal.proposedWeights });
  printTiers('CURRENT weights', stratifyByTier(currentResults));
  printTiers('PROPOSED weights', stratifyByTier(proposedResults));

  if (!CONFIRM) {
    console.log('\nDry run — nothing written. Re-run with --confirm to promote these weights to engine/confirmation_weights.json');
    console.log('after reviewing the diff and re-validation above.');
    process.exit(0);
  }

  const newActive = {
    version: (active.version || 1) + 1,
    status: 'promoted',
    note: `Promoted from proposal generated ${proposal.generatedAt} (${proposal.basedOnResolvedSignals} resolved signals) via backtest/apply_weights.js --confirm on ${new Date().toISOString()}.`,
    weights: proposal.proposedWeights,
  };
  fs.writeFileSync(weightsPath, JSON.stringify(newActive, null, 2));
  console.log(`\nPromoted. engine/confirmation_weights.json is now version ${newActive.version}.`);
  console.log('Re-run backtest/confirmation_backtest.js (and confirmation_backtest_finegrain.js if you have deep_1m.json) to keep validating going forward.');
})().catch(e => { console.error('apply_weights failed:', e.message); process.exit(1); });
