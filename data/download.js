'use strict';

// CLI entry point for the paginated TradeLocker history downloader.
//
// Usage:
//   node -r ./scripts/load_env.js data/download.js [--resolutions=1m,5m,15m,30m,1H,4H,1D] [--maxRequests=N] [--force]
//
// Credentials come from PXBOT_EMAIL / PXBOT_PASSWORD / PXBOT_SERVER in the
// environment (see scripts/load_env.js + .env) — never as CLI args (visible
// via `ps`) and never written to disk by this script.

const { TradeLockerClient } = require('../lib/tradelocker_client');
const { MarketDataStore } = require('./store');
const { downloadAll } = require('./downloader');
const { generateIntegrityReport } = require('./integrity_report');

function parseArgs(argv) {
  const out = { resolutions: ['1m', '5m', '15m', '30m', '1H', '4H', '1D'], maxRequests: 5000, force: false };
  for (const a of argv) {
    if (a.startsWith('--resolutions=')) out.resolutions = a.split('=')[1].split(',');
    else if (a.startsWith('--maxRequests=')) out.maxRequests = parseInt(a.split('=')[1], 10);
    else if (a === '--force') out.force = true;
  }
  return out;
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  const email = process.env.PXBOT_EMAIL, password = process.env.PXBOT_PASSWORD, server = process.env.PXBOT_SERVER;
  if (!email || !password || !server) {
    console.error('Missing PXBOT_EMAIL / PXBOT_PASSWORD / PXBOT_SERVER. Set them in .env (see .env.example) and run with: node -r ./scripts/load_env.js data/download.js');
    process.exit(1);
  }

  console.log('Authenticating to TradeLocker...');
  const client = new TradeLockerClient({ email, password, server });
  const conn = await client.connect('NAS');
  console.log(`Connected: ${conn.symbol} (instrumentId=${conn.instrumentId}, routeId=${conn.infoRouteId}, accNum=${conn.accNum})`);

  const store = new MarketDataStore();
  const identity = {
    provider: 'tradelocker', broker: server, accountId: conn.accountId,
    symbol: conn.symbol, instrumentId: conn.instrumentId, routeId: conn.infoRouteId,
  };

  console.log(`\nDownloading resolutions: ${opts.resolutions.join(', ')} (maxRequests/resolution=${opts.maxRequests}, force=${opts.force})\n`);
  const summary = await downloadAll(client, store, identity, opts.resolutions, { maxRequests: opts.maxRequests, force: opts.force, logger: console.log });

  console.log('\n=== DOWNLOAD SUMMARY ===');
  for (const [res, s] of Object.entries(summary)) {
    if (s.skipped) { console.log(`  ${res}: skipped (already exhausted)`); continue; }
    const counts = store.countBars(identity.symbol, res);
    console.log(`  ${res}: ${counts.n} bars stored, range ${counts.oldest ? new Date(counts.oldest * 1000).toISOString().slice(0, 10) : 'n/a'} .. ${counts.newest ? new Date(counts.newest * 1000).toISOString().slice(0, 10) : 'n/a'}, historyExhausted=${s.historyExhausted}, requests=${s.requestCount}`);
  }

  console.log('\nGenerating data-integrity report...');
  const report = generateIntegrityReport(store, identity, opts.resolutions);
  console.log(`Report written to data/logs/DATA_INTEGRITY_REPORT.json`);
  console.log(JSON.stringify(report.summary, null, 2));

  store.close();
})().catch(e => { console.error('Download run failed:', e.message); process.exit(1); });
