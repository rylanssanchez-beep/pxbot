'use strict';

// Deterministic synthetic OHLCV generator — for regression/parity testing ONLY,
// not for evaluating strategy edge. This sandbox has no live TradeLocker
// credentials, so real-history scripts (run.js, walkforward.js,
// confirmation_backtest.js, montecarlo.js, stress_test.js) cannot be executed
// here against real data. This fixture exists so code-behavior-parity checks
// (regression_test.js) and self-tests of the new engine modules are
// reproducible without a live connection. A fixed seed always produces the
// exact same bar series, which is the point: it lets us prove "this refactor
// didn't change the numbers" without needing real market data at all.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// resolutionMin: bar size in minutes. count: number of bars.
// Produces bars walking backward from `endTime` (unix seconds, default now),
// so the most recent bar's time is always endTime-aligned — deterministic
// given the same (seed, count, resolutionMin, endTime, basePrice).
function generateSyntheticBars({ count = 5000, resolutionMin = 60, seed = 42, endTime, basePrice = 20000, volPts = 25 } = {}) {
  const rand = mulberry32(seed);
  const stepSecs = resolutionMin * 60;
  const end = endTime || Math.floor(Date.UTC(2025, 0, 1, 0, 0, 0) / 1000);
  const startTime = end - (count - 1) * stepSecs;

  const bars = [];
  let price = basePrice;
  for (let i = 0; i < count; i++) {
    const time = startTime + i * stepSecs;
    // Slight session-shaped volatility: higher during a synthetic "NY-ish" window.
    const hourOfDay = new Date(time * 1000).getUTCHours();
    const sessionMult = (hourOfDay >= 13 && hourOfDay <= 20) ? 1.4 : 0.8;
    const drift = (rand() - 0.5) * volPts * sessionMult;
    const open = price;
    const close = +(open + drift).toFixed(2);
    const wick = Math.abs(drift) * (0.3 + rand() * 0.7) + rand() * volPts * 0.2;
    const high = +(Math.max(open, close) + wick * rand()).toFixed(2);
    const low = +(Math.min(open, close) - wick * rand()).toFixed(2);
    const volume = Math.round(200 + rand() * 800);
    bars.push({ time, open, high, low, close, volume });
    price = close;
  }
  return bars;
}

// Aggregates minute-resolution synthetic bars up to a coarser resolution,
// mirroring how TL bars would be aggregated (used to build multi-timeframe
// fixtures for engine self-tests from one base 1-minute series).
function aggregateBars(bars, factor) {
  const out = [];
  for (let i = 0; i < bars.length; i += factor) {
    const chunk = bars.slice(i, i + factor);
    if (!chunk.length) continue;
    out.push({
      time: chunk[0].time,
      open: chunk[0].open,
      close: chunk[chunk.length - 1].close,
      high: Math.max(...chunk.map(b => b.high)),
      low: Math.min(...chunk.map(b => b.low)),
      volume: chunk.reduce((a, b) => a + (b.volume || 0), 0),
    });
  }
  return out;
}

module.exports = { generateSyntheticBars, aggregateBars };
