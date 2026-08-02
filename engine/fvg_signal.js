'use strict';

// ─── Live signal module for the VALIDATED hourly FVG strategy ─────────────
// (research id: fvg_continuation_narrow — STRATEGY_RESEARCH_LOG.md round 5)
//
// Mirrors backtest/research_phase5.js's tradesFromFvgContinuation logic
// EXACTLY, restricted to the config that was validated end-to-end (5/5
// walk-forward folds + 92-trade untouched holdout + funded-account Monte
// Carlo): minGapSize=50, slBufferPct=0.1, targetRMultiple=1, maxWaitBars=10,
// Tue/Wed/Thu signal days. Deliberately NOT configurable from the UI — the
// validated config is the strategy; changing a knob invalidates the
// evidence behind it.
//
// Definition (objective, machine-checkable): a bullish FVG exists at hourly
// bar i when bar[i-2].high < bar[i].low with a gap of >= minGapSize points
// (bearish: bar[i-2].low > bar[i].high). The signal becomes actionable only
// once bar i has CLOSED. Entry: first touch of the gap's near edge within
// maxWaitBars hourly bars (live: a resting limit order at that edge).
// Stop: far gap edge minus (slBufferPct x gap). Target: 1R.

const VALIDATED_CONFIG = Object.freeze({
  minGapSize: 50, slBufferPct: 0.1, targetRMultiple: 1, maxWaitBars: 10,
  allowedDaysOfWeek: Object.freeze([2, 3, 4]), // Tue/Wed/Thu (CT), per the validated config
});

function ctDow(unixSecs) {
  const d = new Date(new Date(unixSecs * 1000).toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  return d.getDay();
}

// Scans hourly bars and returns the current actionable state:
//  { state: 'NONE' } — no qualifying FVG inside its wait window
//  { state: 'PENDING', bias, entry, sl, target, gapLow, gapHigh, signalTime, expiresAfterBarTime }
//     — gap formed, untouched: a resting limit at `entry` is the validated entry
//  { state: 'FIRED', ... } — gap edge already touched within the window this
//     bar-series shows; entry level already traded. Shown for transparency;
//     chasing after the touch is NOT the validated entry.
function currentSignal(hourlyBars, cfg = VALIDATED_CONFIG) {
  if (!hourlyBars || hourlyBars.length < 4) return { state: 'NONE', reason: 'insufficient hourly data' };

  // Walk backward over recent bars so the MOST RECENT qualifying gap wins.
  const start = Math.max(2, hourlyBars.length - cfg.maxWaitBars - 3);
  let best = null;
  for (let i = hourlyBars.length - 1; i >= start; i--) {
    if (!cfg.allowedDaysOfWeek.includes(ctDow(hourlyBars[i].time))) continue;
    const left = hourlyBars[i - 2], right = hourlyBars[i];
    let bias = null, gapLow = null, gapHigh = null;
    if (left.high < right.low && (right.low - left.high) >= cfg.minGapSize) { bias = 'BUY'; gapLow = left.high; gapHigh = right.low; }
    else if (left.low > right.high && (left.low - right.high) >= cfg.minGapSize) { bias = 'SELL'; gapLow = right.high; gapHigh = left.low; }
    if (!bias) continue;

    const barsSince = hourlyBars.length - 1 - i;
    if (barsSince > cfg.maxWaitBars) continue; // wait window expired

    const gapSize = gapHigh - gapLow;
    const entry = bias === 'BUY' ? gapHigh : gapLow; // near edge (first-touch level)
    const sl = bias === 'BUY' ? gapLow - gapSize * cfg.slBufferPct : gapHigh + gapSize * cfg.slBufferPct;
    const risk = Math.abs(entry - sl);
    const target = bias === 'BUY' ? entry + risk * cfg.targetRMultiple : entry - risk * cfg.targetRMultiple;

    // Touched yet? (only bars strictly AFTER the formation bar count)
    let touched = false;
    for (let k = i + 1; k < hourlyBars.length; k++) {
      const b = hourlyBars[k];
      if (b.low <= gapHigh && b.high >= gapLow) { touched = true; break; }
    }

    best = {
      state: touched ? 'FIRED' : 'PENDING',
      bias, entry: +entry.toFixed(2), sl: +sl.toFixed(2), target: +target.toFixed(2),
      riskPts: +risk.toFixed(2), targetPts: +Math.abs(target - entry).toFixed(2),
      gapLow: +gapLow.toFixed(2), gapHigh: +gapHigh.toFixed(2), gapSizePts: +gapSize.toFixed(2),
      signalTime: right.time, barsSinceSignal: barsSince, waitBarsRemaining: cfg.maxWaitBars - barsSince,
    };
    break; // most recent qualifying gap wins
  }
  return best || { state: 'NONE', reason: `no qualifying FVG (>=${cfg.minGapSize}pt hourly imbalance, Tue/Wed/Thu) within the last ${cfg.maxWaitBars} hours` };
}

module.exports = { VALIDATED_CONFIG, currentSignal };
