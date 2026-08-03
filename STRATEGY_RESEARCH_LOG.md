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

## Round 5 — fvg_continuation_narrow: the first ACCEPTED candidate

**Reproduce:** `node backtest/research_phase5.js --only=fvg_continuation_narrow`

Round 4's `fvg_continuation` was rejected only on the stability gate, but its fold-by-fold detail
showed something the strict exact-config-match check missed: `minGapSize=40` and the Tue/Wed/Thu
day filter were picked in **5 of 5** folds, `targetRMultiple=1` and `maxWaitBars=10` in **4 of 5**
(the one disagreement was fold 3, an early low-data fold). Only the stop-buffer flip-flopped between
two nearby values. That is principled grounds for narrowing the grid to what the data already
agreed on — not cherry-picking the answer, but recognizing a real pattern the coarse stability check
couldn't see. A new candidate (`fvg_continuation_narrow`) was registered with those parameters fixed
and only the genuinely uncertain dimension (stop buffer, plus a small window around gap size) left
open, then run through the identical, unbiased walk-forward + untouched-holdout process.

**Result: ACCEPTED.**

| | Walk-forward (OOS) | Untouched holdout |
|---|---|---|
| Trades | 153 | 92 |
| Folds/verdict | 5/5 profitable | positive, n well above the 15-trade minimum |
| Win rate | 58.82% | 57.61% |
| RR (payoff) | 0.878 | 0.849 |
| Expectancy | +0.1049R | +0.0681R |
| Profit factor | 1.254 | — |

Combined (all 245 real trades, walk-forward + holdout, via `backtest/metrics.js`):

| Metric | fvg_continuation_narrow | Frozen baseline (ORB component) | Frozen baseline (combined) |
|---|---|---|---|
| Trades | 245 | 301 | 429 |
| Win rate | 58.37% | 55.48% | 55.24% |
| Expectancy | **+0.0911R** | +0.0482R | +0.0298R |
| Profit factor | **1.215** | 1.134 | 1.090 |
| Max drawdown | **7.34R** | 13.25R | 15.07R |
| Sharpe (per-trade) | 0.096 | 0.058 | 0.038 |
| Net R by year | 2024: +5.9, 2025: +10.1, 2026: +6.3 | 2024: +17.3, 2025/26: net negative | same pattern |

**This beats the baseline on win rate, expectancy, profit factor, drawdown, and — notably — year-
over-year stability.** ORB's edge was concentrated almost entirely in 2024; this candidate
contributed positively in all three calendar years tested, directly addressing the decay pattern
flagged in `CURRENT_STRATEGY_BASELINE.md`.

**Stress check (Part 11 requirement — is this a few lucky wins?):** removing the top 20 winning
trades (8% of the sample) still leaves positive expectancy (+0.0145R, n=225); removing the top 10
leaves +0.0542R. The top 10 winning trades themselves are all clustered at 0.95–0.97R, not
outliers — this strategy uses a fixed 1R target, so no single trade can structurally dominate the
result the way an unbounded-target strategy's occasional large win could. This is a healthier,
less fragile profile than a strategy whose edge depends on a handful of outsized trades.

**Funded-account comparison** (`node backtest/funded_account_report.js --runId=phase5_fvg_continuation_narrow --strategyId=fvg_continuation_narrow`,
same generic illustrative configs as `FUNDED_ACCOUNT_RISK_REPORT.md`): at matching risk levels this
candidate clears survival thresholds ORB alone could not — e.g. under adverse execution costs and
the conservative config, ORB's failure probability was 11.7% even at the lowest tested risk (0.25%,
already over the 10% bar); this candidate's failure probability at the same risk/config/scenario is
3.4%. Under the lenient config at base costs, this candidate supports 1.00% risk/trade at 9.3%
failure probability with an 87.2% chance of reaching the profit target (median 43 days) — ORB's
comparable safe risk level was lower with a slower, less reliable path to target.

## What this is NOT (read before treating this as "ready")

- **Multiple-testing context**: this is the 13th configuration tested across 5 rounds this session
  (12 rejected, this one accepted). Part 7 requires the evidence bar to rise with the number of
  variants tried — one acceptance out of many honest attempts is a real, positive finding, but
  should be held to *more* scrutiny, not less, precisely because so much was tried before it. It
  clears every gate this project's process defines (stability, fold majority, minimum samples,
  untouched-holdout positivity, an outlier-removal stress check, and now a funded-account
  comparison) — but "cleared every gate we defined" is not the same claim as "definitely a durable
  real-world edge."
- **Still under `severe` execution-cost stress, this candidate also fails at every tested risk
  level**, same as ORB. Severe-scenario fragility has not been solved by this finding.
