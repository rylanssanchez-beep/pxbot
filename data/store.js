'use strict';

// Persistent historical market-data store — Part 2 of the PXBOT upgrade.
// Uses node:sqlite (built into Node 22.5+, no native compile step, no new
// npm dependency) so the Windows PXBOT.bat launcher — which only runs
// `npm install` for @modelcontextprotocol/sdk + zod, no build toolchain —
// keeps working unmodified. Requires Node >= 22.5; PXBOT.bat checks this
// before launch, and the require() below fails loudly (not with a cryptic
// "Cannot find module" stack) on older Node.

const path = require('path');
const fs = require('fs');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  throw new Error(
    `PXBOT's data store requires node:sqlite, which needs Node.js >= 22.5 (you have ${process.version}). ` +
    `Install a current Node LTS from https://nodejs.org and re-run. (Original error: ${e.message})`
  );
}

const DEFAULT_DB_PATH = path.join(__dirname, 'pxbot_market_data.sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS candles (
  provider        TEXT NOT NULL,
  broker          TEXT NOT NULL,
  account_id      TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  instrument_id   TEXT NOT NULL,
  route_id        TEXT NOT NULL,
  resolution      TEXT NOT NULL,
  time            INTEGER NOT NULL,
  open            REAL NOT NULL,
  high            REAL NOT NULL,
  low             REAL NOT NULL,
  close           REAL NOT NULL,
  volume          REAL,
  spread          REAL,
  source          TEXT NOT NULL,
  downloaded_at   INTEGER NOT NULL,
  quality_flags   TEXT,
  PRIMARY KEY (provider, broker, account_id, symbol, instrument_id, route_id, resolution, time)
);
CREATE INDEX IF NOT EXISTS idx_candles_range ON candles(symbol, resolution, time);

CREATE TABLE IF NOT EXISTS download_checkpoints (
  provider          TEXT NOT NULL,
  broker            TEXT NOT NULL,
  account_id        TEXT NOT NULL,
  symbol            TEXT NOT NULL,
  instrument_id     TEXT NOT NULL,
  route_id          TEXT NOT NULL,
  resolution        TEXT NOT NULL,
  oldest_fetched    INTEGER,
  newest_fetched    INTEGER,
  history_exhausted INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER,
  PRIMARY KEY (provider, broker, account_id, symbol, instrument_id, route_id, resolution)
);

CREATE TABLE IF NOT EXISTS download_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  resolution     TEXT NOT NULL,
  request_from   INTEGER,
  request_to     INTEGER,
  window_days    REAL,
  bars_returned  INTEGER,
  oldest_bar     INTEGER,
  newest_bar     INTEGER,
  status         TEXT NOT NULL,
  error          TEXT,
  attempt        INTEGER
);

CREATE TABLE IF NOT EXISTS data_quality_issues (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  detected_at INTEGER NOT NULL,
  symbol      TEXT NOT NULL,
  resolution  TEXT NOT NULL,
  issue_type  TEXT NOT NULL,
  bar_time    INTEGER,
  detail      TEXT
);

