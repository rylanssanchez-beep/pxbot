'use strict';

// Automatically resolves pending signals from signal_journal.json by pulling
// the REAL bars that happened after each signal fired and running the exact
// same simulation logic the backtest used — no manual entry required. This
// is the actual "self-adapting" mechanism: run this periodically (weekly is
// plenty) and it tells you whether live outcomes are matching what the
// backtest predicted, using the chart data already built into the system.

const fs   = require('fs');
const path = require('path');
const http = require('http');
const confirmationEngine = require('../engine/confirmation_engine');

const journalPath = path.join(__dirname, 'signal_journal.json');
const weightsPath = path.join(__dirname, '..', 'engine', 'confirmation_weights.json');
const proposedWeightsPath = path.join(__dirname, '..', 'engine', 'confirmation_weights.proposed.json');

function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: 8899, path: p }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function loadJournal() { try { return JSON.parse(fs.readFileSync(journalPath, 'utf8')); } catch (_) { return []; } }
function saveJournal(j) { fs.writeFileSync(journalPath, JSON.stringify(j, null, 2)); }

// Resolves against the breakeven-ladder management plan (stop to entry
// after TP1, to TP1 after TP2, ride to TP3) — matches
// ict_engine.js:simulateTradeManaged and server.js's live managementPlan
// guidance now shown to the user. Duplicated (not imported) because this
// operates on already-logged journal entries (real bars since the signal
// fired), not a forward-walk simulation over a fixed bar count — same
// staged-stop logic, different driving loop.
function resolveICT(sig, bars) {
  const { levels, bias } = sig;
  let entryIdx = -1, entryPrice = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.low <= levels.oteHigh && b.high >= levels.oteLow) {
      entryIdx = i;
      entryPrice = bias === 'BUY' ? Math.min(levels.oteHigh, b.high) : Math.max(levels.oteLow, b.low);
      break;
    }
  }
  if (entryIdx === -1) return { status: 'pending', reason: "price hasn't entered the OTE zone yet" };
  const risk = Math.abs(entryPrice - levels.sl);
  if (risk <= 0) return { status: 'pending', reason: 'invalid risk' };

  let stop = levels.sl, stage = 0; // 0=initial, 1=past TP1 (stop at breakeven), 2=past TP2 (stop at TP1)
  const r1 = Math.abs(levels.tp1 - entryPrice) / risk;
  for (let i = entryIdx; i < bars.length; i++) {
    const b = bars[i];
    const hitStop = bias === 'BUY' ? b.low <= stop : b.high >= stop;
    if (hitStop) {
      const r = stage === 0 ? -1 : stage === 1 ? 0 : r1;
      return { status: 'resolved', outcome: r > 0.001 ? 'win' : (r < -0.001 ? 'loss' : 'breakeven'), r };
    }
    const hitTP3 = bias === 'BUY' ? b.high >= levels.tp3 : b.low <= levels.tp3;
    if (hitTP3) return { status: 'resolved', outcome: 'win', r: Math.abs(levels.tp3 - entryPrice) / risk };
    const hitTP2 = bias === 'BUY' ? b.high >= levels.tp2 : b.low <= levels.tp2;
    if (hitTP2 && stage < 2) { stage = 2; stop = levels.tp1; }
    const hitTP1 = bias === 'BUY' ? b.high >= levels.tp1 : b.low <= levels.tp1;
    if (hitTP1 && stage < 1) { stage = 1; stop = entryPrice; }
  }
  return { status: 'pending', reason: 'entered but no target/stop hit yet in available bars' };
}

function resolveORB(sig, bars) {
  const { bias, entry, sl, target } = sig;
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return { status: 'pending', reason: 'invalid risk' };
  for (const b of bars) {
    const hitSL     = bias === 'BUY' ? b.low <= sl : b.high >= sl;
    const hitTarget = bias === 'BUY' ? b.high >= target : b.low <= target;
    if (hitSL)     return { status: 'resolved', outcome: 'loss', r: -1 };
    if (hitTarget) return { status: 'resolved', outcome: 'win', r: Math.abs(target - entry) / risk };
  }
  return { status: 'pending', reason: 'no target/stop hit yet in available bars' };
}

