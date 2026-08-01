'use strict';

// Pages past TradeLocker's 20,000-bar-per-request cap to build a deep,
// continuous fine-resolution (default 1-minute) dataset for backtesting real
// entry timing, not just hourly-approximated fills. Requires server.js
// running and connected — reads store internals via the /api/candles proxy
// isn't enough here (it computes its own from/to), so this talks to the
// documented TradeLocker endpoint directly using the token server.js already
// holds (fetched via /api/health + /api/debug for instrId/routeId/accNum,
// and the token via /api/debug is NOT exposed for security — so this script
// takes email/password itself and authenticates independently, read-only).

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
  if (!Array.isArray(bd)) return [];
  return bd.map(b => ({
    time: Math.floor(parseInt(b.t || 0) / 1000),
    open: parseFloat(b.o || 0), high: parseFloat(b.h || 0), low: parseFloat(b.l || 0), close: parseFloat(b.c || 0),
    volume: parseInt(b.v || 0),
  })).filter(b => b.close > 0 && b.time > 0);
}

(async () => {
  // Credentials via env vars, not argv — argv is visible in `ps` and shell history.
  const email      = process.env.PXBOT_EMAIL;
  const password   = process.env.PXBOT_PASSWORD;
  const accServer  = process.env.PXBOT_SERVER;
  const [,, resolutionArg, totalDaysArg] = process.argv;
  if (!email || !password || !accServer) {
    console.error('Usage: PXBOT_EMAIL=... PXBOT_PASSWORD=... PXBOT_SERVER=... node backtest/fetch_deep.js [resolution=1m] [totalDays=180]');
    process.exit(1);
  }
  const resolution = resolutionArg || '1m';
  const totalDays = parseInt(totalDaysArg || '180');
  const chunkDays = resolution === '1m' ? 13 : resolution === '5m' ? 65 : 800; // stay under 20k bars/request

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
  console.log(`Instrument ${nas.name} (${nas.tradableInstrumentId}), route ${infoRoute.id}, accNum ${accNum}`);

  const now = Math.floor(Date.now() / 1000);
  const allBars = [];
  let cursor = now;
  let emptyStreak = 0;
  const maxChunks = Math.ceil(totalDays / chunkDays) + 2;

  for (let i = 0; i < maxChunks && (now - cursor) / 86400 < totalDays; i++) {
    const to = cursor;
    const from = cursor - chunkDays * 86400;
    const json = await tlFetch(`/trade/history?tradableInstrumentId=${nas.tradableInstrumentId}&routeId=${infoRoute.id}&resolution=${resolution}&from=${from * 1000}&to=${to * 1000}`, token, accNum);
    const bars = parseBarDetails(json);
    console.log(`  chunk ${i}: ${new Date(from * 1000).toDateString()} -> ${new Date(to * 1000).toDateString()}: ${bars.length} bars`);
    if (bars.length === 0) {
      emptyStreak++;
      if (emptyStreak >= 3) { console.log('  3 empty chunks in a row — stopping (likely hit data retention limit).'); break; }
    } else {
      emptyStreak = 0;
      allBars.push(...bars);
    }
    cursor = from;
    await new Promise(r => setTimeout(r, 300)); // be polite to the broker's API
  }

  allBars.sort((a, b) => a.time - b.time);
  const seen = new Set();
  const deduped = allBars.filter(b => { if (seen.has(b.time)) return false; seen.add(b.time); return true; });

  const fs = require('fs');
  const path = require('path');
  const outPath = path.join(__dirname, `deep_${resolution}.json`);
  fs.writeFileSync(outPath, JSON.stringify(deduped));
  console.log(`\nWrote ${deduped.length} bars (${((deduped[deduped.length-1]?.time - deduped[0]?.time) / 86400).toFixed(1)} days) to ${outPath}`);
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
