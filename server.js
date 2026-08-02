'use strict';

// PXBOT Operator Console — Node.js server + TradeLocker proxy
// Runs on http://127.0.0.1:8899
// Core proxy uses only Node built-ins; /mcp needs @modelcontextprotocol/sdk + zod (see package.json)

const http         = require('http');
const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const { execFile } = require('child_process');

const ROOT = __dirname;
const PORT = 8899;

const structureEngine = require('./engine/structure_engine');

// ── curl-based HTTP helper (bypasses Cloudflare TLS fingerprinting) ───────────
// Windows 10+ ships curl.exe built-in. curl uses Schannel (WinTLS) which
// Cloudflare treats as a legitimate client, unlike Node.js's OpenSSL fingerprint.
function curlRequest(method, url, body, token) {
  return new Promise((resolve) => {
    const args = [
      '-s',            // silent
      '-L',            // follow redirects
      '--max-redirs', '5',
      '-X', method,
      '-H', 'Content-Type: application/json',
      '-H', 'Accept: application/json',
      '-H', 'Accept-Language: en-US,en;q=0.9',
      '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      '-H', 'Origin: https://app.tradelocker.com',
      '-H', 'Referer: https://app.tradelocker.com/',
      '--max-time', '20',
      '--connect-timeout', '10',
    ];
    if (token) args.push('-H', `Authorization: Bearer ${token}`);
    if (body)  args.push('-d', JSON.stringify(body));
    args.push(url);

    execFile('curl', args, { timeout: 25000, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !stdout) {
        console.error('  [curl] error:', err.message);
        return resolve({ status: 0, json: { error: 'curl failed: ' + err.message + '. Ensure curl is installed (built into Windows 10+).' } });
      }
      try {
        const json = JSON.parse(stdout);
        resolve({ status: 200, json });
      } catch {
        // Try to extract HTTP status from curl output if JSON parse fails
        resolve({ status: 0, json: { _raw: stdout.slice(0, 400) } });
      }
    });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
};

// ── Shared session state ──────────────────────────────────────────────────────
const store = {
  token:        null,
  accountId:    null,
  accNum:       null,
  balance:      null,
  instrId:      null,
  instrName:    null,
  instrDesc:    null,
  allRoutes:    [],
  infoRouteId:  null,
  tradeRouteId: null,
  candleCache:  {},
  ndxBasis:     null, // NDX price minus TL live price — used to shift historical bars to TL scale
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

function send(res, code, obj, type) {
  cors(res);
  const ct = type || 'application/json; charset=utf-8';
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': ct, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function tlFetch(method, url, body, token, _hops) {
  if ((_hops || 0) > 5) return Promise.resolve({ status: 0, json: { error: 'Too many redirects' } });
  return new Promise((resolve) => {
    const u = new URL(url);
    const raw = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Origin': 'https://app.tradelocker.com',
        'Referer': 'https://app.tradelocker.com/',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(raw ? { 'Content-Length': Buffer.byteLength(raw) } : {}),
      },
    };
    const lib = u.protocol === 'https:' ? https : require('http');
    const req = lib.request(opts, res => {
      // Follow redirects
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const nextUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${u.protocol}//${u.host}${res.headers.location}`;
        console.log(`  [TL] Redirect ${res.statusCode} → ${nextUrl}`);
        // 303 always becomes GET; 307/308 keep original method
        const nextMethod = res.statusCode === 303 ? 'GET' : method;
        const nextBody   = nextMethod === 'GET' ? null : body;
        resolve(tlFetch(nextMethod, nextUrl, nextBody, token, (_hops || 0) + 1));
        return;
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, json: { _raw: d.slice(0, 400) } }); }
      });
    });
    req.on('error', e => resolve({ status: 0, json: { error: e.message } }));
    if (raw) req.write(raw);
    req.end();
  });
}

// ── TradeLocker symbols + endpoint templates ──────────────────────────────────
const TL_SYMBOLS = ['NQ1!', 'NQ', 'MNQM5', 'MNQH5', '@NQ#'];

const CANDLE_PATHS = [
  (s,r,f,t) => `/marketdata/history?symbol=${s}&resolution=${r}&from=${f}&to=${t}`,
  (s,r,f,t) => `/trade/history?symbol=${s}&resolution=${r}&from=${f}&to=${t}`,
  (s,r,f,t) => `/api/v1/history?symbol=${s}&resolution=${r}&from=${f}&to=${t}`,
  (s,r,f,t) => `/marketdata/bars?symbol=${s}&timeframe=${r}&from=${f}&to=${t}`,
  (s,r,f,t) => `/v1/history?symbol=${s}&resolution=${r}&from=${f}&to=${t}`,
];

const QUOTE_PATHS = [
  s => `/marketdata/quotes?symbols=${s}`,
  s => `/trade/quotes?symbol=${s}`,
  s => `/api/v1/quotes?symbol=${s}`,
  s => `/marketdata/snapshot?symbol=${s}`,
];

function normBars(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(b => ({
    time:   parseInt(b.time  || b.timestamp || b.t  || 0),
    open:   parseFloat(b.open  || b.o || 0),
    high:   parseFloat(b.high  || b.h || 0),
    low:    parseFloat(b.low   || b.l || 0),
    close:  parseFloat(b.close || b.c || 0),
    volume: parseInt(b.volume  || b.v || 0),
  })).filter(b => b.close > 0);
}

// ── Yahoo Finance fallback ────────────────────────────────────────────────────
function fetchYahoo(resolution) {
  return new Promise((resolve) => {
    const res = parseInt(resolution) || 5;
    // Map resolution (minutes) → Yahoo interval + range
    let interval, range;
    if (res === 1)                    { interval = '1m';  range = '7d'; }
    else if (res <= 5)                { interval = '5m';  range = '7d'; }
    else if (res <= 15)               { interval = '15m'; range = '7d'; }
    else if (res <= 30)               { interval = '30m'; range = '30d'; }
    else if (res <= 60)               { interval = '60m'; range = '30d'; }   // 60m not 60h!
    else if (res <= 240)              { interval = '1h';  range = '60d'; }
    else                              { interval = '1d';  range = '1y'; }
    const url  = `https://query1.finance.yahoo.com/v8/finance/chart/NQ%3DF?interval=${interval}&range=${range}&includePrePost=true`;
    const req  = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try {
          const result = JSON.parse(d)?.chart?.result?.[0];
          if (!result) return resolve(null);
          const ts = result.timestamp;
          const q  = result.indicators.quote[0];
          const bars = ts.map((t, i) => ({
            time: t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0,
          })).filter(b => b.close != null && b.close > 0);
          console.log(`  [Yahoo] ${bars.length} bars for NQ=F`);
          resolve(bars);
        } catch(e) { console.error('  [Yahoo] parse error:', e.message); resolve(null); }
      });
    });
    req.on('error', e => { console.error('  [Yahoo] request error:', e.message); resolve(null); });
  });
}

// ── TradeLocker API constants (discovered via live API inspection) ─────────────
// Real API base: https://bsa.tradelocker.com/backend-api
// Auth: POST /auth/jwt/token  {email, password, server}
// Accounts: GET /auth/jwt/all-accounts  → {accounts:[{id, accNum, accountBalance}]}
// Instruments: GET /trade/accounts/{accountId}/instruments  header: accNum
// Quotes: GET /trade/quotes?tradableInstrumentId={id}&routeId={infoRouteId}  header: accNum
// History: GET /trade/history?tradableInstrumentId={id}&routeId={infoRouteId}&resolution={1m|5m|15m|30m|1H|4H|1D}&from={unix}&to={unix}
// Resolution format: '1m','5m','15m','30m','1H','4H','1D','1W','1M'

const TL_API = 'https://bsa.tradelocker.com/backend-api';

// Resolve resolution number → TL format string
function tlResolution(r) {
  const n = parseInt(r) || 5;
  if (n < 60)  return `${n}m`;
  if (n < 1440) return `${Math.round(n/60)}H`;
  return '1D';
}

// TL fetch with accNum header
function tlApiFetch(method, path, body, token, accNum) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'accNum': String(accNum || ''),
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Origin': 'https://live.tradelocker.com',
    'Referer': 'https://live.tradelocker.com/',
  };
  return new Promise((resolve) => {
    const u    = new URL(`${TL_API}${path}`);
    const raw  = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search, method,
      headers: { ...headers, ...(raw ? { 'Content-Length': Buffer.byteLength(raw) } : {}) },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, json: { _raw: d.slice(0, 300) } }); }
      });
    });
    req.on('error', e => resolve({ status: 0, json: { error: e.message } }));
    if (raw) req.write(raw);
    req.end();
  });
}

// ── API routes ────────────────────────────────────────────────────────────────

