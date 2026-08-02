'use strict';

// ICT session-scenario classifier + trade simulator.
// Codifies the 4-scenario playbook already described in app.js (SCENARIOS) as
// deterministic rules over continuous OHLC bars, so it can be run against real
// history instead of only existing as prompt text for an LLM to interpret.
//
// All tunable knobs live in DEFAULT_THRESHOLDS and are threaded through every
// function as a parameter (never read from module scope) so backtest/sweep.js
// can grid-search them — that's the actual "self-improving" mechanism here:
// real outcomes tune real numbers, verified out-of-sample, not vibes.

const DEFAULT_THRESHOLDS = {
  directionalRatio: 0.55, // |close-open| / range above this = "directional", at/below = "ranging"
  sweepEpsilonPts:  1.0,  // London must clear Asia's extreme by more than this to count as a sweep
  slBufferPct:      0.05, // stop sits this fraction of leg size beyond the leg's origin extreme
  oteLo:            0.618, // OTE retracement band, fraction of leg size from the leg's terminal point
  oteHi:            0.705,
  allowedDaysOfWeek: [0, 1, 2, 3, 4, 5, 6], // 0=Sun..6=Sat (CT date of the NY session) — filter for day-of-week gating
  minLegSize:       0, // points — skip small/noisy legs entirely below this size (selectivity filter)
};

