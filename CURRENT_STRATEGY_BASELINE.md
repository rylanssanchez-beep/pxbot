# PXBOT NQ Console — Current Strategy Baseline (Part 4)

**Frozen benchmark. Every future candidate strategy must beat this, on real data, before it can be
called "better."**

**Run ID:** `baseline_v1_base` (headline) / `baseline_v1_zero` (cost-sensitivity comparison)
**Generated:** 2026-08-02 (revised same day — see "Revision note" below)
**Code hash:** `6d74b6f4ca4b2915` (sha256 of `ict_engine.js` + `orb_engine.js` + `run_baseline.js` +
`replay_engine.js`, first 16 hex chars)
**Dataset hash:** hourly `3edc4dca1fbed4dd`, 1-minute `7ce33543871f055b`
**Reproduce:** `node -r ./scripts/load_env.js data/download.js` (if not already downloaded), then
`node backtest/run_baseline.js --costModel=base` (or `--costModel=zero`)

## Revision note (transparency, not silence)

The first version of this baseline used a 15:00 CT forced exit for the PREMARKET strategy. A direct
question ("I thought premarket was profitable?") prompted a real check
(`scripts/diagnose_premarket.js`) rather than a defensive answer. That check isolated the cause
precisely: forcing an early 15:00 CT close — not data recency — was the dominant factor turning the
result negative, and it was an inconsistent choice to begin with: `ict_engine.js`/`orb_engine.js`
both already treat 15:00–19:00 CT as "afterhours," still part of the tradeable day, not a cutoff.
This baseline now uses 19:00 CT, matching that existing convention. This does **not** fully recover
the old `PREMARKET_TRACK_RECORD` comment's claimed number (that gap is now understood to be a
mix of exit-timing and real execution costs, not a mystery) — see "By strategy" below for the
honest, current number. The diagnostic script and its full output are preserved in git history.

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
| **PREMARKET** | Breakout of the 07:00–09:30 CT range (built from real 1-minute bars) | Opposite range side ± 5% buffer | 0.5× range size, **or session close (19:00 CT)** | Tue/Wed/Thu only | 1m (live behavior — this is the one strategy the live handler actually executes at 1-minute granularity) |

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
| Win rate | 55.24% | 56.41% |
| Avg win / avg loss (R) | 0.652 / -0.739 | 0.683 / -0.761 |
| **Expectancy (R/trade)** | **+0.0298** | +0.0697 |
| Profit factor | 1.090 | 1.221 |
| Net R | +12.78 | +29.92 |
| Max drawdown (R) | 15.07 | 12.36 |
| Sharpe (per-trade) | 0.038 | 0.089 |
| Sortino | 0.053 | 0.129 |
| Calmar | 0.328 | 0.938 |
| Recovery factor | 0.848 | 2.42 |
| Payoff ratio | 0.883 | 0.898 |
| Median R | 0.182 | 0.222 |
| Std dev R | 0.775 | 0.782 |
| Max consecutive wins / losses | 7 / 5 | 10 / 5 |
| Avg / max holding time | 227.2 min / 570 min | same |
| Avg MAE / MFE (R) | 0.685 / 0.66 | 0.681 / 0.679 |
| 90th-pct MAE (R) | 1.235 | 1.237 |
| % trades reaching 1R before stopping | 22.84% | 25.41% |
| % months profitable | 58.06% (18/31) | 64.52% |
| % weeks profitable | 55.74% (68/122) | 60.66% |
| Exposure (time-in-market) | 7.19% | 7.19% |
| Total commission drag (R) | 8.58 | 0 |
| Ambiguous same-bar stop/target fills | 0.47% (2 trades) | 0.47% |
| Trades excluded as END_OF_DATA (real, not fabricated) | 51 | 51 |

**The realistic cost assumption removes ~57% of the raw edge** (expectancy 0.0697R → 0.0298R).
This is exactly the kind of gap DATA_AUDIT.md §5 flagged as missing from every existing engine —
now it's visible and quantified rather than silently absent. `fundedAccountBreachProbability` is
intentionally `null` — that requires Part 10's funded-account simulator, not yet built. This is
**insufficient evidence, not zero risk.**

## By strategy (base costs)

| | ICT | ORB | PREMARKET |
|---|---|---|---|
| Trades | 22 | 301 | 106 |
| Win rate | 22.73% | 55.48% | 61.32% |
| Expectancy | **-0.1093R** | +0.0482R | +0.0065R |
| Profit factor | 0.726 | 1.134 | 1.028 |
| Net R | -2.41 | +14.50 | +0.69 |
| Max DD (R) | 5.16 | 13.25 | 5.77 |
| Payoff ratio | 2.469 | 0.910 | 0.648 |
| % months profitable | 30% (3/10) | 61.29% (19/31) | 33.33% (3/9) |
| Excluded END_OF_DATA | 2 | 49 | 0 |