async function handleAuth(req, res) {
  const data      = await readBody(req);
  const accServer = (data.accServer || '').trim();

  console.log(`  [TL] Auth → ${TL_API}/auth/jwt/token  broker: ${accServer}`);
  const r = await curlRequest('POST', `${TL_API}/auth/jwt/token`,
    { email: data.email, password: data.password, server: accServer }, null);

  const token = r.json?.accessToken || r.json?.token || r.json?.access_token;
  if (!token) {
    const errMsg = r.json?.message || r.json?.error || r.json?._raw || JSON.stringify(r.json || {});
    console.log(`  [TL] Auth FAILED — ${errMsg}`);
    return send(res, 401, { error: `Auth failed: ${errMsg}` });
  }

  store.token = token;

  // Fetch all accounts to get accNum and accountId
  const acctR = await tlApiFetch('GET', '/auth/jwt/all-accounts', null, token, '');
  if (acctR.json?.accounts?.length) {
    const acct = acctR.json.accounts[0];
    store.accountId = acct.id;
    store.accNum    = acct.accNum;
    store.balance   = acct.accountBalance;
    console.log(`  [TL] Auth OK ✓  accountId:${store.accountId}  accNum:${store.accNum}  balance:$${store.balance}`);
  }

  // Find NQ/NAS100 instrument — broad multi-name search for any broker naming convention
  if (store.accountId) {
    const instrR = await tlApiFetch('GET', `/trade/accounts/${store.accountId}/instruments`, null, token, store.accNum);
    // TL may return d.instruments (object) or d as array
    const raw = instrR.json?.d;
    const instrList = Array.isArray(raw)
      ? raw
      : (Array.isArray(raw?.instruments) ? raw.instruments : []);
    console.log(`  [TL] ${instrList.length} instruments available: ${instrList.slice(0,20).map(i=>`${i.name||'?'}/${(i.description||'').slice(0,20)}`).join(' | ')}`);

    const NQ_NAMES = ['NAS100','NASDAQ','NQ100','US100','USTECH','NDX','NQ','NASDAQ100','NAS','USNAS','US30','NQ1'];
    const NQ_DESCS = ['nasdaq','nas100','nq','us tech','us100','ndx','tech 100','us nasdaq'];

    const nq = instrList.find(i => {
      const name = (i.name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const desc = (i.description || '').toLowerCase();
      return NQ_NAMES.some(n => name.includes(n)) || NQ_DESCS.some(d => desc.includes(d));
    }) || instrList.find(i => {
      // Last resort: futures-type instrument with high price (NQ trades ~18000-22000)
      return (i.type || '').toLowerCase().includes('future') || (i.category || '').toLowerCase().includes('future');
    }) || instrList[0]; // absolute fallback — use first instrument and log warning

    if (nq) {
      store.instrId   = nq.tradableInstrumentId;
      store.instrName = nq.name;
      store.instrDesc = nq.description;
      store.allRoutes = nq.routes || [];
      const infoRoute  = (nq.routes || []).find(r => r.type === 'INFO');
      const tradeRoute = (nq.routes || []).find(r => r.type === 'TRADE');
      store.infoRouteId  = infoRoute?.id  || tradeRoute?.id;
      store.tradeRouteId = tradeRoute?.id || infoRoute?.id;
      console.log(`  [TL] NQ matched: "${nq.name}" / "${nq.description}"  instrId:${store.instrId}  routes:${JSON.stringify(nq.routes)}`);
    } else {
      console.warn(`  [TL] WARNING: No instruments found — instruments endpoint returned empty`);
    }
  }

  // Start quote stream immediately after auth — don't wait for SSE client
  startQuoteStream();
  // Persist token so next server start auto-reconnects without UI login
  saveSession();

  send(res, 200, {
    accessToken:  token,
    accountId:    store.accountId,
    accNum:       store.accNum,
    balance:      store.balance,
    instrId:      store.instrId,
    infoRouteId:  store.infoRouteId,
    _resolvedServer: TL_API,
  });
}

async function handleAccounts(req, res) {
  if (!store.token) return send(res, 401, { error: 'Not authenticated' });
  const r = await tlApiFetch('GET', '/auth/jwt/all-accounts', null, store.token, '');
  send(res, r.status === 200 ? 200 : r.status, r.json);
}

// Parse TradeLocker /trade/history response → bar array
// Per the documented API (public-api.tradelocker.com/reference/gethistory), the
// real shape is {s:"ok", d:{barDetails:[{t,o,h,l,c,v}, ...]}} with t in unix MS.
function parseTLBars(json) {
  const d = json?.d;
  if (!d) return [];
  // Documented format: array of bar objects under d.barDetails
  if (Array.isArray(d.barDetails) && d.barDetails.length > 0) {
    return d.barDetails.map(b => ({
      time:   Math.floor(parseInt(b.t || 0) / 1000), // ms -> seconds, matches the rest of this app
      open:   parseFloat(b.o || 0),
      high:   parseFloat(b.h || 0),
      low:    parseFloat(b.l || 0),
      close:  parseFloat(b.c || 0),
      volume: parseInt(b.v || 0),
    })).filter(b => b.close > 0 && b.time > 0);
  }
  // Column format (seen on some older/other TL deployments)
  if (d.t && Array.isArray(d.t) && d.t.length > 0) {
    return d.t.map((t, i) => ({
      time:   parseInt(t),
      open:   parseFloat(d.o?.[i] || 0),
      high:   parseFloat(d.h?.[i] || 0),
      low:    parseFloat(d.l?.[i] || 0),
      close:  parseFloat(d.c?.[i] || 0),
      volume: parseInt(d.v?.[i]   || 0),
    })).filter(b => b.close > 0 && b.time > 0);
  }
  // Row format fallback (some endpoints return array of objects)
  if (Array.isArray(d)) {
    return d.map(b => ({
      time:   parseInt(b.t || b.time || 0),
      open:   parseFloat(b.o || b.open  || 0),
      high:   parseFloat(b.h || b.high  || 0),
      low:    parseFloat(b.l || b.low   || 0),
      close:  parseFloat(b.c || b.close || 0),
      volume: parseInt(b.v   || b.volume || 0),
    })).filter(b => b.close > 0 && b.time > 0);
  }
  return [];
}

async function handleCandles(req, res) {
  cors(res);
  const u          = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const resolution = u.searchParams.get('resolution') || '5';
  const count      = parseInt(u.searchParams.get('count') || '300');
  const now        = Math.floor(Date.now() / 1000);
  // Go back at least 14 days to always capture the last full trading week
  const minLookback = 14 * 24 * 3600;
  const calcLookback = count * parseInt(resolution) * 65;
  const fromSecs   = now - Math.max(minLookback, calcLookback);

  const tlRes = tlResolution(resolution);

  if (!store.token || !store.instrId || !store.infoRouteId) {
    return send(res, 503, { bars: [], source: 'none', error: 'Not connected to TradeLocker. Connect first.' });
  }
  // Per the documented API (public-api.tradelocker.com/reference/gethistory):
  // GET /trade/history?tradableInstrumentId&routeId&resolution&from&to
  // from/to MUST be unix milliseconds (the earlier seconds-based calls were the
  // reason this always fell back to the NDX-calibrated path — TL was reading
  // the range as an instant near 1970 and reporting no/invalid data).
  const fromMs = fromSecs * 1000;
  const nowMs  = now * 1000;
  const attempts = [
    `/trade/history?tradableInstrumentId=${store.instrId}&routeId=${store.infoRouteId}&resolution=${tlRes}&from=${fromMs}&to=${nowMs}`,
    // Fallback: some instruments only expose history on the TRADE route
    store.tradeRouteId !== store.infoRouteId
      ? `/trade/history?tradableInstrumentId=${store.instrId}&routeId=${store.tradeRouteId}&resolution=${tlRes}&from=${fromMs}&to=${nowMs}`
      : null,
  ].filter(Boolean);

  for (const attempt of attempts) {
    console.log(`  [TL] Trying: ${attempt.split('?')[0]} res=${tlRes}`);
    const r = await tlApiFetch('GET', attempt, null, store.token, store.accNum);
    console.log(`  [TL] → s=${r.json?.s} status=${r.status} errmsg=${r.json?.errmsg||''} dKeys=${Object.keys(r.json?.d||{}).join(',')}`);
    const bars = parseTLBars(r.json);
    if (bars.length > 0) {
      console.log(`  [TL] ✓ ${bars.length} bars from: ${attempt.split('?')[0]}`);
      store.candleCache[resolution] = bars;
      return send(res, 200, { bars, source: 'tradelocker', symbol: 'NAS100', resolution: tlRes });
    }
    if (r.status === 429) { console.warn('  [TL] Rate limited on this variant — waiting 1s'); await new Promise(r=>setTimeout(r,1000)); }
  }

  // TL history returned no bars — build seamless chart from NDX historical + live tick bars
  const tickKey = String(parseInt(resolution));
  const tickAccumulated = (tickBars[tickKey] || []).filter(b => b.time >= fromSecs);

  // Load basis-calibrated NDX historical bars from tv_context.json
  let ndxHistorical = [];
  if (fs.existsSync(TV_CONTEXT_FILE)) {
    try {
      const ctx = JSON.parse(fs.readFileSync(TV_CONTEXT_FILE, 'utf8'));
      const resKey = String(parseInt(resolution));
      const rawBars = ctx[resKey] || [];
      const basis = store.ndxBasis !== null ? store.ndxBasis : 150; // default ~150pt NDX-TL offset
      ndxHistorical = rawBars
        .filter(b => b.time >= fromSecs)
        .map(b => ({
          time:   b.time,
          open:   +(b.open  - basis).toFixed(2),
          high:   +(b.high  - basis).toFixed(2),
          low:    +(b.low   - basis).toFixed(2),
          close:  +(b.close - basis).toFixed(2),
          volume: b.volume || 0,
        }));
      console.log(`  [NDX→TL] ${rawBars.length} raw → ${ndxHistorical.length} filtered, basis=${basis}pts`);
    } catch(e) { console.warn('  [NDX] Failed to load tv_context.json:', e.message); }
  }

  // Merge: NDX historical up to first tick bar, then tick bars onward (tick bars are already TL-priced)
  const tickStart = tickAccumulated[0]?.time || Infinity;
  const ndxBeforeTick = ndxHistorical.filter(b => b.time < tickStart);
  const merged = [...ndxBeforeTick, ...tickAccumulated].sort((a, b) => a.time - b.time);

  if (merged.length > 0) {
    console.log(`  [Merged] ✓ ${merged.length} bars (${ndxBeforeTick.length} NDX historical + ${tickAccumulated.length} live tick bars)`);
    return send(res, 200, {
      bars: merged, source: 'tl_calibrated', symbol: 'NAS100', resolution: tlRes,
      basis: store.ndxBasis, note: 'NDX history calibrated to TL NAS100 price scale via live basis offset',
    });
  }

  // Try cache before giving up
  const cached = store.candleCache[resolution];
  if (cached && cached.length > 0) {
    console.log(`  [TL] Using ${cached.length} cached bars for ${tlRes}`);
    return send(res, 200, { bars: cached, source: 'cache', symbol: 'NAS100', resolution: tlRes });
  }

  // No bars available yet
  const tickCount = tickBars[tickKey]?.length || 0;
  const isWeekend = (() => { const d=new Date(), day=d.getUTCDay(), hr=d.getUTCHours(); return day===6||(day===0&&hr<22); })();
  console.warn(`  [TL] No bars — tickBars[${tickKey}]=${tickCount} bars accumulated so far`);
  send(res, 200, {
    bars: [], source: 'tradelocker',
    error: isWeekend ? 'NQ market closed — Globex reopens Sun 10PM UTC / 5PM ET.' : `Live data accumulating — ${tickCount} bars so far. TL history returned no_data.`,
    marketClosed: isWeekend,
    tickBarsAccumulated: tickCount,
  });
}

async function handleQuote(req, res) {
  // Use live TL quotes if authenticated
  if (store.token && store.instrId && store.infoRouteId) {
    const r = await tlApiFetch('GET',
      `/trade/quotes?tradableInstrumentId=${store.instrId}&routeId=${store.infoRouteId}`,
      null, store.token, store.accNum);
    if (r.json?.s === 'ok' && r.json?.d) {
      const q    = r.json.d;
      const bid  = parseFloat(q.bp || 0);
      const ask  = parseFloat(q.ap || 0);
      const last = parseFloat(q.lp || q.tp || 0) || (bid + ask) / 2;
      if (last > 0) onQuoteTick(last);
      return send(res, 200, { last, bid, ask, symbol: 'NAS100', source: 'tradelocker', time: Math.floor(Date.now()/1000) });
    }
  }
  // Fallback: candle cache
  const bars = store.candleCache['1'] || store.candleCache['5'];
  if (bars && bars.length) {
    const last = bars[bars.length - 1].close;
    return send(res, 200, { last, bid: last - 0.5, ask: last + 0.5, symbol: 'NQ=F', source: 'cache' });
  }
  send(res, 200, { last: 0, error: 'no quote available' });
}

async function handlePositions(req, res) {
  if (!store.token) return send(res, 401, { error: 'Not authenticated' });
  // Positions require accNum header
  const r = await tlApiFetch('GET', '/trade/positions', null, store.token, store.accNum);
  send(res, r.status === 200 ? 200 : 200, r.json?.d || r.json || []);
}

function handleHealth(req, res) {
  send(res, 200, { ok: true, authenticated: !!store.token, server: TL_API,
    instrId: store.instrId, accNum: store.accNum, port: PORT });
}

// ── Validated signal engine — replaces Ollama as the decision-maker ───────────
// Same two approaches actually backtested (backtest/ict_engine.js,
// backtest/orb_engine.js), same configs backtest/signal_now.js verified live:
//   ICT leg-filter: leg>=199pt (the one filter that held up out-of-sample)
//   ORB: rangeHour=9/target=0.5x, folds 1+2 only (both profitable, n=137,
//        +0.110R/trade combined) — fold 4 picked this shape too and went
//        slightly negative; excluded here by explicit instruction.
// Neither is proven at scale — every response says so plainly so the UI
// can never present this as more certain than the real backtest evidence.
const ictEngine = require('./backtest/ict_engine');
const orbEngine = require('./backtest/orb_engine');

const SIGNAL_ICT_MIN_LEG  = 199;
const SIGNAL_ORB_CONFIG   = { ...orbEngine.DEFAULT_ORB, rangeHour: 9, targetMultiple: 0.5, slBufferPct: 0.05, minRangeSize: 100 };
const ICT_TRACK_RECORD = 'leg>=199pt filter: +0.349R avg train (n=18), +0.405R avg OOS (n=7) — thin sample, not proven.';
const ORB_TRACK_RECORD = 'rangeHour=9/target=0.5x, folds 1+2 only (both profitable): +0.110R/trade combined (n=137). '
  + 'Fold 4 picked this same shape and went slightly negative (-0.025R, n=80) — excluded here by request, not silently.';

// ── Confirmation Engine — ADDITIVE ONLY ────────────────────────────────────
// Fractal/MTF/regime/confluence context (engine/*.js) attached alongside
// ict/orb, never altering them. Explicitly NOT gating any trade yet: a live
// walk-forward check on this account's real history (Aug 2026) found ICT's
// leg>=199pt filter is currently NOT showing a validated edge (-0.068R avg,
// 1/5 walk-forward folds profitable — the documented +0.405R OOS above was a
// thin n=7 sample that hasn't held up), and ORB's edge, while real, is
// thinner than originally documented (+0.068R avg live vs the +0.110R this
// config was tuned on). The confirmation tiers DID track real expectancy
// monotonically on that same live run (skip 0.004R -> B 0.066R -> A 0.111R
// -> A+ 0.144R) but per-fold sample sizes (as low as n=8) are still too thin
// to trust as a live gate. So: surfaced for visibility now, gating is a
// later, separate decision once more live confirmation-vs-outcome data
// accumulates (see backtest/journal_review.js's planned factor-correlation
// analysis).
const fractalEngine = require('./engine/fractal_engine');
const mtfEngine = require('./engine/mtf_engine');
const confirmationEngine = require('./engine/confirmation_engine');

function loadConfirmationWeights() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'engine', 'confirmation_weights.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.weights || confirmationEngine.DEFAULT_WEIGHTS;
  } catch (_) {
    return confirmationEngine.DEFAULT_WEIGHTS;
  }
}

