# PXBOT NQ Console — Data & Strategy Audit

**Date:** 2026-08-02
**Scope:** Part 1 of the PXBOT upgrade mission — audit only, no strategy changes made.
**Method:** Direct read of every server-side data/strategy file. All line numbers refer to the
commit that synced this branch to the uploaded project snapshot (`bc66acc`).

---

## 1. Live-data path

`server.js` is the only backend process. It authenticates to TradeLocker directly (no local
broker abstraction layer) and serves the browser UI (`index.html` + `app.js`) over a loopback
HTTP API on `127.0.0.1:8899`.

- **Auth:** `handleAuth` (server.js:272-350) → `POST {TL_API}/auth/jwt/token`, then
  `GET /auth/jwt/all-accounts` to resolve `accountId`/`accNum`, then
  `GET /trade/accounts/{accountId}/instruments` to resolve the tradable NAS100/NQ instrument
  and its `INFO`/`TRADE` route IDs. `TL_API = https://bsa.tradelocker.com/backend-api`
  (server.js:227).
- **Live quote:** `handleQuote` / `pollQuoteOnce` (server.js:502-524, 930-966) poll
  `GET /trade/quotes?tradableInstrumentId&routeId` every 500ms and also drive a tick→candle
  accumulator (`onQuoteTick`, server.js:1265-1286).
- **Live candles:** `handleCandles` (server.js:400-500) calls
  `GET /trade/history?tradableInstrumentId&routeId&resolution&from&to` with `from`/`to` in
  **unix milliseconds** — confirmed correct in code comments (server.js:416-420: an earlier
  seconds-based version silently returned no data because TL read the range as an instant near
  1970). This is the one correctly-functioning history call in the app.
- **Signal engine:** `handleSignal` (server.js:763-922) runs three deterministic, already-backtested
  strategies (ICT leg-filter, ORB, NY-premarket breakout) against live hourly + 1-minute bars and
  a live quote. This is genuinely evidence-based, not an LLM guessing — see §5.

## 2. Historical-data path (three separate, disconnected paths)

There is **no unified historical store**. Three different code paths produce three different,
never-reconciled datasets:

1. **`handleCandles`** (used for the live chart) — on each call it asks TL for only
   `max(14 days, count × resolution × 65 seconds)` of bars (server.js:406-409), then falls back
   to a **NDX-index proxy dataset** (`tv_context.json`, calibrated by a live price-offset guess)
   merged with **locally accumulated tick bars** if TL history comes back empty (server.js:444-481).
2. **`handleBacktest`** (server.js:1368-1386) — hardcoded to **35 days of 1-hour bars**, single
   request, no pagination, no persistence. The UI's "Run Sunday Refresh" backtest button
   (index.html:472, app.js:2158-2265) uses exactly this endpoint.
3. **`backtest/fetch_deep.js`** — a standalone CLI script (not wired into the server or UI) that
   *does* paginate backward in `chunkDays`-sized windows until 3 consecutive empty responses, then
   writes a flat `backtest/deep_{resolution}.json` file. This is the closest thing in the codebase
   to what Part 2 asks for, and it's the reason code comments elsewhere claim "200k+ bars over
   ~200 days" of real 1-minute history exists. But it: has no checkpoint/resume (a restart starts
   the pagination over from `now`), no dedup-across-runs, no retry/backoff, no rate-limit handling,
   no gap/quality report, and is never invoked automatically.

## 3. Every concrete restriction on full-history retrieval

| # | Restriction | Location | Effect |
|---|---|---|---|
| 1 | `handleBacktest` hardcodes `from = now - 35 days`, one non-paginated request | server.js:1375-1376 | The only backtest endpoint wired to the UI never sees more than 35 days, regardless of how much history TradeLocker actually has. |
| 2 | `handleCandles` lookback formula caps at `count × resolution(min) × 65 sec` | server.js:406-409 | A chart/API request for 1500 1-minute bars only reaches back ~25 hours; large `count` values are the only way to reach further back, and nothing in the UI requests more than ~19,000 bars. |
| 3 | NDX fallback target hardcoded to 20,000 5-minute bars (~6 months) | server.js:1053 (`NDX_TARGET_BARS`) | Caps the *fallback* proxy dataset at 6 months even though TradingView could supply more; also this is **NDX cash-index data, not TL's NAS100/NQ feed** — see §4. |
| 4 | Tick-accumulated bars capped at 2,000 per resolution | server.js:981 (`MAX_BARS_PER_RES`), enforced at 1281 | The only *guaranteed-authentic* fallback series (built tick-by-tick from real TL quotes while the app is running) self-truncates — e.g. at 1-minute resolution this is only ~33 hours before old bars are silently dropped. |
| 5 | `fetch_deep.js` is a detached script with no persistence, no resume, no server integration | backtest/fetch_deep.js (whole file) | Every run restarts pagination from "now"; an interrupted run loses all partial progress; results are never merged into what the live UI or the walk-forward scripts use by default. |
| 6 | No code anywhere empirically determines TradeLocker's actual max-bars-per-request | — | `fetch_deep.js`'s `chunkDays` values (13/65/800 days for 1m/5m/other, line 71) are **assumed**, based on a comment ("stay under 20k bars/request"), never verified by a controlled probe. Part 2 must verify this, not re-assume it. |
| 7 | Walk-forward/backtest research scripts (`backtest/walkforward.js`, `orb_walkforward.js`, etc.) pull live via `/api/candles?resolution=60&count=19000`, i.e. depend on runtime TL responses each run, not a stored, versioned dataset | backtest/walkforward.js:58-70 | Results are not reproducible from a fixed dataset — a rerun next week silently uses a different (shifted-forward) window with no record of what the prior run actually saw. |

