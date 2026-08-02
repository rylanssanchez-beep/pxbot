'use strict';

// Automated proof that engine/replay_engine.js never uses future data —
// Part 3's explicit requirement ("Create automated tests proving there is
// no lookahead bias"). Two independent properties, both checked against a
// fixed-seed synthetic series (no live TL connection needed to run this):
//
//   1. ChronologicalContext prefix-consistency: closedBarsAsOf(tf, T)
//      computed from the FULL bar series must be byte-identical to the same
//      call computed from a series truncated at some point >= T. If a
//      future bar were leaking into "closed" aggregation, truncating it
//      away would change the result — it must not.
//
//   2. simulateTrade prefix-consistency: once a trade has fully resolved by
//      exitIndex, appending arbitrarily more bars after exitIndex (or even
//      corrupting their prices) must never change that trade's recorded
//      entry/exit/R/MAE/MFE. This is the direct test for "did the engine
//      peek past the moment it should have known about."
//
// Usage: node backtest/no_lookahead_test.js

const assert = require('assert');
const { generateSyntheticBars } = require('./fixtures/synthetic_bars');
const { ChronologicalContext, simulateTrade, TIMEFRAME_SECONDS } = require('../engine/replay_engine');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  PASS  ${label}`); }
  catch (e) { failures++; console.error(`  FAIL  ${label}\n        ${e.message}`); }
}

console.log('=== No-lookahead test 1: ChronologicalContext prefix-consistency ===');
{
  const bars1m = generateSyntheticBars({ count: 20000, resolutionMin: 1, seed: 7, basePrice: 20000, volPts: 8 });
  const fullCtx = new ChronologicalContext(bars1m, ['5m', '15m', '1H', '4H']);

  // Try several truncation points spread through the series.
  const truncationPoints = [5000, 9000, 13000, 17000, 19999];
  for (const M of truncationPoints) {
    const truncated = bars1m.slice(0, M + 1);
    const truncCtx = new ChronologicalContext(truncated, ['5m', '15m', '1H', '4H']);
    const T = bars1m[M].time;
    for (const tf of ['5m', '15m', '1H', '4H']) {
      check(`closedBarsAsOf('${tf}', T) identical whether computed on the full series or a series truncated right at T=${T} (bar ${M})`, () => {
        const full = fullCtx.closedBarsAsOf(tf, T);
        const trunc = truncCtx.closedBarsAsOf(tf, T);
        assert.deepStrictEqual(full, trunc, `full=${full.length} bars, truncated=${trunc.length} bars — must match`);
      });
    }
  }

  // Sanity: the in-progress bucket at T must NOT appear in closedBarsAsOf —
  // otherwise the "closed" claim above would be vacuous (both sides could
  // agree while both being wrong in the same way).
  check('the in-progress (still-forming) higher-timeframe bucket is excluded from closedBarsAsOf', () => {
    const T = bars1m[10000].time;
    const closed = fullCtx.closedBarsAsOf('1H', T);
    const inProgressBucketStart = Math.floor(T / TIMEFRAME_SECONDS['1H']) * TIMEFRAME_SECONDS['1H'];
    const leaked = closed.find(b => b.time === inProgressBucketStart);
    assert.strictEqual(leaked, undefined, 'the still-forming 1H bucket must not be returned as "closed"');
  });
}

console.log('\n=== No-lookahead test 2: simulateTrade prefix-consistency ===');
{
  const bars1m = generateSyntheticBars({ count: 30000, resolutionMin: 1, seed: 11, basePrice: 20000, volPts: 6 });

  // A spread of signal indices and exit-plan shapes, so this isn't just
  // proving one lucky trade shape is lookahead-safe.
  const scenarios = [
    { signalIndex: 500,  direction: 'LONG',  stopPts: 20, targetR: 1.5, label: 'simple fixed target, LONG' },
    { signalIndex: 4000, direction: 'SHORT', stopPts: 15, targetR: 2.0, label: 'simple fixed target, SHORT' },
    { signalIndex: 9000, direction: 'LONG',  stopPts: 25, trailing: { type: 'atr', atrMultiple: 1.5, atrPeriod: 14 }, label: 'ATR trailing stop, LONG' },
    { signalIndex: 15000, direction: 'SHORT', stopPts: 18, partials: [{ rMultiple: 1, pct: 0.5 }, { rMultiple: 2, pct: 0.5 }], breakevenAtR: 1, label: 'laddered partials + breakeven, SHORT' },
    { signalIndex: 22000, direction: 'LONG', stopPts: 10, maxHoldingBars: 60, label: 'tight stop, likely time-exit, LONG' },
  ];

  for (const sc of scenarios) {
    const entrySignalPrice = bars1m[sc.signalIndex].close;
    const stopPrice = sc.direction === 'LONG' ? entrySignalPrice - sc.stopPts : entrySignalPrice + sc.stopPts;
    const targetPrice = sc.targetR ? (sc.direction === 'LONG' ? entrySignalPrice + sc.stopPts * sc.targetR : entrySignalPrice - sc.stopPts * sc.targetR) : null;
    const exitPlan = {
      partials: sc.partials, breakevenAtR: sc.breakevenAtR, trailing: sc.trailing,
      maxHoldingBars: sc.maxHoldingBars || 2000,
    };
    const costModel = { spreadPts: 1, slippagePts: 0.5, commissionR: 0.01 };

    const full = simulateTrade({ bars: bars1m, signalIndex: sc.signalIndex, direction: sc.direction,
      stopPrice, targetPrice, exitPlan, costModel });

    check(`[${sc.label}] trade actually resolved within the fixture (not END_OF_DATA) so this scenario is a meaningful test`, () => {
      assert.ok(full.filled, 'expected a fill');
      assert.notStrictEqual(full.exitReason, 'END_OF_DATA', 'trade ran off the end of the fixture — increase fixture size or adjust scenario');
    });
    if (!full.filled || full.exitReason === 'END_OF_DATA') continue;

    // (a) Truncating the series right after exitIndex must reproduce the identical trade.
    const truncatedExact = bars1m.slice(0, full.exitIndex + 1);
    const tightResult = simulateTrade({ bars: truncatedExact, signalIndex: sc.signalIndex, direction: sc.direction,
      stopPrice, targetPrice, exitPlan, costModel });
    check(`[${sc.label}] identical result when the series is truncated to exactly exitIndex+1`, () => {
      assert.deepStrictEqual(tightResult, full);
    });

    // (b) Appending arbitrary extra bars after exitIndex must not change the result.
    const extendedBars = bars1m.slice(0, full.exitIndex + 1).concat(
      generateSyntheticBars({ count: 500, resolutionMin: 1, seed: 999, endTime: bars1m[full.exitIndex].time + 500 * 60, basePrice: bars1m[full.exitIndex].close })
    );
    const extendedResult = simulateTrade({ bars: extendedBars, signalIndex: sc.signalIndex, direction: sc.direction,
      stopPrice, targetPrice, exitPlan, costModel });
    check(`[${sc.label}] identical result when unrelated future bars are appended after exitIndex`, () => {
      assert.deepStrictEqual(extendedResult, full);
    });

    // (c) Corrupting a future bar's price (a bar strictly after exitIndex) must not change the result —
    // the strongest possible negative control: if the engine were peeking, this would flip the outcome.
    if (full.exitIndex + 50 < bars1m.length) {
      const corrupted = bars1m.map((b, i) => (i === full.exitIndex + 50 ? { ...b, high: b.high + 100000, low: b.low - 100000 } : b));
      const corruptedResult = simulateTrade({ bars: corrupted, signalIndex: sc.signalIndex, direction: sc.direction,
        stopPrice, targetPrice, exitPlan, costModel });
      check(`[${sc.label}] identical result even when a bar 50 bars after exitIndex is corrupted to an extreme price`, () => {
        assert.deepStrictEqual(corruptedResult, full);
      });
    }

    // (d) Truncating BEFORE the trade resolves must produce a *different*, honest
    // END_OF_DATA-flagged result — proving the engine doesn't fabricate a
    // resolution it hasn't actually seen play out.
    if (full.exitIndex - full.entryIndex > 3) {
      const tooShort = bars1m.slice(0, full.entryIndex + 2);
      const shortResult = simulateTrade({ bars: tooShort, signalIndex: sc.signalIndex, direction: sc.direction,
        stopPrice, targetPrice, exitPlan, costModel });
      check(`[${sc.label}] truncating BEFORE resolution yields an honest END_OF_DATA result, not a fabricated match to the full-data outcome`, () => {
        assert.ok(!shortResult.filled || shortResult.exitReason === 'END_OF_DATA' || shortResult.exitIndex < full.exitIndex,
          'expected either no fill, an END_OF_DATA exit, or an earlier exit than the full-data run — never the same resolved outcome from less data');
      });
    }
  }
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} — engine/replay_engine.js ${failures === 0 ? 'shows no evidence of lookahead bias across all tested scenarios.' : 'FAILED the no-lookahead proof — do not trust its output until fixed.'}`);
process.exit(failures === 0 ? 0 : 1);