const BACKTESTED = {
  // Breakeven-ladder managed exit (server.js:ICT_MANAGEMENT_PLAN). Real
  // 1-minute-execution OOS test, held-out period stronger than train — but
  // the same logic on the much bigger hourly-approximated history was
  // weaker (still negative). Both true; this cites the more-accurate-but-
  // thinner number since that's what actually matches real fills.
  'ICT-leg-filter': { avgR: 0.405, n: 7, label: 'real 1m-execution OOS (thin sample; weaker on hourly-approximated full history — see server.js comment)' },
  // rangeHour=8/target=1x/slBuffer=0.1/skipMonday — picked independently in
  // 5/5 walk-forward folds (stable signal), 4/5 profitable OOS. Caveat: the
  // most recent 6-7 weeks tested show decay, currently worse than the prior
  // config there — see server.js:ORB_TRACK_RECORD for the full picture.
  'ORB':            { avgR: 0.056, n: 299, label: 'walk-forward 4/5 folds profitable, config picked in every fold; recent-period decay flagged separately' },
};

// ── Human-in-the-loop confirmation-weight learning ─────────────────────────
// The evidence-based half of "self-adaptation": per-confirmation-factor
// win-rate/expectancy correlation, computed from real resolved live signals
// (server.js now logs every fired signal's full confirmation report — see
// server.js:appendToSignalJournal). This NEVER writes to the active
// engine/confirmation_weights.json — only to a separate *.proposed.json
// file. Promoting proposed -> active requires a human to run
// backtest/apply_weights.js deliberately; nothing here auto-applies
// anything, per explicit instruction.
const MIN_SAMPLES_PER_SIDE = 10; // minimum resolved signals on EACH side (agree/disagree) before a factor's weight is touched at all
const WEIGHT_MIN = 0.25, WEIGHT_MAX = 2.5;

function reviewConfirmationFactors(journal) {
  const byFactor = {}; // name -> { agree: {n,wins,totalR}, disagree: {n,wins,totalR} }
  let resolvedWithConfirmation = 0;

  for (const entry of journal) {
    for (const sig of entry.signals) {
      if (!sig.outcome || !sig.confirmation || !Array.isArray(sig.confirmation.factors)) continue;
      resolvedWithConfirmation++;
      const r = sig.actualR;
      for (const f of sig.confirmation.factors) {
        if (f.excluded || f.agrees === null || f.agrees === undefined) continue;
        if (!byFactor[f.name]) byFactor[f.name] = { agree: { n: 0, wins: 0, totalR: 0 }, disagree: { n: 0, wins: 0, totalR: 0 } };
        const bucket = byFactor[f.name][f.agrees ? 'agree' : 'disagree'];
        bucket.n++;
        bucket.totalR += r;
        if (r > 0.001) bucket.wins++;
      }
    }
  }

  console.log('=== CONFIRMATION-ENGINE FACTOR REVIEW ===');
  console.log(`${resolvedWithConfirmation} resolved signals carry a confirmation report to analyze.`);
  if (resolvedWithConfirmation < MIN_SAMPLES_PER_SIDE * 2) {
    console.log(`Well below a usable sample (need roughly ${MIN_SAMPLES_PER_SIDE * 2}+) — no per-factor analysis or weight proposal yet. This is expected early on; keep running signal checks and re-run this periodically.\n`);
    return;
  }

  let currentWeights = confirmationEngine.DEFAULT_WEIGHTS;
  try { currentWeights = JSON.parse(fs.readFileSync(weightsPath, 'utf8')).weights || currentWeights; } catch (_) {}

  const proposedWeights = { ...currentWeights };
  const factorReport = {};
  let anyAdjusted = false;

  for (const [name, buckets] of Object.entries(byFactor)) {
    const { agree, disagree } = buckets;
    const agreeAvgR = agree.n ? agree.totalR / agree.n : null;
    const disagreeAvgR = disagree.n ? disagree.totalR / disagree.n : null;
    const current = currentWeights[name] ?? 1;
    let proposed = current;
    let note = 'not enough samples on both sides yet — weight unchanged';

    if (agree.n >= MIN_SAMPLES_PER_SIDE && disagree.n >= MIN_SAMPLES_PER_SIDE) {
      const separation = agreeAvgR - disagreeAvgR;
      // Simple, auditable step function — NOT a continuous fitted formula.
      // Evidence tiers, not invented magic numbers: how far apart is
      // "this factor agreed" vs "this factor disagreed" in real outcome R.
      let step = 0;
      if (separation > 0.15) step = 0.5;
      else if (separation > 0) step = 0.25;
      else if (separation > -0.15) step = -0.25;
      else step = -0.5;
      proposed = Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, current + step));
      note = `separation=${separation.toFixed(3)}R -> step ${step >= 0 ? '+' : ''}${step}`;
      if (proposed !== current) anyAdjusted = true;
    }

    proposedWeights[name] = +proposed.toFixed(2);
    factorReport[name] = { agreeN: agree.n, agreeAvgR: agreeAvgR !== null ? +agreeAvgR.toFixed(3) : null,
      disagreeN: disagree.n, disagreeAvgR: disagreeAvgR !== null ? +disagreeAvgR.toFixed(3) : null,
      currentWeight: current, proposedWeight: +proposed.toFixed(2), note };
    console.log(`  ${name}: agree n=${agree.n} avgR=${factorReport[name].agreeAvgR ?? 'n/a'} | disagree n=${disagree.n} avgR=${factorReport[name].disagreeAvgR ?? 'n/a'} | weight ${current} -> ${factorReport[name].proposedWeight} (${note})`);
  }

  if (!anyAdjusted) {
    console.log('\nNo factor has enough samples on both sides to justify a weight change yet — no proposal written.\n');
    return;
  }

  const proposal = {
    generatedAt: new Date().toISOString(),
    basedOnResolvedSignals: resolvedWithConfirmation,
    minSamplesPerSide: MIN_SAMPLES_PER_SIDE,
    currentWeights, proposedWeights, factorReport,
    note: 'PROPOSAL ONLY — never auto-applied. Review the per-factor evidence above, then run backtest/apply_weights.js '
      + 'if you want to promote this to the active engine/confirmation_weights.json. That script also re-validates with '
      + 'confirmation_backtest.js before letting you confirm.',
  };
  fs.writeFileSync(proposedWeightsPath, JSON.stringify(proposal, null, 2));
  console.log(`\nProposed weight changes written to engine/confirmation_weights.proposed.json (NOT active — review, then run backtest/apply_weights.js to promote).\n`);
}

