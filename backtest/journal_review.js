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

const journalPath = path.join(__dirname, 'signal_journal.json');

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
  for (let i = entryIdx; i < bars.length; i++) {
    const b = bars[i];
    const hitSL  = bias === 'BUY' ? b.low <= levels.sl : b.high >= levels.sl;
    const hitTP3 = bias === 'BUY' ? b.high >= levels.tp3 : b.low <= levels.tp3;
    const hitTP2 = bias === 'BUY' ? b.high >= levels.tp2 : b.low <= levels.tp2;
    const hitTP1 = bias === 'BUY' ? b.high >= levels.tp1 : b.low <= levels.tp1;
    if (hitSL)  return { status: 'resolved', outcome: 'loss', r: -1 };
    if (hitTP3) return { status: 'resolved', outcome: 'win', r: Math.abs(levels.tp3 - entryPrice) / risk };
    if (hitTP2) return { status: 'resolved', outcome: 'win', r: Math.abs(levels.tp2 - entryPrice) / risk };
    if (hitTP1) return { status: 'resolved', outcome: 'win', r: Math.abs(levels.tp1 - entryPrice) / risk };
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
  'ICT-leg-filter': { avgR: 0.405, n: 7, label: 'OOS backtest (thin sample)' },
  'ORB':            { avgR: 0.077, n: 598, label: 'untuned backtest' },
};

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
