'use strict';

// ─── Confirmation Engine gating validation, at REAL EXECUTION GRANULARITY ──
// confirmation_backtest.js validates against hourly bars for both
// classification and execution — an approximation matching ict_engine.js/
// orb_engine.js's own documented hourly tradeoff (full 2+ year history is
// only available at hourly resolution). But this account's real entries/
// exits happen on the 1-minute chart, and the confirmation engine's
// FVG/order-block/displacement/VWAP/sweep checks now read real 1-minute
// bars live (server.js:computeSignalConfirmation) — so THIS script closes
// that validation gap: same hourly-classify approach as
// backtest/finegrain.js (Asia/London ranges need long history), but real
// 1-minute bars for both trade simulation AND confirmation-engine scoring,
// restricted to the ~207-day window where continuous 1m history actually
// exists (backtest/deep_1m.json, built via fetch_deep.js's deep pagination —
// a single /api/candles request only reaches ~9-10 days).
//
// Usage: node backtest/confirmation_backtest_finegrain.js
//   Requires server.js running+connected (for hourly classification bars +
//   MTF context) and backtest/deep_1m.json already built via:
//   PXBOT_EMAIL=... PXBOT_PASSWORD=... PXBOT_SERVER=... node backtest/fetch_deep.js 1m 200

const fs = require('fs');
const path = require('path');
const http = require('http');
const ictEngine = require('./ict_engine');
const orbEngine = require('./orb_engine');
const fractalEngine = require('../engine/fractal_engine');
const confirmationEngine = require('../engine/confirmation_engine');

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

const _dateKeyCache = new WeakMap();
function ctDateKeyCached(bar) {
  let key = _dateKeyCache.get(bar);
  if (key === undefined) { key = ctParts(bar.time).dateKey; _dateKeyCache.set(bar, key); }
  return key;
}

function sliceByDateFine(bars) {
  const byDate = new Map();
  const ensure = key => { if (!byDate.has(key)) byDate.set(key, { asia: [], london: [], ny: [], forward: [] }); return byDate.get(key); };
  for (const b of bars) {
    const { hour, dateKey, jsDate } = ctParts(b.time);
    if (hour >= 19) { const next = new Date(jsDate); next.setDate(next.getDate() + 1); ensure(next.toISOString().slice(0, 10)).asia.push(b); }
    else if (hour < 1) ensure(dateKey).asia.push(b);
    else if (hour < 7) ensure(dateKey).london.push(b);
    else if (hour >= 9.5 && hour < 15) ensure(dateKey).ny.push(b);
    else if (hour >= 15) ensure(dateKey).forward.push(b);
  }
  return byDate;
}

// Mirrors orb_engine.js's simulateOrbDay exactly, adapted to take an
// explicit bar-count budget (maxHoldBars) instead of orb_engine's
// hourly-bar-implicit "maxHoldHours" — at 1-minute resolution that name
// would silently mean 8 BARS (8 minutes) instead of 8 hours, which would be
// wrong. No change to orb_engine.js itself.
function simulateOrbDayFine(rangeBar, forwardBars, th, maxHoldBars) {
  const size = rangeBar.high - rangeBar.low;
  if (size <= 0 || size < th.minRangeSize) return null;
  let bias = null, entryPrice = null, entryIdx = -1;
  const scan = forwardBars.slice(0, maxHoldBars);
  for (let i = 0; i < scan.length; i++) {
    const b = scan[i];
    if (b.high > rangeBar.high) { bias = 'BUY'; entryPrice = rangeBar.high; entryIdx = i; break; }
    if (b.low < rangeBar.low) { bias = 'SELL'; entryPrice = rangeBar.low; entryIdx = i; break; }
  }
  if (!bias) return { entered: false };
  const sl = bias === 'BUY' ? rangeBar.low - size * th.slBufferPct : rangeBar.high + size * th.slBufferPct;
  const target = bias === 'BUY' ? entryPrice + size * th.targetMultiple : entryPrice - size * th.targetMultiple;
  const risk = Math.abs(entryPrice - sl);
  if (risk <= 0) return { entered: false };
  for (let i = entryIdx; i < scan.length; i++) {
    const b = scan[i];
    const hitSL = bias === 'BUY' ? b.low <= sl : b.high >= sl;
    const hitTarget = bias === 'BUY' ? b.high >= target : b.low <= target;
    if (hitSL) return { entered: true, bias, r: -1, exit: 'SL' };
    if (hitTarget) return { entered: true, bias, r: Math.abs(target - entryPrice) / risk, exit: 'TARGET' };
  }
  return { entered: true, bias, r: 0, exit: 'TIMEOUT' };
}

