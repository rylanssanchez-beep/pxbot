'use strict';

// Builds sandbox_snapshot.html — a self-contained chart+context page you can
// open directly in a browser or hand to Claude to publish as an Artifact.
// Pulls LITERAL TradeLocker data (not the NDX fallback) via the already-running
// server.js on 127.0.0.1:8899 — connect via the app's login UI first.

const fs   = require('fs');
const path = require('path');
const http = require('http');

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

function findSwings(daily) {
  const swings = [];
  for (let i = 2; i < daily.length - 2; i++) {
    const b = daily[i];
    if (b.high > daily[i-1].high && b.high > daily[i-2].high && b.high > daily[i+1].high && b.high > daily[i+2].high)
      swings.push({ type: 'SH', price: +b.high.toFixed(2), date: fmtDate(b.time) });
    if (b.low < daily[i-1].low && b.low < daily[i-2].low && b.low < daily[i+1].low && b.low < daily[i+2].low)
      swings.push({ type: 'SL', price: +b.low.toFixed(2), date: fmtDate(b.time) });
  }
  return swings;
}

function findEqLevels(daily) {
  const eq = [];
  const recent = daily.slice(-60);
  for (let i = 0; i < recent.length - 1; i++) {
    for (let j = i + 1; j < Math.min(i + 10, recent.length); j++) {
      if (Math.abs(recent[i].high - recent[j].high) < 10)
        eq.push({ type: 'EQH', price: +((recent[i].high + recent[j].high) / 2).toFixed(2), dates: [fmtDate(recent[i].time), fmtDate(recent[j].time)] });
      if (Math.abs(recent[i].low - recent[j].low) < 10)
        eq.push({ type: 'EQL', price: +((recent[i].low + recent[j].low) / 2).toFixed(2), dates: [fmtDate(recent[i].time), fmtDate(recent[j].time)] });
    }
  }
  return eq;
}

function atr14(daily) {
  const tail = daily.slice(-15);
  const trs = tail.map((b, i) => i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - tail[i-1].close), Math.abs(b.low - tail[i-1].close)));
  return +(trs.slice(-14).reduce((a, b) => a + b, 0) / 14).toFixed(1);
}

function weeklyProfile(daily) {
  const weeks = [];
  for (let i = 0; i < daily.length; i += 5) {
    const chunk = daily.slice(i, i + 5);
    if (!chunk.length) continue;
    const hi = Math.max(...chunk.map(b => b.high)), lo = Math.min(...chunk.map(b => b.low));
    weeks.push({
      weekStart: fmtDate(chunk[0].time), open: chunk[0].open, close: chunk[chunk.length-1].close,
      high: +hi.toFixed(2), low: +lo.toFixed(2), range: +(hi - lo).toFixed(1),
      bias: chunk[chunk.length-1].close > chunk[0].open ? 'BULL' : 'BEAR',
    });
  }
  return weeks;
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
