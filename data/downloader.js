'use strict';

// Paginated TradeLocker history downloader — Part 2 of the PXBOT upgrade.
//
// Empirically measured behavior (scripts/probe_tl_history.js, run live
// against the connected account — see DATA_AUDIT.md §9): TradeLocker's
// /trade/history does NOT truncate an oversized window to some fixed max bar
// count — it returns an EMPTY result once the implied bar count in the
// requested window gets too large. That means a 200-response with zero bars
// is ambiguous: it could mean (a) the window was too wide and got rejected,
// (b) this is a genuine data gap (weekend/holiday), or (c) real history
// truly ends here. This downloader resolves that ambiguity by shrinking the
// window and retrying before ever concluding "end of history", and only
// commits to "history_exhausted" after several consecutive empty responses
// at the smallest (floor) window size.

const { MarketDataStore } = require('./store');
const { TradeLockerClient } = require('../lib/tradelocker_client');

// Default (safe) and floor window sizes per resolution, in days. Chosen with
// margin below the empirically observed request-failure boundary (1m: works
// at 30d/27,612 bars, fails at 60d; 5m: works at 120d/23,369 bars, fails at
// 240d; 15m: works at 400d/25,923 bars, untested beyond; 1H: works at
// 1600d/15,440 bars, fails at 3200d; 1D: works at 4000d/2,999 bars,
// untested beyond). 30m and 4H were NOT directly probed (time-boxed) — their
// defaults are interpolated from bar-density scaling between the measured
// neighbors and are intentionally conservative; the adaptive shrink logic
// below self-corrects even if these estimates are wrong.
const DEFAULT_WINDOW_DAYS = { '1m': 20, '5m': 90, '15m': 300, '30m': 600, '1H': 1400, '4H': 2500, '1D': 3650 };
const FLOOR_WINDOW_DAYS   = { '1m': 2,  '5m': 5,  '15m': 10,  '30m': 15,  '1H': 30,   '4H': 60,   '1D': 90 };
const MAX_EMPTY_STREAK_AT_FLOOR = 4; // consecutive empty floor-window requests before declaring history exhausted
const REQUEST_DELAY_MS = 350;        // politeness delay between requests
const MAX_RETRIES = 5;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function backoffMs(attempt) { return Math.min(30000, 1000 * Math.pow(2, attempt - 1)); }

async function requestWithRetry(client, resolution, fromSec, toSec, logger) {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const r = await client.fetchHistory(resolution, fromSec, toSec);
      if (r.status === 429) {
        logger?.(`  [rate-limit] 429 on ${resolution} attempt ${attempt} — backing off ${backoffMs(attempt)}ms`);
        if (attempt > MAX_RETRIES) return { bars: [], status: r.status, attempt, error: 'rate-limited, retries exhausted' };
        await sleep(backoffMs(attempt));
        continue;
      }
      if (r.status === 401) {
        logger?.(`  [auth] token expired mid-run — re-authenticating`);
        await client.authenticate();
        if (attempt > MAX_RETRIES) return { bars: [], status: r.status, attempt, error: 'auth retry exhausted' };
        continue;
      }
      if (r.status >= 500 || r.status === 0) {
        if (attempt > MAX_RETRIES) return { bars: [], status: r.status, attempt, error: `server/network error, retries exhausted (status ${r.status})` };
        logger?.(`  [retry] status=${r.status} on ${resolution} attempt ${attempt} — backing off ${backoffMs(attempt)}ms`);
        await sleep(backoffMs(attempt));
        continue;
      }
      return { bars: r.bars, status: r.status, attempt };
    } catch (e) {
      if (attempt > MAX_RETRIES) return { bars: [], status: 0, attempt, error: e.message };
      logger?.(`  [retry] network exception on ${resolution} attempt ${attempt}: ${e.message} — backing off ${backoffMs(attempt)}ms`);
      await sleep(backoffMs(attempt));
    }
  }
}

// Validates a batch of raw bars: drops zero/negative-price rows (parseTLBars
// already filters close<=0, this re-checks open/high/low too and internal
// OHLC consistency), flags out-of-order timestamps, returns { clean, flags }.
function validateBars(bars) {
  const clean = [];
  const flags = [];
  let prevTime = -Infinity;
  for (const b of bars) {
    const malformed = !(b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0)
      || b.high < b.low || b.high < b.open || b.high < b.close || b.low > b.open || b.low > b.close;
    if (malformed) { flags.push({ time: b.time, type: 'malformed_bar', detail: JSON.stringify(b) }); continue; }
    if (b.time <= prevTime) { flags.push({ time: b.time, type: 'out_of_order_or_duplicate_within_batch', detail: `prev=${prevTime}` }); continue; }
    prevTime = b.time;
    clean.push(b);
  }
  return { clean, flags };
}