function hourlyToH4(bars) {
  const out = [];
  for (let i = 0; i < bars.length; i += 4) {
    const chunk = bars.slice(i, i + 4);
    if (!chunk.length) continue;
    out.push({ time: chunk[0].time, open: chunk[0].open, close: chunk[chunk.length - 1].close,
      high: Math.max(...chunk.map(b => b.high)), low: Math.min(...chunk.map(b => b.low)),
      volume: chunk.reduce((a, b) => a + (b.volume || 0), 0) });
  }
  return out;
}
function hourlyToDaily(bars) {
  const byDate = new Map();
  for (const b of bars) { const key = ctDateKeyCached(b); if (!byDate.has(key)) byDate.set(key, []); byDate.get(key).push(b); }
  const out = [];
  for (const chunk of byDate.values()) {
    out.push({ time: chunk[0].time, open: chunk[0].open, close: chunk[chunk.length - 1].close,
      high: Math.max(...chunk.map(b => b.high)), low: Math.min(...chunk.map(b => b.low)),
      volume: chunk.reduce((a, b) => a + (b.volume || 0), 0) });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}
function truncate(bars, cutoffTime) {
  const idx = bars.findIndex(b => b.time > cutoffTime);
  return idx === -1 ? bars : bars.slice(0, idx);
}

function scoreTradeFine(bias, quote, entryZone, hourlyBarsFull, m1BarsFull, cutoffTime, ictResult, orbResult) {
  const availableHourly = truncate(hourlyBarsFull, cutoffTime);
  const availableM1 = truncate(m1BarsFull, cutoffTime);
  if (availableHourly.length < 60 || availableM1.length < 60) return null;
  const recentM1 = availableM1.slice(-1000); // ~16.7 hours of real 1-minute execution context
  const daily = hourlyToDaily(availableHourly);
  const h4 = hourlyToH4(availableHourly);
  const weekly = fractalEngine.aggregateToTimeframe(daily, 'week');
  const monthly = fractalEngine.aggregateToTimeframe(daily, 'month');
  const barsByTF = { m1: recentM1, h1: availableHourly.slice(-200), h4, d1: daily, weekly, monthly };
  return confirmationEngine.computeConfirmation({ bias, quote, entryZone, executionBars: recentM1, barsByTF, ictResult, orbResult });
}

function stratifyByTier(results) {
  const byTier = {};
  for (const r of results) {
    if (!byTier[r.tier]) byTier[r.tier] = { n: 0, wins: 0, totalR: 0 };
    byTier[r.tier].n++; byTier[r.tier].totalR += r.r;
    if (r.r > 0.001) byTier[r.tier].wins++;
  }
  for (const k of Object.keys(byTier)) {
    byTier[k].winRate = +((byTier[k].wins / byTier[k].n) * 100).toFixed(1);
    byTier[k].avgR = +(byTier[k].totalR / byTier[k].n).toFixed(3);
    byTier[k].totalR = +byTier[k].totalR.toFixed(2);
  }
  return byTier;
}

(async () => {
  const deepPath = path.join(__dirname, 'deep_1m.json');
  if (!fs.existsSync(deepPath)) {
    console.error('backtest/deep_1m.json not found. Build it first with:');
    console.error('  PXBOT_EMAIL=... PXBOT_PASSWORD=... PXBOT_SERVER=... node backtest/fetch_deep.js 1m 200');
    process.exit(1);
  }
  const m1Bars = JSON.parse(fs.readFileSync(deepPath, 'utf8'));
  console.log(`Loaded ${m1Bars.length} real 1-minute bars, ${((m1Bars[m1Bars.length - 1].time - m1Bars[0].time) / 86400).toFixed(1)} days.`);

  const health = await get('/api/health');
  if (!health.authenticated) { console.error('Not connected to TradeLocker — log in via the app UI first, then re-run this.'); process.exit(1); }
  const h1data = await get('/api/candles?resolution=60&count=19000');
  if (!h1data.bars || !h1data.bars.length) { console.error('No hourly bars.'); process.exit(1); }
  const hourlyBars = h1data.bars;
  console.log(`Loaded ${hourlyBars.length} hourly bars for classification + MTF context.\n`);

  const ictTh = { ...ictEngine.DEFAULT_THRESHOLDS, minLegSize: 199 };
  const orbTh = { ...orbEngine.DEFAULT_ORB, rangeHour: 9, targetMultiple: 0.5, slBufferPct: 0.05, minRangeSize: 100 };

  const classByDate = sliceByDateFine(hourlyBars);
  const execByDate = sliceByDateFine(m1Bars);
  const results = [];

  for (const [dateKey, sess] of classByDate.entries()) {
    const execSess = execByDate.get(dateKey);
    if (!execSess) continue; // no real 1m coverage this date — skip rather than fall back to hourly (that would defeat the point)
    if (!sess.asia.length || !sess.london.length) continue;

    // ICT — classify on hourly Asia/London, simulate entry/exit on REAL 1m NY+forward bars
    const cls = ictEngine.classifyDay(sess.asia, sess.london, ictTh);
    if (cls.id !== 0 && cls.id !== 4) {
      const levels = ictEngine.legLevels(cls.bias, cls.legLow, cls.legHigh, ictTh);
      const forward = [...execSess.ny, ...execSess.forward];
      if (forward.length) {
        const sim = ictEngine.simulateTrade(cls.bias, levels, forward, 1800); // 1800 1-min bars = 30 hours, matches the hourly version's maxForwardBars=30
        if (sim.entered) {
          const decisionTime = sess.london[sess.london.length - 1].time;
          const entryZone = { low: levels.oteLow, high: levels.oteHigh };
          const report = scoreTradeFine(cls.bias, sim.entryPrice, entryZone, hourlyBars, m1Bars, decisionTime, { bias: cls.bias }, null);
          if (report) {
            const r = sim.result === 'SL' ? -1 : (sim.result === 'TIMEOUT' ? 0 : Number(sim.r) || 0);
            results.push({ date: dateKey, strategy: 'ICT', bias: cls.bias, tier: report.tier, confidence: report.confidence, r, result: sim.result, time: decisionTime });
          }
        }
      }
    }
  }

  // ORB needs its own date grouping (orb_engine.sliceByDate's bucketing differs from ICT's session buckets)
  const orbByDate = orbEngine.sliceByDate(hourlyBars, orbTh);
  for (const [dateKey, entry] of orbByDate.entries()) {
    if (!entry.rangeBar) continue;
    const execSess1m = m1Bars.filter(b => ctDateKeyCached(b) === dateKey && ctParts(b.time).hour > orbTh.rangeHour);
    if (!execSess1m.length) continue;
    const sim = simulateOrbDayFine(entry.rangeBar, execSess1m, orbTh, 480); // 480 1-min bars = 8 hours, matches orb_engine's default maxHoldHours=8
    if (!sim || !sim.entered) continue;
    const decisionTime = entry.rangeBar.time;
    const size = entry.rangeBar.high - entry.rangeBar.low;
    const entryPrice = sim.bias === 'BUY' ? entry.rangeBar.high : entry.rangeBar.low;
    const entryZone = { low: Math.min(entryPrice, entryPrice - size * 0.1), high: Math.max(entryPrice, entryPrice + size * 0.1) };
    const report = scoreTradeFine(sim.bias, entryPrice, entryZone, hourlyBars, m1Bars, decisionTime, null, { bias: sim.bias });
    if (!report) continue;
    results.push({ date: dateKey, strategy: 'ORB', bias: sim.bias, tier: report.tier, confidence: report.confidence, r: sim.r, result: sim.exit, time: decisionTime });
  }

  results.sort((a, b) => a.time - b.time);
  console.log(`${results.length} trades scored at REAL 1-minute execution granularity (ICT + ORB combined, no-lookahead).\n`);

  console.log('=== COMBINED (real 1m execution, real MTF context) ===');
  const combined = stratifyByTier(results);
  for (const tier of ['A+', 'A', 'B', 'skip']) {
    if (!combined[tier]) { console.log(`  ${tier}: no trades`); continue; }
    const t = combined[tier];
    console.log(`  ${tier}: n=${t.n}, winRate=${t.winRate}%, avgR=${t.avgR}, totalR=${t.totalR}`);
  }

  console.log('\n=== HYPOTHESIS CHECK (reported honestly either way) ===');
  const order = ['skip', 'B', 'A', 'A+'];
  const avgRs = order.map(t => combined[t] ? combined[t].avgR : null);
  let monotonic = true;
  for (let i = 1; i < avgRs.length; i++) { if (avgRs[i] === null || avgRs[i - 1] === null) continue; if (avgRs[i] < avgRs[i - 1]) monotonic = false; }
  console.log(`avgR by tier (skip -> B -> A -> A+): ${JSON.stringify(avgRs)}`);
  console.log(monotonic ? 'Monotonically non-decreasing — consistent with the hypothesis, at REAL execution granularity.' : 'NOT monotonic at real execution granularity — reported as-is.');

  const outPath = path.join(__dirname, 'confirmation_backtest_finegrain_results.json');
  fs.writeFileSync(outPath, JSON.stringify({ combined, tradeCount: results.length, trades: results }, null, 2));
  console.log(`\nFull results written to ${outPath}`);
})().catch(e => { console.error('Finegrain confirmation backtest failed:', e.message, e.stack); process.exit(1); });
