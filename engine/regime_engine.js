'use strict';

// ─── Market Regime AI ──────────────────────────────────────────────────────
// Rule-based (no black-box model — every number here is a named, standard
// quant technique, not an invented magic threshold) classification of the
// current market environment, per the directive: "Only allow strategies that
// fit the detected environment." This module classifies; engine/confirmation_engine.js
// is what actually decides whether a given strategy fits.
//
// Returns a MULTI-dimensional read (direction + volatility state + level +
// mean-reversion tendency), not one mutually-exclusive label — the directive
// lists trending/ranging/expanding/compressing/high-vol/low-vol/mean-reverting
// as independent axes a market can occupy simultaneously (e.g. trending AND
// expanding AND high-volatility all at once).
//
// "News driven" is explicitly NOT implemented: it requires an economic-
// calendar/news feed this codebase has no access to. Rather than fake it,
// `newsDriven` always reports `available: false` with the reason why.

const structureEngine = require('./structure_engine');
const fractalEngine = require('./fractal_engine');

const DEFAULT_THRESHOLDS = {
  erLookback:            20,   // bars used for the directional efficiency ratio (Kaufman ER)
  erTrendThreshold:      0.4,  // ER above this = trending, at/below = ranging
  meanReversionLookback: 20,
  meanReversionCrossRate: 0.35, // mean-crossing rate above this (while ranging) = mean-reverting character
  atrPeriod:             14,
  volSampleLookback:     100,  // bars sampled to build the ATR percentile distribution
  volHighPercentile:     0.8,
  volLowPercentile:      0.2,
};

// Kaufman Efficiency Ratio: |net move| / sum(|bar-to-bar moves|) over a
// lookback window. 1.0 = perfectly straight-line trend, ~0 = pure chop.
// Standard, well-known technique (Kaufman's Adaptive Moving Average),
// not an invented statistic.
function efficiencyRatio(bars, lookback) {
  const slice = bars.slice(-lookback);
  if (slice.length < 2) return null;
  const closes = slice.map(b => b.close);
  const net = Math.abs(closes[closes.length - 1] - closes[0]);
  let volatilitySum = 0;
  for (let i = 1; i < closes.length; i++) volatilitySum += Math.abs(closes[i] - closes[i - 1]);
  if (volatilitySum === 0) return 0;
  return net / volatilitySum;
}

// How often price crosses its own lookback-window mean — a simple, honest
// proxy for oscillation/mean-reversion character (not a statistical
// autocorrelation test, which would need a much larger sample than a
// single live signal check has available).
function meanCrossingRate(bars, lookback) {
  const slice = bars.slice(-lookback);
  if (slice.length < 3) return null;
  const closes = slice.map(b => b.close);
  const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
  let crossings = 0;
  for (let i = 1; i < closes.length; i++) {
    if ((closes[i - 1] - mean) * (closes[i] - mean) < 0) crossings++;
  }
  return crossings / (closes.length - 1);
}

// Percentile rank of the current short-term ATR against a rolling sample of
// its own recent history — "high/low volatility" relative to this
// instrument's own recent behavior, not an arbitrary fixed point-value.
function volatilityPercentile(bars, th) {
  const start = Math.max(th.atrPeriod + 1, bars.length - th.volSampleLookback);
  const samples = [];
  for (let i = start; i <= bars.length; i++) {
    const v = structureEngine.atr(bars.slice(0, i), th.atrPeriod);
    if (v) samples.push(v);
  }
  if (!samples.length) return null;
  const current = samples[samples.length - 1];
  const below = samples.filter(s => s <= current).length;
  return below / samples.length;
}

function classifyRegime(bars, th = DEFAULT_THRESHOLDS) {
  const er = efficiencyRatio(bars, th.erLookback);
  const closes = bars.slice(-th.erLookback).map(b => b.close);
  const netDir = closes.length >= 2 ? closes[closes.length - 1] - closes[0] : 0;

  let direction = 'ranging';
  if (er !== null && er > th.erTrendThreshold) direction = netDir >= 0 ? 'trending-up' : 'trending-down';

  const crossRate = meanCrossingRate(bars, th.meanReversionLookback);
  const meanReverting = direction === 'ranging' && crossRate !== null && crossRate > th.meanReversionCrossRate;

  const expansionState = fractalEngine.expansionCompression(bars, {
    shortAtrPeriod: fractalEngine.DEFAULT_THRESHOLDS.shortAtrPeriod,
    longAtrPeriod: fractalEngine.DEFAULT_THRESHOLDS.longAtrPeriod,
    expansionRatio: fractalEngine.DEFAULT_THRESHOLDS.expansionRatio,
    compressionRatio: fractalEngine.DEFAULT_THRESHOLDS.compressionRatio,
  });

  const volPct = volatilityPercentile(bars, th);
  let volatilityLevel = 'normal';
  if (volPct !== null) {
    if (volPct >= th.volHighPercentile) volatilityLevel = 'high';
    else if (volPct <= th.volLowPercentile) volatilityLevel = 'low';
  }

  return {
    direction,
    efficiencyRatio: er !== null ? +er.toFixed(3) : null,
    meanReverting,
    meanCrossRate: crossRate !== null ? +crossRate.toFixed(3) : null,
    volatilityState: expansionState.state,   // 'expanding' | 'compressing' | 'steady' | 'unknown'
    volatilityRatio: expansionState.ratio,
    volatilityLevel,                          // 'high' | 'low' | 'normal', relative to this instrument's own recent history
    volatilityPercentile: volPct !== null ? +volPct.toFixed(2) : null,
    newsDriven: { available: false, reason: 'no economic-calendar/news feed configured in this codebase' },
  };
}

module.exports = { DEFAULT_THRESHOLDS, efficiencyRatio, meanCrossingRate, volatilityPercentile, classifyRegime };
