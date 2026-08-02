'use strict';

// ─── Replay / Execution Engine — Part 3 of the PXBOT upgrade ──────────────
// A general-purpose, deterministic, chronological trade simulator that every
// strategy module (existing and new) can share, instead of each engine
// reimplementing its own ad-hoc forward-scan loop with zero cost modeling
// (the gap DATA_AUDIT.md §5 found in ict_engine.js/orb_engine.js/
// session_breakout_engine.js). Two responsibilities:
//
//   1. ChronologicalContext — safe multi-timeframe access. Given a 1-minute
//      bar index, exposes only the higher-timeframe bars that have actually
//      CLOSED as of that point (never the still-forming current bucket).
//      Aggregation itself is a pure function of the fixed input array (a
//      bucket's OHLC only depends on the 1m bars inside that bucket's exact
//      time range, never on anything after it), so precomputing the full
//      aggregated series once and then filtering to "closed as of time T" is
//      provably equivalent to recomputing incrementally up to T — see
//      backtest/no_lookahead_test.js for the automated proof.
//
//   2. simulateTrade — one trade's full lifecycle: order-type fill (market/
//      limit/stop, with missed-limit tracking), partials, breakeven,
//      trailing stops, time/session exits, MAE/MFE, and a configurable cost
//      model (spread/slippage/commission). Same-bar stop-vs-target ambiguity
//      is ALWAYS resolved by checking the stop first (never assumes the
//      target was hit first, per the mission's explicit requirement) and the
//      trade is additionally flagged `ambiguousFill: true` so it's visible
//      in the ledger/report rather than silently treated as clean.

const structureEngine = require('./structure_engine');

// ── 1) Deterministic OHLC aggregation ──────────────────────────────────────
// unitSeconds: bucket width (e.g. 300 for 5m, 3600 for 1H). Buckets are
// floor(time / unitSeconds) * unitSeconds, matching server.js's existing
// buildAllResolutions() convention so results agree with the live app.
function aggregateOHLC(bars1m, unitSeconds) {
  const out = [];
  for (const b of bars1m) {
    const bucketStart = Math.floor(b.time / unitSeconds) * unitSeconds;
    const last = out.length ? out[out.length - 1] : null;
    if (last && last.time === bucketStart) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume = (last.volume || 0) + (b.volume || 0);
      last._lastMemberTime = b.time;
    } else {
      out.push({ time: bucketStart, open: b.open, high: b.high, low: b.low, close: b.close,
        volume: b.volume || 0, _lastMemberTime: b.time });
    }
  }
  return out;
}

const TIMEFRAME_SECONDS = { '5m': 300, '15m': 900, '30m': 1800, '1H': 3600, '4H': 14400, '1D': 86400 };

class ChronologicalContext {
  constructor(bars1m, timeframes = Object.keys(TIMEFRAME_SECONDS)) {
    this.bars1m = bars1m;
    this.timeframes = timeframes;
    this._aggregated = {};
    this._unitSeconds = {};
    for (const tf of timeframes) {
      const unit = TIMEFRAME_SECONDS[tf];
      if (!unit) throw new Error(`Unknown timeframe: ${tf}`);
      this._unitSeconds[tf] = unit;
      this._aggregated[tf] = aggregateOHLC(bars1m, unit);
    }
  }

  // All bars for `tf` whose bucket has fully closed by `currentTimeSec`
  // (bucketEnd = bucketStart + unit <= currentTimeSec). Excludes the
  // in-progress bucket that currentTimeSec itself falls inside.
  closedBarsAsOf(tf, currentTimeSec) {
    const unit = this._unitSeconds[tf];
    const series = this._aggregated[tf];
    // Binary search for the last bar whose (time + unit) <= currentTimeSec.
    let lo = 0, hi = series.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (series[mid].time + unit <= currentTimeSec) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans === -1 ? [] : series.slice(0, ans + 1);
  }

  latestClosedBar(tf, currentTimeSec) {
    const bars = this.closedBarsAsOf(tf, currentTimeSec);
    return bars.length ? bars[bars.length - 1] : null;
  }
}