- **This has not yet been combined with ORB into an ensemble** or tested for correlation between the
  two (if they tend to fire on the same days/conditions, combining them would not add the
  diversification benefit Part 8 expects — untested, not assumed either way).
- **No real fills have been measured on this account** — execution costs are still the same
  documented assumptions used throughout, not measurements.
- Per the mission's own status vocabulary: this candidate is **PAPER_READY at small size**
  (comparable to or somewhat better than ORB's own readiness level) — not yet `MICRO_LIVE_READY`,
  and `SCALE_READY` requires the full remaining checklist (ensemble correlation check, real-fill
  cost measurement, a second independent holdout period as more calendar time accumulates).

## Round 6 — the 30pt stop cap, measured costs, and the first 1,000+-trade validated system

**New hard operator constraints stated mid-session:** max 30-point protective stop; preferred
targets 30–100+pts; 2–3 trades/day across Asia and NY premarket/AM; must scale funded accounts.

**Reproduce:** `node backtest/research_phase5.js --only=fvg_1m_capped,micro_orb_1m_capped,asia_fade_1m_capped`
(assumed 2pt spread), then `scripts/measure_spread.js`, then
`node backtest/research_phase5.js --only=retest_nyopen_1m,retest_asia_1m,fvg_1m_capped --spread=1.32`

### 6a. The win-rate lesson, demonstrated on real data

Three ≤30pt-stop candidates were built on real 1-minute data with a selection rule that maximizes
win rate subject to positive train expectancy. Results under the assumed 2pt spread:

| Candidate | Trades | Win rate | Expectancy | Verdict |
|---|---|---|---|---|
| asia_fade_1m_capped (holdout) | 31 | **87.1%** | **-0.021R** | REJECTED — holdout unprofitable |
| fvg_1m_capped | 1,300 | 78.0% | -0.019R | REJECTED — 0/4 folds |
| micro_orb_1m_capped | **0** | — | — | REJECTED — NQ opening ranges are structurally wider than a 30pt stop permits; zero qualifying days |

**The operator's requested ~90% win rate was effectively found — 87.1% on an untouched holdout —
and it loses money.** 8pt winners cannot pay for 30pt losers plus costs. Win rate is purchasable;
expectancy is not. This is the empirical demonstration, not a lecture.

### 6b. Costs measured, not assumed

`scripts/measure_spread.js` sampled 70 live quotes from this account's real feed (Sunday Globex
reopen — typically the week's worst liquidity): **median spread 1.32pts** (p95 1.32, max 1.57) vs.
the 2pt assumption used everywhere prior. At ≤30pt stops the difference is ~0.02–0.05R/trade —
exactly the margin the near-breakeven scalps died by. Slippage (1pt) remains an assumption; no
real fills exist yet to measure it. Saved: `data/logs/measured_spread.json`.

### 6c. The operator's stated geometry (≤30pt stop, 30–100pt targets): REJECTED

Breakout-retest continuation (close-confirmed break of the opening/Asia range, pullback entry at
the level, fixed 20–30pt stop, 1.5–3R targets), both sessions, measured spread:

| Candidate | Folds | Trades | Win rate | RR | Expectancy | Verdict |
|---|---|---|---|---|---|---|
| retest_nyopen_1m | 1/5 | 116 | 34.48% | 1.226 | -0.2506R | REJECTED |
| retest_asia_1m | 1/5 | 92 | 35.87% | 1.151 | -0.2465R | REJECTED |

At 1.5–3R targets these needed ~40–50% win rates; they achieved ~35%. NQ pullback-retests at
tight fixed stops get run through too often before continuing. This exact geometry, on this
instrument, at this stop cap, does not currently show an edge — stated plainly.

### 6d. fvg_1m_capped under MEASURED costs: ACCEPTED — first system past the 1,000-trade bar

The same 1m FVG candidate that failed by -0.019R under the 2pt spread assumption, re-run with the
measured 1.32pt spread:

| | Walk-forward OOS | Untouched holdout |
|---|---|---|
| Trades | 1,523 | **907** |
| Folds | 4/5 profitable, **same config in 5/5 folds** (minGapSize=12, target 0.5R, Mon–Fri) | — |
| Win rate | 79.05% | **79.49%** |
| Expectancy | +0.0288R | **+0.0364R** (holdout better than dev) |
| Profit factor | 1.126 | — |

**2,430 total qualifying validation trades — the first candidate to clear Part 8's 1,000-trade
requirement**, from one strategy, one timeframe, chronologically non-overlapping by construction.
Ledger deep-dive: median stop 20.3pts (max 31.6 — cap respected), maxDD 11.95R, max 5 consecutive
losses, 75% of months profitable, positive in every session bucket except ny_open (~flat) and
afterhours (negative).

### 6e. The honest problems with 6d (read before celebrating)

1. **It is not manually tradeable.** 15.4 trades/day average (max 51), average hold time ~1.1
   minutes, median target ~10pts. This is an automated scalper's profile. PXBOT is deliberately
   read-only/manual-execution — no order path exists — and the operator asked for 2–3 deliberate
   trades/day. This system cannot be traded by a human clicking buttons, and it does NOT meet the
   operator's stated 30–100pt-target preference.
2. **The edge is thin and cost-fragile.** +0.03R/trade flips negative at a 2pt spread (proven in
   6a — same candidate, same data). It lives or dies on ~0.7pts of spread and the still-unmeasured
   slippage assumption. A 0.5–1pt real slippage difference kills it.
3. **7.1% ambiguous fills** (stop and target both touched within one 1m bar), resolved
   conservatively (stop-first), so the reported number is a floor in that one respect — but heavy
   intrabar-sequencing dependence is inherent to 1-minute scalping and adds real-world variance.
4. **Two of five folds were ~flat** (+0.0016, -0.0032) — the OOS profit concentrates in folds 4–5
   and the holdout (the most recent months). Could be regime-dependence; could be genuine recency
   of the edge. Unknown.
5. Multiple-testing: ~18th configuration tested this session. The acceptance evidence is the
   strongest of the session (n=2,430, 5/5 config stability, holdout > dev), but the bar stays high.

**Status: RESEARCH_ONLY.** It clears the trade-count bar and the statistical gates, but fails the
operator's own operational constraints (manual execution, target size) and is cost-fragile. Its
realistic use would require automated execution — a deliberate architectural decision PXBOT has so
far refused (read-only by design) — plus NY-hours spread/slippage measurement first.

### 6f. Funded-account Monte Carlo on the 2,430 real trades (backtest/funded_account_report_fvg1m.json)

10,000 block-bootstrap paths per cell, generic illustrative configs (swap in the real firm's rules
before any real decision):

| Config / scenario | Best risk with P(fail)≤10% | At that risk: P(reach target before fail) | Median days to target |
|---|---|---|---|
| Lenient funded, measured costs | **1.00%** | 92.0% | 13 |
| Lenient funded, 0.50% risk | (P(fail) 0.5%) | **99.2%** | 32 |
| Conservative eval, measured costs | 0.25% only | 98.3% | 56 |
| **Either config, adverse costs (+0.05R, 5% missed, winners -10%)** | **NONE — P(fail) ~100% at every risk level** | ~0% | — |
| Either config, severe costs | NONE — P(fail) 100% | 0% | — |

**Read both rows.** Under measured costs this system passes a generic eval with near-certainty at
modest risk. Under adverse execution — just 0.05R/trade worse — it fails with near-certainty. The
entire outcome pivots on ~0.7pts of spread plus the unmeasured slippage assumption, at 15
trades/day where costs compound fast. The conservative config's daily-loss rule also bites hard at
this frequency (0.50% risk → 34% failure purely from daily-loss breaches). This is a knife-edge
system: genuinely validated, genuinely fragile, and dependent on execution quality that cannot be
known without live demo fills. It is NOT "ready to scale a funded account" and claiming so would
be false; it IS the strongest statistical result this codebase has produced and the correct next
step for it is demo-account forward measurement, not live capital.

### Where this leaves the operator's full requirement set

No tested strategy simultaneously satisfies: manual 2–3 trades/day + ≤30pt stop + 30–100pt targets
+ validated edge. Each pairwise combination was tested honestly: high-WR small-target works only at
scalper frequency; the 30–100pt-target retest geometry shows no edge at this stop cap; wide-stop
hourly strategies (ORB, hourly FVG, prev-day-level) all require stops wider than 30pts. The
constraint set itself — not the research effort — is what's binding. Next candidates worth testing
against the spec: prev-day-level breakout with a FIXED ≤30pt stop and fixed 40–100pt targets (the
strongest level type from round 3, re-geometried to the cap), and a session-filtered variant of
6d (Asia + NY AM windows only) IF automated execution is ever on the table.

## Round 7 — bigger targets + higher win rate under the 30pt cap: both rejected

**Reproduce:** `node backtest/research_phase5.js --only=prevday_fixedstop_1m,fvg_hourly_1m_entry --spread=1.32`

| Candidate | Folds | Trades | Win rate | RR | Expectancy | Verdict |
|---|---|---|---|---|---|---|
| prevday_fixedstop_1m (fixed 25/30pt stop, 40/60/100pt targets, premarket/NY-AM) | 3/5 | 59 | 45.76% | 1.367 | **+0.0895R** | REJECTED — 4 distinct configs in 5 folds; per-fold n of 7–22 makes fold outcomes coin flips |
| fvg_hourly_1m_entry (validated hourly FVG signal, deeper 1m entry, fixed ≤30pt stop) | 1/3 | 35 | 40.0% | 1.238 | -0.1122R | REJECTED — the hourly FVG edge evidently NEEDS its wide structural stop; compressing to 30pts converts winners into stop-outs |

prevday_fixedstop_1m is positive-expectancy overall and partially consistent across folds
(retest style 4/5, 40pt target 4/5, Tue/Wed/Thu 4/5) — but unlike the fvg_continuation_narrow
rescue (16–52 trades/fold, 5/5 agreement on the fixed params), per-fold samples of 7–12 trades
cannot distinguish signal from noise, so a "principled narrowing" here would be curve-fitting.
Verdict: INSUFFICIENT_TRADES at this frequency (~0.33/day) in the 267-day 1m window — revisit as
1m history accumulates, do not rescue now.

**Accumulated verdict on the literal constraint set (fixed ≤30pt stop + 40–100pt targets on NQ):**
four mechanically distinct entry types have now been tested against it — opening-range retest
(both sessions, ~35% WR), prev-day-level break/retest (46% WR, unstable), deep-FVG entry (40% WR)
— and none produced a stable validated edge. The consistent picture: NQ's ordinary noise exceeds
30pts on the path to 40–100pt moves, so tight fixed stops get run before big targets are reached.
The one system validated with targets in the operator's band (hourly FVG: 58% WR, ~45–55pt
targets) needs a ~45–55pt stop — just outside the cap. **Stop WIDTH and dollar RISK are not the
same thing**: at constant dollar risk, halving position size doubles affordable stop width (e.g.
$500 risk = 8 MNQ at a 30pt stop, or 5 MNQ at a 50pt stop). Whether the validated system fits the
operator's real constraint depends on whether the 30pt cap is a literal stop-distance rule from
their prop firm (rare) or a dollar-risk habit expressed in points (common) — an operator question,
not a research question.