async function downloadResolution(client, store, identity, resolution, opts = {}) {
  const log = opts.logger || console.log;
  const nowSec = Math.floor(Date.now() / 1000);
  const fullIdentity = { ...identity, resolution };
  const checkpoint = store.getCheckpoint(fullIdentity);

  let historyExhausted = checkpoint?.history_exhausted === 1;
  let oldestFetched = checkpoint?.oldest_fetched ?? null;
  let newestFetched = checkpoint?.newest_fetched ?? null;

  // 1) Top up forward: fill the gap between newestFetched and now, so
  //    resuming a stale checkpoint also catches up on recent bars.
  if (newestFetched && newestFetched < nowSec - 60) {
    log(`  [${resolution}] Top-up: ${new Date(newestFetched * 1000).toISOString()} -> now`);
    const topUp = await requestWithRetry(client, resolution, newestFetched + 1, nowSec, log);
    store.logRequest({ resolution, from: newestFetched + 1, to: nowSec, barsReturned: topUp.bars.length,
      oldestBar: topUp.bars[0]?.time, newestBar: topUp.bars.at(-1)?.time, status: topUp.error ? 'error' : 'ok', error: topUp.error, attempt: topUp.attempt });
    if (topUp.bars.length) {
      const { clean, flags } = validateBars(topUp.bars);
      store.upsertBars(fullIdentity, clean, 'tradelocker');
      for (const f of flags) store.logQualityIssue(identity.symbol, resolution, f.type, f.time, f.detail);
      newestFetched = Math.max(newestFetched, clean.at(-1)?.time || newestFetched);
      store.saveCheckpoint(fullIdentity, { oldestFetched, newestFetched, historyExhausted });
    }
    await sleep(REQUEST_DELAY_MS);
  }

  if (historyExhausted && !opts.force) {
    log(`  [${resolution}] History already marked exhausted (oldest=${oldestFetched ? new Date(oldestFetched * 1000).toISOString() : 'n/a'}). Pass --force to re-probe further back.`);
    return { skipped: true };
  }

  // 2) Paginate backward from oldestFetched (resume point) or now (fresh start).
  let cursor = oldestFetched ?? nowSec;
  let windowDays = DEFAULT_WINDOW_DAYS[resolution] || 90;
  const floorDays = FLOOR_WINDOW_DAYS[resolution] || 5;
  let consecutiveEmptyAtFloor = 0;
  let requestCount = 0;
  const maxRequests = opts.maxRequests || 5000;

  while (!historyExhausted && requestCount < maxRequests) {
    const to = cursor;
    const from = to - Math.round(windowDays * 86400);
    requestCount++;
    const result = await requestWithRetry(client, resolution, from, to, log);

    if (result.error) {
      store.logRequest({ resolution, from, to, windowDays, barsReturned: 0, status: 'error', error: result.error, attempt: result.attempt });
      log(`  [${resolution}] Request failed after retries: ${result.error} — stopping this resolution's run (resumable).`);
      break;
    }

    if (result.bars.length > 0) {
      const { clean, flags } = validateBars(result.bars);
      store.upsertBars(fullIdentity, clean, 'tradelocker');
      for (const f of flags) store.logQualityIssue(identity.symbol, resolution, f.type, f.time, f.detail);
      const oldestReturned = clean[0]?.time ?? result.bars[0].time;
      const newestReturned = clean.at(-1)?.time ?? result.bars.at(-1).time;
      oldestFetched = oldestFetched === null ? oldestReturned : Math.min(oldestFetched, oldestReturned);
      newestFetched = newestFetched === null ? newestReturned : Math.max(newestFetched, newestReturned);
      store.logRequest({ resolution, from, to, windowDays, barsReturned: result.bars.length, oldestBar: oldestReturned, newestBar: newestReturned, status: 'ok', attempt: result.attempt });
      store.saveCheckpoint(fullIdentity, { oldestFetched, newestFetched, historyExhausted: false });
      log(`  [${resolution}] window=${windowDays.toFixed(1)}d -> ${result.bars.length} bars [${new Date(oldestReturned * 1000).toISOString().slice(0, 10)} .. ${new Date(newestReturned * 1000).toISOString().slice(0, 10)}] (total stored: ${store.countBars(identity.symbol, resolution).n})`);
      cursor = oldestReturned - 1;
      windowDays = Math.min(DEFAULT_WINDOW_DAYS[resolution] || 90, windowDays * 2); // grow back toward default after success
      consecutiveEmptyAtFloor = 0;
    } else {
      store.logRequest({ resolution, from, to, windowDays, barsReturned: 0, status: 'empty', attempt: result.attempt });
      if (windowDays > floorDays) {
        windowDays = Math.max(floorDays, windowDays / 2);
        log(`  [${resolution}] Empty response for ${windowDays.toFixed(1)}*2d window — shrinking to ${windowDays.toFixed(1)}d and retrying same cursor (ambiguous: oversized window vs. real gap).`);
        continue;
      }
      consecutiveEmptyAtFloor++;
      log(`  [${resolution}] Empty response at floor window (${floorDays}d), streak=${consecutiveEmptyAtFloor}/${MAX_EMPTY_STREAK_AT_FLOOR}, cursor=${new Date(cursor * 1000).toISOString().slice(0, 10)}`);
      if (consecutiveEmptyAtFloor >= MAX_EMPTY_STREAK_AT_FLOOR) {
        historyExhausted = true;
        store.saveCheckpoint(fullIdentity, { oldestFetched, newestFetched, historyExhausted: true });
        log(`  [${resolution}] History exhausted — oldest available bar: ${oldestFetched ? new Date(oldestFetched * 1000).toISOString() : 'none found'}`);
        break;
      }
      cursor -= Math.round(floorDays * 86400); // step past the gap and keep trying further back
      windowDays = DEFAULT_WINDOW_DAYS[resolution] || 90; // reset window for the next probe
    }
    await sleep(REQUEST_DELAY_MS);
  }

  if (requestCount >= maxRequests) {
    log(`  [${resolution}] Hit maxRequests=${maxRequests} for this run — checkpoint saved, resumable next run.`);
  }

  return { oldestFetched, newestFetched, historyExhausted, requestCount };
}

async function downloadAll(client, store, identity, resolutions, opts = {}) {
  const summary = {};
  for (const res of resolutions) {
    summary[res] = await downloadResolution(client, store, identity, res, opts);
  }
  return summary;
}

module.exports = { downloadResolution, downloadAll, DEFAULT_WINDOW_DAYS, FLOOR_WINDOW_DAYS, validateBars };
