# PXBOT NQ Console — Current Strategy Baseline (Part 4)

**Frozen benchmark. Every future candidate strategy must beat this, on real data, before it can be
called "better."**

**Run ID:** `baseline_v1_base` (headline) / `baseline_v1_zero` (cost-sensitivity comparison)
**Generated:** 2026-08-02
**Code hash:** `3b6180fea2f8b64e` (sha256 of `ict_engine.js` + `orb_engine.js` + `run_baseline.js` +
`replay_engine.js`, first 16 hex chars)
**Dataset hash:** hourly `3edc4dca1fbed4dd`, 1-minute `7ce33543871f055b`
**Reproduce:** `node -r ./scripts/load_env.js data/download.js` (if not already downloaded), then
`node backtest/run_baseline.js --costModel=base` (or `--costModel=zero`)

## What was frozen

This is server.js's `handleSignal` **exactly as currently live** — the three strategies it actually
runs (`SIGNAL_ICT_MIN_LEG`, `SIGNAL_ORB_CONFIG`, `SIGNAL_PREMARKET_CONFIG`), with their exact
published parameters, using `ict_engine.js`/`orb_engine.js`'s own unmodified classification/entry
functions to decide *when and where* a signal fires. Only the *execution* step (fill cost, MAE/MFE,
ambiguous-fill flagging, ledger) is routed through the new `engine/replay_engine.js` instead of each
engine's own zero-cost simulator — see `backtest/run_baseline.js` header comment for exactly how
each strategy's entry/exit was translated. No parameter was tuned, searched, or cherry-picked for
this baseline — that is the entire point of freezing it before any research begins.

| Strategy | Entry | Stop | Target/Exit | Filters | Bars used |
|---|---|---|---|---|---|
| **ICT** | OTE zone (0.618–0.705 retracement) touch after Asia/London leg classification | Leg extreme ± 5% buffer | Managed: stop→breakeven at TP1, stop→TP1 at TP2, ride to TP3 | `minLegSize≥199pt` | 1H (live behavior — `handleSignal` classifies/executes ICT on hourly bars, not 1-minute) |
| **ORB** | Breakout of the 08:00–09:00 CT hourly range | Opposite range side ± 10% buffer | 1× range size | Monday excluded | 1H (live behavior) |
| **PREMARKET** | Breakout of the 07:00–09:30 CT range (built from real 1-minute bars) | Opposite range side ± 5% buffer | 0.5× range size, **or session close (15:00 CT)** | Tue/Wed/Thu only | 1m (live behavior — this is the one strategy the live handler actually executes at 1-minute granularity) |

**Honest deviation, flagged, not hidden:** the original 1-minute-precision validation referenced in
server.js's comments (`PREMARKET_TRACK_RECORD`: "~207 real days, avg +0.108–0.115R/trade, n=83")
used a hold-time parameter that is not recoverable from the committed codebase — every walk-forward
script that still exists (`session_breakout_walkforward.js` and siblings) validated on **hourly**
bars with `maxHoldBars=40`, not the 1-minute run that comment describes. This baseline instead uses
a session-close exit (ride until 15:00 CT) as a documented, reproducible choice consistent with the
strategy's stated intent — not a reproduction of that unseen historical run. The two numbers
(baseline below vs. the old comment) should **not** be read as contradicting each other; they are
different, both-real measurements of a strategy whose exact original parameterization was lost.

## Data window

- 1H bars: 15,440 bars, 2024-01-01 → 2026-07-31 (~2.6 years) — the real, broker-confirmed retention
  floor for this account/instrument (see `DATA_INTEGRITY_REPORT.md`), not the "~2.3yr" figure old
  code comments assumed.
- 1m bars: 258,487 bars, 2025-11-06 → 2026-07-31 (~267 days) — same real retention floor.

## Cost assumptions

NAS100 CFD spread/slippage are **not yet measured from real fills** on this account (no trade
history exists to measure from) — the `base` scenario below uses documented, configurable
assumptions (2pt spread, 1pt slippage, 0.01R flat commission) consistent with typical retail NAS100
CFD conditions, not measured facts. `zero` is run alongside it purely as a transparency comparison —
**not** a claim that zero-cost execution is realistic.

## Headline result — ALL THREE STRATEGIES COMBINED