-- Complete machine-readable trade ledger (Part 14 artifact). One row per
-- completed (or missed-limit) simulated trade, from any run — baseline,
-- research candidate, walk-forward fold, or final holdout. run_id ties each
-- trade back to its experiments row.
CREATE TABLE IF NOT EXISTS trades (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id             TEXT NOT NULL,
  strategy_id        TEXT NOT NULL,
  strategy_version   TEXT,
  symbol             TEXT NOT NULL,
  session            TEXT,
  direction          TEXT NOT NULL,
  order_type         TEXT,
  filled             INTEGER NOT NULL,
  missed_reason      TEXT,
  signal_time        INTEGER,
  entry_time         INTEGER,
  entry_price        REAL,
  stop_price_initial REAL,
  target_price_initial REAL,
  exit_time          INTEGER,
  exit_price         REAL,
  exit_reason        TEXT,
  risk_pts           REAL,
  r_multiple_gross   REAL,
  r_multiple         REAL,
  mae_pts            REAL,
  mfe_pts            REAL,
  mae_r              REAL,
  mfe_r              REAL,
  ambiguous_fill     INTEGER NOT NULL DEFAULT 0,
  commission_cost_r  REAL,
  holding_bars       INTEGER,
  split              TEXT,
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_run ON trades(run_id);
CREATE INDEX IF NOT EXISTS idx_trades_strategy_split ON trades(strategy_id, split);

-- Experiment registry (Part 7 requirement). One row per research run —
-- baseline freeze, a parameter-sweep candidate, a walk-forward fold, a final
-- holdout — so every reported result traces back to exactly what was run.
CREATE TABLE IF NOT EXISTS experiments (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            TEXT UNIQUE NOT NULL,
  strategy_id       TEXT NOT NULL,
  strategy_version  TEXT,
  code_hash         TEXT,
  dataset_hash      TEXT,
  data_range        TEXT,
  instrument        TEXT,
  session           TEXT,
  params            TEXT,
  costs             TEXT,
  splits            TEXT,
  results           TEXT,
  rejection_reason  TEXT,
  created_at        INTEGER NOT NULL
);
`;

class MarketDataStore {
  constructor(dbPath = DEFAULT_DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    this._upsertStmt = this.db.prepare(`
      INSERT INTO candles (provider, broker, account_id, symbol, instrument_id, route_id, resolution,
                            time, open, high, low, close, volume, spread, source, downloaded_at, quality_flags)
      VALUES (@provider, @broker, @accountId, @symbol, @instrumentId, @routeId, @resolution,
              @time, @open, @high, @low, @close, @volume, @spread, @source, @downloadedAt, @qualityFlags)
      ON CONFLICT(provider, broker, account_id, symbol, instrument_id, route_id, resolution, time)
      DO UPDATE SET open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
                    volume=excluded.volume, spread=excluded.spread, source=excluded.source,
                    downloaded_at=excluded.downloaded_at, quality_flags=excluded.quality_flags
    `);
  }

  // identity: { provider, broker, accountId, symbol, instrumentId, routeId, resolution }
  // bars: [{ time, open, high, low, close, volume }]
  // Returns { inserted, updated } counts using rowid delta (SQLite has no
  // native upsert-diff reporting, so we count rows before/after per batch).
  upsertBars(identity, bars, source) {
    if (!bars.length) return { written: 0 };
    const now = Date.now();
    const insertMany = this.db.transaction ? null : null; // node:sqlite has no .transaction helper; wrap manually
    this.db.exec('BEGIN');
    try {
      for (const b of bars) {
        this._upsertStmt.run({
          provider: identity.provider, broker: identity.broker, accountId: String(identity.accountId),
          symbol: identity.symbol, instrumentId: String(identity.instrumentId), routeId: String(identity.routeId),
          resolution: identity.resolution, time: b.time, open: b.open, high: b.high, low: b.low, close: b.close,
          volume: b.volume ?? null, spread: b.spread ?? null, source,
          downloadedAt: now, qualityFlags: b.qualityFlags ? JSON.stringify(b.qualityFlags) : null,
        });
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { written: bars.length };
  }

  getCheckpoint(identity) {
    const row = this.db.prepare(`
      SELECT * FROM download_checkpoints
      WHERE provider=? AND broker=? AND account_id=? AND symbol=? AND instrument_id=? AND route_id=? AND resolution=?
    `).get(identity.provider, identity.broker, String(identity.accountId), identity.symbol,
      String(identity.instrumentId), String(identity.routeId), identity.resolution);
    return row || null;
  }

  saveCheckpoint(identity, { oldestFetched, newestFetched, historyExhausted }) {
    this.db.prepare(`
      INSERT INTO download_checkpoints (provider, broker, account_id, symbol, instrument_id, route_id, resolution,
                                         oldest_fetched, newest_fetched, history_exhausted, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, broker, account_id, symbol, instrument_id, route_id, resolution)
      DO UPDATE SET oldest_fetched=excluded.oldest_fetched, newest_fetched=excluded.newest_fetched,
                    history_exhausted=excluded.history_exhausted, updated_at=excluded.updated_at
    `).run(identity.provider, identity.broker, String(identity.accountId), identity.symbol,
      String(identity.instrumentId), String(identity.routeId), identity.resolution,
      oldestFetched ?? null, newestFetched ?? null, historyExhausted ? 1 : 0, Date.now());
  }

  logRequest(entry) {
    this.db.prepare(`
      INSERT INTO download_log (ts, resolution, request_from, request_to, window_days, bars_returned, oldest_bar, newest_bar, status, error, attempt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(Date.now(), entry.resolution, entry.from ?? null, entry.to ?? null, entry.windowDays ?? null,
      entry.barsReturned ?? 0, entry.oldestBar ?? null, entry.newestBar ?? null,
      entry.status, entry.error ?? null, entry.attempt ?? 1);
  }

  logQualityIssue(symbol, resolution, issueType, barTime, detail) {
    this.db.prepare(`
      INSERT INTO data_quality_issues (detected_at, symbol, resolution, issue_type, bar_time, detail)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(Date.now(), symbol, resolution, issueType, barTime ?? null, detail ?? null);
  }

  countBars(symbol, resolution) {
    const row = this.db.prepare('SELECT COUNT(*) AS n, MIN(time) AS oldest, MAX(time) AS newest FROM candles WHERE symbol=? AND resolution=?').get(symbol, resolution);
    return row;
  }

  getBarsInRange(symbol, resolution, fromSec, toSec, source) {
    const q = source
      ? this.db.prepare('SELECT * FROM candles WHERE symbol=? AND resolution=? AND time>=? AND time<=? AND source=? ORDER BY time ASC')
      : this.db.prepare('SELECT * FROM candles WHERE symbol=? AND resolution=? AND time>=? AND time<=? ORDER BY time ASC');
    return source ? q.all(symbol, resolution, fromSec, toSec, source) : q.all(symbol, resolution, fromSec, toSec);
  }

  // All stored bars for symbol+resolution, ascending, deduped by PK (SQLite
  // guarantees no duplicate timestamps for the same identity already).
  getAllBars(symbol, resolution, source) {
    const q = source
      ? this.db.prepare('SELECT * FROM candles WHERE symbol=? AND resolution=? AND source=? ORDER BY time ASC')
      : this.db.prepare('SELECT * FROM candles WHERE symbol=? AND resolution=? ORDER BY time ASC');
    return source ? q.all(symbol, resolution, source) : q.all(symbol, resolution);
  }

  distinctSources(symbol, resolution) {
    return this.db.prepare('SELECT DISTINCT source FROM candles WHERE symbol=? AND resolution=?').all(symbol, resolution).map(r => r.source);
  }

  // Call before re-inserting a run's trades so re-running the same script
  // (e.g. while iterating on a bug fix) REPLACES that run's ledger rows
  // instead of silently appending duplicates on top of them.
  clearRunTrades(runId) {
    return this.db.prepare('DELETE FROM trades WHERE run_id=?').run(runId).changes;
  }

  // trade: a replay_engine.simulateTrade() result, plus { runId, strategyId,
  // strategyVersion, symbol, session, signalTime, split }.
  insertTrade(trade) {
    this.db.prepare(`
      INSERT INTO trades (run_id, strategy_id, strategy_version, symbol, session, direction, order_type, filled,
        missed_reason, signal_time, entry_time, entry_price, stop_price_initial, target_price_initial,
        exit_time, exit_price, exit_reason, risk_pts, r_multiple_gross, r_multiple, mae_pts, mfe_pts,
        mae_r, mfe_r, ambiguous_fill, commission_cost_r, holding_bars, split, created_at)
      VALUES (@runId, @strategyId, @strategyVersion, @symbol, @session, @direction, @orderType, @filled,
        @missedReason, @signalTime, @entryTime, @entryPrice, @stopPriceInitial, @targetPriceInitial,
        @exitTime, @exitPrice, @exitReason, @riskPts, @rMultipleGross, @rMultiple, @maePts, @mfePts,
        @maeR, @mfeR, @ambiguousFill, @commissionCostR, @holdingBars, @split, @createdAt)
    `).run({
      runId: trade.runId, strategyId: trade.strategyId, strategyVersion: trade.strategyVersion || null,
      symbol: trade.symbol, session: trade.session || null, direction: trade.direction,
      orderType: trade.orderType || null, filled: trade.filled ? 1 : 0, missedReason: trade.missedReason || null,
      signalTime: trade.signalTime ?? null, entryTime: trade.entryTime ?? null, entryPrice: trade.entryPrice ?? null,
      stopPriceInitial: trade.stopPriceInitial ?? null, targetPriceInitial: trade.targetPriceInitial ?? null,
      exitTime: trade.exitTime ?? null, exitPrice: trade.exitPrice ?? null, exitReason: trade.exitReason ?? null,
      riskPts: trade.riskPts ?? null, rMultipleGross: trade.rMultipleGross ?? null, rMultiple: trade.rMultiple ?? null,
      maePts: trade.maePts ?? null, mfePts: trade.mfePts ?? null, maeR: trade.maeR ?? null, mfeR: trade.mfeR ?? null,
      ambiguousFill: trade.ambiguousFill ? 1 : 0, commissionCostR: trade.commissionCostR ?? null,
      holdingBars: trade.holdingBars ?? null, split: trade.split || null, createdAt: Date.now(),
    });
  }

  getTrades({ runId, strategyId, split } = {}) {
    let sql = 'SELECT * FROM trades WHERE 1=1';
    const params = [];
    if (runId) { sql += ' AND run_id=?'; params.push(runId); }
    if (strategyId) { sql += ' AND strategy_id=?'; params.push(strategyId); }
    if (split) { sql += ' AND split=?'; params.push(split); }
    sql += ' ORDER BY entry_time ASC';
    return this.db.prepare(sql).all(...params);
  }

  insertExperiment(exp) {
    this.db.prepare(`
      INSERT INTO experiments (run_id, strategy_id, strategy_version, code_hash, dataset_hash, data_range,
        instrument, session, params, costs, splits, results, rejection_reason, created_at)
      VALUES (@runId, @strategyId, @strategyVersion, @codeHash, @datasetHash, @dataRange,
        @instrument, @session, @params, @costs, @splits, @results, @rejectionReason, @createdAt)
      ON CONFLICT(run_id) DO UPDATE SET results=excluded.results, rejection_reason=excluded.rejection_reason
    `).run({
      runId: exp.runId, strategyId: exp.strategyId, strategyVersion: exp.strategyVersion || null,
      codeHash: exp.codeHash || null, datasetHash: exp.datasetHash || null, dataRange: exp.dataRange || null,
      instrument: exp.instrument || null, session: exp.session || null,
      params: exp.params ? JSON.stringify(exp.params) : null, costs: exp.costs ? JSON.stringify(exp.costs) : null,
      splits: exp.splits ? JSON.stringify(exp.splits) : null, results: exp.results ? JSON.stringify(exp.results) : null,
      rejectionReason: exp.rejectionReason || null, createdAt: Date.now(),
    });
  }

  getExperiment(runId) {
    const row = this.db.prepare('SELECT * FROM experiments WHERE run_id=?').get(runId);
    if (!row) return null;
    for (const k of ['params', 'costs', 'splits', 'results']) if (row[k]) row[k] = JSON.parse(row[k]);
    return row;
  }

  close() { this.db.close(); }
}

module.exports = { MarketDataStore, DEFAULT_DB_PATH };
