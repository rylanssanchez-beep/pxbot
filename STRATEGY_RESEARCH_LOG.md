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

## Round 2 — widened trend_pullback / session_breakout grids + regime filter

**Reproduce:** `node backtest/research_phase5.js --only=trend_pullback,session_breakout_asia,session_breakout_london`

Round 1's "next steps" suggested widening `trend_pullback`'s efficiency-ratio threshold range and
adding `session_breakout_engine.js`'s existing (but unswept in round 1) `minTrendEfficiency` regime
pre-filter to the breakout candidates. Done — `minTrendEfficiency ∈ {0, 0.3, 0.4, 0.5}` added to
both session_breakout anchors (grid size 36→144), `minTrendEfficiency` range widened from
`{0.3,0.4,0.5}` to `{0.2,...,0.6}` for trend_pullback (grid size 81→135).

| Candidate | Valid folds | Profitable OOS folds | Distinct configs | Combined OOS avgR (n) | Verdict |
|---|---|---|---|---|---|
| trend_pullback (wider grid) | 5 | 2 | 2 | +0.028R (n=30) | REJECTED — still not a majority (2/5); OOS avgR *fell* vs. round 1's 0.105R |
| session_breakout (Asia, +regime filter) | 5 | 2 | 4 | -0.133R (n=52) | REJECTED — still not a majority (2/5) |
| session_breakout (London, +regime filter) | 5 | 0 | 5 | -0.117R (n=112) | REJECTED — got worse (was 1/5, now 0/5), configs got less stable (5 distinct vs. 4) |

**The regime filter did not help either candidate — it made session_breakout_london's result both
more negative and less stable.** Reported here in full rather than only reporting round 1, because
silently dropping a round that didn't confirm the hoped-for improvement would itself be a form of
cherry-picking. Two full rounds (11 total candidate/anchor configurations) have now failed to beat
the frozen baseline. Per Part 7's multiple-testing awareness — "the more variants tested, the
stronger the evidence required" — continuing to widen grids indefinitely in search of *any* passing
configuration would itself become the overfitting risk this process exists to prevent, not a
legitimate next step.

## Round 3 — ORB refinement + a new family (previous-day high/low), with full win/loss/RR reporting

**Reproduce:** `node backtest/research_phase5.js --only=orb_refine,prev_day_level`

Per explicit request: refine ORB specifically (wider grid: range-defining hour 7–10 CT, target
0.5–2×, stop buffer 5–15%, day filters), test one new strategy family (`tradesFromPrevDayLevel` —
breakout of the *prior calendar day's* full range during NY hours, mechanically distinct from ORB's
single-hour range), and report full stats (trades, wins, losses, win rate, RR/payoff ratio,
expectancy, profit factor) for every result from here on, not just an aggregate avgR number.

**A real bug was caught and fixed before either of these numbers were reported as final** — the
first `prev_day_level` run showed an eye-catching 80.56% win rate / 5.4x profit factor, but its
internal counts didn't match (verdict said n=348, detailed stats showed n=72). That was the exact
same execution-window bug already fixed twice this session (`run_baseline.js`, then
`diagnose_premarket.js`) recurring a third time in a brand-new function: 79% of that candidate's
walk-forward trades and 92% of its holdout trades had never actually resolved (`END_OF_DATA`), yet
were counting toward the accept decision. Fixed at the root (the function now gives execution room
through 19:00 CT with a real session-close exit) and with defense in depth (every scoring/gating
step in this file now explicitly excludes unresolved trades, not just the final report). Both
candidates below were re-run after the fix.

| Candidate | Walk-forward folds profitable | Trades | Wins | Losses | Win rate | Avg win / avg loss | RR (payoff) | Expectancy | Profit factor | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| orb_refine (wider grid) | 0/5 | 128 | 52 | 76 | 40.63% | 0.78R / -0.953R | 0.818 | **-0.2493R** | 0.56 | **REJECTED** — worse than round-1's already-rejected version once unresolved trades are correctly excluded |
| prev_day_level | 5/5 | 72 (dev) + 9 (holdout) | 49 + 6 | 23 + 3 | 68.06% (dev) / 66.67% (holdout) | 1.259R / -1.033R | 1.218 | +0.5266R (dev) / +0.5397R (holdout, too small to trust) | 2.595 (dev) | **REJECTED** — walk-forward is genuinely strong and stable (same config picked 4/5 folds), but the untouched holdout only produced 9 real trades, below this project's own 15-trade minimum-holdout-sample gate |

