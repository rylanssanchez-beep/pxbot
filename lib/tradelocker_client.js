'use strict';

// Shared, read-only TradeLocker REST client for offline tooling (the Part 2
// downloader, integrity probes, future research scripts). Deliberately
// separate from server.js's handleAuth: server.js uses a curl subprocess to
// dodge Cloudflare TLS fingerprinting for the BROWSER-facing login flow, but
// backtest/fetch_deep.js already proved plain Node https works fine against
// the backend-api host for authenticated, non-interactive scripts — this
// module continues that same validated approach rather than introducing a
// second, untested code path. Never logs the password or the bearer token.

const https = require('https');

const TL_API_HOST = 'bsa.tradelocker.com';
const TL_API_BASE = '/backend-api';

function tlRequest(method, pathAndQuery, body, token, accNum) {
  return new Promise((resolve, reject) => {
    const raw = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (accNum !== undefined) headers.accNum = String(accNum || '');
    if (raw) headers['Content-Length'] = Buffer.byteLength(raw);
    const opts = { hostname: TL_API_HOST, port: 443, path: `${TL_API_BASE}${pathAndQuery}`, method, headers };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, json: null, raw: d.slice(0, 300) }); }
      });
    });
    req.on('error', e => reject(e));
    if (raw) req.write(raw);
    req.end();
  });
}

function parseBarDetails(json) {
  const bd = json?.d?.barDetails;
  if (!Array.isArray(bd)) return [];
  return bd.map(b => ({
    time: Math.floor(parseInt(b.t || 0, 10) / 1000), // TL bar timestamps are unix MILLISECONDS
    open: parseFloat(b.o || 0), high: parseFloat(b.h || 0), low: parseFloat(b.l || 0), close: parseFloat(b.c || 0),
    volume: b.v != null ? parseInt(b.v, 10) : null,
  })).filter(b => b.close > 0 && b.time > 0);
}

class TradeLockerClient {
  constructor({ email, password, server }) {
    this.email = email;
    this.password = password;
    this.server = server;
    this.token = null;
    this.accountId = null;
    this.accNum = null;
    this.instrumentId = null;
    this.symbol = null;
    this.infoRouteId = null;
    this.tradeRouteId = null;
  }

  async authenticate() {
    const r = await tlRequest('POST', '/auth/jwt/token', { email: this.email, password: this.password, server: this.server }, null);
    const token = r.json?.accessToken || r.json?.token || r.json?.access_token;
    if (!token) {
      // Never include the password in the thrown error, even though the caller supplied it —
      // r.json may echo back request fields on some error paths.
      const msg = r.json?.message || r.json?.error || 'unknown auth error';
      throw new Error(`TradeLocker auth failed: ${msg}`);
    }
    this.token = token;
    return true;
  }

  async resolveAccount() {
    const r = await tlRequest('GET', '/auth/jwt/all-accounts', null, this.token, '');
    const acct = r.json?.accounts?.[0];
    if (!acct) throw new Error('No TradeLocker accounts returned for this login.');
    this.accountId = acct.id;
    this.accNum = acct.accNum;
    this.balance = acct.accountBalance;
    return acct;
  }

  // NAS100-name matching mirrors server.js's handleAuth so both paths resolve
  // the same instrument for the same account.
  async resolveInstrument(nameHint = 'NAS') {
    const r = await tlRequest('GET', `/trade/accounts/${this.accountId}/instruments`, null, this.token, this.accNum);
    const raw = r.json?.d;
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.instruments) ? raw.instruments : []);
    const nq = list.find(i => (i.name || '').toUpperCase().includes(nameHint.toUpperCase())
      || (i.description || '').toLowerCase().includes('nasdaq'));
    if (!nq) throw new Error(`No instrument matching "${nameHint}" found in account instrument list (${list.length} instruments).`);
    this.instrumentId = nq.tradableInstrumentId;
    this.symbol = nq.name;
    this.description = nq.description;
    const infoRoute = (nq.routes || []).find(r2 => r2.type === 'INFO');
    const tradeRoute = (nq.routes || []).find(r2 => r2.type === 'TRADE');
    this.infoRouteId = infoRoute?.id || tradeRoute?.id;
    this.tradeRouteId = tradeRoute?.id || infoRoute?.id;
    return nq;
  }

  async connect(nameHint) {
    await this.authenticate();
    await this.resolveAccount();
    await this.resolveInstrument(nameHint);
    return {
      accountId: this.accountId, accNum: this.accNum, symbol: this.symbol,
      instrumentId: this.instrumentId, infoRouteId: this.infoRouteId, tradeRouteId: this.tradeRouteId,
    };
  }

  // fromSec/toSec: unix SECONDS (converted to the milliseconds TL's
  // /trade/history endpoint actually expects — verified empirically, see
  // DATA_AUDIT.md and scripts/probe_tl_history.js).
  async fetchHistory(resolution, fromSec, toSec) {
    const path = `/trade/history?tradableInstrumentId=${this.instrumentId}&routeId=${this.infoRouteId}&resolution=${resolution}&from=${fromSec * 1000}&to=${toSec * 1000}`;
    const r = await tlRequest('GET', path, null, this.token, this.accNum);
    return { status: r.status, bars: parseBarDetails(r.json), raw: r.json };
  }
}

module.exports = { TradeLockerClient, tlRequest, parseBarDetails, TL_API_HOST, TL_API_BASE };
