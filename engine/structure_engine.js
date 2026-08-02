'use strict';

// ─── Structure Engine ──────────────────────────────────────────────────────
// Consolidates the fractal swing-high/low, equal-highs/lows (liquidity pool),
// BOS/CHOCH, ATR, and weekly-profile logic that previously existed as three
// separate, independently-drifting copies:
//   - app.js:detectStructure()      (3-bar lookback, 8pt EQ threshold, BOS/CHOCH)
//   - server.js:handleTVContext()   (2-bar lookback daily swings, 10pt EQ, full history)
//   - sandbox/build.js findSwings/findEqLevels/atr14/weeklyProfile (2-bar, 10pt, last 60 bars)
//
// Every function here is a pure (bars, opts) -> data transform with no I/O,
// no date formatting, and no site-specific field names (nqAdj, etc.) — each
// call site keeps its own thin wrapper that formats/labels the output exactly
// as it did before, so consolidating the algorithm changes zero observable
// output anywhere it's wired in. Written UMD-style so both server.js
// (require) and app.js (plain <script> tag, no bundler in this project) can
// use the same implementation.

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.StructureEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  // Fractal swing high: `lookback` bars strictly lower on both sides.
  function findSwingHighs(bars, lookback = 2) {
    const out = [];
    for (let i = lookback; i < bars.length - lookback; i++) {
      const b = bars[i];
      let isHigh = true;
      for (let j = 1; j <= lookback; j++) {
        if (b.high <= bars[i - j].high || b.high <= bars[i + j].high) { isHigh = false; break; }
      }
      if (isHigh) out.push({ idx: i, price: b.high, bar: b });
    }
    return out;
  }

  // Fractal swing low: `lookback` bars strictly higher on both sides.
  function findSwingLows(bars, lookback = 2) {
    const out = [];
    for (let i = lookback; i < bars.length - lookback; i++) {
      const b = bars[i];
      let isLow = true;
      for (let j = 1; j <= lookback; j++) {
        if (b.low >= bars[i - j].low || b.low >= bars[i + j].low) { isLow = false; break; }
      }
      if (isLow) out.push({ idx: i, price: b.low, bar: b });
    }
    return out;
  }

  // Merged swing highs+lows, sorted by bar index, SH before SL on the rare
  // tie — reproduces the exact single-pass interleaving order server.js's
  // original combined `swings` loop produced.
  function findSwingPoints(bars, lookback = 2) {
    const highs = findSwingHighs(bars, lookback).map(s => ({ ...s, type: 'SH' }));
    const lows  = findSwingLows(bars, lookback).map(s => ({ ...s, type: 'SL' }));
    return [...highs, ...lows].sort((a, b) => a.idx - b.idx);
  }

  // Equal highs/lows (liquidity pools): any pair of bars within `windowSize`
  // of each other whose highs (or lows) differ by less than `threshold`.
  // Returns them interleaved in the exact (i, j, EQH-before-EQL) order the
  // original nested loops produced in server.js/sandbox/build.js — that
  // order matters because callers slice to "last N", so it must match.
  function findEqualLevels(bars, threshold = 10, windowSize = 10) {
    const out = [];
    for (let i = 0; i < bars.length - 1; i++) {
      for (let j = i + 1; j < Math.min(i + windowSize, bars.length); j++) {
        if (Math.abs(bars[i].high - bars[j].high) < threshold) {
          out.push({ type: 'EQH', price: (bars[i].high + bars[j].high) / 2, i, j, barI: bars[i], barJ: bars[j] });
        }
        if (Math.abs(bars[i].low - bars[j].low) < threshold) {
          out.push({ type: 'EQL', price: (bars[i].low + bars[j].low) / 2, i, j, barI: bars[i], barJ: bars[j] });
        }
      }
    }
    return out;
  }

  // BOS: a swing point that exceeds the prior swing point in the same
  // direction. Merged and index-sorted, matching app.js's original.
  function findBOS(swingHighs, swingLows) {
    const bosPoints = [];
    for (let i = 1; i < swingHighs.length; i++) {
      if (swingHighs[i].price > swingHighs[i - 1].price) {
        bosPoints.push({ type: 'BOS_UP', idx: swingHighs[i].idx, price: swingHighs[i].price, broke: swingHighs[i - 1].price });
      }
    }
    for (let i = 1; i < swingLows.length; i++) {
      if (swingLows[i].price < swingLows[i - 1].price) {
        bosPoints.push({ type: 'BOS_DN', idx: swingLows[i].idx, price: swingLows[i].price, broke: swingLows[i - 1].price });
      }
    }
    bosPoints.sort((a, b) => a.idx - b.idx);
    return bosPoints;
  }

  // CHOCH: first BOS that reverses the direction of the prior BOS.
  function findCHOCH(bosPoints) {
    const chochPoints = [];
    for (let i = 1; i < bosPoints.length; i++) {
      const prev = bosPoints[i - 1], curr = bosPoints[i];
      if ((prev.type === 'BOS_UP' && curr.type === 'BOS_DN') ||
          (prev.type === 'BOS_DN' && curr.type === 'BOS_UP')) {
        chochPoints.push({ ...curr, type: curr.type === 'BOS_UP' ? 'CHOCH_UP' : 'CHOCH_DN' });
      }
    }
    return chochPoints;
  }

  // Wilder-style ATR (simple average of true range over `period`, matching
  // the exact rolling window the two original duplicate implementations
  // used — not the smoothed/exponential Wilder average).
  function atr(bars, period = 14) {
    const tail = bars.slice(-(period + 1));
    if (tail.length < 2) return null;
    const trs = tail.map((b, i) => i === 0
      ? b.high - b.low
      : Math.max(b.high - b.low, Math.abs(b.high - tail[i - 1].close), Math.abs(b.low - tail[i - 1].close)));
    const usable = trs.slice(-period);
    return usable.reduce((a, b) => a + b, 0) / usable.length;
  }

  // Chunks bars into fixed-size (default 5, i.e. "week" of daily bars)
  // groups and summarizes each. Returns raw numeric fields — callers apply
  // their own rounding/date formatting, since the two original duplicates
  // rounded open/close slightly differently and this preserves both exactly.
  function weeklyProfile(bars, chunkSize = 5) {
    const weeks = [];
    for (let i = 0; i < bars.length; i += chunkSize) {
      const chunk = bars.slice(i, i + chunkSize);
      if (!chunk.length) continue;
      const high = Math.max(...chunk.map(b => b.high));
      const low = Math.min(...chunk.map(b => b.low));
      weeks.push({
        weekStartTime: chunk[0].time,
        open: chunk[0].open,
        close: chunk[chunk.length - 1].close,
        high, low,
        range: high - low,
        bias: chunk[chunk.length - 1].close > chunk[0].open ? 'BULL' : 'BEAR',
      });
    }
    return weeks;
  }

  // Full pipeline matching app.js's original detectStructure() exactly:
  // 3-bar lookback swings, BOS, CHOCH, 8pt EQH/EQL computed over the SWING
  // POINTS themselves (not raw bars — deliberately different from
  // findEqualLevels above, which pairs raw bars for the daily-context use
  // case). Kept as its own function rather than composed generically so this
  // one output shape never has to change to accommodate the other two sites.
  function detectStructure(candles, opts = {}) {
    const LB = opts.lookback || 3;
    const EQ_THR = opts.eqThreshold || 8;
    if (candles.length < 10) {
      return { swingHighs: [], swingLows: [], bosPoints: [], chochPoints: [], eqHighs: [], eqLows: [] };
    }

    const swingHighs = findSwingHighs(candles, LB).map(s => ({ idx: s.idx, price: s.price, candle: s.bar }));
    const swingLows  = findSwingLows(candles, LB).map(s => ({ idx: s.idx, price: s.price, candle: s.bar }));

    const bosPoints = findBOS(swingHighs, swingLows);
    const chochPoints = findCHOCH(bosPoints);

    const eqHighs = [], eqLows = [];
    for (let i = 0; i < swingHighs.length - 1; i++) {
      if (Math.abs(swingHighs[i].price - swingHighs[i + 1].price) <= EQ_THR) {
        eqHighs.push({ price: (swingHighs[i].price + swingHighs[i + 1].price) / 2, idx1: swingHighs[i].idx, idx2: swingHighs[i + 1].idx });
      }
    }
    for (let i = 0; i < swingLows.length - 1; i++) {
      if (Math.abs(swingLows[i].price - swingLows[i + 1].price) <= EQ_THR) {
        eqLows.push({ price: (swingLows[i].price + swingLows[i + 1].price) / 2, idx1: swingLows[i].idx, idx2: swingLows[i + 1].idx });
      }
    }

    const recentBos = bosPoints.slice(-3);
    const upCount = recentBos.filter(b => b.type === 'BOS_UP').length;
    const dnCount = recentBos.filter(b => b.type === 'BOS_DN').length;
    const structureBias = upCount > dnCount ? 'BULLISH' : dnCount > upCount ? 'BEARISH' : 'NEUTRAL';

    return { swingHighs, swingLows, bosPoints, chochPoints, eqHighs, eqLows, structureBias };
  }

  return {
    findSwingHighs, findSwingLows, findSwingPoints,
    findEqualLevels, findBOS, findCHOCH, atr, weeklyProfile, detectStructure,
  };
});
