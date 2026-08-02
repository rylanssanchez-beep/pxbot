# PXBOT NQ Console — Strategy Research Log (Part 5/7)

**Round 1 — run ID prefix `phase5_*`, 2026-08-02.**
**Reproduce:** `node backtest/research_phase5.js` (reads real stored data, writes to the
`experiments` and `trades` tables in `data/pxbot_market_data.sqlite`, plus a summary at
`backtest/phase5_results.json`, gitignored as regenerable output).

## Method

Eight session-anchored candidate strategies already built in this codebase (not written from
scratch this round — see "What was already here" below) were tested against real 1H NAS100 data
(2024-01-01 → 2026-07-31, the full retained history) using this discipline:

1. **Expanding-window walk-forward, 5 folds**, over the first 80% of history. Parameters are
   selected ONLY from a grid search on train-so-far, scored ONLY on each fold's held-out test
   window — the same pattern `backtest/walkforward.js` already established for ICT.
2. **Stability gate**: the same picked config must recur in at least half the valid folds. A
   different "best" every fold is treated as noise, not signal, and rejects the candidate outright
   regardless of how good the aggregate out-of-sample number looks.
3. **Majority gate**: at least half the valid folds must be individually profitable out-of-sample.
4. **Minimum sample gate**: at least 20 combined out-of-sample trades across all folds.
5. **Untouched final holdout** (the most recent 20% of history) — evaluated exactly once, only for
   candidates that already passed gates 1–4, using whichever config was most common across folds.
   A candidate that passes walk-forward but fails on the holdout is still rejected. **The holdout
   was never touched for any candidate in this round** (see verdicts below) — none passed the
   earlier gates, so nothing repeatedly reused it for tuning.

Every candidate — accepted or rejected — is logged to the `experiments` table with its full
params/costs/splits/results and, if rejected, the specific reason. Every walk-forward and holdout
trade is written to the `trades` ledger (1,813 trades this round), so nothing here is a summary
number without the underlying decisions behind it.

Real execution costs (2pt spread, 1pt slippage, 0.01R commission — same "base" assumptions as
`CURRENT_STRATEGY_BASELINE.md`) were applied to every trade via `engine/replay_engine.js`, not the
candidate engines' own zero-cost simulators.

## What was already here

`trend_pullback_engine.js`, `vwap_reversion_engine.js`, `liquidity_sweep_engine.js`, and
`session_reversion_engine.js` existed in the codebase before this session with their own
documentation of prior informal testing (e.g. `session_reversion_engine.js`'s own header notes
VWAP-reversion was "already tested and rejected: 2/4 folds, -0.075R avg"). This round re-tests all
of them under the newer, more rigorous discipline above (stability gate + untouched holdout, neither
of which existed in the prior informal scripts) and against real costs, rather than assuming the old
informal results still hold.

## Results — Round 1

| Candidate | Valid folds | Profitable OOS folds | Distinct configs | Most-common repeats | Combined OOS avgR (n) | Verdict |
|---|---|---|---|---|---|---|
| trend_pullback | 5 | 2 | 2 | 4 | +0.105R (n=61) | **REJECTED** — not a majority (2/5) |
| vwap_reversion | 3 | 3 | 3 | 1 | **+1.295R** (n=72) | **REJECTED** — no config repeated (1/3) |
| liquidity_sweep (Asia anchor) | 5 | 0 | 3 | 3 | -0.781R (n=313) | REJECTED — 0/5 folds profitable |
| liquidity_sweep (London anchor) | 5 | 0 | 2 | 3 | -0.824R (n=274) | REJECTED — 0/5 folds profitable |
| session_reversion (Asia anchor) | 5 | 0 | 3 | 2 | -0.441R (n=353) | REJECTED — 0/5 folds profitable |
| session_reversion (London anchor) | 5 | 0 | 1 | 5 | -0.545R (n=264) | REJECTED — 0/5 folds profitable |
| session_breakout (Asia anchor) | 5 | 2 | 2 | 3 | -0.087R (n=183) | REJECTED — not a majority (2/5) |
| session_breakout (London anchor) | 5 | 1 | 4 | 2 | -0.006R (n=293) | REJECTED — not a majority (1/5) |