**Bottom line:** the app today can obtain roughly 200 real days of 1-minute bars and roughly
2.3 years of hourly bars (per in-code comments referencing prior manual `fetch_deep.js` runs and
live walk-forward output), but only through a script that has to be run and merged by hand — the
live application itself never sees more than 35 days for backtesting and 6 months for its NDX
fallback chart.

## 4. Instrument/source identity risk (real, not hypothetical)

- `tv_context.json` (TradingView NASDAQ:NDX, a **cash index**, free/no-subscription symbol) is
  price-shifted by a **single scalar "basis" offset** (`ndxBasis`, calculated once from the first
  live TL tick vs. the last NDX close, server.js:1252-1263) and then spliced directly onto TL bars
  whenever TL's own history call returns nothing (server.js:444-481, `source: 'tl_calibrated'`).
  A constant offset does not account for NDX vs. NAS100-CFD vs. NQ-futures session-hours, rollover,
  or spread differences — this is exactly the "silent merge of different instruments" the mission
  brief warns against. It is labeled in the API response (`source` field) but nothing downstream
  (backtests, journal) currently checks or excludes that source before treating bars as real.
- `backtest/ict_engine.js`/`orb_engine.js` comments openly acknowledge testing against "the much
  larger 2.3-year **hourly-approximated** history" (server.js:562) as a *separate, weaker* check
  from the real 1-minute-execution test — this is good practice already followed by this codebase
  (the difference is disclosed, not hidden) and should be preserved as a pattern.

## 5. Current live strategy — exact logic (server.js:538-922)

Three independently-validated, deterministic strategies, all gated by day-of-week filters derived
from actual walk-forward results (not vibes):

1. **ICT leg-filter** (`backtest/ict_engine.js`) — classifies each day's Asia (19:00-01:00 CT) and
   London (01:00-07:00 CT) ranges into 4 scenarios (Asia-directional, London-sweep-continuation,
   London-reversal, or "avoid" when London sweeps both sides). Entry: OTE retracement zone
   (0.618-0.705 of the leg). Stop: leg extreme ± 5% buffer. Exit: managed breakeven ladder
   (TP1→breakeven, TP2→lock TP1, ride to TP3). Filter: `minLegSize=199pt`. Live config uses the
   **managed** exit; `ICT_TRACK_RECORD` (server.js:560-564) discloses TRAIN avgR 0.314 (n=11) /
   TEST avgR 0.405 (n=7) at real 1-minute execution, but **negative** avgR on the much larger
   2.3-year hourly-approximated set — openly flagged as a thin-sample caveat, not hidden.
2. **ORB** (`backtest/orb_engine.js`) — range = the 08:00-09:00 CT hourly bar, breakout of that
   range triggers entry, stop = opposite side of range ± 5% buffer, target = 1× range size, Monday
   excluded (walk-forward evidence: avgR -0.275, 28% win rate vs 60%+ Tue/Thu). Same-bar stop/target
   ambiguity is resolved conservatively (stop checked before target, orb_engine.js:82-85; ict
   engine likewise, ict_engine.js:161-165) — matches the mission's anti-lookahead requirement already.
3. **NY-premarket breakout** (`backtest/session_breakout_engine.js`) — range = 07:00-09:30 CT,
   breakout entry, Tue/Wed/Thu only. Documented as the most rigorously validated of the three
   (5/5 walk-forward folds profitable, confirmed at real 1-minute granularity over ~207 days,
   Monte Carlo P(net loss) ~3%).