**ICT is net negative on the full real hourly history (n=22, -0.109R/trade).** This is consistent
with — and extends — what server.js's own comments already disclosed: the strategy's positive
track record (avgR 0.314–0.405) was measured on a thin n=7–11 sample; checked against the much
larger real history it goes negative, exactly as previously flagged. This baseline confirms that
finding on 2x the previously-checked sample, with real costs added. **ICT does not currently show a
validated edge and should not be presented as one.**

**ORB is the strongest single contributor** (n=301, the largest sample of the three, PF 1.134,
positive in 19 of 31 months) and is the main reason the combined baseline is net positive.

**PREMARKET is marginally positive** (n=106, +0.0065R/trade, barely above breakeven) after the
19:00 CT exit-timing correction above. Its win rate is high (61.32%) but payoff ratio is weak
(0.648 — average win is smaller than average loss), which is why the edge is thin despite winning
more often than it loses. Not the strong, clearly-validated edge the old `PREMARKET_TRACK_RECORD`
comment described, but a real, small, positive number under this baseline's honest assumptions —
worth investigating further in Phase 5 (different target multiples, tighter stops, or a genuinely
different hold-time rule may recover more of it), not something to overstate in either direction.

## By session (all three strategies combined, base costs)

| Session | Trades | Win rate | Expectancy | Net R | Profit factor |
|---|---|---|---|---|---|
| ny_open (08:30–10:00 CT) | 355 | 56.90% | +0.0420 | +14.91 | 1.124 |
| ny_am (10:00–12:00 CT) | 52 | 48.08% | -0.0509 | -2.65 | 0.850 |
| ny_midday (12:00–13:30 CT) | 10 | 60.00% | +0.0851 | +0.85 | 1.579 |
| ny_pm (13:30–15:00 CT) | 4 | 25.00% | -0.1624 | -0.65 | 0.227 |
| afterhours (15:00–19:00 CT) | 5 | 60.00% | +0.0734 | +0.37 | 1.334 |
| asia (19:00–01:00 CT) | 3 | 0.00% | -0.0182 | -0.06 | 0.000 |

**Only `ny_open` has a sample large enough (n=355) to draw any conclusion from** — its own edge
(+0.042R/trade) is close to the combined-strategy edge. Every other session has n<55 and several
have n<10 — **not enough evidence to conclude anything about Asia, London/NY-overlap, midday, PM,
or afterhours performance yet.** London itself produced zero qualifying trades in this baseline (no
strategy here is anchored to a pure London entry window) — a real, honest gap for Phase 5 to
address, not a hidden one.

## By calendar year

| Year | Trades | Win rate | Expectancy | Net R |
|---|---|---|---|---|
| 2024 | 85 | 62.35% | +0.2038 | +17.32 |
| 2025 | 147 | 48.98% | -0.0231 | -3.39 |
| 2026 (YTD, through Jul 31) | 197 | 56.85% | -0.0059 | -1.16 |

**Real performance decay over time, though less severe after the correction** — the entire
combined-baseline net-positive result still comes almost entirely from 2024; 2025 and 2026 are
both roughly flat-to-slightly-negative rather than 2025's earlier, more sharply negative reading.
This is disclosed, not smoothed over: whatever edge this frozen configuration had appears to be
decaying, which is exactly the kind of finding Part 9 requires future candidates to be judged
against (stability across periods), not just an aggregate number.

## By direction and day of week

| Direction | Trades | Win rate | Expectancy |
|---|---|---|---|
| LONG | 227 | 57.71% | -0.0050 |
| SHORT | 202 | 52.48% | +0.0688 |

| Day | Trades | Win rate | Expectancy |
|---|---|---|---|
| Mon | 5 | 20.00% | -0.3942 |
| Tue | 127 | 55.12% | -0.0157 |
| Wed | 118 | 53.39% | +0.0241 |
| Thu | 123 | 53.66% | -0.0202 |
| Fri | 56 | 66.07% | +0.2924 |

Monday's n=5 (only ICT trades — ORB already excludes Monday live, PREMARKET is Tue/Wed/Thu-only)
is far too small to act on despite the large negative number; Friday's apparent strength (n=56) is
worth investigating in Phase 5 but is not yet a large enough sample to be conclusive on its own.
LONG trades being roughly flat while SHORT trades are net positive is a real, disclosed asymmetry —
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
baseline** above (expectancy +0.0298R/trade, profit factor 1.090, max drawdown 15.07R over 429
trades) — not against zero-cost numbers, not against any single strategy's number in isolation
unless the candidate is itself scoped to that same session/strategy family. Per Part 9, a candidate
should show higher out-of-sample expectancy, comparable-or-better profit factor, lower drawdown, and
stability across the same year-by-year and session breakdowns shown above — a candidate that only
wins in 2024 the way this baseline does would not clear that bar.
