'use strict';

// Run this whenever you want a read before trading Asia/London/pre-market/NY
// open. Checks the two validated (thin-edge, not "beast") approaches from
// this session's research against your LIVE account right now:
//
//   1. ICT leg-filter (Asia/London session classification + OTE entry)
//      — real track record: +0.35R avg, 18 trades, 7 out-of-sample.
//   2. Opening Range Breakout (NY-open-hour range breakout)
//      — using the rangeHour=9/target=0.5x config folds 1, 2, and 4 of the
//      walk-forward independently picked (2 of those 3 folds profitable,
//      not all — see ORB_TRACK_RECORD below for the real per-fold numbers).
//
// Every check appends to backtest/signal_journal.json — that journal is what
// "self-adapting" actually means here: re-run backtest/journal_review.js
// periodically (weekly is plenty) to see whether real outcomes still match
// what backtesting predicted, and to catch a strategy going stale before it
// costs money, instead of trusting one old backtest forever.

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { classifyDay, legLevels, DEFAULT_THRESHOLDS } = require('./ict_engine');
const { DEFAULT_ORB } = require('./orb_engine');

function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: 8899, path: p }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function ctParts(unixSecs) {
  const d = new Date(new Date(unixSecs * 1000).toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  return { hour: d.getHours() + d.getMinutes() / 60, dateKey: d.toISOString().slice(0, 10) };
}

function rangeOf(bars) {
  if (!bars.length) return null;
  return { open: bars[0].open, close: bars[bars.length - 1].close, high: Math.max(...bars.map(b => b.high)), low: Math.min(...bars.map(b => b.low)) };
}

const ICT_TRACK_RECORD = 'leg>=199pt filter: +0.349R avg train (n=18), +0.405R avg OOS (n=7) — thin sample, not proven.';
const ICT_MIN_LEG = 199; // the one leg-size filter that held up out-of-sample

// Restricted to ONLY the 2 profitable walk-forward folds (1 and 2) — fold 4
// picked this same rangeHour=9/target=0.5x shape too but went slightly
// negative, and is deliberately excluded here per instruction. That means
// this config is now backed by the 2 folds that worked, not a claim that
// the shape is reliable across all folds that ever picked it — say so.
const ORB_CONFIG = { ...DEFAULT_ORB, rangeHour: 9, targetMultiple: 0.5, slBufferPct: 0.05, minRangeSize: 100 };
const ORB_TRACK_RECORD = 'rangeHour=9/target=0.5x config, folds 1+2 only (both profitable): fold1 +0.184R/trade (n=58), '
  + 'fold2 +0.055R/trade (n=79) — combined +0.110R/trade (n=137). Fold 4 picked this same shape and went slightly '
  + 'negative (-0.025R, n=80) — excluded from this number by request, not because it disagreed and got dropped quietly.';

(async () => {
  const health = await get('/api/health');
  if (!health.authenticated) { console.error('Not connected to TradeLocker — log in via the app UI first.'); process.exit(1); }

  const h1 = await get('/api/candles?resolution=60&count=19000');
  if (!h1.bars || !h1.bars.length) { console.error('No bars.'); process.exit(1); }
  const bars = h1.bars;
  const quote = await get('/api/quote');

  const now = bars[bars.length - 1];
  const { hour, dateKey } = ctParts(now.time);
  console.log(`=== SIGNAL CHECK — ${new Date().toString()} ===`);
  console.log(`Last bar: ${new Date(now.time * 1000).toString()} (CT hour ${hour.toFixed(1)})`);
  console.log(`Live quote: ${quote.last} (bid ${quote.bid} / ask ${quote.ask})\n`);

  const results = { time: now.time, checkedAt: Date.now(), quote: quote.last, signals: [] };

  // --- ICT leg-filter: needs today's Asia + London bars ---
  const asiaBars = [], londonBars = [];
  for (const b of bars.slice(-200)) {
    const p = ctParts(b.time);
    if (p.dateKey === dateKey || (p.hour >= 19 && p.dateKey < dateKey)) {
      if (p.hour >= 19 || p.hour < 1) asiaBars.push(b);
      else if (p.hour >= 1 && p.hour < 7) londonBars.push(b);
    }
  }
  if (asiaBars.length && londonBars.length) {
    const th = { ...DEFAULT_THRESHOLDS, minLegSize: ICT_MIN_LEG };
    const cls = classifyDay(asiaBars, londonBars, th);
    console.log(`[ICT] Asia+London classified: S${cls.id} ${cls.bias} — ${cls.reason}`);
    if (cls.id !== 0 && cls.id !== 4) {
      const levels = legLevels(cls.bias, cls.legLow, cls.legHigh, th);
      console.log(`  Entry zone (OTE): ${levels.oteLow} - ${levels.oteHigh}`);
      console.log(`  Stop: ${levels.sl}  TP1: ${levels.tp1}  TP2: ${levels.tp2}  TP3: ${levels.tp3}`);
      console.log(`  Track record: ${ICT_TRACK_RECORD}`);
      results.signals.push({ strategy: 'ICT-leg-filter', scenario: cls.id, bias: cls.bias, levels, trackRecord: ICT_TRACK_RECORD });
    } else {
      console.log(`  No trade per ICT rules right now (${cls.reason === 'leg too small (< 199pt selectivity floor)' ? 'leg too small for the validated filter' : cls.reason}).`);
    }
  } else {
    console.log('[ICT] Not enough Asia/London data yet for today — check back after London closes (~7am CT).');
  }

  // --- ORB: needs today's range-hour bar + is currently past it ---
  console.log('');
  const rangeBar = bars.slice(-30).find(b => { const p = ctParts(b.time); return p.dateKey === dateKey && Math.floor(p.hour) === ORB_CONFIG.rangeHour; });
  if (!rangeBar) {
    console.log(`[ORB] Range-hour bar (${ORB_CONFIG.rangeHour}:00 CT) not available yet for today.`);
  } else {
    const size = rangeBar.high - rangeBar.low;
    console.log(`[ORB] Opening range (${ORB_CONFIG.rangeHour}:00-${ORB_CONFIG.rangeHour + 1}:00 CT): ${rangeBar.low} - ${rangeBar.high} (${size.toFixed(1)}pt)`);
    if (hour <= ORB_CONFIG.rangeHour + 1) {
      console.log('  Still inside the range hour — no breakout to check yet.');
    } else if (size < ORB_CONFIG.minRangeSize) {
      console.log(`  Range too small (< ${ORB_CONFIG.minRangeSize}pt floor) — no signal.`);
    } else if (quote.last > rangeBar.high) {
      const sl = rangeBar.low - size * ORB_CONFIG.slBufferPct;
      const target = quote.last + size * ORB_CONFIG.targetMultiple;
      console.log(`  BREAKOUT: price ${quote.last} above range high ${rangeBar.high} -> BUY`);
      console.log(`  Stop: ${sl.toFixed(1)}  Target: ${target.toFixed(1)}`);
      console.log(`  Track record: ${ORB_TRACK_RECORD}`);
      results.signals.push({ strategy: 'ORB', bias: 'BUY', entry: quote.last, sl, target, trackRecord: ORB_TRACK_RECORD });
    } else if (quote.last < rangeBar.low) {
      const sl = rangeBar.high + size * ORB_CONFIG.slBufferPct;
      const target = quote.last - size * ORB_CONFIG.targetMultiple;
      console.log(`  BREAKOUT: price ${quote.last} below range low ${rangeBar.low} -> SELL`);
      console.log(`  Stop: ${sl.toFixed(1)}  Target: ${target.toFixed(1)}`);
      console.log(`  Track record: ${ORB_TRACK_RECORD}`);
      results.signals.push({ strategy: 'ORB', bias: 'SELL', entry: quote.last, sl, target, trackRecord: ORB_TRACK_RECORD });
    } else {
      console.log('  Still inside the range — no breakout yet.');
    }
  }

  console.log(`\n${results.signals.length} signal(s) found. Everything above is read-only — no order is placed. Manual execution only.`);

  const journalPath = path.join(__dirname, 'signal_journal.json');
  let journal = [];
  try { journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')); } catch (_) {}
  journal.push(results);
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  console.log(`Logged to backtest/signal_journal.json (${journal.length} checks total) — this is what makes re-validation possible later.`);
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