## Round 8 — the 90%-win-rate frontier, mapped and closed

**Reproduce:** `node backtest/research_phase5.js --only=asia_fade_widestop,london_fade_widestop,lunch_fade_widestop --spread=1.32`

The dollar-risk clarification unlocked wide-stop fades (50–80pt stops, sized down in contracts;
10–20pt targets). Three windows tested with the winRate-constrained selector:

| Candidate | Folds | Trades | Win rate | RR | Expectancy | Verdict |
|---|---|---|---|---|---|---|
| asia_fade_widestop | 1/5 | 89 | 77.53% | 0.194 | -0.0668R | REJECTED — wider stops LOWERED win rate (87→78%): wins shrank in R faster than losses thinned |
| london_fade_widestop | 0/5 | 92 | 78.26% | 0.180 | -0.0753R | REJECTED |
| **lunch_fade_widestop** | **5/5** | 119 (dev) + 36 (holdout) | **94.96% dev / 91.67% holdout** | 0.109 / 0.071 | +0.0361R dev / **-0.0189R holdout** | **REJECTED — the holdout lost money at a 91.7% win rate: 3 losses erased 33 wins** |

**The operator's request — a strategy that "wins 90% and higher" — was found.** The NY-lunch range
fade won 94.96% of 119 walk-forward trades and 91.67% of 36 untouched holdout trades. The win rate
is real and stable. **And it is not profitable**: average win ~0.07R, average loss ~1R, so the
holdout's 3 losses outweighed its 33 wins. The dev/holdout straddle (+0.036R / -0.019R) is exactly
the signature of a zero-edge process — the gates worked precisely as designed.

**The high-win-rate frontier on this instrument/feed/window is now mapped at four independent
points** (87% @ RR 0.13 → -0.02R; 78% @ RR 0.19 → -0.07R; 78% @ RR 0.18 → -0.08R; 92–95% @ RR
0.07–0.11 → ≈0R minus costs), all breakeven-or-negative after real measured costs. The market
prices these fades efficiently: any win rate is purchasable, and the price is the edge itself.
**Continuing to re-roll this specific question is now data mining, not research** — the posterior
is settled unless something material changes (substantially deeper history, materially tighter
measured costs, or a different instrument). Near-miss candidates (prevday_fixedstop, the fades)
remain legitimately re-testable as genuinely NEW 1m data accumulates month by month — that is new
evidence, not a re-roll. New mechanism families (displacement, breaker structures, news-window
avoidance overlays) also remain open, judged by expectancy first.

What stands validated and live remains the honest answer: the hourly FVG system (58% WR, +0.091R,
funded-MC-tested, DEMO-FIRST, integrated in the app) — and the path to the operator's 2–3
trades/day is stacking additional validated modules over time, not forcing a win-rate number the
market has now repeatedly refused to pay for.

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