// Same hourly->daily/4H aggregation approach validated in
// backtest/confirmation_backtest.js — kept here rather than shared since one
// is a live-request helper and the other an offline-backtest helper with
// different bar-count/perf tradeoffs, but the algorithm is identical.
function hourlyToDaily(bars) {
  const byDate = new Map();
  for (const b of bars) {
    const key = signalCtParts(b.time).dateKey;
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(b);
  }
  const out = [];
  for (const chunk of byDate.values()) {
    out.push({ time: chunk[0].time, open: chunk[0].open, close: chunk[chunk.length - 1].close,
      high: Math.max(...chunk.map(b => b.high)), low: Math.min(...chunk.map(b => b.low)),
      volume: chunk.reduce((a, b) => a + (b.volume || 0), 0) });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}
function hourlyToH4(bars) {
  const out = [];
  for (let i = 0; i < bars.length; i += 4) {
    const chunk = bars.slice(i, i + 4);
    if (!chunk.length) continue;
    out.push({ time: chunk[0].time, open: chunk[0].open, close: chunk[chunk.length - 1].close,
      high: Math.max(...chunk.map(b => b.high)), low: Math.min(...chunk.map(b => b.low)),
      volume: chunk.reduce((a, b) => a + (b.volume || 0), 0) });
  }
  return out;
}

// Computes the confirmation report for whichever of ict/orb actually fired.
// Wrapped by the caller in try/catch — a failure here must never break the
// ict/orb response those fields already depend on.
async function computeSignalConfirmation(ict, orb, quote, hourlyBars) {
  const ictFired = ict && ict.bias !== 'WAIT';
  const orbFired = orb && orb.bias !== 'WAIT';
  if (!ictFired && !orbFired) return null;

  // Same priority ICT-over-ORB the UI already uses (app.js:runAISignal).
  const bias = ictFired ? ict.bias : orb.bias;
  const entryZone = ictFired
    ? { low: ict.levels.oteLow, high: ict.levels.oteHigh }
    : (() => { const size = orb.rangeBar.high - orb.rangeBar.low; return { low: Math.min(orb.entry, orb.entry - size * 0.1), high: Math.max(orb.entry, orb.entry + size * 0.1) }; })();

  // m1 is the TRUE execution timeframe — this account enters/exits on the
  // 1-minute chart, not hourly. Hourly bars stay in barsByTF as "key levels"
  // MTF context (matching the directive's Monthly/Weekly/Daily/4H/1H/15M/5M/
  // Execution list) but no longer stand in for the execution timeframe.
  const [m1data, m5, m15, h4data, d1data] = await Promise.all([
    loopbackGet('/api/candles?resolution=1&count=1000'),
    loopbackGet('/api/candles?resolution=5&count=300'),
    loopbackGet('/api/candles?resolution=15&count=300'),
    loopbackGet('/api/candles?resolution=240&count=500'),
    loopbackGet('/api/candles?resolution=1440&count=250'),
  ]);
  const daily = (d1data.bars && d1data.bars.length) ? d1data.bars : hourlyToDaily(hourlyBars);
  const h4 = (h4data.bars && h4data.bars.length) ? h4data.bars : hourlyToH4(hourlyBars);
  // m1 falls back to the hourly series (still better than nothing) only if
  // the 1-minute feed genuinely returned nothing — this account's feed has
  // real 1m depth (verified: 200k+ bars over ~200 days via fetch_deep.js),
  // so this fallback should not normally trigger live.
  const executionBars = (m1data.bars && m1data.bars.length >= 60) ? m1data.bars.slice(-1000) : hourlyBars.slice(-200);
  const barsByTF = {
    m1: executionBars, m5: m5.bars || [], m15: m15.bars || [], h1: hourlyBars.slice(-200), h4, d1: daily,
    weekly: fractalEngine.aggregateToTimeframe(daily, 'week'),
    monthly: fractalEngine.aggregateToTimeframe(daily, 'month'),
  };

  const weights = loadConfirmationWeights();
  const report = confirmationEngine.computeConfirmation({
    bias, quote, entryZone, executionBars, barsByTF,
    ictResult: ictFired ? { bias: ict.bias } : null,
    orbResult: orbFired ? { bias: orb.bias } : null,
  }, weights);

  return { ...report, note: 'Context only — does NOT gate ict/orb above. See server.js comment above computeSignalConfirmation for why gating is deferred.' };
}

function signalCtParts(unixSecs) {
  const d = new Date(new Date(unixSecs * 1000).toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  return { hour: d.getHours() + d.getMinutes() / 60, dateKey: d.toISOString().slice(0, 10) };
}

async function handleSignal(req, res) {
  cors(res);
  if (!store.token || !store.instrId || !store.infoRouteId) {
    return send(res, 503, { error: 'Not connected to TradeLocker.' });
  }
  try {
    const [h1, quote] = await Promise.all([
      loopbackGet('/api/candles?resolution=60&count=19000'),
      loopbackGet('/api/quote'),
    ]);
    if (!h1.bars || !h1.bars.length) return send(res, 200, { ict: null, orb: null, error: 'No candle data yet.' });

    const bars = h1.bars;
    const now  = bars[bars.length - 1];
    const { hour, dateKey } = signalCtParts(now.time);

    // --- ICT leg-filter ---
    const asiaBars = [], londonBars = [];
    for (const b of bars.slice(-200)) {
      const p = signalCtParts(b.time);
      if (p.dateKey === dateKey || (p.hour >= 19 && p.dateKey < dateKey)) {
        if (p.hour >= 19 || p.hour < 1) asiaBars.push(b);
        else if (p.hour >= 1 && p.hour < 7) londonBars.push(b);
      }
    }
    let ict = null;
    if (asiaBars.length && londonBars.length) {
      const th = { ...ictEngine.DEFAULT_THRESHOLDS, minLegSize: SIGNAL_ICT_MIN_LEG };
      const cls = ictEngine.classifyDay(asiaBars, londonBars, th);
      if (cls.id !== 0 && cls.id !== 4) {
        const levels = ictEngine.legLevels(cls.bias, cls.legLow, cls.legHigh, th);
        ict = { scenario: cls.id, bias: cls.bias, reason: cls.reason, levels, trackRecord: ICT_TRACK_RECORD };
      } else {
        ict = { scenario: cls.id, bias: 'WAIT', reason: cls.reason, trackRecord: ICT_TRACK_RECORD };
      }
    }

    // --- ORB ---
    let orb = null;
    const rangeBar = bars.slice(-30).find(b => { const p = signalCtParts(b.time); return p.dateKey === dateKey && Math.floor(p.hour) === SIGNAL_ORB_CONFIG.rangeHour; });
    if (rangeBar) {
      const size = rangeBar.high - rangeBar.low;
      if (hour <= SIGNAL_ORB_CONFIG.rangeHour + 1) {
        orb = { bias: 'WAIT', reason: 'still inside the range hour', rangeBar, trackRecord: ORB_TRACK_RECORD };
      } else if (size < SIGNAL_ORB_CONFIG.minRangeSize) {
        orb = { bias: 'WAIT', reason: `range too small (< ${SIGNAL_ORB_CONFIG.minRangeSize}pt floor)`, rangeBar, trackRecord: ORB_TRACK_RECORD };
      } else if (quote.last > rangeBar.high) {
        const sl = rangeBar.low - size * SIGNAL_ORB_CONFIG.slBufferPct;
        const target = quote.last + size * SIGNAL_ORB_CONFIG.targetMultiple;
        orb = { bias: 'BUY', entry: quote.last, sl, target, rangeBar, trackRecord: ORB_TRACK_RECORD };
      } else if (quote.last < rangeBar.low) {
        const sl = rangeBar.high + size * SIGNAL_ORB_CONFIG.slBufferPct;
        const target = quote.last - size * SIGNAL_ORB_CONFIG.targetMultiple;
        orb = { bias: 'SELL', entry: quote.last, sl, target, rangeBar, trackRecord: ORB_TRACK_RECORD };
      } else {
        orb = { bias: 'WAIT', reason: 'still inside the range, no breakout yet', rangeBar, trackRecord: ORB_TRACK_RECORD };
      }
    }

    // Confirmation engine is purely additive context — failures here must
    // never take down the ict/orb response those fields already depend on.
    let confirmation = null;
    try {
      confirmation = await computeSignalConfirmation(ict, orb, quote.last, bars);
    } catch (e) {
      confirmation = { error: 'confirmation engine failed: ' + e.message };
    }

    send(res, 200, { ict, orb, confirmation, quote: quote.last, asOf: now.time });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}

// ── Server-Sent Events: real-time price stream (1 second ticks) ───────────────
const sseClients  = new Set();
let latestQuote   = { last: 0, bid: 0, ask: 0, change: 0, changePct: 0, dayHigh: 0, dayLow: 0, spread: 0, symbol: '', source: 'none', time: 0 };
let streamActive  = false;
let openPrice     = 0;

async function pollQuoteOnce() {
  // Live TL quotes
  if (store.token && store.instrId && store.infoRouteId) {
    try {
      const r = await tlApiFetch('GET',
        `/trade/quotes?tradableInstrumentId=${store.instrId}&routeId=${store.infoRouteId}`,
        null, store.token, store.accNum);
      if (r.json?.s === 'ok' && r.json?.d) {
        const q    = r.json.d;
        const bid  = parseFloat(q.bp || q.b || 0);
        const ask  = parseFloat(q.ap || q.a || 0);
        // Prefer actual last trade price (lp/tp) over mid — matches what TL chart shows
        const last = parseFloat(q.lp || q.tp || q.last || 0) || (bid + ask) / 2;
        if (last > 0) {
          if (!openPrice) openPrice = last;
          const change    = +(last - openPrice).toFixed(2);
          const changePct = +((change / openPrice) * 100).toFixed(3);
          latestQuote = {
            last, bid, ask,
            change, changePct, spread: +(ask - bid).toFixed(2),
            dayHigh: Math.max(latestQuote.dayHigh || last, last),
            dayLow:  latestQuote.dayLow ? Math.min(latestQuote.dayLow, last) : last,
            symbol: 'NAS100', source: 'tradelocker', time: Date.now(),
          };
          return;
        }
      }
    } catch(_) {}
  }
  // Fallback: candle cache
  const bars = store.candleCache['1'] || store.candleCache['5'];
  if (bars && bars.length) {
    const last = bars[bars.length - 1].close;
    if (!openPrice) openPrice = last;
    latestQuote = { ...latestQuote, last, bid: last - 0.5, ask: last + 0.5, symbol: 'NQ=F', source: 'cache', time: Date.now() };
  }
}

function broadcastQuote() {
  if (!sseClients.size) return;
  const msg = `data: ${JSON.stringify(latestQuote)}\n\n`;
  sseClients.forEach(res => { try { res.write(msg); } catch(_) { sseClients.delete(res); } });
}

// ── Tick-to-candle accumulator: builds real OHLCV bars from live TL quotes ─────
// Persisted to disk so history survives server restarts
const TV_CONTEXT_FILE = path.join(ROOT, 'tv_context.json');
const TICK_BAR_FILE   = path.join(ROOT, 'tick_bars.json');
const SESSION_FILE    = path.join(ROOT, 'tl_session.json');
const TICK_RESOLUTIONS = [1, 5, 15, 30, 60, 240, 1440]; // minutes
let tickBars = {}; // { '1': [{time,open,high,low,close,volume},...], '5': [...], ... }
const MAX_BARS_PER_RES = 2000;

try {
  const saved = JSON.parse(fs.readFileSync(TICK_BAR_FILE, 'utf8'));
  tickBars = saved;
  const summary = Object.entries(tickBars).map(([k,v])=>`${k}m:${v.length}`).join(' ');
  console.log(`  [TickBars] Loaded persisted bars — ${summary}`);
} catch (_) {
  TICK_RESOLUTIONS.forEach(r => { tickBars[String(r)] = []; });
  console.log('  [TickBars] No persisted bars — starting fresh tick accumulation');
}

let _tickSaveDirty = false;
setInterval(() => {
  if (_tickSaveDirty) {
    try { fs.writeFileSync(TICK_BAR_FILE, JSON.stringify(tickBars)); _tickSaveDirty = false; } catch(_) {}
  }
}, 10000); // save every 10s if dirty

// ── Persist auth session for auto-reconnect on restart ───────────────────────
function saveSession() {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({
      token:        store.token,
      accountId:    store.accountId,
      accNum:       store.accNum,
      instrId:      store.instrId,
      infoRouteId:  store.infoRouteId,
      tradeRouteId: store.tradeRouteId,
      instrName:    store.instrName,
      instrDesc:    store.instrDesc,
      balance:      store.balance,
      savedAt:      Date.now(),
    }));
    console.log('  [Session] Saved to tl_session.json — will auto-connect on next restart');
  } catch(e) { console.error('  [Session] Save error:', e.message); }
}

async function autoReconnect() {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch { return; }
  if (!saved?.token || !saved?.instrId) return;
  const ageHours = (Date.now() - (saved.savedAt || 0)) / 3600000;
  if (ageHours > 22) {
    console.log(`  [AutoConnect] Session expired (${ageHours.toFixed(1)}h old) — connect via UI to refresh`);
    return;
  }
  console.log(`  [AutoConnect] Testing saved session (${ageHours.toFixed(1)}h old)...`);
  const check = await tlApiFetch('GET', '/auth/jwt/all-accounts', null, saved.token, '');
  if (check.status !== 200 || !check.json?.accounts) {
    console.log('  [AutoConnect] Token rejected by server — connect via UI');
    return;
  }
  Object.assign(store, {
    token:        saved.token,
    accountId:    saved.accountId,
    accNum:       saved.accNum,
    instrId:      saved.instrId,
    infoRouteId:  saved.infoRouteId,
    tradeRouteId: saved.tradeRouteId,
    instrName:    saved.instrName,
    instrDesc:    saved.instrDesc,
    balance:      saved.balance,
  });
  console.log(`  [AutoConnect] ✓ Connected — ${saved.instrName}  instrId:${saved.instrId}  accNum:${saved.accNum}`);
  startQuoteStream();
}

// ── Deep NDX History — TradingView WebSocket batch downloader ─────────────────
// Uses request_more_data (exact protocol TV chart uses when scrolling left) to
// pull 2000 bars per round × N rounds = months of 5m NDX history.
// NDX (NASDAQ:NDX) is a free symbol — no subscription required.
const NDX_TARGET_BARS = 20000; // ~6 months of 5m bars (78 bars/trading day × 126 days)
const NDX_BATCH_SIZE  = 2000;
const NDX_MAX_ROUNDS  = Math.ceil(NDX_TARGET_BARS / NDX_BATCH_SIZE) + 1; // +1 safety

function tvFetchBatch(fromTimestamp) {
  // Single WebSocket connection → fetches up to NDX_BATCH_SIZE 5m bars ending at fromTimestamp
  // Sends request_more_data after each series_completed to pull older batches.
  return new Promise((resolve) => {
    const tls   = require('tls');
    const host  = 'data.tradingview.com';
    const bars  = [];
    let rawBuf = '', wsFrameBuf = Buffer.alloc(0), wsUpgraded = false, done = false;
    let round = 0, lastCount = 0;
    const sessId = 'cs_' + Math.random().toString(36).slice(2, 10);
    const wsKey  = Buffer.from((Date.now() + Math.random()).toString()).toString('base64');

    function tvEncode(p) { const s=typeof p==='string'?p:JSON.stringify(p); return `~m~${s.length}~m~${s}`; }
    function tvMsg(f,a)  { return tvEncode(JSON.stringify({m:f,p:a})); }
    function wsMask(payload) {
      const mask=Buffer.from([Math.random()*255|0,Math.random()*255|0,Math.random()*255|0,Math.random()*255|0]);
      return {mask,masked:Buffer.from(payload).map((b,i)=>b^mask[i%4])};
    }
    function wsWrite(sock,text) {
      const payload=Buffer.from(text,'utf8');
      const {mask,masked}=wsMask(payload);
      const len=masked.length;
      let hdr;
      if(len<126)        hdr=Buffer.from([0x81,0x80|len,...mask]);
      else if(len<65536) hdr=Buffer.from([0x81,0xFE,len>>8,len&0xFF,...mask]);
      else { hdr=Buffer.alloc(14); hdr[0]=0x81; hdr[1]=0xFF; hdr.writeBigUInt64BE(BigInt(len),2); mask.copy(hdr,10); }
      sock.write(Buffer.concat([hdr,masked]));
    }
    function processFrames(sock) {
      while (wsFrameBuf.length>=2) {
        const opcode=wsFrameBuf[0]&0x0F, isMasked=(wsFrameBuf[1]&0x80)!==0;
        let payLen=wsFrameBuf[1]&0x7F, hLen=2;
        if(payLen===126){if(wsFrameBuf.length<4)return; payLen=wsFrameBuf.readUInt16BE(2); hLen=4;}
        else if(payLen===127){if(wsFrameBuf.length<10)return; payLen=Number(wsFrameBuf.readBigUInt64BE(2)); hLen=10;}
        if(isMasked)hLen+=4;
        if(wsFrameBuf.length<hLen+payLen)return;
        let payload=wsFrameBuf.slice(hLen,hLen+payLen);
        if(isMasked){const m=wsFrameBuf.slice(hLen-4,hLen); payload=Buffer.from(payload.map((b,i)=>b^m[i%4]));}
        wsFrameBuf=wsFrameBuf.slice(hLen+payLen);
        if(opcode===9) sock.write(Buffer.from([0x8A,0x00]));
        else if(opcode===1||opcode===0){rawBuf+=payload.toString('utf8'); processMessages(sock);}
        else if(opcode===8&&!done){done=true; sock.destroy(); resolve(bars);}
      }
    }
    function processMessages(sock) {
      const re=/~m~(\d+)~m~/g; let match,pos=0;
      while((match=re.exec(rawBuf))!==null){
        const len=parseInt(match[1]),start=match.index+match[0].length;
        if(rawBuf.length<start+len)break;
        handleMsg(sock,rawBuf.slice(start,start+len));
        pos=start+len; re.lastIndex=pos;
      }
      rawBuf=rawBuf.slice(pos);
    }
    function ingestSeries(src) {
      for(const key of Object.keys(src)){
        const series=src[key];
        if(series&&Array.isArray(series.s)){
          for(const b of series.s){
            if(b.v&&b.v.length>=5){
              const[ts,o,h,l,c,vol]=b.v;
              bars.push({time:Math.floor(ts),open:+o.toFixed(2),high:+h.toFixed(2),low:+l.toFixed(2),close:+c.toFixed(2),volume:Math.round(vol||0)});
            }
          }
        }
      }
    }
    function handleMsg(sock,body) {
      if(body.startsWith('~h~')){wsWrite(sock,tvEncode(body)); return;}
      let obj; try{obj=JSON.parse(body);}catch{return;}
      // Initial handshake
      if(obj.session_id){
        wsWrite(sock,tvMsg('set_auth_token',['unauthorized_user_token']));
        wsWrite(sock,tvMsg('chart_create_session',[sessId,'']));
        wsWrite(sock,tvMsg('switch_timezone',[sessId,'America/Chicago']));
        wsWrite(sock,tvMsg('resolve_symbol',[sessId,'sds_sym_1','={"symbol":"NASDAQ:NDX","adjustment":"splits","session":"extended"}']));
        // create_series: request NDX_BATCH_SIZE bars; 7th param = '' means most recent
        wsWrite(sock,tvMsg('create_series',[sessId,'$prices','s1','sds_sym_1','5',NDX_BATCH_SIZE,'']));
        return;
      }
      // Ingest bar data from timescale_update or du
      if(obj.m==='timescale_update'||obj.m==='du'){
        const sources=obj.p||[];
        for(const src of sources){ if(src&&typeof src==='object') ingestSeries(src); }
      }
      // series_completed = one batch done
      if(obj.m==='series_completed'){
        round++;
        const newBars = bars.length - lastCount;
        process.stdout.write(`  [NDX] Batch ${round}: +${newBars} bars (total ${bars.length})\n`);
        lastCount = bars.length;
        if(done) return;
        // Keep pulling older batches until we hit target or server has no more data
        if(bars.length < NDX_TARGET_BARS && round < NDX_MAX_ROUNDS && newBars > 10){
          wsWrite(sock, tvMsg('request_more_data',[sessId,'$prices',NDX_BATCH_SIZE]));
        } else {
          done = true;
          sock.destroy();
          resolve(bars);
        }
      }
      if(obj.m==='series_error'){ done=true; sock.destroy(); resolve(bars); }
    }
    const handshake=[
      'GET /socket.io/websocket HTTP/1.1',`Host: ${host}`,
      'Upgrade: websocket','Connection: Upgrade',
      `Sec-WebSocket-Key: ${wsKey}`,'Sec-WebSocket-Version: 13',
      'Origin: https://www.tradingview.com',
      'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language: en-US,en;q=0.9','',''
    ].join('\r\n');
    const sock=tls.connect({host,port:443,servername:host},()=>{ sock.write(handshake); });
    sock.setTimeout(120000); // 2 min total — fetching many rounds takes time
    sock.on('timeout',()=>{ if(!done){done=true;sock.destroy();resolve(bars);} });
    sock.on('error',e=>{ console.error('  [NDX] WS error:',e.message); if(!done)resolve(bars); });
    sock.on('end',()=>{ if(!done){done=true;resolve(bars);} });
    sock.on('data',chunk=>{
      if(!wsUpgraded){
        const str=chunk.toString('utf8');
        if(str.includes('101')){
          wsUpgraded=true;
          const idx=chunk.indexOf(Buffer.from('\r\n\r\n'));
          if(idx!==-1){wsFrameBuf=Buffer.concat([wsFrameBuf,chunk.slice(idx+4)]);processFrames(sock);}
        } else { sock.destroy(); resolve(bars); }
        return;
      }
      wsFrameBuf=Buffer.concat([wsFrameBuf,chunk]);
      processFrames(sock);
    });
  });
}

function buildAllResolutions(bars5m) {
  const result = {'5': bars5m};
  for(const[res,key]of[[1,'1'],[15,'15'],[30,'30'],[60,'60'],[240,'240'],[1440,'1440']]){
    const agg=[];
    for(const b of bars5m){
      const bt=Math.floor(b.time/(res*60))*(res*60);
      const last=agg.length>0?agg[agg.length-1]:null;
      if(last&&last.time===bt){
        last.high=Math.max(last.high,b.high); last.low=Math.min(last.low,b.low);
        last.close=b.close; last.volume=(last.volume||0)+(b.volume||0);
      } else {
        agg.push({time:bt,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume||0});
      }
    }
    result[key]=agg;
  }
  return result;
}

async function refreshNDXContext() {
  // Check if existing data is fresh enough — skip if updated within 2h
  try {
    const existing = JSON.parse(fs.readFileSync(TV_CONTEXT_FILE, 'utf8'));
    const bars = existing['5'] || [];
    if (bars.length > 0) {
      const ageHours = (Date.now()/1000 - bars[bars.length-1].time) / 3600;
      if (ageHours < 2 && bars.length >= NDX_TARGET_BARS * 0.9) {
        console.log(`  [NDX] Context current (${ageHours.toFixed(1)}h old, ${bars.length} bars) — skipping`);
        return;
      }
    }
  } catch {}

  console.log(`  [NDX] Building ${NDX_TARGET_BARS.toLocaleString()}-bar history from TradingView (${NDX_MAX_ROUNDS} batch rounds)...`);
  const raw = await tvFetchBatch();

  if (!raw.length) { console.log('  [NDX] No data received'); return; }

  // Deduplicate and sort
  const seen  = new Set();
  const bars5m = raw.filter(b => { if(seen.has(b.time)||b.close<100)return false; seen.add(b.time); return true; });
  bars5m.sort((a,b)=>a.time-b.time);

  // Merge with any existing bars that are OLDER than what we just got (fill gaps)
  let merged = bars5m;
  try {
    const existing = JSON.parse(fs.readFileSync(TV_CONTEXT_FILE, 'utf8'));
    const oldBars  = (existing['5'] || []).filter(b => !seen.has(b.time) && b.close > 100);
    if (oldBars.length) {
      merged = [...oldBars, ...bars5m].sort((a,b)=>a.time-b.time);
      const dedupSeen = new Set();
      merged = merged.filter(b=>{ if(dedupSeen.has(b.time))return false; dedupSeen.add(b.time); return true; });
    }
  } catch {}

  const result = buildAllResolutions(merged);
  try {
    fs.writeFileSync(TV_CONTEXT_FILE, JSON.stringify(result));
    const days = result['1440']?.length || 0;
    console.log(`  [NDX] ✓ Saved ${merged.length} 5m bars (${days} trading days) to tv_context.json`);
  } catch(e) { console.error('  [NDX] Save error:', e.message); }
}

function calibrateBasis(tlPrice) {
  // Calculate NDX→TL basis from first live TL price vs tv_context.json last close
  if (store.ndxBasis !== null || !tlPrice || tlPrice < 1000) return;
  try {
    const ctx = JSON.parse(fs.readFileSync(TV_CONTEXT_FILE, 'utf8'));
    const ndxLast = (ctx['5'] || []).at(-1)?.close;
    if (ndxLast && ndxLast > 0) {
      store.ndxBasis = +(ndxLast - tlPrice).toFixed(2);
      console.log(`  [Basis] NDX ${ndxLast} − TL ${tlPrice} = ${store.ndxBasis}pts offset (apply to historical NDX bars)`);
    }
  } catch(_) {}
}

function onQuoteTick(price, ts) {
  if (!price || price < 1000) return; // ignore invalid prices
  calibrateBasis(price);
  const timestamp = ts || Math.floor(Date.now() / 1000);
  for (const res of TICK_RESOLUTIONS) {
    const barTime = Math.floor(timestamp / (res * 60)) * (res * 60);
    const key = String(res);
    if (!tickBars[key]) tickBars[key] = [];
    const bars = tickBars[key];
    const last = bars.length > 0 ? bars[bars.length - 1] : null;
    if (last && last.time === barTime) {
      last.high  = Math.max(last.high, price);
      last.low   = Math.min(last.low,  price);
      last.close = price;
      last.volume = (last.volume || 0) + 1;
    } else {
      if (bars.length >= MAX_BARS_PER_RES) bars.splice(0, bars.length - MAX_BARS_PER_RES + 1);
      bars.push({ time: barTime, open: price, high: price, low: price, close: price, volume: 1 });
    }
  }
  _tickSaveDirty = true;
}

function startQuoteStream() {
  if (streamActive) return;
  streamActive = true;
  setInterval(async () => {
    await pollQuoteOnce();
    // Feed every real TL tick into the accumulator
    if (latestQuote.source === 'tradelocker' && latestQuote.last > 0) {
      onQuoteTick(latestQuote.last, Math.floor(latestQuote.time / 1000));
    }
    broadcastQuote();
  }, 500);
  // Refresh the most recent bars for all core TFs every 5s
  // Each iteration rotates through TFs so we don't spam TL all at once
  const _refreshTFs = [
    { res: '1m',  secs: 1,    lookback: 600   },  // last 10 × 1m bars
    { res: '5m',  secs: 5,    lookback: 1800  },  // last 6 × 5m bars
    { res: '15m', secs: 15,   lookback: 1800  },  // last 2 × 15m bars
    { res: '30m', secs: 30,   lookback: 3600  },
    { res: '1H',  secs: 60,   lookback: 7200  },
    { res: '4H',  secs: 240,  lookback: 14400 },
    { res: '1D',  secs: 1440, lookback: 172800},
  ];
  let _tfIdx = 0;
  setInterval(async () => {
    if (!store.token || !store.instrId || !store.infoRouteId) return;
    // Rotate: refresh 1m every tick, cycle through others
    const targets = [_refreshTFs[0]]; // always refresh 1m
    const rotated = _refreshTFs[_tfIdx % _refreshTFs.length];
    if (rotated !== _refreshTFs[0]) targets.push(rotated);
    _tfIdx++;

    const now = Math.floor(Date.now() / 1000);
    for (const tf of targets) {
      try {
        const from = now - tf.lookback;
        const p    = `/trade/history?tradableInstrumentId=${store.instrId}&routeId=${store.infoRouteId}&resolution=${tf.res}&from=${from * 1000}&to=${now * 1000}`;
        const r    = await tlApiFetch('GET', p, null, store.token, store.accNum);
        const bars = parseTLBars(r.json);
        if (bars.length > 0) {
          // Map TL resolution string → minute-number key used by client
          const key = String(tf.secs);
          const existing = store.candleCache[key] || [];
          const cutoff   = bars[0].time;
          store.candleCache[key] = [...existing.filter(b => b.time < cutoff), ...bars];
        }
      } catch(_) {}
    }
  }, 5000);
  console.log('  [Stream] Real-time 1s quote + 5s bar refresh active');
}

function handleStream(req, res) {
  cors(res);
  res.writeHead(200, {
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache, no-transform',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`data: ${JSON.stringify({ ...latestQuote, connected: true })}\n\n`);
  sseClients.add(res);
  startQuoteStream();
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch(_) { clearInterval(ping); } }, 20000);
  req.on('close', () => { sseClients.delete(res); clearInterval(ping); });
}

// ── Static file server ────────────────────────────────────────────────────────
function handleStatic(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${PORT}`).pathname);
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(ROOT, pathname));
  if (!file.startsWith(ROOT)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    cors(res);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

// ── Backtest — returns 35 days of 1H TL data for the weekly strategy analysis ──
async function handleBacktest(req, res) {
  cors(res);
  if (!store.token || !store.instrId || !store.infoRouteId) {
    return send(res, 503, { bars: [], error: 'Not connected to TradeLocker. Connect first.' });
  }
  const now  = Math.floor(Date.now() / 1000);
  const from = now - 60 * 60 * 24 * 35; // 35 days back
  const path = `/trade/history?tradableInstrumentId=${store.instrId}&routeId=${store.infoRouteId}&resolution=1H&from=${from * 1000}&to=${now * 1000}`;
  console.log(`  [TL] Backtest 1H → 35 days`);
  const r    = await tlApiFetch('GET', path, null, store.token, store.accNum);
  const bars = parseTLBars(r.json);
  if (bars.length > 20) {
    console.log(`  [TL] Backtest: ${bars.length} 1H bars`);
    return send(res, 200, { bars, source: 'tradelocker', resolution: '1H' });
  }
  console.warn(`  [TL] Backtest no data. s=${r.json?.s}`);
  send(res, 200, { bars: [], source: 'tradelocker', error: r.json?.errmsg || 'No backtest data returned' });
}

// Browser sends token here after doing direct auth (bypasses Cloudflare)
async function handleSetToken(req, res) {
  const data = await readBody(req);
  if (data.token)  store.token  = data.token;
  if (data.server) store.server = data.server;
  console.log(`  [TL] Token set via browser auth — server: ${store.server}`);
  send(res, 200, { ok: true });
}

// ── NQ Market Context Engine ──────────────────────────────────────────────────
// Provides session profiles, weekly tendencies, and adaptive stats from tick bars
function buildMarketContext() {
  const now    = new Date();
  const ctNow  = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const dow    = ctNow.getDay(); // 0=Sun,1=Mon,...,5=Fri,6=Sat
  const ctH    = ctNow.getHours() + ctNow.getMinutes() / 60;
  const month  = ctNow.getMonth(); // 0=Jan
  const dom    = ctNow.getDate();

  // ── Session windows (CT) ──────────────────────────────────────────────────
  const sessions = {
    asia:     { start: 19, end: 25,  label: 'Asia (7PM–1AM CT)',    avgRange: 55,  character: 'range/accumulation' },
    london:   { start: 1,  end: 7,   label: 'London (1AM–7AM CT)',  avgRange: 90,  character: 'manipulation/sweep' },
    premarket:{ start: 6,  end: 8.5, label: 'Pre-Market (6–8:30AM CT)', avgRange: 60, character: 'directional setup' },
    nyOpen:   { start: 8.5,end: 10,  label: 'NY Open KZ (8:30–10AM CT)', avgRange: 120, character: 'high-velocity expansion' },
    nyAm:     { start: 10, end: 12,  label: 'NY AM (10AM–12PM CT)',  avgRange: 50,  character: 'continuation or fade' },
    lunch:    { start: 12, end: 13.5,label: 'Lunch (12–1:30PM CT)', avgRange: 30,  character: 'chop/low volume — avoid' },
    nyPm:     { start: 13.5,end: 15, label: 'NY PM (1:30–3PM CT)',  avgRange: 60,  character: 'second expansion possible' },
    afterhours:{ start:15, end: 19,  label: 'After Hours (3–7PM CT)',avgRange: 35,  character: 'low volume/gap fill' },
  };

  let activeSess = 'afterhours';
  let nextSess   = 'asia';
  let tradeableNow = false;
  let sessionQuality = 'LOW';

  for (const [k, s] of Object.entries(sessions)) {
    const inSess = s.end > 24 ? (ctH >= s.start || ctH < s.end - 24) : (ctH >= s.start && ctH < s.end);
    if (inSess) { activeSess = k; break; }
  }

  if (['nyOpen','london','premarket'].includes(activeSess)) { tradeableNow = true; sessionQuality = 'HIGH'; }
  else if (['nyPm','nyAm','asia'].includes(activeSess))   { tradeableNow = true; sessionQuality = 'MEDIUM'; }
  else { sessionQuality = 'LOW'; }

  // ── Weekly profile (DOW tendencies for NQ) ────────────────────────────────
  const weeklyProfile = {
    1: { day:'Monday',    tendency:'Range expansion or false breakout. Market hunts Monday\'s liquidity. Often sets the weekly bias direction. Price may reverse Tuesday. DO NOT chase Monday breakouts — wait for Tuesday confirmation.' },
    2: { day:'Tuesday',   tendency:'TRUE direction day. Often the most directional session of the week. If Monday was bearish sweep → Tuesday confirms and expands bullish (or vice versa). Highest-probability trade day. NY open KZ is the prime entry.' },
    3: { day:'Wednesday', tendency:'Mid-week continuation. Usually extends Tuesday\'s move toward the weekly target. NY open KZ 8:30-9:30AM CT. Watch for mid-week reversal if Tuesday already hit 75%+ of weekly range.' },
    4: { day:'Thursday',  tendency:'Distribution begins. Partial reversals common. Avoid new trend entries. TP1/TP2 targets from earlier in week may be hit. Can trade continuation if weekly target not yet reached.' },
    5: { day:'Friday',    tendency:'Profit-taking and position squaring. Often reverses Thursday. Do NOT enter new swing positions. Scalp only. Close all positions before 2PM CT — weekend gap risk.' },
    6: { day:'Saturday',  tendency:'Market closed. No trades.' },
    0: { day:'Sunday',    tendency:'Globex open 5PM CT. Low volume. Watch for gap fill before Asia session. No trading recommended until Asia session establishes direction.' },
  };

  // ── Monthly profile ───────────────────────────────────────────────────────
  let monthlyBias = '';
  if (dom <= 7)        monthlyBias = 'EARLY MONTH — typically bullish institutional positioning. Look for BUY setups on dips.';
  else if (dom <= 14)  monthlyBias = 'MID-MONTH first half — trend continuation. Follow established monthly direction.';
  else if (dom <= 21)  monthlyBias = 'MID-MONTH second half — watch for monthly pivot. Key reversal zone if month has run hard.';
  else                 monthlyBias = 'END OF MONTH — institutional rebalancing. Increased volatility and reversals common. Tighten risk.';

  // ── Quarterly tendency ────────────────────────────────────────────────────
  const q = Math.floor(month / 3) + 1;
  const qTendency = {
    1: 'Q1 (Jan-Mar): Strong seasonal bullish bias for NQ. Tech earnings. January effect. March FOMC often volatile.',
    2: 'Q2 (Apr-Jun): Mixed. April strength then May/June chop. "Sell in May" narrative. FOMC quarterly meetings.',
    3: 'Q3 (Jul-Sep): Summer rally then September weakness. August low volume. Labor Day transition often volatile.',
    4: 'Q4 (Oct-Dec): Strong seasonal. October fear/opportunity, November-December Santa rally. Year-end positioning.',
  }[q];

  // ── Key NQ levels (behavioral, not price-specific) ────────────────────────
  const keyRules = [
    'NQ respects prior day HIGH/LOW as major liquidity targets — these are swept before continuation in 70%+ of sessions.',
    'Weekly opening price (Sunday 5PM CT open) acts as a magnet — price returns to it at least once per week in 80% of weeks.',
    'NY open (9:30AM ET = 8:30AM CT) sees the highest volume of any 30-minute window — the manipulation sweep happens HERE.',
    'FVGs on the 15m and 1H chart fill within 1-3 sessions 85% of the time.',
    'OTE zone (0.618-0.705 fibonacci of the manipulation leg) is the highest-probability entry — confirmed by OB or FVG inside = A+.',
    'London (1-7AM CT) sweeps Asia H or L in 75% of sessions — this sets the ICT model direction for NY.',
    'S4 (London sweeps BOTH sides of Asia) = Search & Destroy — NO TRADE day. Sit on hands.',
    'After 10AM CT: DO NOT initiate new positions unless a pre-market signal is still valid and price has not yet reached TP1.',
    'NQ average daily range: 100-150 points on normal days, 200+ on news/FOMC days.',
    'Equal Highs (EQH) above = sell-side liquidity — smart money SELLS INTO these levels, not buys.',
    'Equal Lows (EQL) below = buy-side liquidity — smart money BUYS from these levels, not sells.',
  ];

  // ── Tick bar stats ────────────────────────────────────────────────────────
  const bars5m  = tickBars['5']  || [];
  const bars1m  = tickBars['1']  || [];
  const bars60m = tickBars['60'] || [];
  const bars1D  = tickBars['1440'] || [];

  let adaptiveStats = { atr5m: null, atr1H: null, dailyRange: null, weeklyBias: null, monthlyOpen: null };

  if (bars5m.length >= 14) {
    // ATR(14) on 5m bars
    const trs = bars5m.slice(-15).map((b,i,a) => i===0 ? b.high-b.low : Math.max(b.high-b.low, Math.abs(b.high-a[i-1].close), Math.abs(b.low-a[i-1].close)));
    adaptiveStats.atr5m = +(trs.slice(-14).reduce((a,b)=>a+b,0)/14).toFixed(1);
  }
  if (bars60m.length >= 14) {
    const trs = bars60m.slice(-15).map((b,i,a) => i===0 ? b.high-b.low : Math.max(b.high-b.low, Math.abs(b.high-a[i-1].close), Math.abs(b.low-a[i-1].close)));
    adaptiveStats.atr1H = +(trs.slice(-14).reduce((a,b)=>a+b,0)/14).toFixed(1);
  }
  if (bars1D.length >= 1) {
    const today = bars1D[bars1D.length-1];
    adaptiveStats.dailyRange = +(today.high - today.low).toFixed(1);
    adaptiveStats.dailyOpen  = +today.open.toFixed(2);
  }
  if (bars1D.length >= 5) {
    const weekBars = bars1D.slice(-5);
    const wOpen = weekBars[0].open;
    const wCur  = weekBars[weekBars.length-1].close;
    adaptiveStats.weeklyBias = wCur > wOpen ? `BULLISH (up ${+(wCur-wOpen).toFixed(0)}pts this week)` : `BEARISH (down ${+(wOpen-wCur).toFixed(0)}pts this week)`;
  }

  return {
    currentTime:    ctNow.toLocaleString('en-US', { weekday:'long', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', timeZone:'America/Chicago' }) + ' CT',
    activeSess:     sessions[activeSess]?.label || activeSess,
    sessionQuality,
    tradeableNow,
    dayOfWeek:      weeklyProfile[dow],
    monthlyBias,
    quarterTendency: qTendency,
    sessions,
    keyRules,
    adaptiveStats,
    tickBarCounts: { '1m': bars1m.length, '5m': bars5m.length, '1H': bars60m.length, '1D': bars1D.length },
  };
}

async function handleContext(req, res) {
  send(res, 200, buildMarketContext());
}

async function handleTVContext(req, res) {
  try {
    const raw  = fs.readFileSync(TV_CONTEXT_FILE, 'utf8');
    const data = JSON.parse(raw);
    const bars5m  = data['5']    || [];
    const bars1H  = data['60']   || [];
    const bars1D  = data['1440'] || [];

    // Swing H/L detection on daily bars — ICT external liquidity levels
    // (engine/structure_engine.js — consolidated, same 2-bar-lookback algorithm this used inline before)
    const swings = structureEngine.findSwingPoints(bars1D, 2).map(s => ({
      type: s.type, price: +s.price.toFixed(2), nqAdj: +(s.price - 150).toFixed(2),
      date: new Date(s.bar.time * 1000).toLocaleDateString(),
    }));

    // EQH/EQL detection — equal highs/lows within 10pts on daily (liquidity pools)
    const eqLevels = structureEngine.findEqualLevels(bars1D, 10, 10).map(e => ({
      type: e.type, price: +e.price.toFixed(2),
      dates: [new Date(e.barI.time * 1000).toLocaleDateString(), new Date(e.barJ.time * 1000).toLocaleDateString()],
    }));

    // ATR(14) on daily bars for volatility context
    let atr14d = null;
    if (bars1D.length >= 15) {
      atr14d = +structureEngine.atr(bars1D, 14).toFixed(1);
    }

    // Weekly profile — last 10 weeks, each week's open/high/low/close/range
    const weeklyProfile = [];
    if (bars1D.length > 5) {
      for (const w of structureEngine.weeklyProfile(bars1D, 5)) {
        weeklyProfile.push({
          weekStart: new Date(w.weekStartTime * 1000).toLocaleDateString(),
          open: +w.open.toFixed(2), close: +w.close.toFixed(2),
          high: +w.high.toFixed(2), low: +w.low.toFixed(2), range: +w.range.toFixed(1),
          bias: w.bias,
        });
      }
    }

    send(res, 200, {
      source:       'NDX_historical_context',
      bars5m_total:  bars5m.length,
      bars1H_total:  bars1H.length,
      bars1D_total:  bars1D.length,
      dateRange:    bars1D.length ? `${new Date(bars1D[0].time*1000).toLocaleDateString()} → ${new Date(bars1D[bars1D.length-1].time*1000).toLocaleDateString()}` : 'none',
      recent5m:      bars5m.slice(-200),   // last 200 5m bars for recent price action
      recent1H:      bars1H.slice(-100),   // last 100 1H bars for intraday structure
      dailyBars:     bars1D,               // all daily bars for full structure analysis
      weeklyProfile: weeklyProfile.slice(-13), // last 13 weeks (quarter)
      keySwings:     swings,
      eqLevels:      eqLevels.slice(-30),
      atr14d,
      lastClose:     bars5m.at(-1)?.close || null,
      note:          'NDX index prices — NQ futures trade ~100-200pts BELOW NDX. Subtract ~150pts from all NDX prices to get NQ equivalent. Use for structure, swing levels, and ICT analysis only.',
    });
  } catch(e) {
    send(res, 200, { source: 'none', bars5m_total: 0, bars1D_total: 0, recent5m: [], dailyBars: [], keySwings: [], note: 'No TV context loaded yet — will build on next server start' });
  }
}

// ── MCP endpoint — read-only Claude custom connector ───────────────────────────
// Exposes the exact same literal data the browser UI shows (candles, quote,
// session/market context, deep swing structure, positions) as MCP tools, so an
// Artifact chart (or Claude directly, in chat) can read the live TradeLocker
// feed. Read-only by design — there is no trade/order tool. Everything you
// execute stays manual.
let McpServer, StreamableHTTPServerTransport, z;
try {
  ({ McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js'));
  ({ StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js'));
  ({ z } = require('zod'));
} catch (e) {
  console.warn('  [MCP] @modelcontextprotocol/sdk / zod not installed yet — run `npm install` in this folder to enable /mcp');
}

const MCP_TOKEN_FILE = path.join(ROOT, 'mcp_token.json');
function getMcpToken() {
  if (process.env.PXBOT_MCP_TOKEN) return process.env.PXBOT_MCP_TOKEN;
  try { return JSON.parse(fs.readFileSync(MCP_TOKEN_FILE, 'utf8')).token; } catch (_) {}
  const token = crypto.randomBytes(24).toString('hex');
  try { fs.writeFileSync(MCP_TOKEN_FILE, JSON.stringify({ token })); } catch (_) {}
  return token;
}
const MCP_TOKEN = getMcpToken();

// Same-process loopback so every MCP tool returns literally what /api/* returns —
// one source of truth, no duplicated candle/quote logic to drift out of sync.
function loopbackGet(apiPath) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: PORT, path: apiPath }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function jsonToolResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function buildMcpServer() {
  const server = new McpServer({ name: 'pxbot-tradelocker', version: '1.0.0' });

  server.registerTool('get_candles', {
    title: 'Get literal TradeLocker candles',
    description: 'Literal OHLCV candles for the connected NAS100/NQ instrument, exactly as the PXBOT chart shows them — sourced from TradeLocker directly. Falls back to calibrated NDX+tick data only when TradeLocker history is temporarily unavailable; check the "source" field ("tradelocker" = live TL history).',
    inputSchema: {
      resolution: z.enum(['1', '5', '15', '30', '60', '240', '1440']).default('5').describe('Bar size in minutes (1440 = daily)'),
      count: z.number().int().min(1).max(2000).default(300).describe('Number of most recent bars to return'),
    },
  }, async ({ resolution, count }) => jsonToolResult(await loopbackGet(`/api/candles?resolution=${resolution}&count=${count}`)));

  server.registerTool('get_quote', {
    title: 'Get live TradeLocker quote',
    description: 'Current live bid/ask/last price, change, and day range for the connected NAS100/NQ instrument.',
    inputSchema: {},
  }, async () => jsonToolResult(await loopbackGet('/api/quote')));

  server.registerTool('get_market_context', {
    title: 'Get session/day/week context',
    description: 'Current trading session (Asia/London/NY open/lunch/etc.), day-of-week and monthly/quarterly seasonal tendencies, and adaptive ATR/range stats built from accumulated live tick bars.',
    inputSchema: {},
  }, async () => jsonToolResult(await loopbackGet('/api/context')));

  server.registerTool('get_deep_context', {
    title: 'Get deep swing/liquidity structure',
    description: 'Multi-month structure: recent 5m/1H bars, daily bars, weekly profile, swing highs/lows (external liquidity) and equal-high/equal-low pools, plus ATR(14) on daily bars. Prices are NDX-scale — see the note field for the NQ offset.',
    inputSchema: {},
  }, async () => jsonToolResult(await loopbackGet('/api/tvcontext')));

  server.registerTool('get_positions', {
    title: 'Get open positions (read-only)',
    description: 'Currently open positions on the connected TradeLocker account. Read-only — this tool never places, modifies, or closes trades. All execution stays manual.',
    inputSchema: {},
  }, async () => jsonToolResult(await loopbackGet('/api/positions')));

  server.registerTool('get_health', {
    title: 'Get connection health',
    description: 'Whether the server is currently authenticated to TradeLocker, and which account/instrument it resolved.',
    inputSchema: {},
  }, async () => jsonToolResult(await loopbackGet('/api/health')));

  return server;
}

function checkMcpAuth(req) {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const qToken = u.searchParams.get('token');
  const authHeader = req.headers['authorization'] || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  return Boolean(MCP_TOKEN) && (qToken === MCP_TOKEN || bearer === MCP_TOKEN);
}

async function handleMcp(req, res) {
  cors(res);
  if (!McpServer) return send(res, 501, { error: 'MCP SDK not installed. Run `npm install` in the PXBOT folder, then restart the server.' });
  if (!checkMcpAuth(req)) return send(res, 401, { error: 'Missing or invalid token. Append ?token=YOUR_TOKEN to the URL or send it as an Authorization: Bearer header — see mcp_token.json.' });
  if (req.method === 'GET' || req.method === 'DELETE') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
  }
  const body = await readBody(req);
  try {
    const mcpServer = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
    res.on('close', () => { transport.close(); mcpServer.close(); });
  } catch (e) {
    console.error('  [MCP] Error:', e.message);
    if (!res.headersSent) send(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  }
}

// ── Router ────────────────────────────────────────────────────────────────────
http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
  const p = req.url.split('?')[0];
  if (p === '/api/auth'      && req.method === 'POST') return handleAuth(req, res);
  if (p === '/api/settoken'  && req.method === 'POST') return handleSetToken(req, res);
  if (p === '/api/accounts'  && req.method === 'GET')  return handleAccounts(req, res);
  if (p === '/api/candles'   && req.method === 'GET')  return handleCandles(req, res);
  if (p === '/api/backtest'  && req.method === 'GET')  return handleBacktest(req, res);
  if (p === '/api/quote'     && req.method === 'GET')  return handleQuote(req, res);
  if (p === '/api/positions' && req.method === 'GET')  return handlePositions(req, res);
  if (p === '/api/health'    && req.method === 'GET')  return handleHealth(req, res);
  if (p === '/api/signal'    && req.method === 'GET')  return handleSignal(req, res);
  if (p === '/api/debug'     && req.method === 'GET')  return send(res, 200, { instrId: store.instrId, instrName: store.instrName, instrDesc: store.instrDesc, allRoutes: store.allRoutes, infoRouteId: store.infoRouteId, tradeRouteId: store.tradeRouteId, accountId: store.accountId, accNum: store.accNum, hasToken: !!store.token, balance: store.balance });
  if (p === '/api/stream'    && req.method === 'GET')  return handleStream(req, res);
  if (p === '/api/context'   && req.method === 'GET')  return handleContext(req, res);
  if (p === '/api/tvcontext' && req.method === 'GET')  return handleTVContext(req, res);
  if (p === '/mcp'           && req.method === 'POST') return handleMcp(req, res);
  if (p === '/mcp')                                    return handleMcp(req, res); // returns 405 for GET/DELETE
  return handleStatic(req, res);

}).listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  ====================================================');
  console.log('  PXBOT NQ Console  +  TradeLocker Proxy');
  console.log(`  http://127.0.0.1:${PORT}`);
  console.log('  Keep this window open while you trade');
  console.log('  ------------------------------------------------------');
  console.log('  Claude MCP connector endpoint (for the tunnel):');
  console.log(`    POST http://127.0.0.1:${PORT}/mcp?token=${MCP_TOKEN}`);
  console.log('  See MCP_CONNECTOR_SETUP.md to expose this to claude.ai');
  console.log('  ====================================================');
  console.log('');
  // Auto-connect from last saved session + refresh NDX chart data on every boot
  setImmediate(() => {
    autoReconnect().catch(e => console.error('  [AutoConnect] Error:', e.message));
    refreshNDXContext().catch(e => console.error('  [NDX] Error:', e.message));
  });
});
