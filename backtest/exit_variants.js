'use strict';

// Tests several exit/management schemes against the SAME entries (same OTE
// touch, same classified days) so differences in result are purely about
// exit logic, not a different signal set. Answers the question the last
// result raised: entries look real (66.7% win rate on 1m fills), total R is
// still ~flat — is that an entry problem or an exit problem?

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { classifyDay, legLevels, DEFAULT_THRESHOLDS } = require('./ict_engine');

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

function sliceByDate(bars) {
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

function findEntry(bias, levels, bars) {
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.low <= levels.oteHigh && b.high >= levels.oteLow) {
      return { idx: i, price: bias === 'BUY' ? Math.min(levels.oteHigh, b.high) : Math.max(levels.oteLow, b.low) };
    }
  }
  return null;
}

// --- Exit variant implementations. Each takes (bias, levels, entryPrice, barsFromEntry) -> { r } ---

function variantBaseline(bias, levels, entryPrice, bars) {
  const risk = Math.abs(entryPrice - levels.sl);
  if (risk <= 0) return null;
  for (const b of bars) {
    const hitSL = bias === 'BUY' ? b.low <= levels.sl : b.high >= levels.sl;
    const hitTP3 = bias === 'BUY' ? b.high >= levels.tp3 : b.low <= levels.tp3;
    const hitTP2 = bias === 'BUY' ? b.high >= levels.tp2 : b.low <= levels.tp2;
    const hitTP1 = bias === 'BUY' ? b.high >= levels.tp1 : b.low <= levels.tp1;
    if (hitSL) return { r: -1, exit: 'SL' };
    if (hitTP3) return { r: Math.abs(levels.tp3 - entryPrice) / risk, exit: 'TP3' };
    if (hitTP2) return { r: Math.abs(levels.tp2 - entryPrice) / risk, exit: 'TP2' };
    if (hitTP1) return { r: Math.abs(levels.tp1 - entryPrice) / risk, exit: 'TP1' };
  }
  return { r: 0, exit: 'TIMEOUT' };
}

// Move stop to breakeven after TP1, to TP1-level after TP2, ride to TP3.
function variantBreakevenLadder(bias, levels, entryPrice, bars) {
  const risk = Math.abs(entryPrice - levels.sl);
  if (risk <= 0) return null;
  let stop = levels.sl, stage = 0; // 0=initial, 1=past TP1, 2=past TP2
  const r1 = Math.abs(levels.tp1 - entryPrice) / risk;
  for (const b of bars) {
    const hitStop = bias === 'BUY' ? b.low <= stop : b.high >= stop;
    if (hitStop) {
      const r = stage === 0 ? -1 : stage === 1 ? 0 : r1;
      return { r, exit: stage === 0 ? 'SL' : stage === 1 ? 'BE' : 'TP1-lock' };
    }
    const hitTP3 = bias === 'BUY' ? b.high >= levels.tp3 : b.low <= levels.tp3;
    if (hitTP3) return { r: Math.abs(levels.tp3 - entryPrice) / risk, exit: 'TP3' };
    const hitTP2 = bias === 'BUY' ? b.high >= levels.tp2 : b.low <= levels.tp2;
    if (hitTP2 && stage < 2) { stage = 2; stop = levels.tp1; }
    const hitTP1 = bias === 'BUY' ? b.high >= levels.tp1 : b.low <= levels.tp1;
    if (hitTP1 && stage < 1) { stage = 1; stop = entryPrice; }
  }
  return { r: stage === 0 ? 0 : stage === 1 ? 0 : r1, exit: 'TIMEOUT' };
}

