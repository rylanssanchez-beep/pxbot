'use strict';

// Part 10 — funded-account risk report, run against REAL ORB baseline
// trades (the one mechanism in this codebase with a demonstrated real edge)
// pulled directly from the trade ledger (data/pxbot_market_data.sqlite),
// never synthetic data. Prints explicit provenance (real trade count, real
// date range, dataset hash) so this is independently verifiable, not taken
// on faith.
//
// Funded-account configs below are GENERIC, ILLUSTRATIVE examples — NOT
// hardcoded to any specific prop firm, per the mission's explicit
// requirement. Real firms vary in exact daily-loss/trailing-DD/consistency
// mechanics; swap in your actual firm's real numbers via the CONFIGS object
// before trusting this for a real evaluation.
//
// Usage: node backtest/funded_account_report.js [--runId=...] [--strategyId=...] [--outFile=...]

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { MarketDataStore } = require('../data/store');
const { runMonteCarlo } = require('../engine/funded_account_simulator');

const argRunId = (process.argv.find(a => a.startsWith('--runId=')) || '').split('=')[1];
const argStrategyId = (process.argv.find(a => a.startsWith('--strategyId=')) || '').split('=')[1];
const argOutFile = (process.argv.find(a => a.startsWith('--outFile=')) || '').split('=')[1];
const RUN_ID = argRunId || 'baseline_v1_base';
const STRATEGY_ID = argStrategyId || 'ORB';
const OUT_FILE = argOutFile || 'funded_account_report.json';
const ITERATIONS = 10000;

const CONFIGS = {
  'generic_conservative_eval': {
    startingBalance: 100000, maxDailyLossPct: 0.04, maxOverallLossType: 'trailing',
    maxOverallLossPct: 0.08, profitTargetPct: 0.08, dailyLossHaltOnly: false,
    consistencyRuleMaxDayShareOfProfit: 0.30,
  },
  'generic_lenient_funded': {
    startingBalance: 100000, maxDailyLossPct: 0.05, maxOverallLossType: 'static',
    maxOverallLossPct: 0.10, profitTargetPct: 0.10, dailyLossHaltOnly: true,
    consistencyRuleMaxDayShareOfProfit: null,
  },
};

const RISK_LEVELS = [0.0025, 0.005, 0.0075, 0.01, 0.015, 0.02];
const SCENARIOS = ['optimistic', 'base', 'adverse', 'severe'];

function datasetHash(trades) {
  const h = crypto.createHash('sha256');
  h.update(String(trades.length));
  if (trades.length) { h.update(String(trades[0].entryTime)); h.update(String(trades.at(-1).entryTime)); }
  for (const t of trades) h.update(t.rMultiple.toFixed(6));
  return h.digest('hex').slice(0, 16);
}

(async () => {
  const store = new MarketDataStore();
  const rawTrades = store.db.prepare(
    'SELECT entry_time, r_multiple FROM trades WHERE run_id=? AND strategy_id=? AND exit_reason != ? ORDER BY entry_time'
  ).all(RUN_ID, STRATEGY_ID, 'END_OF_DATA');

  if (rawTrades.length < 30) {
    console.error(`Only ${rawTrades.length} real trades found for ${RUN_ID}/${STRATEGY_ID} — run backtest/run_baseline.js first.`);
    process.exit(1);
  }

  const trades = rawTrades.map(t => ({ entryTime: t.entry_time, rMultiple: t.r_multiple }));
  const hash = datasetHash(trades);

  console.log('=== REAL-DATA PROVENANCE (not synthetic) ===');
  console.log(`Source: data/pxbot_market_data.sqlite, run_id=${RUN_ID}, strategy_id=${STRATEGY_ID}`);
  console.log(`Real trade count: ${trades.length}`);
  console.log(`Real date range: ${new Date(trades[0].entryTime * 1000).toISOString().slice(0, 10)} .. ${new Date(trades.at(-1).entryTime * 1000).toISOString().slice(0, 10)}`);
  console.log(`Sample real R-multiples (first 5): ${trades.slice(0, 5).map(t => t.rMultiple.toFixed(4)).join(', ')}`);
  console.log(`Dataset hash: ${hash}\n`);

  const report = { generatedAt: new Date().toISOString(), source: { runId: RUN_ID, strategyId: STRATEGY_ID, tradeCount: trades.length, dateRange: `${new Date(trades[0].entryTime * 1000).toISOString().slice(0, 10)}..${new Date(trades.at(-1).entryTime * 1000).toISOString().slice(0, 10)}`, datasetHash: hash }, configs: {} };

  for (const [configName, config] of Object.entries(CONFIGS)) {
    console.log(`\n########## CONFIG: ${configName} ##########`);
    console.log(JSON.stringify(config));
    report.configs[configName] = { config, byScenario: {} };

    for (const scenario of SCENARIOS) {
      console.log(`\n--- Execution scenario: ${scenario} ---`);
      report.configs[configName].byScenario[scenario] = { byRisk: {} };
      let maxSafeRisk = null;

      for (const risk of RISK_LEVELS) {
        const fullConfig = { ...config, riskPerTradePct: risk };
        const result = runMonteCarlo({ trades, config: fullConfig, scenario, iterations: ITERATIONS, blockSize: 5, seed: 42 });
        report.configs[configName].byScenario[scenario].byRisk[risk] = result;
        console.log(`  risk=${(risk * 100).toFixed(2)}%  P(fail)=${(result.probabilityOfFailure * 100).toFixed(1)}%  P(target before fail)=${(result.probabilityOfReachingTargetBeforeFailure * 100).toFixed(1)}%  medianDaysToTarget=${result.medianDaysToTarget}  worstDD(p95)=${(result.worstDrawdownPct.p95 * 100).toFixed(1)}%`);
        // "Safe" = failure probability under 10% — a documented, adjustable threshold, not a universal truth.
        if (result.probabilityOfFailure <= 0.10) maxSafeRisk = risk;
      }
      report.configs[configName].byScenario[scenario].maxSafeRiskPerTradePct = maxSafeRisk;
      console.log(`  => Maximum risk/trade keeping P(fail) <= 10% under '${scenario}' costs: ${maxSafeRisk !== null ? (maxSafeRisk * 100).toFixed(2) + '%' : 'NONE of the tested levels — even the lowest (0.25%) exceeds 10% failure probability'}`);
    }
  }

  fs.writeFileSync(path.join(__dirname, OUT_FILE), JSON.stringify(report, null, 2));
  console.log(`\nFull report written to backtest/${OUT_FILE}`);
  store.close();
})().catch(e => { console.error('Funded-account report failed:', e.stack); process.exit(1); });
