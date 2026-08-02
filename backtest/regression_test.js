'use strict';

// Code-behavior-parity check for ict_engine.js / orb_engine.js — the two
// modules that must NEVER change as a side effect of the confirmation-engine
// work. Runs both engines against a fixed, seeded synthetic bar series
// (backtest/fixtures/synthetic_bars.js — this sandbox has no live
// TradeLocker credentials, so real history isn't available here) and
// compares the result against a committed golden snapshot
// (backtest/regression_snapshot.json).
//
// Usage:
//   node backtest/regression_test.js            # compare against snapshot, exit 1 on mismatch
//   node backtest/regression_test.js --write     # (re)write the snapshot — only ever run this
//                                                 # BEFORE touching ict_engine.js/orb_engine.js,
//                                                 # never after, or it stops meaning anything.

const fs = require('fs');
const path = require('path');
const ictEngine = require('./ict_engine');
const orbEngine = require('./orb_engine');
const { generateSyntheticBars } = require('./fixtures/synthetic_bars');

const SNAPSHOT_PATH = path.join(__dirname, 'regression_snapshot.json');

function buildResult() {
  // volPts=220 tuned so this fixture actually exercises every scenario branch
  // (0/1/2/3/4) and both the win/loss/timeout paths in each engine's trade
  // simulator — a 0-trade fixture would "pass" trivially without proving the
  // simulation logic itself stayed byte-identical.
  const hourly = generateSyntheticBars({ count: 8000, resolutionMin: 60, seed: 42, basePrice: 20000, volPts: 220 });

  const ict = ictEngine.runBacktest(hourly, { thresholds: { ...ictEngine.DEFAULT_THRESHOLDS, minLegSize: 199 } });
  const orb = orbEngine.runOrbBacktest(hourly, { rangeHour: 9, targetMultiple: 0.5, slBufferPct: 0.05, minRangeSize: 100 });

  return {
    fixture: { count: hourly.length, seed: 42, firstTime: hourly[0].time, lastTime: hourly[hourly.length - 1].time },
    ict: { totalDays: ict.totalDays, tradedDays: ict.tradedDays, wins: ict.wins, losses: ict.losses, timeouts: ict.timeouts, totalR: ict.totalR, byScenario: ict.byScenario },
    orb: { totalDays: orb.totalDays, tradedDays: orb.tradedDays, wins: orb.wins, losses: orb.losses, totalR: orb.totalR, avgR: orb.avgR },
  };
}

function diff(expected, actual, prefix = '') {
  const mismatches = [];
  const keys = new Set([...Object.keys(expected || {}), ...Object.keys(actual || {})]);
  for (const k of keys) {
    const e = expected ? expected[k] : undefined;
    const a = actual ? actual[k] : undefined;
    const p = prefix ? `${prefix}.${k}` : k;
    if (e && typeof e === 'object' && a && typeof a === 'object') {
      mismatches.push(...diff(e, a, p));
    } else if (e !== a) {
      mismatches.push(`${p}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
    }
  }
  return mismatches;
}

const result = buildResult();

if (process.argv.includes('--write')) {
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(result, null, 2));
  console.log(`Wrote baseline snapshot to ${SNAPSHOT_PATH}`);
  console.log(`ICT: ${result.ict.tradedDays} traded, totalR=${result.ict.totalR}`);
  console.log(`ORB: ${result.orb.tradedDays} traded, totalR=${result.orb.totalR}`);
  process.exit(0);
}

if (!fs.existsSync(SNAPSHOT_PATH)) {
  console.error(`No snapshot at ${SNAPSHOT_PATH} — run with --write first to establish the baseline.`);
  process.exit(1);
}

const expected = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
const mismatches = diff(expected, result);

if (mismatches.length) {
  console.error(`REGRESSION: ict_engine.js and/or orb_engine.js produced different output than the baseline snapshot.`);
  console.error(`This means their entry/stop/target/classification logic changed — that must NEVER happen from confirmation-engine work.\n`);
  mismatches.forEach(m => console.error('  ' + m));
  process.exit(1);
} else {
  console.log('PASS — ict_engine.js and orb_engine.js output is byte-identical to the baseline snapshot. No regression.');
  process.exit(0);
}
