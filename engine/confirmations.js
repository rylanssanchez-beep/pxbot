'use strict';

// ─── Confirmation Detectors ────────────────────────────────────────────────
// Fair value gaps, order blocks, VWAP, displacement, a generalized level-
// sweep check, and SMT divergence. None of these existed anywhere in this
// codebase before — server.js's `keyRules` only described them as prose for
// a human/LLM to read, with no detector backing the text. These are real,
// computed detectors, each an independent input engine/confirmation_engine.js
// weighs — none of them fires a trade by itself.

const structureEngine = require('./structure_engine');

const DEFAULT_THRESHOLDS = {
  obImpulseLookback:    3,    // bars after a candidate order block to measure the displacement move over
  obImpulseAtrMultiple: 2,    // displacement must exceed this multiple of ATR to qualify a candidate as an order block
  obAtrPeriod:          14,
  displacementRangeAtrMultiple: 1.5, // bar range must exceed this multiple of ATR to count as displacement
  displacementBodyRatio: 0.7, // body/range must be at least this to count as displacement (small wicks)
  smtSwingLookback:     3,
};

// Standard 3-candle Fair Value Gap: candle1 and candle3 leave a gap that
// candle2 (the middle, displacement candle) didn't fill. `filled` scans
// forward for the first later bar that trades back into the gap zone.
function findFVGs(bars, opts = {}) {
  const checkFillAhead = opts.checkFillAhead !== false;
  const gaps = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const c1 = bars[i - 1], c3 = bars[i + 1];
    if (c3.low > c1.high) {
      gaps.push(buildGap('bullish', i, c1.high, c3.low, bars, checkFillAhead));
    } else if (c3.high < c1.low) {
      gaps.push(buildGap('bearish', i, c3.high, c1.low, bars, checkFillAhead));
    }
  }
  return gaps;
}

function buildGap(type, idx, bottom, top, bars, checkFillAhead) {
  let filled = false, filledIdx = null;
  if (checkFillAhead) {
    for (let k = idx + 2; k < bars.length; k++) {
      const b = bars[k];
      if (b.low <= top && b.high >= bottom) { filled = true; filledIdx = k; break; }
    }
  }
  return { type, idx, top, bottom, size: top - bottom, filled, filledIdx };
}

// Order block: the last opposite-direction candle before a displacement move
// (measured as an ATR-relative impulse over the following bars) that pushes
// price well beyond the candidate candle's own range. A simplified, honestly
// documented definition — not full ICT mitigation/breaker-block taxonomy —
// but a real, computed detector rather than the prose-only placeholder that
// existed before.
function findOrderBlocks(bars, th = DEFAULT_THRESHOLDS) {
  const obs = [];
  for (let i = th.obAtrPeriod; i < bars.length - th.obImpulseLookback; i++) {
    const candidate = bars[i];
    const isDown = candidate.close < candidate.open;
    const isUp = candidate.close > candidate.open;
    if (!isDown && !isUp) continue;

    const atrVal = structureEngine.atr(bars.slice(0, i + 1), th.obAtrPeriod);
    if (!atrVal) continue;

    const impulse = bars.slice(i + 1, i + 1 + th.obImpulseLookback);
    if (!impulse.length) continue;
    const impulseHigh = Math.max(...impulse.map(b => b.high));
    const impulseLow = Math.min(...impulse.map(b => b.low));

    if (isDown) {
      const upMove = impulseHigh - candidate.high;
      if (upMove > atrVal * th.obImpulseAtrMultiple) {
        obs.push({ type: 'bullish', idx: i, high: candidate.high, low: candidate.low, atrAtFormation: +atrVal.toFixed(2), impulsePts: +upMove.toFixed(2) });
      }
    } else {
      const downMove = candidate.low - impulseLow;
      if (downMove > atrVal * th.obImpulseAtrMultiple) {
        obs.push({ type: 'bearish', idx: i, high: candidate.high, low: candidate.low, atrAtFormation: +atrVal.toFixed(2), impulsePts: +downMove.toFixed(2) });
      }
    }
  }
  return obs;
}