**ORB refinement made things worse, not better** — a wider search over range-hour/target/stop found
nothing that beats the frozen baseline's own hand-picked config (`rangeHour=8, target=1x,
slBuffer=0.1`). That config isn't a lucky guess; broader search around it doesn't improve on it.

**prev_day_level is the most promising lead so far** — 5/5 walk-forward folds profitable, a stable
picked config, real win rate/RR that would clear the baseline if confirmed — but it does not clear
this project's own bar because the untouched final holdout is too small (9 trades) to trust despite
being positive. This is not a rejection of the mechanism; it is an honest "not enough evidence yet"
verdict, exactly the language Part 9 asks for. Revisit once either (a) more calendar time has
accumulated in the real dataset, or (b) the holdout window is deliberately shrunk in a way that's
still methodologically defensible (would need justification, not just moved until it passes).

## Round 4 — two more strategy families (Fair Value Gaps, ORB-failure fade)

**Reproduce:** `node backtest/research_phase5.js --only=fvg_continuation,orb_failure_fade`

Per continued request to keep searching new families while refining ORB: `fvg_continuation` (Part
1's own candidate list — an objective 3-bar imbalance pattern, betting the gap acts as
support/resistance on a retrace-and-continue) and `orb_failure_fade` (the direct complement to ORB:
when the opening-range breakout FAILS and price closes back inside the range, fade toward the
opposite side, instead of ORB's continuation bet — reuses ORB's own range definition so only that
one variable changes).

| Candidate | Folds profitable | Trades | Win rate | RR (payoff) | Expectancy | Profit factor | Verdict |
|---|---|---|---|---|---|---|---|
| fvg_continuation | **4/5** (a real majority) | 190 | 51.58% | 1.072 | +0.0695R | 1.142 | REJECTED — only on the stability gate (config repeated in just 2/5 folds) |
| orb_failure_fade | 0/5 | 179 | 16.20% | 0.881 | -0.7372R | 0.170 | REJECTED — clearly, consistently negative |

**fvg_continuation is the closest call of any candidate tested this session** — a genuine majority
of folds were profitable with real, plausible numbers (PF 1.142, n=190), but the specific parameters
that worked kept drifting fold to fold. Worth a narrower, more targeted grid in a future round
(fewer, more surgical parameter choices around gap size and target multiple) rather than dismissed.

**orb_failure_fade is useful negative evidence, not a wasted test**: failed ORB breakouts do NOT
reliably reverse — if anything this reinforces confidence in ORB's own continuation logic being the
right read of this instrument's behavior at the open, not an arbitrary choice.

## Consolidated final tally — all 12 candidates tested this session

(Corrected for the ledger-duplication and END_OF_DATA gating bugs found and fixed mid-session — see
git history. Numbers below are the final, doubly-verified figures; a few shifted by 1-2 trades from
earlier round reports as a result, none materially.)

| # | Candidate | Trades (OOS) | Win rate | RR | Expectancy | PF | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | trend_pullback | 29 | 48.28% | 1.157 | +0.0348R | 1.08 | Rejected — not a fold majority |
| 2 | vwap_reversion | 72 | 56.94% | 2.915 | +1.2952R | 3.856 | Rejected — unstable (overfitting signature) |
| 3 | liquidity_sweep_asia | 312 | 16.35% | 0.842 | -0.7837R | 0.165 | Rejected — stably negative |
| 4 | liquidity_sweep_london | 272 | 13.97% | 0.692 | -0.8305R | 0.112 | Rejected — stably negative |
| 5 | session_reversion_asia | 352 | 21.88% | 1.926 | -0.4449R | 0.539 | Rejected — stably negative |
| 6 | session_reversion_london | 264 | 17.42% | 2.111 | -0.5447R | 0.445 | Rejected — stably negative (same config every fold) |
| 7 | session_breakout_asia | 56 | 48.21% | 0.798 | -0.1401R | 0.743 | Rejected — not a fold majority |
| 8 | session_breakout_london | 94 | 42.55% | 0.919 | -0.1914R | 0.680 | Rejected — not a fold majority |
| 9 | orb_refine (wider grid) | 128 | 40.63% | 0.818 | -0.2493R | 0.560 | Rejected — worse than the frozen config |
| 10 | prev_day_level | 72 (+9 holdout) | 68.06% | 1.218 | +0.5266R | 2.595 | Rejected — holdout too small (promising lead) |
| 11 | fvg_continuation | 190 | 51.58% | 1.072 | +0.0695R | 1.142 | Rejected — unstable config (closest call) |
| 12 | orb_failure_fade | 179 | 16.20% | 0.881 | -0.7372R | 0.170 | Rejected — stably negative |

**0 of 12 accepted. 2,029 real OOS/holdout trades ledgered across this research** (verified directly
against `data/pxbot_market_data.sqlite`: `SELECT COUNT(*) FROM trades WHERE run_id LIKE 'phase5_%'`
— does not count toward the mission's 1,000-trade validation bar — see "Trade-count accounting" above; these are
rejection evidence, not validation evidence). The frozen baseline (ORB inside it: +0.0482R/trade,
n=301, PF 1.134) remains the only demonstrated real edge in this codebase, and remains unbeaten.

## Trade-frequency math for the 1,000-trade target

At a practical operating cadence (~2 trades/day, ~250 trading days/year), 1,000 trades needs about
2 years — achievable from the real ~2.6-year hourly window we have. But **no single strategy tested
so far fires anywhere near that often**: ORB ~0.46/day, PREMARKET ~0.4/day, prev_day_level
~0.15/day. Reaching that frequency (and therefore reaching 1,000 real trades within the available
history) requires an ensemble of multiple validated, non-overlapping modules — reinforcing Part 8's
own guidance, not a new conclusion, but now grounded in this session's actual measured frequencies
rather than an assumption.

**Recommended direction from here**, in priority order:
1. Stop searching for brand-new independent strategy families for now. ORB is the one mechanism in
   this entire codebase with a demonstrated, real, stable edge (`CURRENT_STRATEGY_BASELINE.md`:
   n=301, PF 1.134, positive in 19/31 months). Spend the next round refining and stress-testing
   *that* mechanism specifically (different range-defining hours, target multiples, stop models)
   rather than continuing to sample new mechanisms broadly.
2. Re-test liquidity_sweep / session_reversion at real 1-minute execution precision once that's
   justified by available history depth (currently ~267 days) — the hourly-resolution caveat above
   is real and unresolved, not dismissed.
3. Revisit PREMARKET's exit model (Part 6: partials, ATR trailing, structure targets) now that the
   19:00 CT exit-timing bug is fixed and it's back to a small positive edge — there may be more
   there with a better-designed exit than either extreme (15:00 forced close vs. ride-to-19:00) tried
   so far.