// Close 50% at TP1 (banked), remaining 50% stop -> breakeven, target TP3.
function variantPartial5050(bias, levels, entryPrice, bars) {
  const risk = Math.abs(entryPrice - levels.sl);
  if (risk <= 0) return null;
  const r1 = Math.abs(levels.tp1 - entryPrice) / risk;
  let stop = levels.sl, bankedFraction = 0, banked = 0;
  for (const b of bars) {
    const hitStop = bias === 'BUY' ? b.low <= stop : b.high >= stop;
    if (hitStop) {
      const remainderR = bankedFraction > 0 ? 0 : -1;
      return { r: banked + (1 - bankedFraction) * remainderR, exit: bankedFraction > 0 ? 'BE-remainder' : 'SL' };
    }
    const hitTP3 = bias === 'BUY' ? b.high >= levels.tp3 : b.low <= levels.tp3;
    if (hitTP3) {
      const r3 = Math.abs(levels.tp3 - entryPrice) / risk;
      return { r: banked + (1 - bankedFraction) * r3, exit: 'TP3-remainder' };
    }
    const hitTP1 = bias === 'BUY' ? b.high >= levels.tp1 : b.low <= levels.tp1;
    if (hitTP1 && bankedFraction === 0) { bankedFraction = 0.5; banked = 0.5 * r1; stop = entryPrice; }
  }
  return { r: banked, exit: 'TIMEOUT' };
}

// Skip TP1/TP2 entirely, single wider target at TP3, with a tighter stop
// (entries are precise on 1m data — test if risk can shrink without losing hits).
function variantTightStopWideTarget(bias, levels, entryPrice, bars, legLow, legHigh) {
  const size = legHigh - legLow;
  const tighterSl = bias === 'BUY' ? legLow + size * 0.02 : legHigh - size * 0.02; // half the default 5% buffer, and just inside the leg
  const risk = Math.abs(entryPrice - tighterSl);
  if (risk <= 0) return null;
  for (const b of bars) {
    const hitSL = bias === 'BUY' ? b.low <= tighterSl : b.high >= tighterSl;
    if (hitSL) return { r: -1, exit: 'SL' };
    const hitTP3 = bias === 'BUY' ? b.high >= levels.tp3 : b.low <= levels.tp3;
    if (hitTP3) return { r: Math.abs(levels.tp3 - entryPrice) / risk, exit: 'TP3' };
  }
  return { r: 0, exit: 'TIMEOUT' };
}

// Bank 50% at TP1 always (a small win locked in immediately). For the other
// 50%: move its stop to breakeven and give it up to `confirmBars` bars to
// prove continuation (make a new favorable extreme beyond TP1) BEFORE it
// touches breakeven again. If it confirms, hold for TP2/TP3, trailing the
// stop up to TP1 once TP2 prints. If it stalls/reverses first, take the
// remainder off at breakeven — the "be cautious, take the small win" case.
function variantPartialAdaptive(bias, levels, entryPrice, bars, legLow, legHigh, confirmBars = 10) {
  const risk = Math.abs(entryPrice - levels.sl);
  if (risk <= 0) return null;
  const r1 = Math.abs(levels.tp1 - entryPrice) / risk;
  let stage = 'pre-tp1', stop = levels.sl, banked = 0, confirmCountdown = 0, bestSinceTp1 = null;

  for (const b of bars) {
    if (stage === 'pre-tp1') {
      const hitStop = bias === 'BUY' ? b.low <= stop : b.high >= stop;
      if (hitStop) return { r: -1, exit: 'SL' };
      const hitTP1 = bias === 'BUY' ? b.high >= levels.tp1 : b.low <= levels.tp1;
      if (hitTP1) { banked = 0.5 * r1; stage = 'confirming'; stop = entryPrice; confirmCountdown = confirmBars; bestSinceTp1 = bias === 'BUY' ? b.high : b.low; continue; }
      continue;
    }
    if (stage === 'confirming') {
      bestSinceTp1 = bias === 'BUY' ? Math.max(bestSinceTp1, b.high) : Math.min(bestSinceTp1, b.low);
      const confirmed = bias === 'BUY' ? bestSinceTp1 > levels.tp1 : bestSinceTp1 < levels.tp1; // made a new extreme beyond TP1
      const hitStop = bias === 'BUY' ? b.low <= stop : b.high >= stop;
      if (hitStop) return { r: banked, exit: confirmed ? 'BE-remainder-after-confirm' : 'BE-remainder-cautious' };
      const hitTP3 = bias === 'BUY' ? b.high >= levels.tp3 : b.low <= levels.tp3;
      if (hitTP3) return { r: banked + 0.5 * (Math.abs(levels.tp3 - entryPrice) / risk), exit: 'TP3-remainder' };
      const hitTP2 = bias === 'BUY' ? b.high >= levels.tp2 : b.low <= levels.tp2;
      if (hitTP2) { stage = 'riding'; stop = levels.tp1; continue; }
      confirmCountdown--;
      if (confirmCountdown <= 0 && !confirmed) return { r: banked, exit: 'BE-remainder-timeout-cautious' };
      continue;
    }
    if (stage === 'riding') {
      const hitStop = bias === 'BUY' ? b.low <= stop : b.high >= stop;
      if (hitStop) return { r: banked + 0.5 * r1, exit: 'TP1-lock-remainder' };
      const hitTP3 = bias === 'BUY' ? b.high >= levels.tp3 : b.low <= levels.tp3;
      if (hitTP3) return { r: banked + 0.5 * (Math.abs(levels.tp3 - entryPrice) / risk), exit: 'TP3-remainder' };
    }
  }
  if (stage === 'pre-tp1') return { r: 0, exit: 'TIMEOUT-no-entry-progress' };
  return { r: banked, exit: 'TIMEOUT' };
}

