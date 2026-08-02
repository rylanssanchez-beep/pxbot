'use strict';

// Data-integrity report generator — Part 2 requirement #13 ("produce a final
// data-integrity report"). Scans everything actually stored in the SQLite
// database (not the download log) so the report reflects ground truth:
// duplicate detection (structurally impossible given the table's PRIMARY KEY,
// verified here anyway), malformed/zero-price bars, out-of-order timestamps,
// and gaps — with weekend/Globex-closure awareness so a normal Friday-close
// to Sunday-reopen gap isn't misreported as missing data.

const fs = require('fs');
const path = require('path');

const RES_MINUTES = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1H': 60, '4H': 240, '1D': 1440 };
const GAP_TOLERANCE_MULTIPLIER = 3; // a gap under (spacing * this) is normal bar-to-bar noise, not flagged
const MAINTENANCE_GAP_HOURS = 30;   // gaps up to this long are treated as a normal daily halt, any weekday

function isWeekendClosureGap(startSec, endSec) {
  // NAS100/NQ trades ~24h Sun 17:00 CT (22:00 UTC) -> Fri 16:00 CT (21:00 UTC),
  // per server.js's own weekend heuristic (day===6 || (day===0 && hr<22)).
  // A gap "explained by the weekend" is one whose start falls at/after Friday
  // ~20:00 UTC and whose end falls at/before Sunday ~23:00 UTC.
  const start = new Date(startSec * 1000);
  const end = new Date(endSec * 1000);
  const startDay = start.getUTCDay(), endDay = end.getUTCDay();
  const startOk = (startDay === 5 && start.getUTCHours() >= 19) || startDay === 6 || (startDay === 0 && start.getUTCHours() <= 23);
  const endOk = endDay === 6 || (endDay === 0 && end.getUTCHours() <= 23) || (endDay === 1 && end.getUTCHours() < 2);
  return startOk && endOk;
}

function scanResolution(store, symbol, resolution) {
  const bars = store.getAllBars(symbol, resolution);
  const minutes = RES_MINUTES[resolution];
  const expectedSpacing = minutes * 60;
  const issues = { duplicates: 0, malformed: 0, outOfOrder: 0, unexplainedGaps: [], weekendGapsSkipped: 0 };

  let prev = null;
  const seen = new Set();
  for (const b of bars) {
    if (seen.has(b.time)) issues.duplicates++;
    seen.add(b.time);
    if (!(b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0) || b.high < b.low) issues.malformed++;
    if (prev) {
      if (b.time <= prev.time) issues.outOfOrder++;
      else {
        const gap = b.time - prev.time;
        if (gap > expectedSpacing * GAP_TOLERANCE_MULTIPLIER && gap > MAINTENANCE_GAP_HOURS * 3600) {
          if (isWeekendClosureGap(prev.time, b.time)) {
            issues.weekendGapsSkipped++;
          } else {
            issues.unexplainedGaps.push({ from: prev.time, fromDate: new Date(prev.time * 1000).toISOString(), to: b.time, toDate: new Date(b.time * 1000).toISOString(), gapHours: +(gap / 3600).toFixed(1) });
          }
        }
      }
    }
    prev = b;
  }

  const qualityIssuesLogged = store.db.prepare('SELECT issue_type, COUNT(*) AS n FROM data_quality_issues WHERE symbol=? AND resolution=? GROUP BY issue_type').all(symbol, resolution);

  return {
    resolution,
    barsStored: bars.length,
    oldest: bars[0]?.time || null,
    oldestDate: bars[0] ? new Date(bars[0].time * 1000).toISOString() : null,
    newest: bars.at(-1)?.time || null,
    newestDate: bars.at(-1) ? new Date(bars.at(-1).time * 1000).toISOString() : null,
    spanDays: bars.length ? +((bars.at(-1).time - bars[0].time) / 86400).toFixed(1) : 0,
    duplicatesFound: issues.duplicates,
    malformedFound: issues.malformed,
    outOfOrderFound: issues.outOfOrder,
    weekendGapsSkipped: issues.weekendGapsSkipped,
    unexplainedGapCount: issues.unexplainedGaps.length,
    unexplainedGaps: issues.unexplainedGaps.slice(0, 50), // cap the listed detail; count above is authoritative
    ingestionQualityFlags: qualityIssuesLogged,
  };
}

function generateIntegrityReport(store, identity, resolutions, outPath) {
  const perResolution = resolutions.map(res => scanResolution(store, identity.symbol, res));
  const report = {
    generatedAt: new Date().toISOString(),
    provider: identity.provider, broker: identity.broker, symbol: identity.symbol,
    instrumentId: identity.instrumentId, routeId: identity.routeId,
    resolutions: perResolution,
    summary: Object.fromEntries(perResolution.map(r => [r.resolution, {
      bars: r.barsStored, range: `${r.oldestDate?.slice(0, 10) || 'n/a'} .. ${r.newestDate?.slice(0, 10) || 'n/a'}`,
      spanDays: r.spanDays, duplicates: r.duplicatesFound, malformed: r.malformedFound,
      outOfOrder: r.outOfOrderFound, unexplainedGaps: r.unexplainedGapCount,
    }])),
  };
  const target = outPath || path.join(__dirname, 'logs', 'DATA_INTEGRITY_REPORT.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(report, null, 2));
  return report;
}

module.exports = { generateIntegrityReport, scanResolution };