// ── 2) Cost model ───────────────────────────────────────────────────────
// Convention (documented, not claimed as microstructure-perfect):
//  - Entry (market or stop-triggered): price moves against the trader by
//    (spreadPts/2 + slippagePts).
//  - Exit via stop/time/session-close (a market-type exit): same adverse
//    (spreadPts/2 + slippagePts).
//  - Exit via target/partial (a resting-limit-type fill): adverse
//    (spreadPts/2) only — no slippage, since a limit order either fills at
//    its price or doesn't.
//  - Commission: a flat R-multiple decrement per fill event (entry counts as
//    one, each exit/partial counts as one), since commission is normally a
//    flat $ amount independent of price and R-normalization is this
//    project's reporting unit throughout.
const DEFAULT_COST_MODEL = { spreadPts: 0, slippagePts: 0, commissionR: 0, entryDelayBars: 0 };

function adverseAdjust(price, direction, pts) {
  // LONG: adverse = higher entry price / lower exit price. SHORT: opposite.
  return direction === 'LONG' ? price + pts : price - pts;
}
function favorableToAdverseExit(price, direction, pts) {
  // For exits, "adverse" means worse fill for the position: LONG sells lower, SHORT buys higher.
  return direction === 'LONG' ? price - pts : price + pts;
}

// ── 3) Trailing-stop helpers — pure functions of (bars up to currentIndex),
// never touch anything beyond currentIndex, so they're lookahead-safe by
// construction as long as callers only ever pass bars.slice(0, currentIndex+1).
function atrTrailingStop(barsUpToNow, direction, atrMultiple, atrPeriod, currentStop) {
  const atrVal = structureEngine.atr(barsUpToNow, atrPeriod);
  if (!atrVal) return currentStop;
  const lastClose = barsUpToNow[barsUpToNow.length - 1].close;
  const candidate = direction === 'LONG' ? lastClose - atrVal * atrMultiple : lastClose + atrVal * atrMultiple;
  if (currentStop === null || currentStop === undefined) return candidate;
  // Ratchet only in the favorable direction — never loosen the stop.
  return direction === 'LONG' ? Math.max(currentStop, candidate) : Math.min(currentStop, candidate);
}

function swingTrailingStop(barsUpToNow, direction, lookback, currentStop) {
  const swings = direction === 'LONG'
    ? structureEngine.findSwingLows(barsUpToNow, lookback)
    : structureEngine.findSwingHighs(barsUpToNow, lookback);
  if (!swings.length) return currentStop;
  const candidate = swings[swings.length - 1].price;
  if (currentStop === null || currentStop === undefined) return candidate;
  return direction === 'LONG' ? Math.max(currentStop, candidate) : Math.min(currentStop, candidate);
}