**0 of 8 candidates accepted.** This is a legitimate, valuable research finding, not a failed
process — see "Why this is still a good outcome" below.

## The one result worth flagging by name: vwap_reversion's +1.295R/trade

This is the largest single number in this whole document, and it was **correctly rejected**. Each
of the 3 valid folds picked a *different* parameter combination as "best" on training data, and
those three different configs happened to each do extremely well on their own test windows — the
textbook signature of overfitting to noise rather than finding a real, stable edge (mission Part 7:
"a different 'best' every time is a strong sign of noise, not a stable edge," a phrase this
codebase's own `walkforward.js` already used for ICT). Reporting this +1.295R number as a discovery
would have been exactly the kind of fabricated-looking-good result the mission explicitly prohibits.
The stability gate caught it automatically; it required no manual judgment call to reject.

## Why the other rejections make sense, not just "the gate said no"

- **liquidity_sweep and session_reversion (both anchors) are consistently, stably negative** —
  0/5 folds profitable, and for `session_reversion_london` the SAME config was picked in all 5
  folds (not noise) and still lost. That is a real, validated absence of edge for these exact
  mechanisms on real hourly NAS100 data with real costs, not an artifact of unlucky sampling.
- **A real, disclosed caveat**: both of these depend on precise sweep/touch-then-reject sequencing
  within a single bar, and only ran on **hourly** bars here (the same tradeoff `ORB`/`ICT` already
  documented — hourly bars can't resolve intrabar ordering the way 1-minute bars can). This round
  does not rule out these mechanisms working better at 1-minute precision; it only tested them at
  hourly resolution because that's where ~2.6 years of history exists vs. ~267 days at 1-minute.
  Re-testing at 1-minute precision (once more 1-minute history accumulates, or accepting the
  267-day window) is a real next step, not a closed question.
- **trend_pullback and session_breakout (both anchors)** show mixed, not-majority-positive results
  — some folds work, most don't. Not stable enough to trust, but also not as clearly negative as
  the reversion/sweep families — worth revisiting with a wider parameter grid or different regime
  filter in a future round rather than fully abandoning the mechanism.

## Why this is still a good outcome

The mission explicitly requires: *"Allow the system to conclude that a session should not be traded
when no robust edge exists... The requirement is coverage capability, not forced overtrading."*
Zero acceptances from a disciplined first round is exactly what an honest process sometimes produces
— the alternative (loosening the gates until something passes) is precisely the failure mode Part 7
warns against. `CURRENT_STRATEGY_BASELINE.md`'s frozen benchmark (+0.0298R/trade combined) remains
the standard nothing here has beaten yet.

## Trade-count accounting (Part 8 — do not conflate with "validated")

1,813 real, non-duplicated trades were generated and ledgered this round across walk-forward folds.
**This number does NOT count toward the mission's 1,000-trade validation requirement** — that
requirement applies to trades from an *accepted* strategy or ensemble, and nothing here was
accepted. These trades are real research evidence (why each candidate was rejected), not validation
evidence for a system being proposed as better than the baseline. The distinction matters: inflating
the "trades tested" number while having zero accepted candidates would be exactly the kind of
trade-count-inflation the mission prohibits.

## Next steps

1. Widen the trend_pullback / session_breakout grids and try a regime filter (`engine/regime_engine.js`
   is already wired into `trend_pullback_engine.js`'s efficiency-ratio filter but not yet swept
   across a wider threshold range).
2. Re-test liquidity_sweep / session_reversion at 1-minute execution precision once justified by
   available 1-minute history depth, with the explicit caveat above addressed rather than assumed.
3. Consider ensemble/ranking approaches only after at least one individual family clears the
   walk-forward + holdout bar on its own — combining several already-rejected mechanisms would not
   manufacture a real edge.
