'use strict';

// Live spread measurement — replaces the ASSUMED 2pt NAS100 spread in the
// cost model with a real measurement from this account's actual feed.
// Read-only: polls /trade/quotes for a few minutes and reports the bid/ask
// spread distribution. The single highest-leverage number in the capped-
// scalp research: at ≤30pt stops, per-trade cost is dominated by spread,
// and the 1m candidates died by roughly the size of the assumption.
//
// Usage: node -r ./scripts/load_env.js scripts/measure_spread.js [samples=60] [intervalMs=2000]

const { TradeLockerClient, tlRequest } = require('../lib/tradelocker_client');

(async () => {
  const samples = parseInt(process.argv[2] || '60', 10);
  const intervalMs = parseInt(process.argv[3] || '2000', 10);
  const email = process.env.PXBOT_EMAIL, password = process.env.PXBOT_PASSWORD, server = process.env.PXBOT_SERVER;
  if (!email || !password || !server) { console.error('Missing PXBOT_* env vars.'); process.exit(1); }

  const client = new TradeLockerClient({ email, password, server });
  const conn = await client.connect('NAS');
  console.log(`Connected: ${conn.symbol} (instrumentId=${conn.instrumentId}, routeId=${conn.infoRouteId})`);
  console.log(`Sampling ${samples} quotes at ${intervalMs}ms intervals (~${Math.round(samples * intervalMs / 60000)} min)...\n`);

  const spreads = [];
  let lastPrice = null;
  for (let i = 0; i < samples; i++) {
    try {
      const r = await tlRequest('GET', `/trade/quotes?tradableInstrumentId=${client.instrumentId}&routeId=${client.infoRouteId}`, null, client.token, client.accNum);
      const q = r.json?.d;
      const bp = parseFloat(q?.bp || 0), ap = parseFloat(q?.ap || 0);
      if (bp > 0 && ap > 0 && ap >= bp) {
        const spread = +(ap - bp).toFixed(2);
        spreads.push(spread);
        lastPrice = (bp + ap) / 2;
        if (i % 10 === 0) process.stdout.write(`  sample ${i}: bid=${bp} ask=${ap} spread=${spread}pts\n`);
      }
    } catch (e) { /* transient failure — skip sample */ }
    await new Promise(res => setTimeout(res, intervalMs));
  }

  if (spreads.length < 10) {
    console.error(`\nOnly ${spreads.length} valid samples — market may be closed or feed unavailable. NOT enough to replace the assumption; keeping the 2pt assumed spread.`);
    process.exit(1);
  }

  spreads.sort((a, b) => a - b);
  const pct = p => spreads[Math.min(spreads.length - 1, Math.floor(p * spreads.length))];
  const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  const result = {
    measuredAt: new Date().toISOString(),
    symbol: conn.symbol, instrumentId: conn.instrumentId,
    validSamples: spreads.length, approxPrice: lastPrice ? +lastPrice.toFixed(1) : null,
    spreadPts: {
      min: spreads[0], p25: pct(0.25), median: pct(0.5), mean: +mean.toFixed(2),
      p75: pct(0.75), p90: pct(0.9), p95: pct(0.95), max: spreads.at(-1),
    },
    note: 'Sunday-evening Globex reopen liquidity may differ from regular-hours liquidity — treat as a first measurement; re-run during NY AM hours for the number that matters most to NY-session strategies.',
  };
  console.log('\n=== MEASURED SPREAD (real feed, not an assumption) ===');
  console.log(JSON.stringify(result, null, 2));

  require('fs').writeFileSync(require('path').join(__dirname, '..', 'data', 'logs', 'measured_spread.json'), JSON.stringify(result, null, 2));
  console.log('\nSaved to data/logs/measured_spread.json');
})().catch(e => { console.error('Spread measurement failed:', e.message); process.exit(1); });