(async () => {
  const health = await get('/api/health');
  if (!health.authenticated) { console.error('Not connected to TradeLocker — log in via the app UI first.'); process.exit(1); }

  const journal = loadJournal();
  console.log(`${journal.length} signal checks logged. Resolving pending ones against real bars since each signal fired...\n`);

  let resolvedNow = 0, stillPending = 0;
  for (const entry of journal) {
    for (const sig of entry.signals) {
      if (sig.outcome) continue; // already resolved
      const nowSec = Math.floor(Date.now() / 1000);
      const spanMin = Math.ceil((nowSec - entry.time) / 60) + 30;
      const count = Math.min(19000, Math.max(spanMin, 60));
      const data = await get(`/api/candles?resolution=1&count=${count}`);
      const bars = (data.bars || []).filter(b => b.time > entry.time);
      if (!bars.length) { stillPending++; continue; }

      const result = sig.strategy === 'ORB' ? resolveORB(sig, bars) : resolveICT(sig, bars);
      if (result.status === 'resolved') {
        sig.outcome = result.outcome;
        sig.actualR = +result.r.toFixed(3);
        sig.resolvedAt = Date.now();
        resolvedNow++;
        console.log(`Resolved [${sig.strategy}] from ${new Date(entry.time * 1000).toDateString()}: ${result.outcome.toUpperCase()} (${sig.actualR}R)`);
      } else {
        stillPending++;
      }
    }
  }
  saveJournal(journal);
  console.log(`\n${resolvedNow} newly resolved automatically, ${stillPending} still pending (need more real bars to pass before they can resolve).\n`);

  reviewConfirmationFactors(journal);

  // --- Summary: live performance vs the original backtest, per strategy ---
  const byStrategy = {};
  for (const entry of journal) {
    for (const sig of entry.signals) {
      const key = sig.strategy;
      if (!byStrategy[key]) byStrategy[key] = { fired: 0, resolved: 0, totalR: 0 };
      byStrategy[key].fired++;
      if (sig.outcome) { byStrategy[key].resolved++; byStrategy[key].totalR += sig.actualR; }
    }
  }
  console.log('=== LIVE vs BACKTEST ===');
  for (const [strategy, stats] of Object.entries(byStrategy)) {
    const bt = BACKTESTED[strategy];
    console.log(`${strategy}: ${stats.fired} fired, ${stats.resolved} resolved automatically.`);
    if (stats.resolved > 0) {
      const liveAvgR = stats.totalR / stats.resolved;
      console.log(`  LIVE avg R: ${liveAvgR.toFixed(3)} (n=${stats.resolved})  vs  backtest avg R: ${bt.avgR} (${bt.label})`);
      if (stats.resolved < 20) {
        console.log(`  Still too few resolved (${stats.resolved}) to trust this over the backtest — keep running this periodically.`);
      } else if (liveAvgR < bt.avgR * 0.5) {
        console.log(`  WARNING: live performance is well below backtest — this strategy may be going stale. Consider pausing it.`);
      } else {
        console.log(`  Live performance roughly tracking the backtest — no stale-edge warning.`);
      }
    } else {
      console.log(`  Nothing resolved yet — either no time has passed or price hasn't reached a target/stop.`);
    }
    console.log('');
  }
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
