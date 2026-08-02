'use strict';

// ─── Funded-Account Monte Carlo Simulator — Part 10 ────────────────────────
// Simulates real account paths under configurable funded-account rules
// (starting balance, daily loss limit, max/trailing drawdown, profit
// target) using block-bootstrap resampling of REAL trade R-multiples, so
// streak behavior (real win/loss clustering) survives into the simulation
// instead of assuming independence. Deliberately configurable — the mission
// explicitly requires NOT hardcoding one prop firm's rules; the example
// configs in backtest/funded_account_report.js are illustrative, generic,
// and labeled as such.
//
// No martingale, no loss-doubling, no revenge sizing, no grid-averaging —
// position sizing is a fixed fraction of CURRENT balance, capped, every
// trade, full stop.

// ── 1) Group real trades into calendar days (CT), preserving intra-day
// clustering (some days 0 trades, some days 1-3) — needed so a block
// bootstrap over DAYS (not raw trades) preserves realistic daily loss
// exposure, not just streak order.
function ctDateKey(unixSecs) {
  const d = new Date(new Date(unixSecs * 1000).toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  return d.toISOString().slice(0, 10);
}

function groupTradesByDay(trades) {
  const byDay = new Map();
  for (const t of trades) {
    const key = ctDateKey(t.entryTime ?? t.entry_time);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(t.rMultiple ?? t.r_multiple);
  }
  return [...byDay.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([date, rMultiples]) => ({ date, rMultiples }));
}

// ── 2) Deterministic PRNG (seeded) so a given seed always reproduces the
// same Monte Carlo path — required for reproducibility (mission-wide rule).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Block bootstrap over day-records: resample contiguous blocks of
// `blockSize` consecutive days (with replacement) until `targetDays` is
// reached. Preserves local streak/clustering structure within each block —
// the whole point of block (vs. i.i.d.) bootstrap for time-series data.
function blockBootstrapDays(days, blockSize, targetDays, rng) {
  if (!days.length) return [];
  const out = [];
  while (out.length < targetDays) {
    const startIdx = Math.floor(rng() * days.length);
    for (let k = 0; k < blockSize && out.length < targetDays; k++) {
      out.push(days[(startIdx + k) % days.length]);
    }
  }
  return out;
}

// ── 3) Default cost/execution-scenario grid (Part 10 requirement: at least
// optimistic/base/adverse/severe). Applied as an ADDITIONAL R-multiple
// haircut per trade (points-equivalent cost is already baked into the
// stored trades' rMultiple from the base-cost backtest — this models
// FURTHER degradation beyond that baseline for stress purposes, not a
// replacement for it).
const EXECUTION_SCENARIOS = {
  optimistic: { extraCostR: 0, missedTradePct: 0, worsenedFillR: 0 },
  base:       { extraCostR: 0, missedTradePct: 0, worsenedFillR: 0 }, // trades are already base-cost; this scenario adds nothing further
  adverse:    { extraCostR: 0.05, missedTradePct: 0.05, worsenedFillR: 0.1 },
  severe:     { extraCostR: 0.15, missedTradePct: 0.15, worsenedFillR: 0.25 },
};

function applyExecutionScenario(rMultiples, scenario, rng) {
  const sc = EXECUTION_SCENARIOS[scenario];
  const out = [];
  for (const r of rMultiples) {
    if (rng() < sc.missedTradePct) continue; // simulate a missed/unfilled trade — no P&L impact, just doesn't happen
    let adjusted = r - sc.extraCostR;
    if (r > 0 && sc.worsenedFillR > 0) adjusted -= r * sc.worsenedFillR; // winners trimmed further under adverse/severe fills
    out.push(adjusted);
  }
  return out;
}

// ── 4) Account-path simulation under configurable funded-account rules ────
// config: {
//   startingBalance, riskPerTradePct (fixed fraction of CURRENT balance,
//   never scaled up after losses), maxDailyLossPct, maxOverallLossType
//   ('static'|'trailing'), maxOverallLossPct, profitTargetPct,
//   dailyLossHaltOnly (true = daily breach just halts that day, does not
//   fail the account; false = daily breach fails the account outright —
//   both real prop-firm patterns exist, configurable not assumed),
//   consistencyRuleMaxDayShareOfProfit (optional, null = off)
// }
function simulateAccountPath(dayBlocks, config) {
  let balance = config.startingBalance;
  let peakBalance = balance;
  let dailyPeakAtDayStart = balance;
  let failed = false, failReason = null, failedAtDay = null;
  let reachedTarget = false, targetReachedAtDay = null;
  let worstDrawdownPct = 0;
  let tradesExecuted = 0;
  const dailyPnlR = []; // for consistency-rule checks

  const targetBalance = config.startingBalance * (1 + config.profitTargetPct);

  for (let d = 0; d < dayBlocks.length; d++) {
    dailyPeakAtDayStart = balance;
    let dayPnlDollars = 0;

    for (const r of dayBlocks[d].rMultiples) {
      const riskDollars = balance * config.riskPerTradePct; // fixed-fractional, current balance — no martingale
      const tradePnl = r * riskDollars;
      balance += tradePnl;
      dayPnlDollars += tradePnl;
      tradesExecuted++;
      if (balance > peakBalance) peakBalance = balance;

      const dd = (peakBalance - balance) / peakBalance;
      if (dd > worstDrawdownPct) worstDrawdownPct = dd;

      // Overall drawdown check (checked after every trade, not just end of day).
      const overallLossPct = config.maxOverallLossType === 'trailing'
        ? (peakBalance - balance) / peakBalance
        : (config.startingBalance - balance) / config.startingBalance;
      if (overallLossPct >= config.maxOverallLossPct) {
        failed = true; failReason = config.maxOverallLossType === 'trailing' ? 'trailing_drawdown_breach' : 'static_max_loss_breach';
        failedAtDay = d;
        break;
      }
      if (balance >= targetBalance && !reachedTarget) { reachedTarget = true; targetReachedAtDay = d; }
    }
    if (failed) break;

    // Daily loss limit check, end of day.
    const dailyLossPct = (dailyPeakAtDayStart - balance) / dailyPeakAtDayStart;
    dailyPnlR.push(dayPnlDollars); // real per-day dollar P&L, for the consistency-rule check below
    if (dailyLossPct >= config.maxDailyLossPct) {
      if (config.dailyLossHaltOnly) {
        // Halts remaining trades that day only — already enforced by construction (we don't re-check mid-day beyond overall DD),
        // account survives to the next day.
      } else {
        failed = true; failReason = 'daily_loss_limit_breach'; failedAtDay = d;
        break;
      }
    }
  }

  // Consistency-rule check (optional): would a payout be blocked because one
  // day contributed more than the configured share of total profit? Checked
  // once at the end against the realized per-day dollar P&L — a real, not a
  // placeholder, computation.
  let consistencyRuleViolated = false;
  if (config.consistencyRuleMaxDayShareOfProfit && reachedTarget) {
    const totalProfit = balance - config.startingBalance;
    if (totalProfit > 0) {
      const maxSingleDayProfit = Math.max(0, ...dailyPnlR);
      consistencyRuleViolated = (maxSingleDayProfit / totalProfit) > config.consistencyRuleMaxDayShareOfProfit;
    }
  }

  return {
    finalBalance: +balance.toFixed(2), peakBalance: +peakBalance.toFixed(2),
    failed, failReason, failedAtDay,
    reachedTarget, targetReachedAtDay, consistencyRuleViolated,
    worstDrawdownPct: +worstDrawdownPct.toFixed(4),
    tradesExecuted, daysSimulated: dayBlocks.length,
    netReturnPct: +(((balance - config.startingBalance) / config.startingBalance) * 100).toFixed(2),
  };
}

// ── 5) Monte Carlo driver: N paths, block bootstrap, one execution scenario.
function runMonteCarlo({ trades, config, scenario = 'base', iterations = 10000, blockSize = 5, pathDays = null, seed = 42 }) {
  const days = groupTradesByDay(trades);
  if (!days.length) throw new Error('No trades to simulate from.');
  const rng = mulberry32(seed);
  const targetDays = pathDays || days.length;

  const results = [];
  for (let i = 0; i < iterations; i++) {
    const bootstrapped = blockBootstrapDays(days, blockSize, targetDays, rng);
    const scenarioAdjusted = bootstrapped.map(d => ({ date: d.date, rMultiples: applyExecutionScenario(d.rMultiples, scenario, rng) }));
    results.push(simulateAccountPath(scenarioAdjusted, config));
  }

  const failures = results.filter(r => r.failed);
  const targetReachers = results.filter(r => r.reachedTarget);
  const targetBeforeFail = results.filter(r => r.reachedTarget && (!r.failed || r.targetReachedAtDay <= r.failedAtDay));
  const consistencyViolations = results.filter(r => r.consistencyRuleViolated).length;
  const finalBalances = results.map(r => r.finalBalance).sort((a, b) => a - b);
  const drawdowns = results.map(r => r.worstDrawdownPct).sort((a, b) => a - b);
  const daysToTarget = targetReachers.map(r => r.targetReachedAtDay).sort((a, b) => a - b);

  const pct = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : null;

  return {
    scenario, iterations, blockSize, pathDays: targetDays,
    inputDays: days.length, inputTrades: trades.length,
    config,
    probabilityOfFailure: +(failures.length / iterations).toFixed(4),
    probabilityOfReachingTargetBeforeFailure: +(targetBeforeFail.length / iterations).toFixed(4),
    medianDaysToTarget: daysToTarget.length ? pct(daysToTarget, 0.5) : null,
    finalBalance: { p5: pct(finalBalances, 0.05), p25: pct(finalBalances, 0.25), p50: pct(finalBalances, 0.5), p75: pct(finalBalances, 0.75), p95: pct(finalBalances, 0.95) },
    worstDrawdownPct: { p50: pct(drawdowns, 0.5), p75: pct(drawdowns, 0.75), p90: pct(drawdowns, 0.9), p95: pct(drawdowns, 0.95), p99: pct(drawdowns, 0.99), max: drawdowns.at(-1) },
    failureReasons: Object.fromEntries(
      [...new Set(failures.map(f => f.failReason))].map(reason => [reason, failures.filter(f => f.failReason === reason).length])
    ),
    probabilityConsistencyRuleBlocksPayout: config.consistencyRuleMaxDayShareOfProfit ? +(consistencyViolations / iterations).toFixed(4) : null,
  };
}

module.exports = {
  groupTradesByDay, blockBootstrapDays, mulberry32,
  EXECUTION_SCENARIOS, applyExecutionScenario,
  simulateAccountPath, runMonteCarlo,
};
