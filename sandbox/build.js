'use strict';

// Builds sandbox_snapshot.html — a self-contained chart+context page you can
// open directly in a browser or hand to Claude to publish as an Artifact.
// Pulls LITERAL TradeLocker data (not the NDX fallback) via the already-running
// server.js on 127.0.0.1:8899 — connect via the app's login UI first.

const fs   = require('fs');
const path = require('path');
const http = require('http');
const structureEngine = require('../engine/structure_engine');

function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: 8899, path: p }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function fmtDate(t) {
  return new Date(t * 1000).toLocaleDateString('en-US', { timeZone: 'America/Chicago' });
}

// Delegates to engine/structure_engine.js (consolidated — this used to be a
// third independent copy of the same swing/EQ/ATR/weekly-profile logic also
// duplicated in server.js and app.js). Output shape/rounding preserved exactly.
function findSwings(daily) {
  return structureEngine.findSwingPoints(daily, 2).map(s => ({
    type: s.type, price: +s.price.toFixed(2), date: fmtDate(s.bar.time),
  }));
}

function findEqLevels(daily) {
  const recent = daily.slice(-60);
  return structureEngine.findEqualLevels(recent, 10, 10).map(e => ({
    type: e.type, price: +e.price.toFixed(2), dates: [fmtDate(e.barI.time), fmtDate(e.barJ.time)],
  }));
}

function atr14(daily) {
  return +structureEngine.atr(daily, 14).toFixed(1);
}

function weeklyProfile(daily) {
  return structureEngine.weeklyProfile(daily, 5).map(w => ({
    weekStart: fmtDate(w.weekStartTime), open: w.open, close: w.close,
    high: +w.high.toFixed(2), low: +w.low.toFixed(2), range: +w.range.toFixed(1),
    bias: w.bias,
  }));
}

(async () => {
  const health = await get('/api/health');
  if (!health.authenticated) {
    console.error('Not connected to TradeLocker — log in via the app UI first, then re-run this.');
    process.exit(1);
  }

  const [m1, h1, d1, ctx] = await Promise.all([
    get('/api/candles?resolution=1&count=19000'), // 1-minute — precise entries, ~1 trading day per pull
    get('/api/candles?resolution=60&count=1500'),
    get('/api/candles?resolution=1440&count=500'),
    get('/api/context'),
  ]);

  if (!m1.bars || !m1.bars.length || !d1.bars || !d1.bars.length) {
    console.error('No literal TradeLocker bars came back yet (source:', m1.source, '). Let the connection settle and retry.');
    process.exit(1);
  }
  if (m1.source !== 'tradelocker' || d1.source !== 'tradelocker') {
    console.warn(`Warning: candles came back as source="${m1.source}"/"${d1.source}", not "tradelocker" — this snapshot may still be the NDX-calibrated fallback.`);
  }

  const daily = d1.bars;
  const data = {
    recent1m:      m1.bars.slice(-700),
    dailyBars:     daily.slice(-20),
    weeklyProfile: weeklyProfile(daily).slice(-6),
    keySwings:     findSwings(daily).slice(-18),
    eqLevels:      findEqLevels(daily).slice(-10),
    atr14d:        atr14(daily),
    lastClose:     daily[daily.length - 1].close,
    dateRange:     `${fmtDate(daily[0].time)} → ${fmtDate(daily[daily.length - 1].time)}`,
    barCounts:     { m1: m1.bars.length, h1: h1.bars.length, d1: daily.length },
  };
  const ctxOut = {
    dayOfWeek:       ctx.dayOfWeek,
    monthlyBias:     ctx.monthlyBias,
    quarterTendency: ctx.quarterTendency,
    sessions:        ctx.sessions,
    keyRules:        ctx.keyRules,
  };

  const tpl = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
  const out = tpl
    .replace('__DATA_JSON__', JSON.stringify(data))
    .replace('__CTX_JSON__', JSON.stringify(ctxOut));

  const outPath = path.join(__dirname, '..', 'sandbox_snapshot.html');
  fs.writeFileSync(outPath, out);
  console.log(`Wrote ${outPath} — ${data.recent1m.length} literal 1m bars, ${data.dailyBars.length} daily, covering ${data.dateRange}.`);
  console.log('Open it directly in a browser, or paste it to Claude and ask to republish the sandbox Artifact.');
  console.log('Note: the "AI Read" panel is written prose, not a recomputed template — ask Claude to rewrite');
  console.log('that paragraph for the new data when you hand off a fresh snapshot.');
})().catch(e => {
  console.error('Build failed:', e.message, '— is server.js running and connected on :8899?');
  process.exit(1);
});
