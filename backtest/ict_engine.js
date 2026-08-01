'use strict';

// ICT session-scenario classifier + trade simulator.
// Codifies the 4-scenario playbook already described in app.js (SCENARIOS) as
// deterministic rules over continuous OHLC bars, so it can be run against real
// history instead of only existing as prompt text for an LLM to interpret.
//
// Thresholds below are named constants specifically so they're one-line changes
// once backtest results say a threshold is wrong — that's the actual
// "self-improving" mechanism for this system: real outcomes tune real numbers.

const THRESHOLDS = {
  directionalRatio: 0.55, // |close-open| / range above this = "directional", at/below = "ranging"
  sweepEpsilonPts:  1.0,  // London must clear Asia's extreme by more than this to count as a sweep
  slBufferPct:      0.05, // stop sits this fraction of leg size beyond the leg's origin extreme
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

function isDirectional(r) {
  const size = r.high - r.low;
  if (size <= 0) return false;
  return Math.abs(r.close - r.open) / size > THRESHOLDS.directionalRatio;
}

// Slice continuous bars into per-calendar-day Asia/London/NY/afterhours windows,
// keyed by the NY session's calendar date (CT).
function sliceSessions(bars) {
  const byDate = new Map(); // dateKey -> { asia:[], london:[], ny:[], forward:[] }
  for (const b of bars) {
    const { hour, dateKey, jsDate } = ctParts(b.time);
    // Asia (19:00 prev day - 01:00 this day) belongs to THIS calendar date's session
    // London/NY/afterhours belong to their own calendar date.
    if (hour >= 19) {
      const next = new Date(jsDate); next.setDate(next.getDate() + 1);
      const key = next.toISOString().slice(0, 10);
      if (!byDate.has(key)) byDate.set(key, { asia: [], london: [], ny: [], forward: [] });
      byDate.get(key).asia.push(b);
    } else if (hour < 1) {
      if (!byDate.has(dateKey)) byDate.set(dateKey, { asia: [], london: [], ny: [], forward: [] });
      byDate.get(dateKey).asia.push(b);
    } else if (hour >= 1 && hour < 7) {
      if (!byDate.has(dateKey)) byDate.set(dateKey, { asia: [], london: [], ny: [], forward: [] });
      byDate.get(dateKey).london.push(b);
    } else if (hour >= 9.5 && hour < 15) {
      if (!byDate.has(dateKey)) byDate.set(dateKey, { asia: [], london: [], ny: [], forward: [] });
      byDate.get(dateKey).ny.push(b);
    } else if (hour >= 15) {
      if (!byDate.has(dateKey)) byDate.set(dateKey, { asia: [], london: [], ny: [], forward: [] });
      byDate.get(dateKey).forward.push(b);
    }
  }
  return byDate;
}

// Classify one day's Asia+London ranges into a scenario per the SCENARIOS playbook.
function classifyDay(asia, london) {
  if (!asia || !london) return { id: 0, bias: 'WAIT', reason: 'insufficient data' };
  const a = rangeOf(asia), l = rangeOf(london);
  if (!a || !l || a.high === a.low || l.high === l.low) return { id: 0, bias: 'WAIT', reason: 'flat range' };

  const sweptHigh = l.high > a.high + THRESHOLDS.sweepEpsilonPts;
  const sweptLow  = l.low  < a.low  - THRESHOLDS.sweepEpsilonPts;
  const sweptBoth = sweptHigh && sweptLow;
  const sweptOne  = sweptHigh !== sweptLow;
  const asiaDir   = isDirectional(a);
  const londonDir = isDirectional(l);
  const londonBias = l.close > l.open ? 'BUY' : 'SELL';
  const asiaBias    = a.close > a.open ? 'BUY' : 'SELL';

  if (sweptBoth) {
    return { id: 4, bias: 'AVOID', reason: 'London swept both sides of Asia — Search & Destroy' };
  }
  if (asiaDir && !londonDir) {
    return { id: 1, bias: asiaBias, legLow: l.low, legHigh: l.high, reason: 'Asia directional, London consolidated' };
  }
  if (!asiaDir && londonDir && sweptOne) {
    // London's own range already spans the sweep point and the continuation extreme.
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
function legLevels(bias, legLow, legHigh) {
  const size = legHigh - legLow;
  if (bias === 'BUY') {
    return {
      oteHigh: +(legHigh - size * 0.618).toFixed(2),
      oteLow:  +(legHigh - size * 0.705).toFixed(2),
      tp1: +(legLow + size * 0.5).toFixed(2),
      tp2: +legHigh.toFixed(2),
      tp3: +(legHigh + size * 0.272).toFixed(2),
      sl:  +(legLow - size * THRESHOLDS.slBufferPct).toFixed(2),
    };
  }
  return {
    oteLow:  +(legLow + size * 0.618).toFixed(2),
    oteHigh: +(legLow + size * 0.705).toFixed(2),
    tp1: +(legHigh - size * 0.5).toFixed(2),
    tp2: +legLow.toFixed(2),
    tp3: +(legLow - size * 0.272).toFixed(2),
    sl:  +(legHigh + size * THRESHOLDS.slBufferPct).toFixed(2),
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

// Full backtest over continuous hourly (or finer) bars.
function runBacktest(bars, opts = {}) {
  const maxForwardBars = opts.maxForwardBars || 30; // ~30 bars forward at whatever resolution is passed in
  const byDate = sliceSessions(bars);
  const days = [];

  for (const [dateKey, sess] of byDate.entries()) {
    if (!sess.asia.length || !sess.london.length) continue;
    const cls = classifyDay(sess.asia, sess.london);
    const day = { date: dateKey, scenario: cls.id, bias: cls.bias, reason: cls.reason };

    if (cls.id === 0 || cls.id === 4) { days.push(day); continue; }

    const levels = legLevels(cls.bias, cls.legLow, cls.legHigh);
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

module.exports = { THRESHOLDS, classifyDay, legLevels, simulateTrade, runBacktest, sliceSessions };
