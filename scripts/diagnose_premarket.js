'use strict';
// One-off diagnostic: isolate why the baseline's PREMARKET result
// (-0.044R/trade, n=106, full 267-day window, session-close exit) differs
// from server.js's PREMARKET_TRACK_RECORD claim (+0.108-0.115R, n=83,
// ~207 days). Tests window length and exit rule independently, at both
// cost scenarios.

const { MarketDataStore } = require('../data/store');
const { simulateTrade } = require('../engine/replay_engine');
const { computeMetrics } = require('../backtest/metrics');

function ctParts(unixSecs) {
  const d = new Date(new Date(unixSecs * 1000).toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  return { hour: d.getHours() + d.getMinutes() / 60, dateKey: d.toISOString().slice(0, 10), dow: d.getDay() };
}

function runPremarket(minuteBars, costModel, exitMode) {
  const th = { targetMultiple: 0.5, slBufferPct: 0.05, minRangeSize: 100, allowedDaysOfWeek: [2, 3, 4] };
  const byDate = new Map();
  for (const b of minuteBars) {
    const { hour, dateKey, dow } = ctParts(b.time);
    if (!byDate.has(dateKey)) byDate.set(dateKey, { premarket: [], forward: [], dow });
    const entry = byDate.get(dateKey);
    if (hour >= 7 && hour < 9.5) entry.premarket.push(b);
    else if (hour >= 9.5) entry.forward.push(b);
  }
  const trades = [];
  for (const [dateKey, day] of byDate.entries()) {
    if (!th.allowedDaysOfWeek.includes(day.dow)) continue;
    if (!day.premarket.length || !day.forward.length) continue;
    const pmHigh = Math.max(...day.premarket.map(b => b.high));
    const pmLow = Math.min(...day.premarket.map(b => b.low));
    const size = pmHigh - pmLow;
    if (size <= 0 || size < th.minRangeSize) continue;

    let bias = null, entryIdx = -1, entryPriceRaw = null;
    for (let i = 0; i < day.forward.length; i++) {
      const b = day.forward[i];
      if (b.high > pmHigh) { bias = 'LONG'; entryPriceRaw = pmHigh; entryIdx = i; break; }
      if (b.low < pmLow) { bias = 'SHORT'; entryPriceRaw = pmLow; entryIdx = i; break; }
    }
    if (!bias) continue;
    const sl = bias === 'LONG' ? pmLow - size * th.slBufferPct : pmHigh + size * th.slBufferPct;
    const target = bias === 'LONG' ? entryPriceRaw + size * th.targetMultiple : entryPriceRaw - size * th.targetMultiple;

    // Both modes now use sessionCloseAfterHour so a trade that never hits
    // stop/target gets a real, clean exit label (SESSION_CLOSE) instead of
    // silently falling into END_OF_DATA and getting excluded from metrics —
    // 'targetOnly' just uses a much later cutoff (19:00 CT, effectively
    // "let it ride all day") than 'sessionClose' (15:00 CT), so the two are
    // now a clean apples-to-apples comparison of hold-time alone.
    const exitPlan = exitMode === 'sessionClose'
      ? { maxHoldingBars: day.forward.length, sessionCloseAfterHour: 15 }
      : { maxHoldingBars: day.forward.length, sessionCloseAfterHour: 19 };

    const result = simulateTrade({
      bars: day.forward, signalIndex: -1, direction: bias, orderType: 'preComputedFill',
      precomputedEntryIndex: entryIdx, precomputedEntryPriceRaw: entryPriceRaw,
      stopPrice: sl, targetPrice: target, exitPlan, costModel, ctPartsFn: ctParts,
    });
    if (!result.filled) continue;
    trades.push(result);
  }
  return trades;
}

(async () => {
  const store = new MarketDataStore();
  const allMinuteBars = store.getAllBars('NAS100', '1m', 'tradelocker');
  const first = allMinuteBars[0].time, last = allMinuteBars.at(-1).time;
  const fullSpanDays = (last - first) / 86400;
  const window207Cutoff = first + 207 * 86400;
  const first207 = allMinuteBars.filter(b => b.time <= window207Cutoff);

  const scenarios = [
    { label: 'FULL 267d window, sessionClose exit, BASE costs', bars: allMinuteBars, exitMode: 'sessionClose', cost: { spreadPts: 2, slippagePts: 1, commissionR: 0.01 } },
    { label: 'FULL 267d window, sessionClose exit, ZERO costs', bars: allMinuteBars, exitMode: 'sessionClose', cost: { spreadPts: 0, slippagePts: 0, commissionR: 0 } },
    { label: 'FULL 267d window, targetOnly exit,  BASE costs', bars: allMinuteBars, exitMode: 'targetOnly', cost: { spreadPts: 2, slippagePts: 1, commissionR: 0.01 } },
    { label: 'FULL 267d window, targetOnly exit,  ZERO costs', bars: allMinuteBars, exitMode: 'targetOnly', cost: { spreadPts: 0, slippagePts: 0, commissionR: 0 } },
    { label: 'FIRST ~207d window, sessionClose exit, BASE costs', bars: first207, exitMode: 'sessionClose', cost: { spreadPts: 2, slippagePts: 1, commissionR: 0.01 } },
    { label: 'FIRST ~207d window, targetOnly exit,  ZERO costs', bars: first207, exitMode: 'targetOnly', cost: { spreadPts: 0, slippagePts: 0, commissionR: 0 } },
    { label: 'LAST ~60d only (the extra data beyond 207d), sessionClose, BASE costs', bars: allMinuteBars.filter(b => b.time > window207Cutoff), exitMode: 'sessionClose', cost: { spreadPts: 2, slippagePts: 1, commissionR: 0.01 } },
  ];

  console.log(`Full dataset: ${allMinuteBars.length} bars, ${fullSpanDays.toFixed(1)} days. First-207d subset: ${first207.length} bars.\n`);

  for (const sc of scenarios) {
    const trades = runPremarket(sc.bars, sc.cost, sc.exitMode);
    const m = computeMetrics(trades, { totalPeriodDays: (sc.bars.at(-1).time - sc.bars[0].time) / 86400 });
    const exitReasonCounts = {};
    for (const t of trades) exitReasonCounts[t.exitReason] = (exitReasonCounts[t.exitReason] || 0) + 1;
    console.log(`${sc.label}`);
    console.log(`  n=${m.totalTrades} (${m.filledTrades} filled, ${m.excludedEndOfDataTruncations} excluded END_OF_DATA), winRate=${m.winRatePct}%, expectancy=${m.expectancyR}R, PF=${m.profitFactor}, netR=${m.netR}`);
    console.log(`  exit reasons: ${JSON.stringify(exitReasonCounts)}`);
  }
  store.close();
})();