| Metric | Base costs | Zero costs |
|---|---|---|
| Total qualifying trades | 429 | 429 |
| Win rate | 53.15% | 54.31% |
| Avg win / avg loss (R) | 0.658 / -0.710 | 0.689 / -0.727 |
| **Expectancy (R/trade)** | **+0.0173** | +0.0572 |
| Profit factor | 1.052 | 1.181 |
| Net R | +7.40 | +24.55 |
| Max drawdown (R) | 19.46 | 12.67 |
| Sharpe (per-trade) | 0.022 | 0.074 |
| Sortino | 0.031 | 0.106 |
| Calmar | 0.147 | 0.751 |
| Recovery factor | 0.38 | 1.94 |
| Payoff ratio | 0.927 | 0.947 |
| Median R | 0.113 | 0.151 |
| Std dev R | 0.771 | 0.778 |
| Max consecutive wins / losses | 7 / 5 | 7 / 5 |
| Avg / max holding time | 207.5 min / 540 min | same |
| Avg MAE / MFE (R) | 0.68 / 0.65 | 0.677 / 0.67 |
| 90th-pct MAE (R) | 1.235 | 1.237 |
| % trades reaching 1R before stopping | 22.84% | 25.41% |
| % months profitable | 58.06% (18/31) | 64.52% |
| % weeks profitable | 53.28% (65/122) | 59.02% |
| Exposure (time-in-market) | 6.56% | 6.56% |
| Total commission drag (R) | 8.58 | 0 |
| Ambiguous same-bar stop/target fills | 0.47% (2 trades) | 0.47% |
| Trades excluded as END_OF_DATA (real, not fabricated) | 51 | 51 |

**The realistic cost assumption alone removes ~70% of the raw edge** (expectancy 0.0572R → 0.0173R).
This is exactly the kind of gap DATA_AUDIT.md §5 flagged as missing from every existing engine —
now it's visible and quantified rather than silently absent. `fundedAccountBreachProbability` is
intentionally `null` — that requires Part 10's funded-account simulator, not yet built. This is
**insufficient evidence, not zero risk.**

## By strategy (base costs)

| | ICT | ORB | PREMARKET |
|---|---|---|---|
| Trades | 22 | 301 | 106 |
| Win rate | 22.73% | 55.48% | 52.83% |
| Expectancy | **-0.1093R** | +0.0482R | **-0.0443R** |
| Profit factor | 0.726 | 1.134 | 0.816 |
| Net R | -2.41 | +14.50 | -4.69 |
| Max DD (R) | 5.16 | 13.25 | 7.42 |
| Payoff ratio | 2.469 | 0.910 | 0.729 |
| % months profitable | 30% (3/10) | 61.29% (19/31) | 33.33% (3/9) |
| Excluded END_OF_DATA | 2 | 49 | 0 |

**ICT is net negative on the full real hourly history (n=22, -0.109R/trade).** This is consistent
with — and extends — what server.js's own comments already disclosed: the strategy's positive
track record (avgR 0.314–0.405) was measured on a thin n=7–11 sample; checked against the much
larger real history it goes negative, exactly as previously flagged. This baseline confirms that
finding on 2x the previously-checked sample, with real costs added. **ICT does not currently show a
validated edge and should not be presented as one.**

**ORB is the strongest single contributor** (n=301, the largest sample of the three, PF 1.134,
positive in 19 of 31 months) and is the main reason the combined baseline is net positive at all.

**PREMARKET is net negative** under this baseline's session-close-exit assumption (n=106,
-0.044R/trade) — see the "honest deviation" note above; this may reflect the different exit rule
rather than a genuine failure of the entry logic, and is a real, open question for Phase 5 research
rather than a settled verdict either way.

## By session (all three strategies combined, base costs)

| Session | Trades | Win rate | Expectancy | Net R | Profit factor |
|---|---|---|---|---|---|
| ny_open (08:30–10:00 CT) | 355 | 55.49% | +0.0341 | +12.10 | 1.099 |
| ny_am (10:00–12:00 CT) | 52 | 40.38% | -0.0810 | -4.21 | 0.763 |
| ny_midday (12:00–13:30 CT) | 10 | 70.00% | +0.0031 | +0.03 | 1.021 |
| ny_pm (13:30–15:00 CT) | 4 | 50.00% | -0.0012 | -0.01 | 0.975 |
| afterhours (15:00–19:00 CT) | 5 | 20.00% | -0.0905 | -0.45 | 0.655 |
| asia (19:00–01:00 CT) | 3 | 0.00% | -0.0182 | -0.06 | 0.000 |

