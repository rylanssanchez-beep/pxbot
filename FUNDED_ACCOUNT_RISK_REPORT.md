# PXBOT NQ Console — Funded-Account Risk Report (Part 10)

**Generated:** 2026-08-02
**Reproduce:** `node backtest/funded_account_report.js` (reads live from
`data/pxbot_market_data.sqlite` — always reflects whatever is currently in the ledger; re-run this
after any new download or baseline regeneration to keep it current, per explicit instruction)

## Data provenance — real, not synthetic

| | |
|---|---|
| Source | `data/pxbot_market_data.sqlite`, `trades` table, `run_id=baseline_v1_base`, `strategy_id=ORB` |
| Real trade count | 301 (END_OF_DATA-truncated trades excluded, same discipline as every other report) |
| Real date range | 2024-01-02 → 2026-07-30 |
| Dataset hash | `e7c8a85be164ea81` |
| Sample real R-multiples | -0.0697, 0.8582, -1.0328, -0.1200, -0.1702 (first 5, chronological) |

ORB is used here — not the combined 429-trade baseline, not any unvalidated Phase 5 candidate —
because it is the one mechanism in this codebase with a demonstrated, real, walk-forward-consistent
edge (`CURRENT_STRATEGY_BASELINE.md`: n=301, PF 1.134, positive in 19/31 months). Simulating a
funded account on ICT (net negative) or an unaccepted candidate would not be honest.

## Method

`engine/funded_account_simulator.js` groups the 301 real trades into their actual calendar days (CT),
then runs a **block bootstrap** (5-day contiguous blocks, resampled with replacement) to generate
10,000 synthetic account paths per configuration — this preserves real streak/clustering behavior
(some days have 0 trades, some have several; winning and losing runs stay intact within a block)
instead of assuming trade independence. Position sizing is **fixed-fractional on current balance
only** — no martingale, no loss-doubling, no revenge sizing, no grid-averaging, matching the
mission's explicit prohibition.

**Funded-account rule configs below are GENERIC, ILLUSTRATIVE examples, not tied to any specific
prop firm** — per the mission's explicit instruction not to hardcode one firm's rules. Swap in your
actual firm's real numbers in `backtest/funded_account_report.js`'s `CONFIGS` object before trusting
this for a real evaluation decision.

| Config | Daily loss limit | Max drawdown | Profit target | Daily breach behavior | Consistency rule |
|---|---|---|---|---|---|
| `generic_conservative_eval` | 4% | 8% (trailing) | 8% | Fails the account | Max 30% of profit from one day |
| `generic_lenient_funded` | 5% | 10% (static from start) | 10% | Halts that day only, account survives | None |

Four execution-cost scenarios were run under each config (Part 10 requirement): `optimistic` (no
added degradation beyond the baseline's own 2pt-spread/1pt-slippage/0.01R-commission assumptions),
`base` (same as optimistic here, since the trades are already base-cost), `adverse` (+0.05R extra
cost, 5% of trades randomly missed, winners trimmed 10%), `severe` (+0.15R extra cost, 15% missed,
winners trimmed 25%).

## Results — `generic_conservative_eval`

| Risk/trade | Optimistic P(fail) | Base P(fail) | Adverse P(fail) | Severe P(fail) |
|---|---|---|---|---|
| 0.25% | 0.2% | 0.2% | 11.7% | 97.1% |
| 0.50% | 16.9% | 16.9% | 68.0% | 100.0% |
| 0.75% | 51.9% | 51.9% | 90.8% | 100.0% |
| 1.00% | 79.6% | 79.6% | 97.9% | 100.0% |

**Maximum risk/trade keeping failure probability ≤10%:** 0.25% under optimistic/base costs.
**Under adverse or severe costs, no tested risk level (down to 0.25%) keeps failure probability at
or below 10%.** At the one risk level that is nominally "safe" (0.25%, base costs), the probability
of reaching the 8% profit target *before* failing is only 17.1%, with a median 233 days to get
there — a real, low-frequency, low-confidence path to a payout, not a fast or reliable one.

## Results — `generic_lenient_funded`

| Risk/trade | Optimistic P(fail) | Base P(fail) | Adverse P(fail) | Severe P(fail) |
|---|---|---|---|---|
| 0.25% | 0.0% | 0.0% | 1.8% | 83.4% |
| 0.50% | 2.2% | 2.2% | 36.0% | 99.8% |
| 0.75% | 9.0% | 9.0% | 61.1% | 100.0% |
| 1.00% | 17.7% | 17.7% | 74.0% | 100.0% |

**Maximum risk/trade keeping failure probability ≤10%:** 0.75% under optimistic/base costs, 0.25%
under adverse costs. **Severe costs still fail more than 80% of paths even at the lowest tested
risk.** This config's more forgiving rules (daily breach only halts, doesn't fail; static not
trailing drawdown) meaningfully improve survivability at the same risk level compared to the
conservative config — the account RULES matter as much as the strategy's edge.

## What this means, stated plainly

1. **ORB's real edge is thin enough that funded-account survivability depends heavily on both risk
   sizing and the account's exact rules** — there is no risk level tested here that is safe under
   every scenario and every rule-set. This is not a flaw in the simulation; it is the honest
   consequence of a +0.0482R/trade edge (see `CURRENT_STRATEGY_BASELINE.md`) being real but modest.
2. **Under adverse or severe real-world execution conditions, this strategy alone is not currently
   safe to fund at any tested risk level under the conservative-style rules**, and only safe at very
   low risk (0.25%) under the more lenient rules.
3. **The probability of reaching a profit target before failing is low even in the "safe" risk
   zones** (6.6%–17.1% at 0.25% risk) — this strategy alone is not a fast or reliable path to a
   funded-account payout by itself.
4. This is exactly why Part 8's ensemble guidance and Phase 5's continued search matter: a single
   thin-edge strategy is not sufficient. Nothing here should be read as "PXBOT doesn't work" — it
   should be read as "this specific, already-frozen configuration, alone, is not yet fund-ready,"
   which is a very different and more useful statement.

## Explicit readiness statement

Per the mission's own status vocabulary: ORB alone, under these findings, is **RESEARCH_ONLY /
PAPER_READY at very small size (≤0.25–0.5% risk/trade)** — not `MICRO_LIVE_READY`, and nowhere near
`SCALE_READY`. `SCALE_READY` requires passing every item on the mission's final acceptance
checklist; this report demonstrates one of the required items (funded-account failure probability)
is not yet at an acceptable level for real capital at any but the smallest tested position sizes,
and only under favorable execution conditions.

## Known limitations of this report (stated, not hidden)

- Costs assumptions (spread/slippage/commission) are still documented estimates, not measured from
  real fills on this account — see `CURRENT_STRATEGY_BASELINE.md`'s own caveat.
- The `adverse`/`severe` scenarios' extra-cost/missed-trade/worsened-fill parameters are reasonable,
  documented assumptions, not measurements from a specific broker's real adverse conditions.
- Only ORB was simulated. Once an ensemble of multiple validated modules exists (Phase 5's
  recommended next direction), re-run this report against the ensemble's combined trade stream —
  diversification across independent modules should improve these numbers, but that has not been
  tested yet and must not be assumed.
- The consistency-rule check only evaluates the single largest day's dollar contribution to total
  profit — real prop-firm consistency rules vary in exact mechanics; treat this as illustrative.