function ctParts(unixSecs) {
  const d = new Date(new Date(unixSecs * 1000).toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  return { hour: d.getHours() + d.getMinutes() / 60, dateKey: d.toISOString().slice(0, 10), jsDate: d };
}

function rangeOf(bars) {
  if (!bars.length) return null;
  return {
    open: bars[0].open, close: bars[bars.length - 1].close,
    high: Math.max(...bars.map(b => b.high)), low: Math.min(...bars.map(b => b.low)),
  };
}

function isDirectional(r, th) {
  const size = r.high - r.low;
  if (size <= 0) return false;
  return Math.abs(r.close - r.open) / size > th.directionalRatio;
}

// Slicing is threshold-independent but a sweep calls this with the SAME bars
// array across thousands of parameter combinations — cache by array identity
// so the (relatively expensive, timezone-formatting-heavy) slice only runs once.
const _sliceCache = new WeakMap();

function sliceSessions(bars) {
  if (_sliceCache.has(bars)) return _sliceCache.get(bars);
  const result = sliceSessionsUncached(bars);
  _sliceCache.set(bars, result);
  return result;
}

function sliceSessionsUncached(bars) {
  const byDate = new Map(); // dateKey -> { asia:[], london:[], ny:[], forward:[], nyDow }
  const ensure = (key, dow) => {
    if (!byDate.has(key)) byDate.set(key, { asia: [], london: [], ny: [], forward: [], nyDow: dow });
    return byDate.get(key);
  };
  for (const b of bars) {
    const { hour, dateKey, jsDate } = ctParts(b.time);
    if (hour >= 19) {
      const next = new Date(jsDate); next.setDate(next.getDate() + 1);
      const key = next.toISOString().slice(0, 10);
      ensure(key, next.getDay()).asia.push(b);
    } else if (hour < 1) {
      ensure(dateKey, jsDate.getDay()).asia.push(b);
    } else if (hour >= 1 && hour < 7) {
      ensure(dateKey, jsDate.getDay()).london.push(b);
    } else if (hour >= 9.5 && hour < 15) {
      ensure(dateKey, jsDate.getDay()).ny.push(b);
    } else if (hour >= 15) {
      ensure(dateKey, jsDate.getDay()).forward.push(b);
    }
  }
  return byDate;
}

// Classify one day's Asia+London ranges into a scenario per the SCENARIOS playbook.
function classifyDay(asia, london, th = DEFAULT_THRESHOLDS) {
  if (!asia || !london || !asia.length || !london.length) return { id: 0, bias: 'WAIT', reason: 'insufficient data' };
  const a = rangeOf(asia), l = rangeOf(london);
  if (!a || !l || a.high === a.low || l.high === l.low) return { id: 0, bias: 'WAIT', reason: 'flat range' };

  const sweptHigh = l.high > a.high + th.sweepEpsilonPts;
  const sweptLow  = l.low  < a.low  - th.sweepEpsilonPts;
  const sweptBoth = sweptHigh && sweptLow;
  const sweptOne  = sweptHigh !== sweptLow;
  const asiaDir   = isDirectional(a, th);
  const londonDir = isDirectional(l, th);
  const londonBias = l.close > l.open ? 'BUY' : 'SELL';
  const asiaBias    = a.close > a.open ? 'BUY' : 'SELL';

  if (sweptBoth) {
    return { id: 4, bias: 'AVOID', reason: 'London swept both sides of Asia — Search & Destroy' };
  }

  const tooSmall = (l.high - l.low) < th.minLegSize;
  if (tooSmall) return { id: 0, bias: 'WAIT', reason: `leg too small (< ${th.minLegSize}pt selectivity floor)` };

  if (asiaDir && !londonDir) {
    return { id: 1, bias: asiaBias, legLow: l.low, legHigh: l.high, reason: 'Asia directional, London consolidated' };
  }
  if (!asiaDir && londonDir && sweptOne) {
    return { id: 2, bias: londonBias, legLow: l.low, legHigh: l.high,
             reason: `Asia ranged, London swept Asia ${sweptHigh ? 'high' : 'low'} and continued` };
  }
  if (!asiaDir && londonDir && !sweptOne && !sweptBoth) {
    return { id: 3, bias: londonBias === 'BUY' ? 'SELL' : 'BUY', legLow: l.low, legHigh: l.high,
             reason: 'Asia ranged, London directional without sweeping Asia — expect NY reversal' };
  }
  return { id: 0, bias: 'WAIT', reason: 'no clean pattern (both directional or both ranging)' };
}

// Given a classified leg, compute the OTE entry zone and TP1/TP2/TP3/SL.
function legLevels(bias, legLow, legHigh, th = DEFAULT_THRESHOLDS) {
  const size = legHigh - legLow;
  if (bias === 'BUY') {
    return {
      oteHigh: +(legHigh - size * th.oteLo).toFixed(2),
      oteLow:  +(legHigh - size * th.oteHi).toFixed(2),
      tp1: +(legLow + size * 0.5).toFixed(2),
      tp2: +legHigh.toFixed(2),
      tp3: +(legHigh + size * 0.272).toFixed(2),
      sl:  +(legLow - size * th.slBufferPct).toFixed(2),
    };
  }
  return {
    oteLow:  +(legLow + size * th.oteLo).toFixed(2),
    oteHigh: +(legLow + size * th.oteHi).toFixed(2),
    tp1: +(legHigh - size * 0.5).toFixed(2),
    tp2: +legLow.toFixed(2),
    tp3: +(legLow - size * 0.272).toFixed(2),
    sl:  +(legHigh + size * th.slBufferPct).toFixed(2),
  };
}

// Walk forward bars looking for OTE entry, then simulate to TP1/TP2/TP3/SL/timeout.
function simulateTrade(bias, levels, forwardBars, maxBars) {
  let entryIdx = -1, entryPrice = null;
  const scanBars = forwardBars.slice(0, maxBars);
  for (let i = 0; i < scanBars.length; i++) {
    const b = scanBars[i];
    if (b.low <= levels.oteHigh && b.high >= levels.oteLow) {
      entryIdx = i;
      entryPrice = bias === 'BUY' ? Math.min(levels.oteHigh, b.high) : Math.max(levels.oteLow, b.low);
      break;
    }
  }
  if (entryIdx === -1) return { entered: false };

  const risk = Math.abs(entryPrice - levels.sl);
  if (risk <= 0) return { entered: false };

  for (let i = entryIdx; i < scanBars.length; i++) {
    const b = scanBars[i];
    const hitSL  = bias === 'BUY' ? b.low  <= levels.sl  : b.high >= levels.sl;
    const hitTP3 = bias === 'BUY' ? b.high >= levels.tp3 : b.low  <= levels.tp3;
    const hitTP2 = bias === 'BUY' ? b.high >= levels.tp2 : b.low  <= levels.tp2;
    const hitTP1 = bias === 'BUY' ? b.high >= levels.tp1 : b.low  <= levels.tp1;
    // Conservative on same-bar ambiguity: check stop before targets.
    if (hitSL)  return { entered: true, entryPrice, result: 'SL',  r: -1 };
    if (hitTP3) return { entered: true, entryPrice, result: 'TP3', r: +(Math.abs(levels.tp3 - entryPrice) / risk).toFixed(2) * 1 };
    if (hitTP2) return { entered: true, entryPrice, result: 'TP2', r: +(Math.abs(levels.tp2 - entryPrice) / risk).toFixed(2) * 1 };
    if (hitTP1) return { entered: true, entryPrice, result: 'TP1', r: +(Math.abs(levels.tp1 - entryPrice) / risk).toFixed(2) * 1 };
  }
  return { entered: true, entryPrice, result: 'TIMEOUT', r: 0 };
}

// Breakeven-ladder trade management: after TP1 prints, move the stop to
// entry (breakeven); after TP2 prints, move it to TP1 (locking that gain
// in); ride the remainder for TP3. Does NOT change entry (OTE zone) or
// classification — pure exit/management, added alongside simulateTrade
// (not replacing it) so every existing caller of simulateTrade/runBacktest
// is completely unaffected. Validated out-of-sample against real 1-minute
// fills (backtest/exit_variants.js): minLeg>=199pt filter unchanged, TRAIN
// avgR 0.314 (n=11), TEST avgR 0.405 (n=7, held out, most recent period) —
// stronger out-of-sample than in-sample, and unlike the single-shot
// baseline exit (avgR -0.101 across the same 29-trade set), this flips the
// sign to positive at every leg-size cut tested.
function simulateTradeManaged(bias, levels, forwardBars, maxBars) {
  let entryIdx = -1, entryPrice = null;
  const scanBars = forwardBars.slice(0, maxBars);
  for (let i = 0; i < scanBars.length; i++) {
    const b = scanBars[i];
    if (b.low <= levels.oteHigh && b.high >= levels.oteLow) {
      entryIdx = i;
      entryPrice = bias === 'BUY' ? Math.min(levels.oteHigh, b.high) : Math.max(levels.oteLow, b.low);
      break;
    }
  }
  if (entryIdx === -1) return { entered: false };

  const risk = Math.abs(entryPrice - levels.sl);
  if (risk <= 0) return { entered: false };

  let stop = levels.sl, stage = 0; // 0=initial risk, 1=past TP1 (stop at breakeven), 2=past TP2 (stop at TP1)
  const r1 = Math.abs(levels.tp1 - entryPrice) / risk;
  for (let i = entryIdx; i < scanBars.length; i++) {
    const b = scanBars[i];
    const hitStop = bias === 'BUY' ? b.low <= stop : b.high >= stop;
    if (hitStop) {
      const r = stage === 0 ? -1 : stage === 1 ? 0 : r1;
      return { entered: true, entryPrice, result: stage === 0 ? 'SL' : stage === 1 ? 'BE' : 'TP1-lock', r };
    }
    const hitTP3 = bias === 'BUY' ? b.high >= levels.tp3 : b.low <= levels.tp3;
    if (hitTP3) return { entered: true, entryPrice, result: 'TP3', r: Math.abs(levels.tp3 - entryPrice) / risk };
    const hitTP2 = bias === 'BUY' ? b.high >= levels.tp2 : b.low <= levels.tp2;
    if (hitTP2 && stage < 2) { stage = 2; stop = levels.tp1; }
    const hitTP1 = bias === 'BUY' ? b.high >= levels.tp1 : b.low <= levels.tp1;
    if (hitTP1 && stage < 1) { stage = 1; stop = entryPrice; }
  }
  return { entered: true, entryPrice, result: 'TIMEOUT', r: stage === 0 ? 0 : stage === 1 ? 0 : r1 };
}

// Full backtest over continuous hourly (or finer) bars.
// opts.allowedScenarios: which classified scenario IDs (1/2/3) are actually
// tradeable — defaults to all three (identical to this function's original
// behavior, so every existing caller is unaffected). Added to isolate
// scenario 2 (London sweep-then-continuation) from scenario 1 (pure Asia-
// directional) after real data showed them behaving very differently when
// combined into one signal — S2 real production-config numbers: 85.7% win
// rate, +0.09R avg (n=7) vs S1's 50% win rate, -0.23R avg (n=16); combining
// them into one "ICT" signal diluted the good one with the bad one.
function runBacktest(bars, opts = {}) {
  const th = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };
  const maxForwardBars = opts.maxForwardBars || 30;
  const allowedScenarios = opts.allowedScenarios || [1, 2, 3];
  const byDate = sliceSessions(bars);
  const days = [];

  for (const [dateKey, sess] of byDate.entries()) {
    if (!sess.asia.length || !sess.london.length) continue;
    if (!th.allowedDaysOfWeek.includes(sess.nyDow)) continue;
    const cls = classifyDay(sess.asia, sess.london, th);
    const day = { date: dateKey, scenario: cls.id, bias: cls.bias, reason: cls.reason };

    if (cls.id === 0 || cls.id === 4 || !allowedScenarios.includes(cls.id)) { days.push(day); continue; }

    const levels = legLevels(cls.bias, cls.legLow, cls.legHigh, th);
    const forward = [...sess.ny, ...sess.forward];
    const sim = simulateTrade(cls.bias, levels, forward, maxForwardBars);
    Object.assign(day, { levels, entered: sim.entered, result: sim.result, r: sim.r });
    days.push(day);
  }

  const traded = days.filter(d => d.entered);
  const byScenario = {};
  for (const d of days) {
    const key = `S${d.scenario}`;
    if (!byScenario[key]) byScenario[key] = { days: 0, traded: 0, wins: 0, losses: 0, timeouts: 0, totalR: 0 };
    byScenario[key].days++;
    if (d.entered) {
      byScenario[key].traded++;
      byScenario[key].totalR += Number(d.r) || 0;
      if (d.result === 'SL') byScenario[key].losses++;
      else if (d.result === 'TIMEOUT') byScenario[key].timeouts++;
      else byScenario[key].wins++;
    }
  }
  for (const k of Object.keys(byScenario)) {
    const s = byScenario[k];
    s.winRate = s.traded ? +((s.wins / s.traded) * 100).toFixed(1) : null;
    s.avgR    = s.traded ? +(s.totalR / s.traded).toFixed(2) : null;
  }

  return {
    totalDays: days.length,
    tradedDays: traded.length,
    wins: traded.filter(d => d.result !== 'SL' && d.result !== 'TIMEOUT').length,
    losses: traded.filter(d => d.result === 'SL').length,
    timeouts: traded.filter(d => d.result === 'TIMEOUT').length,
    totalR: +traded.reduce((a, d) => a + (Number(d.r) || 0), 0).toFixed(2),
    byScenario,
    days,
  };
}

