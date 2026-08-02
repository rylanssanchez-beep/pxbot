'use strict';

// ─── Fractal Intelligence Engine ───────────────────────────────────────────
// Context engine, NOT a strategy — it never triggers a trade on its own.
// Computes dealing ranges (the ICT sense: a high/low box with an equilibrium
// midpoint splitting it into premium/discount halves), where price currently
// sits within them, expansion/compression state, internal vs. external
// range, and how well multiple nested timeframes agree on premium/discount
// positioning. All of this only ever feeds confidence up or down inside
// engine/confirmation_engine.js — it is pure data, never a bias/entry signal
// by itself, per the directive's explicit instruction.
//
// Same discipline as backtest/ict_engine.js: every tunable knob lives in
// DEFAULT_THRESHOLDS and is threaded through as a parameter, never read from
// module scope, so it stays grid-searchable/backtestable rather than magic.

const structureEngine = require('./structure_engine');

const DEFAULT_THRESHOLDS = {
  equilibriumBand: 0.05,  // +/- this fraction of range around the 0.5 midpoint counts as "equilibrium", not premium/discount
  expansionRatio:  1.3,   // shortATR/longATR above this = "expanding"
  compressionRatio: 0.7,  // shortATR/longATR below this = "compressing"
  shortAtrPeriod:  5,
  longAtrPeriod:   20,
};

