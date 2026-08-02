# PXBOT — Final Strategy Spec: Hourly FVG Continuation (Part 14)

**Strategy ID:** `FVG` (research id `fvg_continuation_narrow`, STRATEGY_RESEARCH_LOG.md rounds 4–5)
**Status: DEMO-FIRST / PAPER_READY at small size.** Not MICRO_LIVE_READY, not SCALE_READY. Forward
demo performance must confirm real execution quality before any live capital. Supported by this
historical sample; not a guarantee of future performance.

## The rules (frozen — changing any knob invalidates the evidence)

| Rule | Value |
|---|---|
| Signal | Hourly 3-bar imbalance: bullish when `bar[i-2].high < bar[i].low` with a gap ≥ **50pts** (bearish mirrored). Signal exists only once bar `i` has **closed**. |
| Days | Signal (3rd) bar must be **Tue/Wed/Thu** (America/Chicago) |
| Entry | **Resting limit at the gap's near edge** (bullish: at `gapHigh`, filled as price falls into the gap). Never chase after the touch. |
| Entry validity | **10 hourly bars** after the signal bar closes; cancel the limit if untouched by then |
| Stop | Far gap edge − 10% of gap size (bullish; mirrored bearish). Typically **55–120pts wide** — see sizing |
| Target | **1R** (equal to the stop distance — typically 55–120pts, inside the operator's 30–100+pt band) |
| Exit management | None. No breakeven move, no trailing, no partials — tested exits underperformed the plain 1R target for this setup |
| Frequency | ~0.45 setups/trading day across the validated window (245 trades / ~26 months) |

Live implementation: `engine/fvg_signal.js` (frozen `VALIDATED_CONFIG`), surfaced in the app via
`/api/signal` (`fvg` field) and the signal panel — `PENDING` = place the limit; `FIRED` = edge
already traded, do not chase. Every `PENDING` signal auto-journals to `backtest/signal_journal.json`
for forward measurement.

## Position sizing — the 30pt question, resolved

The operator's 30pt stop cap is a **dollar-risk cap**, not a stop-distance rule. Stop width varies
with gap size; contracts scale down so dollars at risk stay fixed:

`contracts = floor(riskDollars / (stopPts × dollarsPerPoint))`

Example at **$500 risk/trade** (0.5% of $100k), MNQ ($2/pt):

| Stop width (gap-dependent) | Contracts | Actual $ risk |
|---|---|---|
| 55pts | 4 | $440 |
| 80pts | 3 | $480 |
| 110pts | 2 | $440 |

Skip any setup where even 1 contract exceeds the risk budget. Never round up.

## Validation evidence (all real trades, real stored TradeLocker data, measured costs)

- Walk-forward: **5/5 folds profitable**, same config family across folds; combined OOS n=153,
  58.8% win rate, +0.105R/trade.
- Untouched holdout: **n=92, 57.6% win rate, +0.068R/trade** (never used for any tuning).
- Combined 245 trades: 58.4% win rate, +0.091R, PF 1.215, maxDD 7.34R, max 4 consecutive losses,
  **positive in 2024, 2025 and 2026 separately** (no single-year concentration).
- Outlier-removal stress: positive expectancy survives removal of the top 20 winners; the 1R fixed
  target structurally caps any single trade's contribution.
- Funded-account Monte Carlo (10k block-bootstrap paths, generic illustrative rules, measured
  1.32pt spread): 87–92% probability of reaching an eval target before failure at 0.75–1.0%
  risk/trade under base costs; conservative-eval rules support ~0.5% risk.
  **Fails under adverse/severe cost stress** — like every strategy tested this session. Execution
  quality is the load-bearing unknown; that is what demo measures.
- Reproduce: `node backtest/research_phase5.js --only=fvg_continuation_narrow` and
  `node backtest/funded_account_report.js --runId=phase5_fvg_continuation_narrow --strategyId=fvg_continuation_narrow`

## Known limitations (unhidden)

1. ~18th configuration tested in its research session — held to elevated scrutiny; forward demo
   confirmation is required, not optional.
2. RR (payoff) is ~0.85–0.88 — average win slightly smaller than average loss; the edge is the
   win rate. A win-rate regime shift kills it; monthly review against the journal is mandatory.
3. Costs beyond spread (slippage, news-window fills) are still assumptions. The adverse-scenario
   failure mode is real: if demo fills run ≥0.05R worse than modeled, stand down.
4. Frequency (~2/week) is below the operator's 2–3/day preference — this is one module, not the
   whole ensemble. Complementary validated modules remain open research.

## Demo protocol (the gate to any live decision)

1. Run PXBOT connected to the demo account; act only on `FVG: PENDING` signals, sized per the table.
2. Every signal auto-journals; `node backtest/journal_review.js` resolves outcomes against real bars.
3. Review at **n≥20 demo trades**: compare demo win rate and avg R against the holdout numbers
   (57.6% / +0.068R). Within tolerance → revisit status toward MICRO_LIVE_READY, small size.
   Materially worse → the execution-cost assumptions were wrong; stand down and re-measure.
4. No live capital before that review, and no size scaling before a second review at n≥50.
