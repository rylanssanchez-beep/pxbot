'use strict';

// ─── Multi-Timeframe Validation Engine ─────────────────────────────────────
// Before this, the only cross-resolution logic anywhere in PXBOT was
// backtest/finegrain.js's offline hourly-classify/1-minute-execute split —
// the live /api/signal path (server.js:handleSignal) only ever looked at
// hourly bars. This module builds a real per-timeframe read across
// Monthly/Weekly/Daily/4H/1H/15M/5M and scores how well they agree — pure
// confirmation input for engine/confirmation_engine.js, never a standalone
// trigger, per the directive.
//
// fetchMTFBars takes an injected `loopbackGet`-shaped function rather than
// doing its own HTTP, so this module stays testable without a live server
// (server.js already has a loopbackGet(apiPath) -> Promise<json> helper it
// passes in — same one handleSignal already uses for the hourly fetch).

const structureEngine = require('./structure_engine');
const fractalEngine = require('./fractal_engine');

// TradeLocker's /api/candles only supports 1/5/15/30/60/240/1440-minute
// resolutions (confirmed in server.js's zod enum for the MCP tool) — no
// native weekly/monthly, so those two are built by aggregating daily bars.
async function fetchMTFBars(loopbackGet, opts = {}) {
  // m1 is the TRUE execution timeframe — this account's actual entries/exits
  // happen on the 1-minute chart, not hourly. m5 through monthly are the
  // higher-timeframe "key levels" context. Together these are the 8
  // timeframes the directive lists: Monthly/Weekly/Daily/4H/1H/15M/5M/Execution.
  const counts = { m1: 1000, m5: 500, m15: 500, h1: 2000, h4: 1000, d1: 500, ...(opts.counts || {}) };
  const [m1, m5, m15, h1, h4, d1] = await Promise.all([
    loopbackGet(`/api/candles?resolution=1&count=${counts.m1}`),
    loopbackGet(`/api/candles?resolution=5&count=${counts.m5}`),
    loopbackGet(`/api/candles?resolution=15&count=${counts.m15}`),
    loopbackGet(`/api/candles?resolution=60&count=${counts.h1}`),
    loopbackGet(`/api/candles?resolution=240&count=${counts.h4}`),
    loopbackGet(`/api/candles?resolution=1440&count=${counts.d1}`),
  ]);
  const daily = d1.bars || [];
  return {
    m1: m1.bars || [], m5: m5.bars || [], m15: m15.bars || [], h1: h1.bars || [], h4: h4.bars || [],
    d1: daily,
    weekly: fractalEngine.aggregateToTimeframe(daily, 'week'),
    monthly: fractalEngine.aggregateToTimeframe(daily, 'month'),
  };
}

// Per-timeframe read: where price sits in this timeframe's dealing range,
// and what its market structure (BOS/CHOCH trend bias) says.
function computeTimeframeAnalysis(bars, currentPrice, opts = {}) {
  if (!bars || bars.length < 10) return null;
  const range = fractalEngine.dealingRange(bars);
  const position = fractalEngine.pricePosition(currentPrice, range, opts.fractalThresholds);
  const structure = structureEngine.detectStructure(bars, opts.structureOpts);
  return { range, position, structureBias: structure.structureBias, lastBarTime: bars[bars.length - 1].time };
}

// Fuses the per-timeframe reads into one alignment score: how many
// timeframes agree on premium/discount (via fractalEngine.nestedFractalAlignment)
// and how many agree on BOS/CHOCH structural bias. Both are directional
// reads computed independently — combining them is itself a confirmation-
// of-confirmations, not a new invented signal.
function mtfAlignment(barsByTF, currentPrice, opts = {}) {
  const perTF = {};
  for (const [tf, bars] of Object.entries(barsByTF)) {
    perTF[tf] = computeTimeframeAnalysis(bars, currentPrice, opts);
  }

  const positionsByTF = {};
  for (const [tf, a] of Object.entries(perTF)) if (a) positionsByTF[tf] = a.position;
  const fractalAlignment = fractalEngine.nestedFractalAlignment(positionsByTF);

  const structureEntries = Object.entries(perTF).filter(([, a]) => a && a.structureBias && a.structureBias !== 'NEUTRAL');
  const bullishCount = structureEntries.filter(([, a]) => a.structureBias === 'BULLISH').length;
  const bearishCount = structureEntries.filter(([, a]) => a.structureBias === 'BEARISH').length;
  const structureDirectional = bullishCount + bearishCount;
  const structureDominant = bullishCount > bearishCount ? 'BULLISH' : bearishCount > bullishCount ? 'BEARISH' : 'MIXED';
  const structureAgreement = structureDirectional > 0 ? Math.max(bullishCount, bearishCount) / structureDirectional : 0;

  let overallAgreement = null;
  if (fractalAlignment.timeframesConsidered > 0 && structureDirectional > 0) {
    overallAgreement = (fractalAlignment.agreement + structureAgreement) / 2;
  } else if (fractalAlignment.timeframesConsidered > 0) {
    overallAgreement = fractalAlignment.agreement;
  } else if (structureDirectional > 0) {
    overallAgreement = structureAgreement;
  }

  return {
    perTimeframe: perTF,
    fractalAlignment,
    structure: { bullishCount, bearishCount, dominant: structureDominant, agreement: +structureAgreement.toFixed(2) },
    timeframesConsidered: Object.keys(perTF).filter(tf => perTF[tf]).length,
    overallAgreement: overallAgreement !== null ? +overallAgreement.toFixed(2) : null,
  };
}

module.exports = { fetchMTFBars, computeTimeframeAnalysis, mtfAlignment };