// Same as runBacktest, but exits are managed with the breakeven ladder
// (simulateTradeManaged) instead of the single-shot TP1/TP2/TP3 exit. Same
// classification/entry, only the exit differs — kept as a fully separate
// function so runBacktest's existing, regression-tested behavior is
// completely untouched.
function runBacktestManaged(bars, opts = {}) {
  const th = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };
  const maxForwardBars = opts.maxForwardBars || 30;
  const allowedScenarios = opts.allowedScenarios || [1, 2, 3];
  const byDate = sliceSessions(bars);
  const days = [];

  for (const [dateKey, sess] of byDate.entries()) {
    if (!sess.asia.length || !sess.london.length) continue;
    if (!th.allowedDaysOfWeek.includes(sess.nyDow)) continue;
    const cls = classifyDay(sess.asia, sess.london, th);
    const day = { date: dateKey, scenario: cls.id, bias: cls.bias, reason: cls.reason };

    if (cls.id === 0 || cls.id === 4 || !allowedScenarios.includes(cls.id)) { days.push(day); continue; }

    const levels = legLevels(cls.bias, cls.legLow, cls.legHigh, th);
    const forward = [...sess.ny, ...sess.forward];
    const sim = simulateTradeManaged(cls.bias, levels, forward, maxForwardBars);
    Object.assign(day, { levels, entered: sim.entered, result: sim.result, r: sim.r });
    days.push(day);
  }

  const traded = days.filter(d => d.entered);
  const wins = traded.filter(d => Number(d.r) > 0.001).length;
  const losses = traded.filter(d => d.result === 'SL').length;
  const breakevens = traded.filter(d => d.result === 'BE').length;
  const timeouts = traded.filter(d => d.result === 'TIMEOUT' && Number(d.r) <= 0.001).length;

  return {
    totalDays: days.length,
    tradedDays: traded.length,
    wins, losses, breakevens, timeouts,
    totalR: +traded.reduce((a, d) => a + (Number(d.r) || 0), 0).toFixed(2),
    days,
  };
}

module.exports = { DEFAULT_THRESHOLDS, classifyDay, legLevels, simulateTrade, simulateTradeManaged, runBacktest, runBacktestManaged, sliceSessions };
