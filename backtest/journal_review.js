'use strict';

// Run this periodically (weekly is plenty) to see whether signal_now.js's
// signals are actually holding up as real trades happen — this is the
// re-validation step that makes "self-adapting" honest instead of a buzzword.
//
// Important: this tool can't auto-detect trade outcomes on its own — nothing
// stays running continuously enough to watch a trade from entry to exit in
// this setup. After you take (or skip) a signal, add the outcome yourself:
//
//   node backtest/journal_review.js log <entryIndex> <win|loss|scratch> <R>
//
// Then this report becomes real: it recomputes win rate and avg R PER
// STRATEGY from what actually happened, not from the original backtest, and
// flags if live performance is falling short of the backtested track record
// — which is the actual signal that a strategy is going stale.

const fs   = require('fs');
const path = require('path');
const journalPath = path.join(__dirname, 'signal_journal.json');

function loadJournal() {
  try { return JSON.parse(fs.readFileSync(journalPath, 'utf8')); } catch (_) { return []; }
}

const BACKTESTED = {
  'ICT-leg-filter': { avgR: 0.405, n: 7, label: 'OOS backtest (thin sample)' },
  'ORB':            { avgR: 0.077, n: 598, label: 'untuned backtest' },
};

const args = process.argv.slice(2);

if (args[0] === 'log') {
  const [, idxStr, outcome, rStr] = args;
  const journal = loadJournal();
  const idx = parseInt(idxStr);
  if (!journal[idx] || !journal[idx].signals.length) { console.error('No signal at that journal index.'); process.exit(1); }
  journal[idx].outcome = outcome;
  journal[idx].actualR = parseFloat(rStr);
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  console.log(`Logged outcome for entry ${idx}: ${outcome}, R=${rStr}`);
  process.exit(0);
}

const journal = loadJournal();
console.log(`${journal.length} signal checks logged.\n`);

const byStrategy = {};
for (const entry of journal) {
  for (const sig of entry.signals) {
    const key = sig.strategy;
    if (!byStrategy[key]) byStrategy[key] = { fired: 0, withOutcome: 0, totalR: 0 };
    byStrategy[key].fired++;
    if (entry.outcome && typeof entry.actualR === 'number') {
      byStrategy[key].withOutcome++;
      byStrategy[key].totalR += entry.actualR;
    }
  }
}

for (const [strategy, stats] of Object.entries(byStrategy)) {
  const bt = BACKTESTED[strategy];
  console.log(`${strategy}: ${stats.fired} signals fired, ${stats.withOutcome} have a recorded real outcome.`);
  if (stats.withOutcome > 0) {
    const liveAvgR = stats.totalR / stats.withOutcome;
    console.log(`  LIVE avg R so far: ${liveAvgR.toFixed(3)} (n=${stats.withOutcome})  vs  backtest avg R: ${bt.avgR} (${bt.label})`);
    if (stats.withOutcome < 20) {
      console.log(`  Still too few real outcomes (${stats.withOutcome}) to trust this over the backtest — keep logging.`);
    } else if (liveAvgR < bt.avgR * 0.5) {
      console.log(`  WARNING: live performance is well below backtest — this strategy may be going stale. Consider pausing it.`);
    } else {
      console.log(`  Live performance roughly tracking the backtest — no stale-edge warning yet.`);
    }
  } else {
    console.log(`  No outcomes recorded yet. Use: node backtest/journal_review.js log <index> <win|loss|scratch> <R>`);
  }
  console.log('');
}
