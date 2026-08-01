'use strict';

// Same classification (Asia/London ranges need long history, so this stays on
// 1H bars — 2+ years available) but real 1-MINUTE bars for the actual entry/
// exit simulation instead of hourly-approximated fills, restricted to the
// ~180 days where continuous 1m history actually exists (see fetch_deep.js).
//
// Usage: node backtest/finegrain.js  (requires server.js running+connected,
// and backtest/deep_1m.json already built via fetch_deep.js)

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { classifyDay, legLevels, simulateTrade, DEFAULT_THRESHOLDS } = require('./ict_engine');

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
  return { hour: d.getHours() + d.getMinutes() / 60, dateKey: d.toISOString().slice(0, 10), jsDate: d };
}

// Slice bars into per-date session buckets, same convention as ict_engine.
function sliceByDate(bars) {
  const byDate = new Map();
  const ensure = key => { if (!byDate.has(key)) byDate.set(key, { asia: [], london: [], ny: [], forward: [] }); return byDate.get(key); };
  for (const b of bars) {
    const { hour, dateKey, jsDate } = ctParts(b.time);
    if (hour >= 19) {
      const next = new Date(jsDate); next.setDate(next.getDate() + 1);
      ensure(next.toISOString().slice(0, 10)).asia.push(b);
    } else if (hour < 1) ensure(dateKey).asia.push(b);
    else if (hour < 7) ensure(dateKey).london.push(b);
    else if (hour >= 9.5 && hour < 15) ensure(dateKey).ny.push(b);
    else if (hour >= 15) ensure(dateKey).forward.push(b);
  }
  return byDate;
}

function runFineBacktest(classBars, execBars, thresholds) {
  const classByDate = sliceByDate(classBars);
  const execByDate  = sliceByDate(execBars);
  const days = [];

  for (const [dateKey, sess] of classByDate.entries()) {
    const execSess = execByDate.get(dateKey);
    if (!execSess) continue; // no fine-resolution coverage for this date
    if (!sess.asia.length || !sess.london.length) continue;

    const cls = classifyDay(sess.asia, sess.london, thresholds);
    const day = { date: dateKey, scenario: cls.id, bias: cls.bias };
    if (cls.id === 0 || cls.id === 4) { days.push(day); continue; }

    const levels = legLevels(cls.bias, cls.legLow, cls.legHigh, thresholds);
    const forward = [...execSess.ny, ...execSess.forward];
    if (!forward.length) { days.push(day); continue; }
    const sim = simulateTrade(cls.bias, levels, forward, forward.length);
    Object.assign(day, { entered: sim.entered, result: sim.result, r: sim.r });
    days.push(day);
  }

  const traded = days.filter(d => d.entered);
  return {
    totalDays: days.length, tradedDays: traded.length,
    wins: traded.filter(d => d.result !== 'SL' && d.result !== 'TIMEOUT').length,
    losses: traded.filter(d => d.result === 'SL').length,
    totalR: +traded.reduce((a, d) => a + (Number(d.r) || 0), 0).toFixed(2),
    days,
  };
}

(async () => {
  const deepPath = path.join(__dirname, 'deep_1m.json');
  if (!fs.existsSync(deepPath)) {
    console.error('backtest/deep_1m.json not found — run fetch_deep.js first.');
    process.exit(1);
  }
  const execBars = JSON.parse(fs.readFileSync(deepPath, 'utf8'));
  console.log(`Loaded ${execBars.length} 1m bars, ${((execBars[execBars.length-1].time - execBars[0].time)/86400).toFixed(1)} days.`);

  const health = await get('/api/health');
  if (!health.authenticated) { console.error('Not connected to TradeLocker.'); process.exit(1); }
  const h1 = await get('/api/candles?resolution=60&count=19000');
  if (!h1.bars || !h1.bars.length) { console.error('No hourly bars.'); process.exit(1); }
  console.log(`Loaded ${h1.bars.length} 1H bars for classification.`);

  // Only the overlap between the two datasets matters — report it plainly.
  const execStart = new Date(execBars[0].time * 1000).toDateString();
  const execEnd   = new Date(execBars[execBars.length - 1].time * 1000).toDateString();
  console.log(`1m execution coverage: ${execStart} -> ${execEnd}\n`);

  const th = { ...DEFAULT_THRESHOLDS };
  const report = runFineBacktest(h1.bars, execBars, th);

  console.log('=== 1-MINUTE EXECUTION BACKTEST (default thresholds, ~180-day window) ===');
  console.log(`Classifiable days with 1m coverage: ${report.totalDays}`);
  console.log(`Trades taken: ${report.tradedDays}`);
  console.log(`Wins: ${report.wins}  Losses: ${report.losses}`);
  console.log(`Win rate: ${report.tradedDays ? (100 * report.wins / report.tradedDays).toFixed(1) : 'n/a'}%`);
  console.log(`Total R: ${report.totalR}  Avg R/trade: ${report.tradedDays ? (report.totalR / report.tradedDays).toFixed(3) : 'n/a'}`);

  fs.writeFileSync(path.join(__dirname, 'finegrain_results.json'), JSON.stringify(report, null, 2));
  console.log('\nFull results written to backtest/finegrain_results.json');
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