// ── 4) Trade simulation ────────────────────────────────────────────────
//
// bars:        execution-resolution bars (1-minute for real trading), MUST
//              extend forward from signalIndex — this function never looks
//              at anything before signalIndex, and only ever reads
//              bars[signalIndex..k] for the k it has already reached, never ahead.
// signalIndex: index of the bar where the entry decision was made.
// direction:   'LONG' | 'SHORT'
// orderType:   'market' | 'limit' | 'stop'
// orderPrice:  required for limit/stop orders (ignored for market).
// stopPrice / targetPrice: initial levels (targetPrice may be null if
//              exitPlan.partials fully describes the exit ladder instead).
// exitPlan:    { partials: [{rMultiple, pct}], breakevenAtR, trailing:
//              {type:'atr'|'swing', atrMultiple, atrPeriod, lookback},
//              maxHoldingBars, sessionCloseAfterHour (CT hour, optional) }
// costModel:   see DEFAULT_COST_MODEL
// entryTimeoutBars: for limit/stop orders — bars to wait for a fill before
//              marking the order missed (never filled, no trade).
function simulateTrade({ bars, signalIndex, direction, orderType = 'market', orderPrice = null,
  stopPrice, targetPrice = null, exitPlan = {}, costModel = DEFAULT_COST_MODEL, entryTimeoutBars = 20,
  ctPartsFn = null }) {
  const cm = { ...DEFAULT_COST_MODEL, ...costModel };
  const sign = direction === 'LONG' ? 1 : -1;

  // --- Entry ---
  let entryIndex = -1, entryPriceRaw = null, missedReason = null;
  const delay = cm.entryDelayBars || 0;
  const searchStart = signalIndex + 1 + delay;

  if (orderType === 'market') {
    if (searchStart < bars.length) { entryIndex = searchStart; entryPriceRaw = bars[searchStart].open; }
  } else {
    // limit / stop: scan forward up to entryTimeoutBars for a touch of orderPrice.
    for (let i = searchStart; i < Math.min(bars.length, searchStart + entryTimeoutBars); i++) {
      const b = bars[i];
      const touched = orderType === 'limit'
        ? (direction === 'LONG' ? b.low <= orderPrice : b.high >= orderPrice)
        : (direction === 'LONG' ? b.high >= orderPrice : b.low <= orderPrice); // stop order
      if (touched) { entryIndex = i; entryPriceRaw = orderPrice; break; }
    }
    if (entryIndex === -1) missedReason = 'timeout';
  }

  if (entryIndex === -1) {
    return { filled: false, missedReason: missedReason || 'no_forward_data', direction, orderType, orderPrice };
  }

  const entryPrice = adverseAdjust(entryPriceRaw, direction, cm.spreadPts / 2 + cm.slippagePts);
  const riskPts = Math.abs(entryPrice - stopPrice);
  if (!(riskPts > 0)) {
    return { filled: false, missedReason: 'zero_or_invalid_risk', direction, orderType, entryPrice, stopPrice };
  }

  // --- Walk forward from entry ---
  const partials = [...(exitPlan.partials || [])].sort((a, b) => a.rMultiple - b.rMultiple);
  const taken = new Set();
  let remainingPct = 1.0;
  let realizedRGross = 0;
  let currentStop = stopPrice;
  let stage = 'initial'; // initial | breakeven | trailing | partial_lock
  let maePts = 0, mfePts = 0;
  let ambiguousFill = false;
  let exitIndex = null, exitReason = null, finalExitPrice = null;
  let fillEvents = 1; // entry counts as one commission event

  const maxHoldingBars = exitPlan.maxHoldingBars || Infinity;

  for (let k = entryIndex; k < bars.length && (k - entryIndex) <= maxHoldingBars; k++) {
    const b = bars[k];
    mfePts = Math.max(mfePts, direction === 'LONG' ? b.high - entryPrice : entryPrice - b.low);
    maePts = Math.max(maePts, direction === 'LONG' ? entryPrice - b.low : b.high - entryPrice);

    const stopTouched = direction === 'LONG' ? b.low <= currentStop : b.high >= currentStop;
    const anyTargetTouched = partials.some(p => !taken.has(p.rMultiple)
      && (direction === 'LONG' ? b.high >= entryPrice + sign * p.rMultiple * riskPts : b.low <= entryPrice - p.rMultiple * riskPts))
      || (targetPrice !== null && (direction === 'LONG' ? b.high >= targetPrice : b.low <= targetPrice));

    if (stopTouched && anyTargetTouched) ambiguousFill = true;

    // Conservative: stop is ALWAYS checked first, regardless of what else touched this bar.
    if (stopTouched) {
      const exitFill = favorableToAdverseExit(currentStop, direction, cm.spreadPts / 2 + cm.slippagePts);
      const rThisLeg = (sign * (exitFill - entryPrice)) / riskPts;
      realizedRGross += rThisLeg * remainingPct;
      fillEvents++;
      exitIndex = k; finalExitPrice = exitFill;
      exitReason = stage === 'initial' ? 'SL' : stage === 'breakeven' ? 'BE' : stage === 'trailing' ? 'TRAIL' : 'PARTIAL_LOCK';
      remainingPct = 0;
      break;
    }

    // Partial targets (ladder), in ascending R order, all touched-this-bar ones processed.
    for (const p of partials) {
      if (taken.has(p.rMultiple)) continue;
      const level = direction === 'LONG' ? entryPrice + p.rMultiple * riskPts : entryPrice - p.rMultiple * riskPts;
      const hit = direction === 'LONG' ? b.high >= level : b.low <= level;
      if (!hit) continue;
      const exitFill = favorableToAdverseExit(level, direction, cm.spreadPts / 2); // limit-type fill: spread only, no slippage
      realizedRGross += p.rMultiple * p.pct;
      remainingPct -= p.pct;
      taken.add(p.rMultiple);
      fillEvents++;
      // Track this as the provisional exit record — if the ladder fully
      // closes the position (remainingPct hits 0) with no separate stop/
      // target event afterward, THIS is the trade's actual final exit and
      // must be recorded, not left null.
      exitIndex = k; finalExitPrice = exitFill; exitReason = 'PARTIAL_TP';
      if (exitPlan.breakevenAtR != null && p.rMultiple >= exitPlan.breakevenAtR && stage === 'initial') {
        currentStop = entryPrice; stage = 'breakeven';
      } else if (stage !== 'breakeven') {
        stage = 'partial_lock';
        currentStop = direction === 'LONG' ? Math.max(currentStop, level) : Math.min(currentStop, level);
      }
      if (remainingPct > 1e-9) { exitIndex = null; finalExitPrice = null; exitReason = null; } // position still open — not the final exit after all
    }

    // Single fixed target (non-laddered mode).
    if (targetPrice !== null && remainingPct > 1e-9) {
      const hit = direction === 'LONG' ? b.high >= targetPrice : b.low <= targetPrice;
      if (hit) {
        const exitFill = favorableToAdverseExit(targetPrice, direction, cm.spreadPts / 2);
        const rThisLeg = (sign * (exitFill - entryPrice)) / riskPts;
        realizedRGross += rThisLeg * remainingPct;
        fillEvents++;
        exitIndex = k; finalExitPrice = exitFill; exitReason = 'TP';
        remainingPct = 0;
        break;
      }
    }

    if (remainingPct <= 1e-9) break;

    // Trailing stop update — uses only bars[0..k], lookahead-safe.
    if (exitPlan.trailing) {
      const barsSoFar = bars.slice(0, k + 1);
      if (exitPlan.trailing.type === 'atr') {
        currentStop = atrTrailingStop(barsSoFar, direction, exitPlan.trailing.atrMultiple || 1.5, exitPlan.trailing.atrPeriod || 14, currentStop);
      } else if (exitPlan.trailing.type === 'swing') {
        currentStop = swingTrailingStop(barsSoFar, direction, exitPlan.trailing.lookback || 2, currentStop);
      }
      if (stage === 'initial') stage = 'trailing';
    }

    // Session-close exit (optional CT-hour cutoff — requires ctPartsFn(time)->{hour}).
    if (exitPlan.sessionCloseAfterHour != null && ctPartsFn) {
      const { hour } = ctPartsFn(b.time);
      if (hour >= exitPlan.sessionCloseAfterHour) {
        const exitFill = favorableToAdverseExit(b.close, direction, cm.spreadPts / 2 + cm.slippagePts);
        const rThisLeg = (sign * (exitFill - entryPrice)) / riskPts;
        realizedRGross += rThisLeg * remainingPct;
        fillEvents++;
        exitIndex = k; finalExitPrice = exitFill; exitReason = 'SESSION_CLOSE';
        remainingPct = 0;
        break;
      }
    }
  }

  if (remainingPct > 1e-9) {
    // Ran out of bars or hit maxHoldingBars without a terminal exit event.
    const k = Math.min(entryIndex + maxHoldingBars, bars.length - 1);
    const b = bars[k];
    const exitFill = favorableToAdverseExit(b.close, direction, cm.spreadPts / 2 + cm.slippagePts);
    const rThisLeg = (sign * (exitFill - entryPrice)) / riskPts;
    realizedRGross += rThisLeg * remainingPct;
    fillEvents++;
    exitIndex = k; finalExitPrice = exitFill;
    exitReason = (k === bars.length - 1 && (k - entryIndex) < maxHoldingBars) ? 'END_OF_DATA' : 'TIME';
  }

  const commissionCostR = cm.commissionR * fillEvents;
  const rMultiple = realizedRGross - commissionCostR;

  return {
    filled: true, direction, orderType,
    entryIndex, entryTime: bars[entryIndex].time, entryPrice, entryPriceRaw,
    stopPriceInitial: stopPrice, targetPriceInitial: targetPrice,
    exitIndex, exitTime: bars[exitIndex]?.time, exitPrice: finalExitPrice, exitReason,
    riskPts,
    rMultipleGross: +realizedRGross.toFixed(4), rMultiple: +rMultiple.toFixed(4),
    maePts: +maePts.toFixed(2), mfePts: +mfePts.toFixed(2),
    maeR: +(maePts / riskPts).toFixed(3), mfeR: +(mfePts / riskPts).toFixed(3),
    ambiguousFill, commissionCostR: +commissionCostR.toFixed(4), fillEvents,
    holdingBars: exitIndex - entryIndex,
  };
}

module.exports = {
  aggregateOHLC, TIMEFRAME_SECONDS, ChronologicalContext,
  DEFAULT_COST_MODEL, simulateTrade,
  atrTrailingStop, swingTrailingStop,
};