// Session/anchored VWAP over the given bar set — caller controls the anchor
// by which bars it passes in (e.g. just today's bars for a session VWAP).
// Typical price = (H+L+C)/3, the standard VWAP formula. Depends on the
// `volume` field TL/Yahoo bars carry (confirmed present, server.js:177 etc.)
// — for a CFD-mirrored feed this may not match true exchange volume
// fidelity, which is a real caveat on this confirmation's reliability, not
// a defect in the math.
function vwap(bars) {
  let cumPV = 0, cumVol = 0;
  const out = [];
  for (const b of bars) {
    const typical = (b.high + b.low + b.close) / 3;
    const vol = b.volume || 0;
    cumPV += typical * vol;
    cumVol += vol;
    out.push({ time: b.time, vwap: cumVol > 0 ? cumPV / cumVol : typical });
  }
  return out;
}

// Displacement: a bar whose range is large relative to recent ATR with a
// small-wick, mostly-body candle — the ICT signature of an institutional
// impulse move (as opposed to a wick-heavy indecision bar of the same range).
function findDisplacements(bars, th = DEFAULT_THRESHOLDS) {
  const out = [];
  for (let i = th.obAtrPeriod; i < bars.length; i++) {
    const atrVal = structureEngine.atr(bars.slice(0, i + 1), th.obAtrPeriod);
    if (!atrVal) continue;
    const b = bars[i];
    const range = b.high - b.low;
    if (range <= 0) continue;
    const body = Math.abs(b.close - b.open);
    if (range > atrVal * th.displacementRangeAtrMultiple && (body / range) >= th.displacementBodyRatio) {
      out.push({ idx: i, bias: b.close > b.open ? 'BUY' : 'SELL', range: +range.toFixed(2), atrAtFormation: +atrVal.toFixed(2) });
    }
  }
  return out;
}

// Generalizes the Asia/London sweep check already proven live in
// backtest/ict_engine.js:85-88 (which is hardcoded to that one comparison)
// into a reusable check against any arbitrary level — used by the fractal
// and MTF layers to check sweeps of prior day/week/month highs-lows, not
// just the Asia range.
function sweptLevel(bars, level, epsilon = 1.0, opts = {}) {
  const direction = opts.direction; // 'above' | 'below' | undefined = either
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (direction !== 'below' && b.high > level + epsilon) return { swept: true, direction: 'above', idx: i, price: b.high };
    if (direction !== 'above' && b.low < level - epsilon) return { swept: true, direction: 'below', idx: i, price: b.low };
  }
  return { swept: false };
}

// SMT (Smart Money Technique) divergence: one correlated instrument makes a
// new swing high/low while the other fails to confirm it. Requires a second
// instrument's bars for the SAME window — PXBOT only fetches NAS100/NQ, no
// correlated feed (ES/YM/etc.) exists in this codebase today, so this
// returns `available: false` with an honest reason instead of faking a
// confirmation. The confirmation engine must treat `available: false` as
// "this factor contributes nothing," never as a default bullish/bearish lean.
function smt(barsA, barsB, th = DEFAULT_THRESHOLDS) {
  if (!barsA || !barsB || !barsA.length || !barsB.length) {
    return { available: false, reason: 'no correlated-instrument feed configured' };
  }
  const aHighs = structureEngine.findSwingHighs(barsA, th.smtSwingLookback);
  const bHighs = structureEngine.findSwingHighs(barsB, th.smtSwingLookback);
  const aLows = structureEngine.findSwingLows(barsA, th.smtSwingLookback);
  const bLows = structureEngine.findSwingLows(barsB, th.smtSwingLookback);

  let bearishDivergence = false, bullishDivergence = false;
  if (aHighs.length >= 2 && bHighs.length >= 2) {
    const aNewHigh = aHighs[aHighs.length - 1].price > aHighs[aHighs.length - 2].price;
    const bNewHigh = bHighs[bHighs.length - 1].price > bHighs[bHighs.length - 2].price;
    bearishDivergence = aNewHigh && !bNewHigh;
  }
  if (aLows.length >= 2 && bLows.length >= 2) {
    const aNewLow = aLows[aLows.length - 1].price < aLows[aLows.length - 2].price;
    const bNewLow = bLows[bLows.length - 1].price < bLows[bLows.length - 2].price;
    bullishDivergence = aNewLow && !bNewLow;
  }
  return { available: true, bullishDivergence, bearishDivergence };
}

module.exports = {
  DEFAULT_THRESHOLDS,
  findFVGs, findOrderBlocks, vwap, findDisplacements, sweptLevel, smt,
};
