'use strict';

// Runs the ICT scenario backtest against real TradeLocker history and prints
// a report. Requires server.js running and connected on 127.0.0.1:8899.
//
// Usage: node backtest/run.js [resolution] [count]
//   resolution: bar size in minutes used for BOTH classification and trade
//               simulation (default 60 — best balance of session-range
//               accuracy and total history depth available from TradeLocker)
//   count:      how many bars to request (default 19000, near TL's 20k cap)

const http = require('http');
const { runBacktest } = require('./ict_engine');

function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: 8899, path: p }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  const resolution = process.argv[2] || '60';
  const count       = process.argv[3] || '19000';

  const health = await get('/api/health');
  if (!health.authenticated) {
    console.error('Not connected to TradeLocker — log in via the app UI first, then re-run this.');
    process.exit(1);
  }

  console.log(`Pulling resolution=${resolution}m count=${count} from the live account...`);
  const data = await get(`/api/candles?resolution=${resolution}&count=${count}`);
  if (!data.bars || !data.bars.length) {
    console.error('No bars came back:', data.error || data.source);
    process.exit(1);
  }
  if (data.source !== 'tradelocker') {
    console.warn(`WARNING: source="${data.source}", not "tradelocker" — this run may include NDX-fallback data, not the literal feed.`);
  }

  const spanDays = (data.bars[data.bars.length - 1].time - data.bars[0].time) / 86400;
  console.log(`Got ${data.bars.length} bars, ${spanDays.toFixed(0)} days (${new Date(data.bars[0].time * 1000).toDateString()} -> ${new Date(data.bars[data.bars.length - 1].time * 1000).toDateString()})`);

  const report = runBacktest(data.bars, { maxForwardBars: resolution === '60' ? 30 : 200 });

  console.log('\n=== ICT SCENARIO BACKTEST ===');
  console.log(`Total classifiable days: ${report.totalDays}`);
  console.log(`Days with a trade taken: ${report.tradedDays}`);
  console.log(`Wins: ${report.wins}  Losses: ${report.losses}  Timeouts: ${report.timeouts}`);
  console.log(`Overall win rate: ${report.tradedDays ? (100 * (report.tradedDays - report.losses - report.timeouts) / report.tradedDays).toFixed(1) : 'n/a'}%`);
  console.log(`Total R: ${report.totalR}  Avg R/trade: ${report.tradedDays ? (report.totalR / report.tradedDays).toFixed(2) : 'n/a'}`);
  console.log('\nBy scenario:');
  for (const [key, s] of Object.entries(report.byScenario)) {
    console.log(`  ${key}: ${s.days} days classified, ${s.traded} traded, ${s.winRate ?? 'n/a'}% win rate, avg ${s.avgR ?? 'n/a'}R, total ${+s.totalR.toFixed(1)}R`);
  }

  const fs = require('fs');
  const path = require('path');
  const outPath = path.join(__dirname, 'results.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nFull per-day results written to ${outPath}`);
})().catch(e => {
  console.error('Backtest failed:', e.message);
  process.exit(1);
});