// Isolates "let it run further" from "tighten the stop" — same original
// stop as baseline, single exit at TP3 instead of the TP1/2/3 ladder.
function variantWideTargetSameStop(bias, levels, entryPrice, bars) {
  const risk = Math.abs(entryPrice - levels.sl);
  if (risk <= 0) return null;
  for (const b of bars) {
    const hitSL = bias === 'BUY' ? b.low <= levels.sl : b.high >= levels.sl;
    if (hitSL) return { r: -1, exit: 'SL' };
    const hitTP3 = bias === 'BUY' ? b.high >= levels.tp3 : b.low <= levels.tp3;
    if (hitTP3) return { r: Math.abs(levels.tp3 - entryPrice) / risk, exit: 'TP3' };
  }
  return { r: 0, exit: 'TIMEOUT' };
}

const VARIANTS = {
  baseline: variantBaseline,
  breakeven_ladder: variantBreakevenLadder,
  partial_50_50: variantPartial5050,
  partial_adaptive: variantPartialAdaptive,
  tight_sl_wide_target: variantTightStopWideTarget,
  wide_target_same_stop: variantWideTargetSameStop,
};

(async () => {
  const deepPath = path.join(__dirname, 'deep_1m.json');
  const execBars = JSON.parse(fs.readFileSync(deepPath, 'utf8'));
  const health = await get('/api/health');
  if (!health.authenticated) { console.error('Not connected.'); process.exit(1); }
  const h1 = await get('/api/candles?resolution=60&count=19000');

  const classByDate = sliceByDate(h1.bars);
  const execByDate  = sliceByDate(execBars);
  const th = { ...DEFAULT_THRESHOLDS };

  const trades = []; // { bias, levels, entryPrice, forwardBars, legLow, legHigh }
  for (const [dateKey, sess] of classByDate.entries()) {
    const execSess = execByDate.get(dateKey);
    if (!execSess || !sess.asia.length || !sess.london.length) continue;
    const cls = classifyDay(sess.asia, sess.london, th);
    if (cls.id === 0 || cls.id === 4) continue;
    const levels = legLevels(cls.bias, cls.legLow, cls.legHigh, th);
    const forward = [...execSess.ny, ...execSess.forward];
    if (!forward.length) continue;
    const entry = findEntry(cls.bias, levels, forward);
    if (!entry) continue;
    trades.push({ bias: cls.bias, levels, entryPrice: entry.price, forwardBars: forward.slice(entry.idx), legLow: cls.legLow, legHigh: cls.legHigh, date: dateKey });
  }

  console.log(`${trades.length} entries found (same entry set for every variant below).\n`);

  for (const [name, fn] of Object.entries(VARIANTS)) {
    let totalR = 0, wins = 0, losses = 0, breakevens = 0, n = 0;
    for (const t of trades) {
      const res = fn(t.bias, t.levels, t.entryPrice, t.forwardBars, t.legLow, t.legHigh);
      if (!res) continue;
      n++;
      totalR += res.r;
      if (res.r > 0.001) wins++; else if (res.r < -0.001) losses++; else breakevens++;
    }
    console.log(`${name}: n=${n}  totalR=${totalR.toFixed(2)}  avgR=${(totalR / n).toFixed(3)}  wins=${wins} losses=${losses} scratches=${breakevens}  (full-win rate ${(100 * wins / (wins + losses || 1)).toFixed(1)}%, non-loss rate ${(100 * (wins + breakevens) / n).toFixed(1)}%)`);
  }

  console.log('\nSample size reminder: n is in the 30s. Directionally informative, not statistically proven.');

  // --- Selectivity: does filtering for bigger/cleaner legs improve quality? ---
  console.log('\n=== SELECTIVITY: bigger legs only (fewer trades, same two best exit schemes) ===');
  const legSizes = trades.map(t => Math.abs(t.legHigh - t.legLow)).sort((a, b) => a - b);
  const median = legSizes[Math.floor(legSizes.length / 2)];
  const thresholds = [0, Math.round(median * 0.75), Math.round(median), Math.round(median * 1.5), Math.round(median * 2)];

  for (const minLeg of thresholds) {
    const filtered = trades.filter(t => Math.abs(t.legHigh - t.legLow) >= minLeg);
    for (const name of ['baseline', 'breakeven_ladder', 'partial_adaptive']) {
      const fn = VARIANTS[name];
      let totalR = 0, n = 0;
      for (const t of filtered) {
        const res = fn(t.bias, t.levels, t.entryPrice, t.forwardBars, t.legLow, t.legHigh);
        if (!res) continue;
        n++; totalR += res.r;
      }
      console.log(`  minLeg>=${minLeg}pt  ${name}: n=${n}  totalR=${totalR.toFixed(2)}  avgR=${n ? (totalR / n).toFixed(3) : 'n/a'}`);
    }
  }

  // --- Out-of-sample check on the two most promising leg-size filters ---
  // Same trap as the earlier 1440-combo sweep is possible here too: picking
  // whichever minLeg looked best in-sample and reporting that alone. Split
  // chronologically (first 60% / last 40%, test half never used to pick the
  // filter) before calling anything promising.
  console.log('\n=== OUT-OF-SAMPLE CHECK on the leg-size filter (chronological split) ===');
  trades.sort((a, b) => a.date < b.date ? -1 : 1);
  for (const minLeg of [150, 199]) {
    const filtered = trades.filter(t => Math.abs(t.legHigh - t.legLow) >= minLeg);
    const splitIdx = Math.ceil(filtered.length * 0.6);
    const train = filtered.slice(0, splitIdx), test = filtered.slice(splitIdx);
    const score = (arr, variantName) => {
      let r = 0, n = 0;
      for (const t of arr) { const res = VARIANTS[variantName](t.bias, t.levels, t.entryPrice, t.forwardBars, t.legLow, t.legHigh); if (!res) continue; n++; r += res.r; }
      return { n, totalR: +r.toFixed(2), avgR: n ? +(r / n).toFixed(3) : null };
    };
    for (const variantName of ['partial_adaptive', 'breakeven_ladder']) {
      const trainScore = score(train, variantName), testScore = score(test, variantName);
      console.log(`  minLeg>=${minLeg}pt [${variantName}]: TRAIN ${JSON.stringify(trainScore)} [${train[0]?.date} -> ${train[train.length-1]?.date}]`);
      console.log(`  minLeg>=${minLeg}pt [${variantName}]: TEST  ${JSON.stringify(testScore)} [${test[0]?.date} -> ${test[test.length-1]?.date}] (never used to pick this filter)`);
    }
  }
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