**Only `ny_open` has a sample large enough (n=355) to draw any conclusion from** — its own edge
(+0.034R/trade) is smaller than the combined-strategy edge, meaning ORB's contribution outside that
window (afternoon exits, longer holds) matters too. Every other session has n<55 and several have
n<10 — **not enough evidence to conclude anything about Asia, London/NY-overlap, midday, PM, or
afterhours performance yet.** London itself produced zero qualifying trades in this baseline (no
strategy here is anchored to a pure London entry window) — a real, honest gap for Phase 5 to address,
not a hidden one.

## By calendar year

| Year | Trades | Win rate | Expectancy | Net R |
|---|---|---|---|---|
| 2024 | 85 | 62.35% | +0.2038 | +17.32 |
| 2025 | 147 | 48.98% | -0.0226 | -3.33 |
| 2026 (YTD, through Jul 31) | 197 | 52.28% | -0.0335 | -6.60 |

**Clear, real performance decay over time** — the entire combined-baseline net-positive result comes
from 2024; 2025 and 2026 are both net negative. This is disclosed, not smoothed over: whatever edge
this frozen configuration had appears to be decaying, which is exactly the kind of finding Part 9
requires future candidates to be judged against (stability across periods), not just an aggregate
number.

## By direction and day of week

| Direction | Trades | Win rate | Expectancy |
|---|---|---|---|
| LONG | 227 | 55.07% | -0.0215 |
| SHORT | 202 | 50.99% | +0.0608 |

| Day | Trades | Win rate | Expectancy |
|---|---|---|---|
| Mon | 5 | 20.00% | -0.3942 |
| Tue | 127 | 51.18% | -0.0311 |
| Wed | 118 | 50.85% | +0.0103 |
| Thu | 123 | 52.85% | -0.0347 |
| Fri | 56 | 66.07% | +0.2924 |

Monday's n=5 (only ICT trades — ORB already excludes Monday live, PREMARKET is Tue/Wed/Thu-only)
is far too small to act on despite the large negative number; Friday's apparent strength (n=56) is
worth investigating in Phase 5 but is not yet a large enough sample to be conclusive on its own.
LONG trades being net negative while SHORT trades are net positive is a real, disclosed asymmetry —
not yet explained, not yet a validated finding.

## What this baseline does NOT claim

- Not a train/validation/holdout split. This is a **frozen, already-published, unmodified**
  configuration being measured, not tuned — there is nothing to overfit here, so the walk-forward /
  holdout discipline (Part 7) applies to Phase 5's *candidate* strategies, not to re-measuring this
  one. If a future revision of the live strategy's parameters is ever proposed, it must go through
  that full discipline before being called an improvement.
- Not a claim about funded-account survivability — `fundedAccountBreachProbability` is null pending
  Part 10.
- Not adjusted for the fact that ICT and PREMARKET's true 1-minute-execution windows are much
  shorter (~267 days) than ORB's hourly window (~2.6 years) — each strategy's own table above states
  its own real sample size and window; they are not pooled in a way that hides this.
- `pctLaterReverseProxy` is intentionally omitted from the headline tables above — it uses an
  explicit, documented proxy definition (MAE≥0.3R) rather than a standard metric; see the full JSON
  reports (`backtest/baseline_report_base.json` / `_zero.json`, gitignored as regenerable output) for
  every field `backtest/metrics.js` computes, including that one.

## Acceptance bar for Phase 5 candidates

A candidate strategy or session-specific module must be compared against the **base-cost combined
baseline** above (expectancy +0.0173R/trade, profit factor 1.052, max drawdown 19.46R over 429
trades) — not against zero-cost numbers, not against any single strategy's number in isolation
unless the candidate is itself scoped to that same session/strategy family. Per Part 9, a candidate
should show higher out-of-sample expectancy, comparable-or-better profit factor, lower drawdown, and
stability across the same year-by-year and session breakdowns shown above — a candidate that only
wins in 2024 the way this baseline does would not clear that bar.
