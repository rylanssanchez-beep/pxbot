'use strict';

// ─── Confirmation Engine ───────────────────────────────────────────────────
// Fuses every independent context source this codebase now has — MTF
// structure (structure_engine + mtf_engine), premium/discount fractal
// position at the daily AND multi-timeframe level (fractal_engine),
// market regime (regime_engine), liquidity sweeps, FVG/order-block
// confluence, VWAP relationship, displacement, cross-strategy (ICT vs ORB)
// agreement, and SMT divergence when available (confirmations.js) — into
// one confidence score and selectivity tier. This is the module that turns
// the previously-hardcoded-null `confidence` field into something real.
//
// Hard invariant, per the directive: this NEVER changes what ict_engine.js
// or orb_engine.js compute for entry/stop/target, and it NEVER fires a trade
// on one confirmation alone — a tier requires a minimum COUNT of
// independently-agreeing factor families, not just a percentage.
//
// Every factor is independent by construction (each reads a different data
// source: structure, fractal position, regime, liquidity, FVG/OB, VWAP,
// cross-strategy, SMT) — "independent" here means computed from a distinct
// underlying signal, not statistically decorrelated (that would need the
// live-data sample confirmation_backtest.js is built to gather).
//
// Weights start equal (see engine/confirmation_weights.json) — NOT invented
// magic numbers. They may only ever change via the human-in-the-loop
// proposal/promotion path (journal_review.js analysis -> *.proposed.json ->
// backtest/apply_weights.js, which a human runs deliberately) — nothing
// here or elsewhere auto-applies a weight change.

const fractalEngine = require('./fractal_engine');
const regimeEngine = require('./regime_engine');
const mtfEngine = require('./mtf_engine');
const confirmations = require('./confirmations');

// Mirrors engine/confirmation_weights.json's baseline exactly. That JSON
// file is the canonical, human-editable source callers load from disk and
// pass in as `weights` — this constant exists so the module is independently
// testable with zero file I/O (matches the "pure functions" discipline the
// rest of engine/ follows).
const DEFAULT_WEIGHTS = {
  mtfStructureAgreement:   1,
  mtfFractalAlignment:     1,
  dailyPricePosition:      1,
  regimeTrendAlignment:    1,
  liquiditySweepAlignment: 1,
  fvgConfluence:           1,
  orderBlockConfluence:    1,
  displacementPresent:     1,
  vwapRelationship:        1,
  crossStrategyAgreement:  1,
  smtConfirmation:         1,
};

// Starting selectivity thresholds — placeholders pending validation by
// backtest/confirmation_backtest.js (which checks whether higher tiers
// actually correlate with better out-of-sample expectancy). Not asserted as
// correct; that is exactly what the validation step exists to check.
const DEFAULT_THRESHOLDS = {
  minAgreeingForB:      3,
  minAgreeingForA:      4,
  minAgreeingForAPlus:  5,
  minConfidenceForB:    55,
  minConfidenceForA:    70,
  minConfidenceForAPlus: 82,
};