**Gaps found relative to the mission's execution-realism requirements (Part 6/10):** none of
the three engines apply spread, commission, or slippage inside their R calculations by default —
`backtest/stress_test.js` adds slippage only as a post-hoc grid sweep, not as a first-class
parameter of the engines themselves. No entry-delay, partial-fill, or missed-limit-order modeling
exists anywhere. All fills are OHLC-touch based (a bar's high/low), which is standard for
bar-level backtesting but does not model spread at all — a real cost on every trade.

## 6. Lookahead / leakage / bias check

No lookahead bugs found in `ict_engine.js`, `orb_engine.js`, or `session_breakout_engine.js`:
range/session bars are strictly separated from forward-scan bars by session slicing
(`sliceSessions`/`sliceByDate`), trade simulation only scans bars *after* the entry index, and
same-bar stop/target ambiguity always checks the stop first (conservative, per mission
requirement — never assumes target-first). `backtest/walkforward.js` uses a proper **expanding**
train/test split (not randomly shuffled), matching Part 7's requirement. `backtest/montecarlo.js`
and `stress_test.js` already implement genuine bootstrap resampling and slippage/stop-buffer
sensitivity grids — better than a typical solo project.

**Real gaps found:**
- **Timezone handling** uses `toLocaleString('en-US', {timeZone:'America/Chicago'})` per bar
  (e.g. ict_engine.js:23-26) — correct for DST since it asks the JS runtime for the live
  Chicago-local conversion, but this is CPU-expensive per bar and only cached by *array identity*
  (`WeakMap`), not by timestamp — fine for backtests re-run on the same array, but not a general
  guarantee across differently-sliced datasets.
- **No commissions/spread/slippage inside the core engines** (see §5) — every R-multiple reported
  today is a frictionless-fill number; only the separate `stress_test.js` script shows what
  happens under adversity, and that script is not run as part of any standard pipeline.
- **No experiment registry** — parameter sweeps (`backtest/sweep.js`, `calibrate_weights.js`)
  write single result files that get overwritten on the next run; there is no historical record of
  what was tried, on what data hash, with what result (mission Part 7 requirement).
- **Confirmation/regime/structure/fractal/MTF engines** (`engine/*.js`) are wired in as
  **additive-only context** (server.js:602-619, explicitly documented as NOT gating trades yet,
  server.js:606-616) — correctly not overclaimed as a live filter, but also not yet statistically
  validated as one either. Worth preserving and eventually validating, not discarding.

## 7. UI metrics: real vs. approximated vs. absent

The current UI (`index.html`) has **no dashboard of backtest statistics** beyond a single text
panel (`#backtestTitle`/`#backtestBody`, index.html:471-472) driven by `runWeeklyBacktest()`
(app.js:2158-2265), which itself calls the 35-day-capped `/api/backtest` endpoint. There is no
equity curve, drawdown curve, Sharpe/Sortino/Calmar, R-distribution, or session-comparison view in
the UI today — so there is nothing currently on-screen that overclaims; the gap is that almost all
of Part 13's required Backtest Center / Data Center views simply don't exist yet and need to be
built, not corrected.

The live `/api/signal` responses (server.js:918) **do** include honest, hardcoded track-record
disclosures (`ICT_TRACK_RECORD`, `ORB_TRACK_RECORD`, `PREMARKET_TRACK_RECORD`) with real sample
sizes, real caveats, and explicit "not proven at scale" language (server.js:545-546) — this
existing practice should be the template for every new status/claim the upgraded system displays.

## 8. Modules confirmed genuinely useful — preserve as-is

- `engine/structure_engine.js`, `regime_engine.js`, `fractal_engine.js`, `mtf_engine.js`,
  `confirmation_engine.js`/`confirmations.js` — real, deterministic, already additive-only.
- `backtest/ict_engine.js`, `orb_engine.js`, `session_breakout_engine.js`,
  `session_reversion_engine.js`, `trend_pullback_engine.js`, `vwap_reversion_engine.js`,
  `liquidity_sweep_engine.js` — session-specific strategy modules already exist for several of the
  families the mission asks to research (Part 5). These are a head start, not a blank slate.
- `backtest/walkforward.js`, `montecarlo.js`, `stress_test.js`, `regression_test.js` — real
  methodology already in place; needs a persistent dataset under it, not a rewrite.
- `backtest/journal_review.js` — resolves live-logged signals to real outcomes automatically.
- TradeLocker auth/instrument-resolution logic in `server.js` (`handleAuth`) — correct and should
  not be touched; Part 2's downloader reuses it rather than re-implementing auth.

## 9. What Part 2 must fix, precisely

1. Replace the 35-day `handleBacktest` cap and the 6-month NDX fallback target with a real
   paginated downloader against `/trade/history` that keeps requesting older windows until TL
   returns empty (same signal `fetch_deep.js` already uses to detect the end of history) —
   for **every** required resolution (1m/5m/15m/30m/1H/4H/1D), not just one.
   **TL max bars/request is NOT yet empirically verified.** This sandboxed session has no live
   TradeLocker credentials or network path to `bsa.tradelocker.com`, so no real request has been
   made here — the `~20,000/request` and `chunkDays` figures in `fetch_deep.js` remain an
   *assumption* from code comments, not a measurement. The downloader built in Part 2 runs an
   explicit probe (a wide request compared against a request known to return few bars) on first
   connection and writes the measured per-resolution cap to `DATA_INTEGRITY_REPORT.json` — that
   file, once generated on a machine with real account access, is the authoritative source, not
   this document.
2. Persist results in a durable, queryable local store (not flat JSON) — see `data/` design in
   `IMPLEMENTATION_CHANGELOG.md`.
3. Add checkpoint/resume so an interrupted download continues instead of restarting.
4. Add a real data-integrity report (gap detection, duplicate detection, zero/malformed bar
   detection) instead of relying on log lines.
5. Keep TL-native bars and any fallback/proxy source (NDX) in clearly separate, labeled tables —
   never silently merged, matching what `handleCandles` already does today at the API-response
   level (the `source` field) but extending that discipline into permanent storage.
