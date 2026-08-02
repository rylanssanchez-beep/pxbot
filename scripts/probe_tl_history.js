'use strict';

// One-time empirical probe: what is TradeLocker's actual max bars returned
// per /trade/history request, for each resolution? Widens the requested
// window until the returned bar count stops growing (plateaus) — that
// plateau is the real per-request cap, not an assumption from comments.
// Read-only. Prints results as JSON to stdout; writes nothing to disk.

const https = require('https');

function tlFetch(pathAndQuery, token, accNum) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'bsa.tradelocker.com', port: 443, path: `/backend-api${pathAndQuery}`, method: 'GET',
      headers: { Authorization: `Bearer ${token}`, accNum: String(accNum || '') },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function tlAuth(email, password, server) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ email, password, server });
    const opts = {
      hostname: 'bsa.tradelocker.com', port: 443, path: '/backend-api/auth/jwt/token', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseBarDetails(json) {
  const bd = json?.d?.barDetails;
  if (!Array.isArray(bd)) return { bars: [], raw: json };
  return {
    bars: bd.map(b => ({
      time: Math.floor(parseInt(b.t || 0) / 1000),
      open: parseFloat(b.o || 0), high: parseFloat(b.h || 0), low: parseFloat(b.l || 0), close: parseFloat(b.c || 0),
      volume: parseInt(b.v || 0),
    })).filter(b => b.close > 0 && b.time > 0),
  };
}

// windowDays to try, ascending, per resolution — chosen so the largest value
// is well beyond any bar-count cap even for the finest resolution (1m).
const PROBE_PLAN = {
  '1m':  [1, 3, 7, 15, 30, 60, 120],
  '5m':  [5, 15, 30, 60, 120, 240],
  '15m': [15, 45, 90, 180, 400],
  '1H':  [60, 180, 400, 800, 1600, 3200],
  '1D':  [365, 1000, 2000, 4000],
};

(async () => {
  const email = process.env.PXBOT_EMAIL, password = process.env.PXBOT_PASSWORD, accServer = process.env.PXBOT_SERVER;
  if (!email || !password || !accServer) {
    console.error('Missing PXBOT_EMAIL/PXBOT_PASSWORD/PXBOT_SERVER in environment.');
    process.exit(1);
  }
  const auth = await tlAuth(email, password, accServer);
  const token = auth.accessToken;
  if (!token) { console.error('Auth failed:', JSON.stringify(auth).slice(0, 200)); process.exit(1); }

  const accounts = await tlFetch('/auth/jwt/all-accounts', token, '');
  const acct = accounts?.accounts?.[0];
  const accNum = acct?.accNum;
  const instruments = await tlFetch(`/trade/accounts/${acct.id}/instruments`, token, accNum);
  const list = Array.isArray(instruments?.d) ? instruments.d : (instruments?.d?.instruments || []);
  const nas = list.find(i => (i.name || '').toUpperCase().includes('NAS') || (i.description || '').toLowerCase().includes('nasdaq'));
  if (!nas) { console.error('Could not find NAS100 instrument.'); process.exit(1); }
  const infoRoute = (nas.routes || []).find(r => r.type === 'INFO') || (nas.routes || [])[0];
  console.error(`Instrument ${nas.name} (${nas.tradableInstrumentId}), route ${infoRoute.id}, accNum ${accNum}\n`);

  const now = Math.floor(Date.now() / 1000);
  const results = {};

  for (const [res, windowDaysList] of Object.entries(PROBE_PLAN)) {
    results[res] = [];
    let prevCount = -1, plateauAt = null;
    for (const days of windowDaysList) {
      const to = now, from = now - days * 86400;
      const json = await tlFetch(`/trade/history?tradableInstrumentId=${nas.tradableInstrumentId}&routeId=${infoRoute.id}&resolution=${res}&from=${from * 1000}&to=${to * 1000}`, token, accNum);
      const { bars } = parseBarDetails(json);
      const oldest = bars[0]?.time, newest = bars[bars.length - 1]?.time;
      const row = { windowDays: days, barsReturned: bars.length, oldest, newest,
        oldestDate: oldest ? new Date(oldest * 1000).toISOString() : null,
        newestDate: newest ? new Date(newest * 1000).toISOString() : null };
      results[res].push(row);
      console.error(`  ${res} window=${days}d -> ${bars.length} bars  [${row.oldestDate} .. ${row.newestDate}]`);
      if (plateauAt === null && prevCount !== -1 && bars.length > 0 && bars.length === prevCount) {
        plateauAt = bars.length;
      }
      prevCount = bars.length;
      await new Promise(r => setTimeout(r, 400));
    }
    results[res].push({ plateauDetected: plateauAt });
    console.error(`  -> ${res}: ${plateauAt ? `plateau detected at ${plateauAt} bars (this is the real per-request cap)` : 'no plateau in tested range — cap not yet reached, or fewer bars exist than the cap allows'}\n`);
  }

  console.log(JSON.stringify(results, null, 2));
})().catch(e => { console.error('Probe failed:', e.message); process.exit(1); });