// input = {
//   bias: 'BUY'|'SELL',              // the candidate direction being scored (from ict/orb's own output)
//   quote: number,                    // current price
//   entryZone: {low, high} | null,    // candidate entry zone, for FVG/OB confluence checks
//   executionBars: [...],             // bars at the timeframe entries are simulated on (hourly today)
//   barsByTF: { m5, m15, h1, h4, d1, weekly, monthly } | undefined,  // from mtf_engine.fetchMTFBars
//   ictResult, orbResult: {...} | null,  // raw engine outputs, for cross-strategy agreement
//   smtBarsB: [...] | undefined,      // optional correlated-instrument bars — omit if none available
// }
function computeConfirmation(input, weights = DEFAULT_WEIGHTS, th = DEFAULT_THRESHOLDS) {
  const { bias, quote, entryZone, executionBars, barsByTF, ictResult, orbResult, smtBarsB } = input;
  const factors = [];
  const addFactor = (name, agrees, detail, excluded = false) => {
    factors.push({ name, weight: excluded ? 0 : (weights[name] || 0), agrees, detail, excluded });
  };

  // 1+2. Multi-timeframe structure bias + premium/discount alignment
  if (barsByTF && Object.keys(barsByTF).length) {
    const align = mtfEngine.mtfAlignment(barsByTF, quote);
    const structDom = align.structure.dominant;
    let structAgrees = null;
    if (structDom === 'BULLISH') structAgrees = bias === 'BUY';
    else if (structDom === 'BEARISH') structAgrees = bias === 'SELL';
    addFactor('mtfStructureAgreement', structAgrees, { dominant: structDom, agreement: align.structure.agreement, timeframesConsidered: align.timeframesConsidered });

    const fracDom = align.fractalAlignment.dominant;
    let fracAgrees = null;
    if (fracDom === 'discount') fracAgrees = bias === 'BUY';
    else if (fracDom === 'premium') fracAgrees = bias === 'SELL';
    addFactor('mtfFractalAlignment', fracAgrees, { dominant: fracDom, agreement: align.fractalAlignment.agreement });
  } else {
    addFactor('mtfStructureAgreement', null, { reason: 'no MTF bars supplied' });
    addFactor('mtfFractalAlignment', null, { reason: 'no MTF bars supplied' });
  }

  // 3. Daily dealing-range premium/discount (explicit standalone daily check)
  if (barsByTF && barsByTF.d1 && barsByTF.d1.length) {
    const dRange = fractalEngine.dealingRange(barsByTF.d1);
    const dPos = fractalEngine.pricePosition(quote, dRange);
    let agrees = null;
    if (dPos.zone === 'discount') agrees = bias === 'BUY';
    else if (dPos.zone === 'premium') agrees = bias === 'SELL';
    addFactor('dailyPricePosition', agrees, { zone: dPos.zone, pct: dPos.pct });
  } else {
    addFactor('dailyPricePosition', null, { reason: 'no daily bars supplied' });
  }

  // 4. Market regime — does the environment favor this direction right now?
  if (executionBars && executionBars.length >= 30) {
    const regime = regimeEngine.classifyRegime(executionBars);
    let agrees = null;
    if (regime.direction === 'trending-up') agrees = bias === 'BUY';
    else if (regime.direction === 'trending-down') agrees = bias === 'SELL';
    addFactor('regimeTrendAlignment', agrees, { direction: regime.direction, efficiencyRatio: regime.efficiencyRatio, volatilityState: regime.volatilityState, volatilityLevel: regime.volatilityLevel });
  } else {
    addFactor('regimeTrendAlignment', null, { reason: 'insufficient execution bars for a regime read' });
  }

  // 5. Liquidity sweep vs. the prior day's range — classic stop-hunt-then-reversal read
  if (barsByTF && barsByTF.d1 && barsByTF.d1.length >= 2 && executionBars && executionBars.length) {
    const priorDay = barsByTF.d1[barsByTF.d1.length - 2];
    const sweptHigh = confirmations.sweptLevel(executionBars, priorDay.high, 1, { direction: 'above' });
    const sweptLow = confirmations.sweptLevel(executionBars, priorDay.low, 1, { direction: 'below' });
    let agrees = null;
    if (sweptLow.swept && !sweptHigh.swept) agrees = bias === 'BUY';
    else if (sweptHigh.swept && !sweptLow.swept) agrees = bias === 'SELL';
    addFactor('liquiditySweepAlignment', agrees, { sweptHigh: sweptHigh.swept, sweptLow: sweptLow.swept });
  } else {
    addFactor('liquiditySweepAlignment', null, { reason: 'insufficient data' });
  }

  // 6. FVG confluence inside/near the candidate entry zone
  if (executionBars && executionBars.length && entryZone) {
    const fvgs = confirmations.findFVGs(executionBars);
    const wantType = bias === 'BUY' ? 'bullish' : 'bearish';
    const nearby = fvgs.filter(g => !g.filled && g.type === wantType && g.top >= entryZone.low && g.bottom <= entryZone.high);
    addFactor('fvgConfluence', nearby.length > 0 ? true : null, { count: nearby.length });
  } else {
    addFactor('fvgConfluence', null, { reason: 'insufficient data' });
  }

  // 7. Order block confluence inside/near the candidate entry zone
  if (executionBars && executionBars.length && entryZone) {
    const obs = confirmations.findOrderBlocks(executionBars);
    const wantType = bias === 'BUY' ? 'bullish' : 'bearish';
    const nearby = obs.filter(o => o.type === wantType && o.low <= entryZone.high && o.high >= entryZone.low);
    addFactor('orderBlockConfluence', nearby.length > 0 ? true : null, { count: nearby.length });
  } else {
    addFactor('orderBlockConfluence', null, { reason: 'insufficient data' });
  }

  // 8. Recent displacement in the same direction
  if (executionBars && executionBars.length >= 20) {
    const disp = confirmations.findDisplacements(executionBars.slice(-20));
    const matching = disp.filter(d => d.bias === bias);
    addFactor('displacementPresent', matching.length > 0 ? true : null, { count: matching.length });
  } else {
    addFactor('displacementPresent', null, { reason: 'insufficient data' });
  }

  // 9. VWAP relationship — only ever supportive (price on the trend side of
  // VWAP), never counted against a trade, since a pullback to VWAP is also a
  // legitimate entry context and treating "wrong side of VWAP" as hard
  // disagreement would be an unvalidated directional claim.
  if (executionBars && executionBars.length) {
    const vw = confirmations.vwap(executionBars);
    const currentVwap = vw[vw.length - 1].vwap;
    const onTrendSide = (bias === 'BUY' && quote > currentVwap) || (bias === 'SELL' && quote < currentVwap);
    addFactor('vwapRelationship', onTrendSide ? true : null, { vwap: +currentVwap.toFixed(2), quote });
  } else {
    addFactor('vwapRelationship', null, { reason: 'insufficient data' });
  }

  // 10. Cross-strategy agreement — ICT and ORB currently run in complete
  // isolation (server.js:handleSignal computes both, fuses neither); this is
  // the first place they actually inform each other.
  if (ictResult && orbResult && ictResult.bias && orbResult.bias && ictResult.bias !== 'WAIT' && orbResult.bias !== 'WAIT') {
    const bothAgree = ictResult.bias === orbResult.bias;
    addFactor('crossStrategyAgreement', bothAgree ? (ictResult.bias === bias) : false, { ictBias: ictResult.bias, orbBias: orbResult.bias });
  } else {
    addFactor('crossStrategyAgreement', null, { reason: 'only one (or neither) strategy has fired' });
  }

  // 11. SMT divergence — excluded entirely (weight forced to 0, not counted
  // as neutral) when no correlated-instrument feed is supplied, per
  // confirmations.js's contract: unavailable must contribute nothing, not a
  // default lean either way.
  const smtResult = confirmations.smt(executionBars, smtBarsB);
  if (smtResult.available) {
    let agrees = null;
    if (smtResult.bullishDivergence) agrees = bias === 'BUY';
    if (smtResult.bearishDivergence) agrees = bias === 'SELL';
    addFactor('smtConfirmation', agrees, smtResult);
  } else {
    addFactor('smtConfirmation', null, smtResult, true);
  }

  // --- Aggregate ---
  const scored = factors.filter(f => !f.excluded && f.weight > 0 && f.agrees !== null);
  const agreeing = scored.filter(f => f.agrees === true);
  const disagreeing = scored.filter(f => f.agrees === false);
  const totalWeight = scored.reduce((a, f) => a + f.weight, 0);
  const agreeWeight = agreeing.reduce((a, f) => a + f.weight, 0);
  const disagreeWeight = disagreeing.reduce((a, f) => a + f.weight, 0);

  let confidence = 50; // neutral baseline when nothing could be scored
  if (totalWeight > 0) confidence = 50 + 50 * (agreeWeight - disagreeWeight) / totalWeight;
  confidence = Math.max(0, Math.min(100, confidence));

  const agreeingCount = agreeing.length;
  let tier = 'skip';
  if (agreeingCount >= th.minAgreeingForAPlus && confidence >= th.minConfidenceForAPlus) tier = 'A+';
  else if (agreeingCount >= th.minAgreeingForA && confidence >= th.minConfidenceForA) tier = 'A';
  else if (agreeingCount >= th.minAgreeingForB && confidence >= th.minConfidenceForB) tier = 'B';

  return {
    bias, factors,
    agreeingCount, disagreeingCount: disagreeing.length, neutralCount: factors.length - scored.length,
    confidence: +confidence.toFixed(1), tier,
  };
}

module.exports = { DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS, computeConfirmation };
