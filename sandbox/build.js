'use strict';

// Builds sandbox_snapshot.html — a self-contained chart+context page you can
// open directly in a browser or hand to Claude to publish as an Artifact.
// Requires server.js already running on 127.0.0.1:8899 (npm start / PXBOT.bat).

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

(async () => {
  const [tv, ctx] = await Promise.all([get('/api/tvcontext'), get('/api/context')]);

  if (!tv.recent5m || !tv.recent5m.length) {
    console.error('No chart data yet — let the server run a bit longer, or check it finished building tv_context.json.');
    process.exit(1);
  }

  const data = {
    recent5m:      tv.recent5m,
    dailyBars:     (tv.dailyBars || []).slice(-20),
    weeklyProfile: (tv.weeklyProfile || []).slice(-6),
    keySwings:     tv.keySwings || [],
    eqLevels:      tv.eqLevels || [],
    atr14d:        tv.atr14d,
    lastClose:     tv.lastClose,
    dateRange:     tv.dateRange,
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
  console.log(`Wrote ${outPath}`);
  console.log('Open it directly in a browser, or paste it to Claude and ask to republish the sandbox Artifact.');
  console.log('Note: the chart/tables/liquidity list refresh automatically from this data — the "AI Read"');
  console.log('panel is written prose, not a recomputed template. Ask Claude to rewrite that paragraph for');
  console.log('the new data when you hand off a fresh snapshot.');
})().catch(e => {
  console.error('Build failed:', e.message, '— is server.js running on :8899?');
  process.exit(1);
});