function ctDateParts(unixSecs) {
  const d = new Date(new Date(unixSecs * 1000).toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  return { dow: d.getDay(), dateKey: d.toISOString().slice(0, 10), year: d.getFullYear(), month: d.getMonth(), jsDate: d };
}

// A dealing range: the high/low box for a set of bars, with an equilibrium
// midpoint splitting it into premium (upper half) and discount (lower half).
function dealingRange(bars) {
  if (!bars || !bars.length) return null;
  const high = Math.max(...bars.map(b => b.high));
  const low = Math.min(...bars.map(b => b.low));
  const size = high - low;
  const mid = (high + low) / 2;
  return {
    high, low, size, equilibrium: mid,
    premiumZone: { low: mid, high },
    discountZone: { low, high: mid },
  };
}

// Where a price sits within a dealing range: 0 = at the low, 1 = at the high.
// Within `equilibriumBand` of 0.5 counts as neutral equilibrium, not
// premium/discount — matches how the OTE zone already treats 0.5 in
// backtest/ict_engine.js (TP1 at the 50% retracement, not an entry zone).
function pricePosition(price, range, th = DEFAULT_THRESHOLDS) {
  if (!range || range.size <= 0) return { zone: 'equilibrium', pct: 0.5 };
  const pct = (price - range.low) / range.size;
  const clamped = Math.max(0, Math.min(1, pct));
  let zone;
  if (Math.abs(clamped - 0.5) <= th.equilibriumBand) zone = 'equilibrium';
  else zone = clamped > 0.5 ? 'premium' : 'discount';
  return { zone, pct: clamped };
}

// TradeLocker has no native weekly/monthly resolution (confirmed: candles
// endpoint only supports 1/5/15/30/60/240/1440-minute bars) — weekly and
// monthly dealing ranges are built by aggregating daily bars locally.
// Week boundary = Sunday CT (matches the day-of-week convention already
// used in backtest/ict_engine.js's allowedDaysOfWeek, 0=Sun).
function aggregateToTimeframe(dailyBars, unit) {
  if (!dailyBars || !dailyBars.length) return [];
  const groups = new Map();
  for (const b of dailyBars) {
    const p = ctDateParts(b.time);
    let key;
    if (unit === 'month') {
      key = `${p.year}-${String(p.month + 1).padStart(2, '0')}`;
    } else { // 'week'
      const sinceSunday = p.dow; // days since most recent Sunday
      const weekStart = new Date(p.jsDate);
      weekStart.setDate(weekStart.getDate() - sinceSunday);
      key = weekStart.toISOString().slice(0, 10);
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  const out = [];
  for (const [key, chunk] of groups.entries()) {
    out.push({
      key, time: chunk[0].time,
      open: chunk[0].open, close: chunk[chunk.length - 1].close,
      high: Math.max(...chunk.map(b => b.high)),
      low: Math.min(...chunk.map(b => b.low)),
      volume: chunk.reduce((a, b) => a + (b.volume || 0), 0),
    });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

// Internal range = the most recent swing-to-swing leg (the last pullback).
// External range = the larger structural range containing it. Both ICT
// terminology — internal liquidity is what price is currently trading
// within; external liquidity is the larger range whose edges are the next
// meaningful draw. Uses structure_engine's swing detection rather than
// re-implementing it.
function internalExternalRange(bars, opts = {}) {
  const lookback = opts.lookback || 3;
  const externalWindow = opts.externalWindow || bars.length;
  const external = dealingRange(bars.slice(-externalWindow));

  const swingHighs = structureEngine.findSwingHighs(bars, lookback);
  const swingLows = structureEngine.findSwingLows(bars, lookback);
  const points = [...swingHighs.map(s => ({ ...s, type: 'high' })), ...swingLows.map(s => ({ ...s, type: 'low' }))]
    .sort((a, b) => a.idx - b.idx);

  let internal = null;
  if (points.length >= 2) {
    const last = points[points.length - 1];
    const prevOpposite = [...points].reverse().slice(1).find(p => p.type !== last.type);
    if (prevOpposite) {
      const lo = Math.min(last.price, prevOpposite.price);
      const hi = Math.max(last.price, prevOpposite.price);
      internal = { high: hi, low: lo, size: hi - lo, equilibrium: (hi + lo) / 2,
        premiumZone: { low: (hi + lo) / 2, high: hi }, discountZone: { low: lo, high: (hi + lo) / 2 } };
    }
  }

  return { internal, external };
}

// ATR-ratio-based expansion/compression state: short-term volatility vs.
// long-term volatility. Same primitive (structure_engine.atr) the ATR(14)
// context display already uses — no new volatility math invented.
function expansionCompression(bars, th = DEFAULT_THRESHOLDS) {
  const shortAtr = structureEngine.atr(bars, th.shortAtrPeriod);
  const longAtr = structureEngine.atr(bars, th.longAtrPeriod);
  if (!shortAtr || !longAtr || longAtr <= 0) return { state: 'unknown', ratio: null, shortAtr, longAtr };
  const ratio = shortAtr / longAtr;
  let state;
  if (ratio >= th.expansionRatio) state = 'expanding';
  else if (ratio <= th.compressionRatio) state = 'compressing';
  else state = 'steady';
  return { state, ratio: +ratio.toFixed(3), shortAtr: +shortAtr.toFixed(2), longAtr: +longAtr.toFixed(2) };
}

// Given per-timeframe price positions (e.g. { monthly: {zone:'premium',...},
// weekly: {...}, daily: {...} }), scores how many timeframes agree on
// premium vs. discount. Equilibrium readings are neutral — they neither
// support nor contradict alignment, matching how OTE's own 50% level isn't
// treated as directional in ict_engine.js.
function nestedFractalAlignment(positionsByTF) {
  const entries = Object.entries(positionsByTF).filter(([, p]) => p && p.zone);
  const premiumCount = entries.filter(([, p]) => p.zone === 'premium').length;
  const discountCount = entries.filter(([, p]) => p.zone === 'discount').length;
  const equilibriumCount = entries.filter(([, p]) => p.zone === 'equilibrium').length;
  const directional = premiumCount + discountCount;
  const dominant = premiumCount > discountCount ? 'premium' : discountCount > premiumCount ? 'discount' : 'mixed';
  const agreement = directional > 0 ? Math.max(premiumCount, discountCount) / directional : 0;
  return {
    perTimeframe: positionsByTF,
    premiumCount, discountCount, equilibriumCount,
    dominant, agreement: +agreement.toFixed(2),
    timeframesConsidered: entries.length,
  };
}

module.exports = {
  DEFAULT_THRESHOLDS,
  dealingRange, pricePosition, aggregateToTimeframe,
  internalExternalRange, expansionCompression, nestedFractalAlignment,
};
