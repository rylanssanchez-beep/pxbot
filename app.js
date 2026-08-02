'use strict';

// ─── Helpers ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const fmt  = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtP = n => fmt(n, 2);
const nowStamp = () => new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

// ─── NQ Constants ─────────────────────────────────────────────────────────────
const NQ_TICK    = 0.25;
const NQ_PT_VAL  = 20;   // $20 per point per contract

// ─── Session Windows — CHICAGO TIME (CDT = UTC-5) ─────────────────────────────
// Asia    7pm–1am  CT  (19:00–25:00)
// London  1am–7am  CT  (01:00–07:00)
// Pre-mkt 6am–8:30am CT (06:00–08:30) — NQ pre-market + signal window
// NY Open 8:30am–9:30am CT (08:30–09:30) — primary kill zone
// NY      9:30am–3pm CT  (09:30–15:00)
//
// THREE SIGNAL ALERT WINDOWS (CT):
//   18:00 CT — Pre-Asia: catch the daily top/bottom before Asia opens
//   00:00 CT — Pre-London: 1 hour before London opens, setup bias
//   06:00 CT — Pre-Market: NQ pre-market open signal
const SESSION_DEF = {
  asia:    { startH: 19, endH: 25, label: 'ASIA',    canvasCol: 'rgba(167,139,250,0.10)' },
  london:  { startH: 1,  endH: 7,  label: 'LONDON',  canvasCol: 'rgba(83,167,255,0.10)'  },
  nyopen:  { startH: 8.5,endH: 9.5,label: 'NY OPEN', canvasCol: 'rgba(53,210,127,0.08)'  },
  ny:      { startH: 9.5,endH: 15, label: 'NY',      canvasCol: 'rgba(53,210,127,0.04)'  },
};

// Helper: current CT decimal hour
function ctNow() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}
function ctDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
}

// Signal windows in CT
const SIGNAL_WINDOWS = {
  preAsia:    { startH: 18.0, endH: 19.0, label: 'PRE-ASIA 6PM CT',    cls: 'preasia',    title: '⭐ PRE-ASIA SIGNAL WINDOW — 6:00 PM CT',    desc: '6–7 PM CT · Identify daily top/bottom before Asia opens. Look for sweep of daily H/L.' },
  preLondon:  { startH: 0.0,  endH: 1.0,  label: 'PRE-LONDON MIDNIGHT', cls: 'prelondon',  title: '⭐ PRE-LONDON SIGNAL WINDOW — MIDNIGHT CT',   desc: 'Midnight–1 AM CT · London opens in 1 hour. Build your bias now.' },
  premarket:  { startH: 6.0,  endH: 8.5,  label: 'PRE-MARKET 6AM CT',   cls: 'premarket',  title: '⭐ PRE-MARKET SIGNAL WINDOW — 6:00 AM CT',   desc: '6–8:30 AM CT · NQ pre-market. OTE zone active before the open.' },
  nyopen:     { startH: 8.5,  endH: 9.5,  label: 'NY OPEN KILL ZONE ✦', cls: 'nyopen',     title: '🔥 NY OPEN KILL ZONE — 8:30 AM CT',          desc: '8:30–9:30 AM CT · Primary entry window. Price sweeps then pulls to OTE.' },
};

// ─── The Correct 4 Scenarios ──────────────────────────────────────────────────
// Based on your image (ET times, profiles are inverse for bearish)
const SCENARIOS = {
  0: {
    name: 'Scanning…', bias: 'WAIT', icon: '?', cls: 'wait-card', col: '#f5b84b',
    desc: 'Analyzing Asia and London session data to identify today\'s scenario.',
  },
  1: {
    name: 'NY Continuation', bias: 'DYNAMIC', icon: '↗', cls: 'buy-card', col: '#35d27f',
    desc: 'Asia makes a DIRECTIONAL move. London CONSOLIDATES (smaller range). ' +
          'NY sweeps the London range first, then CONTINUES in Asia\'s direction. ' +
          'Entry: wait for the London range sweep, then BUY/SELL the fib pull-back (0.618–0.705 OTE).',
  },
  2: {
    name: 'NY Consolidation', bias: 'DYNAMIC', icon: '↙↗', cls: 'buy-card', col: '#53a7ff',
    desc: 'Asia CONSOLIDATES. London makes a directional move that SWEPT ASIA first (stop hunt on Asia highs/lows). ' +
          'NY CONTINUES London\'s direction. ' +
          'Entry: fib pull-back of the London leg after the Asia sweep (0.618–0.705 OTE).',
  },
  3: {
    name: 'NY Reversal', bias: 'DYNAMIC', icon: '↗↙', cls: 'sell-card', col: '#ff5368',
    desc: 'Asia CONSOLIDATES. London makes a directional move but did NOT sweep Asia first (manipulation / fake-out). ' +
          'NY REVERSES London\'s move. ' +
          'Entry: look for NY to sweep the London extreme, then fade back through the London range (0.618–0.705 OTE of London leg).',
  },
  4: {
    name: 'Search & Destroy', bias: 'AVOID', icon: '⟺', cls: 'wait-card', col: '#f5b84b',
    desc: 'Usually after a big range day. Asia consolidates. London sweeps BOTH sides of Asia in a larger consolidated range. ' +
          'NY does the same to London — broadening formation "<". NO TRADE TODAY. ' +
          'Watch for this after any day with 300+ point NQ range.',
  },
};

const FIBS = [
  { r: 0.236, label: '0.236' },
  { r: 0.382, label: '0.382' },
  { r: 0.500, label: '0.500' },
  { r: 0.618, label: '0.618',     ote: true },
  { r: 0.705, label: '0.705 OTE', ote: true },
  { r: 0.786, label: '0.786' },
];

// ─── State ────────────────────────────────────────────────────────────────────
function todayKey() { return new Date().toISOString().slice(0, 10); }

const state = {
  candles:    [],
  visible:    [],
  scenarioId: 0,
  asiaBias:   'BUY',
  fibHigh: 0, fibLow: 0, fibBias: 'BUY',
  signal: null,
  journal: JSON.parse(localStorage.getItem('px_nq_journal') || '[]'),
  tl: { connected: false, token: null, server: '', acct: null, positions: [] },
  weeklyStats: JSON.parse(localStorage.getItem('px_weekly') || 'null'),

  // Daily limits & gates
  day: {
    key: todayKey(),
    trades: JSON.parse(localStorage.getItem('px_day_trades') || '[]'), // [{scenarioId,bias,result,time}]
    tradeActive: false,
    maxTrades: 3,        // max 3 total trades per day
    maxPerSetup: 3,      // max 3 attempts on the same scenario+bias — after 3 stops, that setup is locked
  },

  // Bar replay
  replay: {
    active: false, playing: false, cursor: 60,
    intervalId: null, trade: null, paperPnl: 0,
  },

  // Trading Mode — bot actively scans when ON
  tradingMode: false,
};

// ─── Daily Limit & Gate Logic ─────────────────────────────────────────────────

function syncDayState() {
  // Reset if new calendar day
  if (state.day.key !== todayKey()) {
    state.day.key    = todayKey();
    state.day.trades = [];
    state.day.tradeActive = false;
    localStorage.setItem('px_day_trades', '[]');
  }
}

function tradesLeft() {
  return Math.max(0, state.day.maxTrades - state.day.trades.length);
}

function setupAttemptsLeft(scenarioId, bias) {
  const key = `${scenarioId}-${bias}`;
  const attempts = state.day.trades.filter(t => `${t.scenarioId}-${t.bias}` === key && t.result === 'loss').length;
  return Math.max(0, state.day.maxPerSetup - attempts);
}

function canTakeSignal(scenarioId, bias) {
  syncDayState();
  if (state.day.tradeActive) return { ok: false, reason: 'TRADE ACTIVE — close your current trade first.' };
  // Check override toggle — user can bypass daily limit
  const overrideEl = $('overrideDailyLimit');
  const overrideOn = overrideEl && overrideEl.checked;
  if (!overrideOn && tradesLeft() === 0) return { ok: false, reason: `DAILY LIMIT HIT (${state.day.maxTrades}/${state.day.maxTrades}) — toggle "Override" to trade more.` };
  if (!overrideOn && scenarioId && bias) {
    const left = setupAttemptsLeft(scenarioId, bias);
    if (left === 0) return { ok: false, reason: `Setup locked — stopped out 3× on S${scenarioId} ${bias}. Toggle Override to continue.` };
    if (left === 1) return { ok: true, warning: `⚠️ LAST ATTEMPT on this setup (S${scenarioId} ${bias}).` };
  }
  return { ok: true };
}

// Gate check: reject weak signals before they touch the UI
function passesGates(sig) {
  if (!sig || sig.bias === 'WAIT') return { pass: false, reason: 'AI returned WAIT — no valid setup today.' };
  const minConf   = Number($('minConf').value)   || 75;
  const minRR     = Number($('minRR').value)      || 2.5;
  const minTarget = Number($('minTarget').value)  || 60;
  const fails = [];
  if ((sig.confidence || 0) < minConf)   fails.push(`Confidence ${sig.confidence}% < ${minConf}% minimum`);
  if ((sig.rr || 0)         < minRR)     fails.push(`R:R ${sig.rr}R < ${minRR}R minimum`);
  if ((sig.targetPts || 0)  < minTarget) fails.push(`Target ${sig.targetPts}pts < ${minTarget}pt minimum`);
  if (fails.length) return { pass: false, reason: '⛔ SIGNAL REJECTED:\n' + fails.join('\n') };
  return { pass: true };
}

function recordTrade(bias, result, scenarioId) {
  syncDayState();
  state.day.trades.push({ bias, result, scenarioId: scenarioId || state.scenarioId || 0, time: nowStamp() });
  state.day.tradeActive = false;
  localStorage.setItem('px_day_trades', JSON.stringify(state.day.trades));
  renderDayPanel();
  // Check if this setup is now locked after 3 losses
  if (result === 'loss' && scenarioId) {
    const left = setupAttemptsLeft(scenarioId, bias);
    if (left === 0) fireExitAlert('locked', `Setup S${scenarioId} ${bias} LOCKED`, `Stopped out 3 times on this setup today. No more entries on S${scenarioId} ${bias}.`, '');
  }
}

function openTrade() {
  state.day.tradeActive    = true;
  state._tradeOpenedAt     = Date.now();
  state._preEntryInvShown  = false;  // reset invalidation flag
  renderDayPanel();
}

function renderDayPanel() {
  syncDayState();
  const taken  = state.day.trades.length;
  const active = state.day.tradeActive;
  const left   = tradesLeft();

  $('tradeCountPill').textContent = taken + (active ? '+1' : '') + ' / 4';
  $('tradeCountPill').className   = left === 0 ? 'pill red-pill' : active ? 'pill blue-pill' : 'pill green-pill';

  // Fill slots
  for (let i = 1; i <= 4; i++) {
    const slot = $('slot' + i);
    const t    = state.day.trades[i - 1];
    if (t) {
      slot.className = 'slot ' + (t.result === 'win' ? 'win' : t.result === 'loss' ? 'loss' : 'win');
      slot.title     = `Trade ${i}: ${t.bias} @ ${t.time}`;
    } else if (active && i === taken + 1) {
      slot.className = 'slot open';
      slot.title     = 'Trade in progress';
    } else {
      slot.className = 'slot empty';
      slot.title     = '';
    }
  }

  $('activeTradeBanner').style.display  = active            ? 'flex'  : 'none';
  $('limitReachedBanner').style.display = left === 0 && !active ? 'block' : 'none';

  // Gate status
  const gs = $('gateStatus');
  if (left === 0 && !active) {
    gs.textContent = '🚫 Daily limit reached'; gs.className = 'gate-status red';
  } else if (active) {
    gs.textContent = '🔒 Trade active — all gates locked'; gs.className = 'gate-status yellow';
  } else {
    gs.textContent = '✅ Ready — ' + left + ' trade' + (left === 1 ? '' : 's') + ' left today'; gs.className = 'gate-status green';
  }
}

// ─── Trading Mode — bot on/off toggle ────────────────────────────────────────
function toggleTradingMode() {
  state.tradingMode = !state.tradingMode;
  renderTradingMode();
  if (state.tradingMode) {
    showToast('🟢 Trading Mode ON — bot is actively scanning', 'info');
    if (state.tl?.connected) startAutoSignalEngine();
  } else {
    showToast('🔴 Trading Mode OFF — bot paused', 'warn');
    stopAutoSignalEngine();
  }
}

function renderTradingMode() {
  const btn   = $('tradingModeBtn');
  const pulse = $('botScanPulse');
  if (!btn) return;
  if (state.tradingMode) {
    btn.textContent = '⬤ BOT: ON';
    btn.className   = 'trading-mode-btn on';
    if (pulse) pulse.style.display = 'inline-flex';
  } else {
    btn.textContent = '⭘ BOT: OFF';
    btn.className   = 'trading-mode-btn off';
    if (pulse) pulse.style.display = 'none';
  }
}

// Call when AI signal starts/ends so pulse reflects actual scan state
function setBotScanning(scanning) {
  const pulse = $('botScanPulse');
  if (!pulse) return;
  if (state.tradingMode && scanning) {
    pulse.style.display = 'inline-flex';
    pulse.textContent   = '● SCANNING';
    pulse.style.color   = 'var(--green)';
  } else if (state.tradingMode) {
    pulse.textContent = '● WATCHING';
    pulse.style.color = 'var(--muted)';
  } else {
    pulse.style.display = 'none';
  }
}

function resetDay() {
  if (!confirm('Reset today\'s trade counter? Only do this for a new genuine session.')) return;
  state.day.trades      = [];
  state.day.tradeActive = false;
  state.day.key         = todayKey();
  localStorage.setItem('px_day_trades', '[]');
  clearTradeBox();
  renderDayPanel();
}

// ─── Sim Data Generation ──────────────────────────────────────────────────────
// 5-min candles covering 20 ET hours (Asia open 8pm → NY close 4pm next day)
// Candle 0 = 8pm ET. Total = 20*12 = 240 candles.
function buildCandles(scenarioId) {
  const candles = [];
  // Seed at live TL quote price if available, otherwise use last known sim price
  const liveBase = window._tlLivePrice || state?.candles?.at(-1)?.close || null;
  let p = liveBase ? liveBase + (Math.random() - 0.5) * 100
                   : 21820 + (Math.random() - 0.5) * 300;
  const vol = 16; // typical NQ 5-min range in points

  // Decide Asia direction for S1/S2
  const asiaDir = Math.random() > 0.5 ? 1 : -1;
  state.asiaBias = asiaDir > 0 ? 'BUY' : 'SELL';

  for (let i = 0; i < 240; i++) {
    // ET hour: starts at 20 (8pm), wraps at 24→0
    const etH = ((20 + i * 5 / 60) % 24);
    let drift = (Math.random() - 0.49) * vol * 0.25;

    // ── Asia (8pm–2am ET, i=0–72) ────────────────────────────────────────────
    if (i < 72) {
      if (scenarioId === 1) {
        // Asia makes a clear directional move
        drift += asiaDir * (1.2 + Math.random() * 0.8);
      } else {
        // Asia consolidates (choppy, small drift)
        drift += (Math.random() - 0.5) * 1.5;
      }
    }

    // ── London (2am–8am ET, i=72–144) ────────────────────────────────────────
    else if (i < 144) {
      const londonProg = (i - 72) / 72; // 0→1
      if (scenarioId === 1) {
        // London CONSOLIDATES — tighten range around current price
        drift *= 0.3;
        drift += (Math.random() - 0.5) * 0.8;
      } else if (scenarioId === 2) {
        // London directional WITH Asia sweep (poke outside Asia range first, then continue)
        const londonDir = Math.random() > 0.5 ? 1 : -1;
        if (londonProg < 0.2) drift += londonDir * 4; // sweep Asia extreme
        else drift += londonDir * (1.5 + londonProg * 1.5);
        state._londonDir2 = londonDir;
      } else if (scenarioId === 3) {
        // London directional WITHOUT sweeping Asia
        const londonDir = Math.random() > 0.5 ? 1 : -1;
        drift += londonDir * (1.2 + londonProg * 2);
        if (!state._londonDir3) state._londonDir3 = londonDir;
      } else if (scenarioId === 4) {
        // Search & Destroy: London sweeps BOTH sides
        const phase = londonProg < 0.35 ? 1 : londonProg < 0.65 ? -1 : 1;
        drift += phase * (2 + Math.random() * 2);
      }
    }

    // ── NY Open (8am–10:30am ET, i=144–180) ──────────────────────────────────
    else if (i < 180) {
      const nyProg = (i - 144) / 36;
      if (scenarioId === 1) {
        // Sweep London range briefly then continue Asia direction
        if (nyProg < 0.15) drift += -asiaDir * 3; // quick London sweep
        else drift += asiaDir * (2 + nyProg * 2);
      } else if (scenarioId === 2) {
        const ld = state._londonDir2 || 1;
        drift += ld * (1.5 + nyProg * 2);
      } else if (scenarioId === 3) {
        const ld = state._londonDir3 || 1;
        // NY reverses London — strong move opposite direction
        drift += -ld * (2.5 + nyProg * 3);
      } else if (scenarioId === 4) {
        // Broadening: NY also sweeps both sides
        const phase = nyProg < 0.4 ? 1 : -1;
        drift += phase * (2.5 + Math.random() * 2);
      }
    }

    // ── NY Afternoon (10:30am–4pm) ────────────────────────────────────────────
    else {
      drift += (Math.random() - 0.5) * vol * 0.4;
    }

    const open  = p;
    const close = Math.max(1000, open + drift + (Math.random() - 0.5) * vol * 0.6);
    const high  = Math.max(open, close) + Math.random() * vol * 0.5;
    const low   = Math.min(open, close) - Math.random() * vol * 0.5;
    // Synthetic unix timestamp: start 20h ago from now, +5min per bar
    const simBaseTs = Math.floor(Date.now() / 1000) - (240 - i) * 300;
    candles.push({ time: simBaseTs, open, high, low, close, volume: 500 + Math.random() * 2800, etH, idx: i });
    p = close;
  }

  // Clean up temp vars
  delete state._londonDir2;
  delete state._londonDir3;
  return candles;
}

// ─── Session Range Extraction ─────────────────────────────────────────────────
function sessionRange(candles, startH, endH) {
  const sub = candles.filter(c => {
    const h = c.etH;
    if (startH >= 20) return h >= startH || h < (endH % 24);
    return h >= startH && h < endH;
  });
  if (!sub.length) return { high: 0, low: 0, range: 0, open: 0, close: 0 };
  const high  = Math.max(...sub.map(c => c.high));
  const low   = Math.min(...sub.map(c => c.low));
  return { high, low, range: +(high - low).toFixed(2), open: sub[0].open, close: sub.at(-1).close };
}

// ─── Manipulation Leg Detection ──────────────────────────────────────────────
// Finds the LIQUIDITY SWEEP leg London made against Asia H/L.
// The fib is drawn on THIS leg — 0.618-0.705 OTE is your entry.
// The opposite Asia extreme is the target (next liquidity pool).
function detectManipulationLeg(asia, london) {
  if (!asia.high || !london.high) return null;
  const buf = 1.5;  // 1.5 pt buffer to filter noise
  const sweptHigh = london.high > asia.high + buf;
  const sweptLow  = london.low  < asia.low  - buf;

  if (sweptLow && !sweptHigh) {
    // London swept BELOW Asia Low = manipulation DOWN → price should reverse UP
    // Draw fib: legLow = London low (the sweep, 0% on BUY fib)
    //           legHigh = Asia high (the opposite pool, 100%)
    // OTE 0.618-0.705 from the LOW = BUY entry zone
    // Target = Asia High (next liquidity above)
    return {
      bias:    'BUY',
      legHigh: asia.high,             // top of the manipulation leg / target pool
      legLow:  london.low,            // bottom of sweep = stop goes below here
      sweepPt: london.low,
      target:  asia.high,             // first target = Asia High
      stop:    +(london.low - 10).toFixed(2),
      asiaH:   asia.high,
      asiaL:   asia.low,
    };
  }

  if (sweptHigh && !sweptLow) {
    // London swept ABOVE Asia High = manipulation UP → price should reverse DOWN
    // Draw fib: legHigh = London high (the sweep, 0% on SELL fib)
    //           legLow = Asia low (the opposite pool, 100%)
    // OTE 0.618-0.705 from the HIGH = SELL entry zone
    // Target = Asia Low (next liquidity below)
    return {
      bias:    'SELL',
      legHigh: london.high,           // top of sweep = stop goes above here
      legLow:  asia.low,              // bottom of the manipulation leg / target pool
      sweepPt: london.high,
      target:  asia.low,              // first target = Asia Low
      stop:    +(london.high + 10).toFixed(2),
      asiaH:   asia.high,
      asiaL:   asia.low,
    };
  }

  return null;  // no clean single-sided sweep
}

// ─── Scenario Detection ───────────────────────────────────────────────────────
function detectScenario(candles) {
  const asia   = sessionRange(candles, 20, 26); // 8pm–2am ET
  const london = sessionRange(candles, 2, 8);   // 2am–8am ET

  if (!asia.high || !london.high) return { id: 0 };

  const asiaRange   = asia.range;
  const londonRange = london.range;

  // Was Asia directional? (net move > 40% of range = trending)
  const asiaNetMove   = Math.abs(asia.close - asia.open);
  const asiaDirectional = asiaNetMove / Math.max(1, asiaRange) > 0.38;
  const asiaDir = asia.close > asia.open ? 'BUY' : 'SELL';

  // Did London sweep BOTH sides of Asia?
  const sweptAsiaHigh = london.high > asia.high;
  const sweptAsiaLow  = london.low  < asia.low;
  const sweptBothSides = sweptAsiaHigh && sweptAsiaLow;

  // London directional? (net move > 45% of London range)
  const londonNetMove     = Math.abs(london.close - london.open);
  const londonDirectional = londonNetMove / Math.max(1, londonRange) > 0.40;
  const londonDir = london.close > london.open ? 'BUY' : 'SELL';

  // London is "consolidating" vs Asia if London range < 55% of Asia range
  const londonConsolidates = londonRange < asiaRange * 0.55;

  let id = 0;
  let fibHigh = london.high, fibLow = london.low, fibBias = 'BUY';
  let asiaBias = asiaDir;

  if (sweptBothSides && !asiaDirectional) {
    // Search & Destroy
    id = 4;
    fibHigh = Math.max(london.high, asia.high);
    fibLow  = Math.min(london.low,  asia.low);
    fibBias = 'WAIT';
  } else if (asiaDirectional && londonConsolidates) {
    // NY Continuation
    id = 1;
    fibHigh = london.high;
    fibLow  = london.low;
    fibBias = asiaDir;
  } else if (!asiaDirectional && londonDirectional && (sweptAsiaHigh || sweptAsiaLow)) {
    // NY Consolidation — London swept Asia then continued
    id = 2;
    fibHigh = london.high;
    fibLow  = london.low;
    fibBias = londonDir;
  } else if (!asiaDirectional && londonDirectional && !sweptAsiaHigh && !sweptAsiaLow) {
    // NY Reversal — London moved WITHOUT sweeping Asia
    id = 3;
    fibHigh = london.high;
    fibLow  = london.low;
    fibBias = londonDir === 'BUY' ? 'SELL' : 'BUY'; // opposite London for reversal
  } else {
    // Default fallback: treat as NY Continuation with best guess
    id = 1;
    fibHigh = london.high;
    fibLow  = london.low;
    fibBias = londonDir;
  }

  // ── Override with precise manipulation leg when available ──────────────────
  // ICT core principle: fib goes on the MANIPULATION LEG, not just London range.
  // If London swept one side of Asia, that sweep IS the manipulation leg.
  const manip = detectManipulationLeg(asia, london);
  if (manip && id !== 4) {
    fibHigh = manip.legHigh;
    fibLow  = manip.legLow;
    fibBias = manip.bias;
  }

  return { id, fibHigh, fibLow, fibBias, asiaBias, asia, london, manip };
}

// ─── Fib Levels ───────────────────────────────────────────────────────────────
function calcFibs(high, low, bias) {
  const range = high - low;
  return FIBS.map(f => {
    const price = bias === 'BUY' || bias === 'WAIT'
      ? high - f.r * range
      : low  + f.r * range;
    return { ...f, price: +price.toFixed(2) };
  });
}

// ─── Risk ─────────────────────────────────────────────────────────────────────
function renderRisk() {
  const acct    = Number($('accountSize').value) || 0;
  const riskPct = Number($('riskPct').value) || 0;
  const stopPts = Number($('stopPts').value) || 1;
  const riskDol = acct * riskPct / 100;
  const stopPerC = stopPts * NQ_PT_VAL;
  const contracts = Math.max(0, Math.floor(riskDol / stopPerC));
  $('riskDollars').textContent = '$' + fmt(riskDol, 0);
  $('contracts').textContent   = contracts + ' contracts';
  $('stopValue').textContent   = '$' + fmt(stopPerC, 0) + ' / contract';
}

// ─── Chart — dual-chart architecture ─────────────────────────────────────────
// TV widget = live chart in #chart div (always)
// LWC chart = replay/overlay chart in #chartReplay div (only during replay)
let lwChart      = null;
let candleSeries = null;
let volSeries    = null;
const _plines    = {};

// Initialize LightweightCharts in the given container element (used by replay)
function initLWCChart(container) {
  if (!window.LightweightCharts) { console.error('[PXBOT] LightweightCharts not loaded'); return; }
  if (lwChart) { try { lwChart.remove(); } catch(_){} lwChart = null; candleSeries = null; volSeries = null; }
  container.innerHTML = '';
  lwChart = LightweightCharts.createChart(container, {
    width:  container.clientWidth  || 900,
    height: container.clientHeight || 500,
    layout: { background: { color: '#10131a' }, textColor: '#8892a4' },
    grid:   { vertLines: { color: '#1a1f2e' }, horzLines: { color: '#1a1f2e' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#2d3442' },
    timeScale: { borderColor: '#2d3442', timeVisible: true, secondsVisible: false,
                 rightOffset: 8, barSpacing: 8 },
  });
  candleSeries = lwChart.addCandlestickSeries({
    upColor: '#35d27f', downColor: '#ff5368',
    borderUpColor: '#35d27f', borderDownColor: '#ff5368',
    wickUpColor: '#35d27f', wickDownColor: '#ff5368',
  });
  volSeries = lwChart.addHistogramSeries({
    color: 'rgba(53,210,127,0.25)', priceFormat: { type: 'volume' },
    priceScaleId: '', scaleMargins: { top: 0.82, bottom: 0 },
  });
  // Keep LWC sized correctly on window resize during replay
  const ro = new ResizeObserver(() => {
    if (lwChart && container.clientWidth > 0) {
      lwChart.resize(container.clientWidth, container.clientHeight || 500);
    }
  });
  ro.observe(container);
  container._lwRO = ro;
}

function destroyLWCChart() {
  const container = $('chartReplay');
  if (container?._lwRO) { container._lwRO.disconnect(); delete container._lwRO; }
  if (lwChart) { try { lwChart.remove(); } catch(_){} }
  lwChart = null; candleSeries = null; volSeries = null;
  Object.keys(_plines).forEach(k => delete _plines[k]);
}

// ── Trade Box Plugin — draws SL/TP zones exactly like TradeLocker ─────────────
class TradeBoxRenderer {
  constructor() { this._data = null; this._series = null; }
  draw(target) {
    if (!this._data || !this._series) return;
    const d = this._data;
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, verticalPixelRatio, horizontalPixelRatio }) => {
      const W = bitmapSize.width;
      const H = bitmapSize.height;
      const toY = p => {
        const c = this._series.priceToCoordinate(p);
        if (c === null || c === undefined) return null;
        const y = Math.round(c * verticalPixelRatio);
        // Clamp strictly to visible chart area — prevents infinite box extension
        return (y < -H || y > 2 * H) ? null : Math.max(-2, Math.min(H + 2, y));
      };
      const entryY = toY(d.entryMid);
      const stopY  = toY(d.stop);
      const tp1Y   = d.tp1 ? toY(d.tp1) : null;
      const tp2Y   = toY(d.tp2);
      const tp3Y   = d.tp3 ? toY(d.tp3) : null;
      const oteHiY = toY(d.entryHigh);
      const oteLoY = toY(d.entryLow);
      if (entryY === null || stopY === null || tp2Y === null) return;
      const isLong = d.bias === 'BUY';

      // ── Stop loss zone (red box) ──────────────────────────────────────────────
      ctx.fillStyle = 'rgba(255,83,104,0.14)';
      const slTop = Math.min(entryY, stopY), slH = Math.abs(stopY - entryY);
      ctx.fillRect(0, slTop, W, slH);
      // Stop border
      ctx.strokeStyle = 'rgba(255,83,104,0.6)';
      ctx.lineWidth   = Math.round(1.5 * horizontalPixelRatio);
      ctx.beginPath(); ctx.moveTo(0, stopY); ctx.lineTo(W, stopY); ctx.stroke();

      // ── TP1 sub-zone (lighter green) ─────────────────────────────────────────
      if (tp1Y !== null) {
        ctx.fillStyle = 'rgba(53,210,127,0.09)';
        const t = Math.min(entryY, tp1Y), h = Math.abs(tp1Y - entryY);
        ctx.fillRect(0, t, W, h);
        // TP1 dashed line
        ctx.strokeStyle = 'rgba(245,184,75,0.7)';
        ctx.lineWidth   = Math.round(1 * horizontalPixelRatio);
        ctx.setLineDash([6 * horizontalPixelRatio, 4 * horizontalPixelRatio]);
        ctx.beginPath(); ctx.moveTo(0, tp1Y); ctx.lineTo(W, tp1Y); ctx.stroke();
        ctx.setLineDash([]);
      }

      // ── TP2 zone (full green box, entry to TP2) ───────────────────────────────
      ctx.fillStyle = 'rgba(53,210,127,0.13)';
      const tpTop = Math.min(entryY, tp2Y), tpH = Math.abs(tp2Y - entryY);
      ctx.fillRect(0, tpTop, W, tpH);
      // TP2 solid border
      ctx.strokeStyle = 'rgba(53,210,127,0.8)';
      ctx.lineWidth   = Math.round(1.5 * horizontalPixelRatio);
      ctx.beginPath(); ctx.moveTo(0, tp2Y); ctx.lineTo(W, tp2Y); ctx.stroke();

      // ── TP3 dashed line ───────────────────────────────────────────────────────
      if (tp3Y !== null) {
        ctx.strokeStyle = 'rgba(83,167,255,0.6)';
        ctx.lineWidth   = Math.round(1 * horizontalPixelRatio);
        ctx.setLineDash([4 * horizontalPixelRatio, 6 * horizontalPixelRatio]);
        ctx.beginPath(); ctx.moveTo(0, tp3Y); ctx.lineTo(W, tp3Y); ctx.stroke();
        ctx.setLineDash([]);
      }

      // ── OTE entry zone (highlighted band) ────────────────────────────────────
      if (oteHiY !== null && oteLoY !== null) {
        const oteCol = isLong ? 'rgba(53,210,127,0.18)' : 'rgba(255,83,104,0.18)';
        ctx.fillStyle = oteCol;
        const oTop = Math.min(oteHiY, oteLoY), oH = Math.abs(oteLoY - oteHiY);
        ctx.fillRect(0, oTop, W, Math.max(oH, 2 * verticalPixelRatio));
        // OTE border lines
        const oteLineCol = isLong ? 'rgba(53,210,127,0.5)' : 'rgba(255,83,104,0.5)';
        ctx.strokeStyle = oteLineCol;
        ctx.lineWidth   = Math.round(1 * horizontalPixelRatio);
        ctx.setLineDash([3 * horizontalPixelRatio, 4 * horizontalPixelRatio]);
        [oteHiY, oteLoY].forEach(y => {
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        });
        ctx.setLineDash([]);
      }

      // ── Entry mid line (amber) ────────────────────────────────────────────────
      ctx.strokeStyle = 'rgba(245,184,75,0.9)';
      ctx.lineWidth   = Math.round(2 * horizontalPixelRatio);
      ctx.setLineDash([8 * horizontalPixelRatio, 4 * horizontalPixelRatio]);
      ctx.beginPath(); ctx.moveTo(0, entryY); ctx.lineTo(W, entryY); ctx.stroke();
      ctx.setLineDash([]);

      // ── Right-side labels ─────────────────────────────────────────────────────
      const fs = Math.round(10 * verticalPixelRatio);
      ctx.font = `bold ${fs}px Inter,system-ui,sans-serif`;
      ctx.textAlign = 'right';
      const pad = 6 * horizontalPixelRatio;
      const lx  = W - pad;

      const drawLabel = (y, text, bg, fg) => {
        if (y === null) return;
        const tw = ctx.measureText(text).width + 8 * horizontalPixelRatio;
        const th = fs + 6 * verticalPixelRatio;
        ctx.fillStyle = bg;
        ctx.beginPath();
        ctx.roundRect(lx - tw, y - th / 2, tw, th, 3 * horizontalPixelRatio);
        ctx.fill();
        ctx.fillStyle = fg;
        ctx.fillText(text, lx - 4 * horizontalPixelRatio, y + fs * 0.35);
      };

      const stopPts  = Math.abs(d.entryMid - d.stop).toFixed(1);
      const tp2Pts   = Math.abs(d.tp2 - d.entryMid).toFixed(1);
      drawLabel(stopY,  `STOP  ${fmtP(d.stop)} (${stopPts}pts)`,  'rgba(255,83,104,0.85)',  '#fff');
      drawLabel(entryY, `ENTRY ${fmtP(d.entryMid)}`,              'rgba(245,184,75,0.9)',    '#000');
      if (tp1Y) drawLabel(tp1Y, `TP1  ${fmtP(d.tp1)}`,            'rgba(245,184,75,0.7)',    '#000');
      drawLabel(tp2Y,   `TP2  ${fmtP(d.tp2)} (+${tp2Pts}pts)`,   'rgba(53,210,127,0.85)',   '#000');
      if (tp3Y) drawLabel(tp3Y, `TP3  ${fmtP(d.tp3)}`,            'rgba(83,167,255,0.75)',   '#fff');
    });
  }
}

class TradeBoxPaneView {
  constructor(plugin) { this._plugin = plugin; this._renderer = new TradeBoxRenderer(); }
  update() { this._renderer._data = this._plugin._data; this._renderer._series = this._plugin._series; }
  renderer() { return this._renderer; }
  zOrder() { return 'bottom'; }
}

class TradeBoxPlugin {
  constructor() { this._views = [new TradeBoxPaneView(this)]; this._data = null; this._series = null; }
  attached(p)  { this._series = p.series; }
  detached()   { this._series = null; }
  updateAllViews() { this._views.forEach(v => v.update()); }
  paneViews()  { return this._views; }
  set(data)    { this._data = data; this.updateAllViews(); if (this._series) this._series.applyOptions({}); }
  clear()      { this._data = null; this.updateAllViews(); if (this._series) this._series.applyOptions({}); }
}

let _tradeBoxPlugin = null;

function showTradeBox(sig) {
  if (!candleSeries || !sig || sig.bias === 'WAIT') { clearTradeBox(); return; }
  if (!_tradeBoxPlugin) {
    _tradeBoxPlugin = new TradeBoxPlugin();
    candleSeries.attachPrimitive(_tradeBoxPlugin);
  }
  _tradeBoxPlugin.set({
    bias:      sig.bias,
    entryMid:  sig.entryMid  || (sig.entryLow + sig.entryHigh) / 2,
    entryHigh: sig.entryHigh || 0,
    entryLow:  sig.entryLow  || 0,
    stop:      sig.stop,
    tp1:       sig.tp1 || null,
    tp2:       sig.tp2 || sig.target,
    tp3:       sig.tp3 || null,
  });
}

function clearTradeBox() {
  if (_tradeBoxPlugin) { try { _tradeBoxPlugin.clear(); } catch(_){} }
}

// Map our minute-number TF to TradingView resolution string
function tvIntervalFor(tf) {
  const n = parseInt(tf) || 5;
  if (n >= 1440) return 'D';
  if (n >= 240)  return '240';
  return String(n);
}

const CHART_LOAD_MAX_RETRIES = 25; // ~5s at 200ms — after this, stop silently retrying and show an error

function initChart(retryCount) {
  retryCount = retryCount || 0;
  const container = $('chart');
  if (!container) return;
  if (typeof TradingView === 'undefined') {
    if (retryCount >= CHART_LOAD_MAX_RETRIES) {
      container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;padding:24px;text-align:center;color:#8892a4;font-size:14px;line-height:1.6">'
        + 'Chart failed to load — TradingView\'s widget script (s3.tradingview.com/tv.js) didn\'t respond.<br>'
        + 'Check your internet connection, firewall, or ad-blocker (some block *.tradingview.com), then reload this page.'
        + '</div>';
      return;
    }
    setTimeout(() => initChart(retryCount + 1), 200);
    return;
  }
  if (container.offsetWidth < 10)        { setTimeout(() => initChart(retryCount + 1), 200); return; }
  if (window._tvWidget) return; // already running

  container.innerHTML = '';

  new TradingView.widget({
    container_id:       'chart',
    autosize:           true,
    symbol:             'NASDAQ:NDX',
    interval:           tvIntervalFor(currentTF),
    timezone:           'America/Chicago',
    theme:              'dark',
    style:              '1',
    locale:             'en',
    toolbar_bg:         '#10131a',
    enable_publishing:  false,
    allow_symbol_change: true,
    withdateranges:     true,
    hide_side_toolbar:  false,
    details:            false,
    hotlist:            false,
    calendar:           false,
    show_popup_button:  false,
    save_image:         true,
    overrides: {
      'paneProperties.background':              '#10131a',
      'paneProperties.backgroundType':          'solid',
      'paneProperties.vertGridProperties.color':'#1a1f2e',
      'paneProperties.horzGridProperties.color':'#1a1f2e',
      'scalesProperties.textColor':             '#8892a4',
    },
    loading_screen: { backgroundColor: '#10131a', foregroundColor: '#53a7ff' },
    onready: function() {
      window._tvWidget = this;
      const tag = $('liveTag');
      if (tag) { tag.textContent = 'LIVE'; tag.className = 'pill green-pill'; }
      const title = $('chartTitle');
      if (title) title.textContent = 'NAS100 — Full Historical Chart (TradeLocker Data Feed)';
      const desc = $('chartDesc');
      if (desc) desc.textContent = 'Complete history from day one · Same TradingView data source as TradeLocker · Real-time prices';
    },
  });
}

// Add an AI signal arrow marker on the live TV chart
function markSignalOnTVChart(sig) {
  if (!window._tvWidget || !sig || sig.bias === 'WAIT') return;
  try {
    window._tvWidget.onChartReady(() => {
      const chart  = window._tvWidget.chart();
      const ts     = Math.floor(Date.now() / 1000);
      const isLong = sig.bias === 'BUY' || sig.bias === 'LONG';
      chart.createShape(
        { time: ts },
        {
          shape:     isLong ? 'arrow_up' : 'arrow_down',
          text:      `${sig.bias} ${sig.confidence}%  E:${sig.entry}  T:${sig.target}`,
          overrides: { arrowColor: isLong ? '#35d27f' : '#ef5350', fontsize: 11 },
        }
      );
    });
  } catch(_) {}
}

function _setPL(key, price, title, color, style=2, width=1) {
  if (!candleSeries || !price || price <= 0) return;
  try { if (_plines[key]) candleSeries.removePriceLine(_plines[key]); } catch(_){}
  try {
    _plines[key] = candleSeries.createPriceLine({ price, color, lineWidth:width, lineStyle:style, axisLabelVisible:true, title });
  } catch(_){}
}

function clearPriceLines() {
  Object.keys(_plines).forEach(k => { try { candleSeries.removePriceLine(_plines[k]); } catch(_){} delete _plines[k]; });
}

// ─── Toast notification (non-blocking, auto-dismiss) ─────────────────────────
function showToast(msg, type = 'info') {
  let wrap = document.getElementById('toastWrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'toastWrap';
    wrap.style.cssText = 'position:fixed;bottom:22px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:6px;pointer-events:none';
    document.body.appendChild(wrap);
  }
  const t = document.createElement('div');
  const bg = type === 'error' ? '#3a1c1c' : type === 'warn' ? '#2a2010' : '#11202a';
  const bd = type === 'error' ? '#ff5368' : type === 'warn' ? '#f5b84b' : '#53a7ff';
  t.style.cssText = `background:${bg};border:1px solid ${bd};color:var(--text);padding:9px 18px;border-radius:8px;font-size:13px;font-weight:500;opacity:1;transition:opacity .35s`;
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 380); }, 3200);
}

// ─── Signal history — draw past AI signals as chart markers ───────────────────
// Each entry: { bias, chartTime, scenId, entryMid, stop, target, result, outcome }
function drawSignalMarkers() {
  if (!candleSeries || !state.replay.active) return;
  // Collect base markers already set (BOS/CHoCH/session) and append signal markers on top
  const sigMarkers = [];

  // Past signals from journal with chartTime
  state.journal.slice(-30).forEach(j => {
    if (!j.chartTime) return;
    const isWin = (j.result || 0) > 0;
    const isBuy = j.bias === 'BUY';
    // Entry marker
    sigMarkers.push({
      time:     j.chartTime,
      position: isBuy ? 'belowBar' : 'aboveBar',
      color:    isBuy ? '#35d27f' : '#ff5368',
      shape:    isBuy ? 'arrowUp' : 'arrowDown',
      text:     (isBuy ? '▲' : '▼') + ' S' + (j.scenId || '?') + (j.result != null ? (isWin ? ' WIN' : ' LOSS') : ' OPEN'),
      size:     2,
    });
    // Exit marker if trade was closed
    if (j.exitChartTime && j.result != null) {
      sigMarkers.push({
        time:     j.exitChartTime,
        position: isWin ? 'aboveBar' : 'belowBar',
        color:    isWin ? '#35d27f' : '#ff5368',
        shape:    'circle',
        text:     isWin ? '+$' + Math.abs(j.result).toFixed(0) : '-$' + Math.abs(j.result).toFixed(0),
        size:     1,
      });
    }
  });

  // Active (unfilled) signal — show as pending diamond
  if (state.signal && state.signal.bias !== 'WAIT' && state.signal.chartTime && !state.day.tradeActive) {
    const isBuy = state.signal.bias === 'BUY';
    sigMarkers.push({
      time:     state.signal.chartTime,
      position: isBuy ? 'belowBar' : 'aboveBar',
      color:    '#f5b84b',
      shape:    'circle',
      text:     '◆ SIGNAL',
      size:     1,
    });
  }

  if (!sigMarkers.length) return;
  try {
    // Merge with chart markers (stored in _chartBaseMarkers after updateChart runs)
    const base   = window._chartBaseMarkers || [];
    const merged = [...base, ...sigMarkers].sort((a, b) => a.time - b.time);
    candleSeries.setMarkers(merged);
  } catch(_) {}
}

function drawChartOverlays() {
  if (!candleSeries || !state.replay.active) return;
  clearPriceLines();

  const det = detectScenario(state.candles);
  if (det.asia?.high) {
    _setPL('asiaH', det.asia.high, 'AS.H', 'rgba(167,139,250,0.8)', 2, 1);
    _setPL('asiaL', det.asia.low,  'AS.L', 'rgba(167,139,250,0.8)', 2, 1);
  }
  if (det.london?.high) {
    _setPL('lonH', det.london.high, 'LON.H', 'rgba(83,167,255,0.7)', 2, 1);
    _setPL('lonL', det.london.low,  'LON.L', 'rgba(83,167,255,0.7)', 2, 1);
  }
  if (det.manip?.sweepPt) _setPL('sweep', det.manip.sweepPt, 'SWEEP ↓', '#f5b84b', 1, 2);

  // Fib levels
  if (state.fibHigh && state.fibLow && state.fibBias !== 'WAIT') {
    calcFibs(state.fibHigh, state.fibLow, state.fibBias).forEach(f => {
      const col = f.ote ? (state.fibBias === 'BUY' ? '#26a69a' : '#ef5350') : 'rgba(55,65,90,0.9)';
      _setPL('fib_'+f.label, f.price, f.label, col, f.ote ? 0 : 2, f.ote ? 2 : 1);
    });
  }

  // EQL / EQH
  try {
    const st = detectStructure(state.candles);
    st.eqHighs.slice(-2).forEach((eq,i) => _setPL('eqh'+i, eq.price, 'EQH', 'rgba(239,83,80,0.6)',  1, 1));
    st.eqLows.slice(-2).forEach((eq,i)  => _setPL('eql'+i, eq.price, 'EQL', 'rgba(38,166,154,0.6)', 1, 1));
  } catch(_){}

  // Trade box handles signal levels visually — just need the current price line
  const last = state.candles.at(-1);
  if (last?.close) _setPL('live', last.close, '', '#f5b84b', 2, 1);

  // Draw past signal entry/exit markers on the chart
  drawSignalMarkers();
}

function _toSortedLWCBars(candles) {
  const seen = new Set();
  return candles
    .filter(c => c.time && c.close > 0)
    .map(c => ({
      time:  c.time,
      open:  +Number(c.open).toFixed(2),
      high:  +Number(c.high).toFixed(2),
      low:   +Number(c.low).toFixed(2),
      close: +Number(c.close).toFixed(2),
      vol:   c.volume || 0,
    }))
    .sort((a, b) => a.time - b.time)
    .filter(b => { if (seen.has(b.time)) return false; seen.add(b.time); return true; });
}

function updateChart(candles) {
  // Live mode: TV widget owns the chart — no LWC ops needed
  if (!state.replay.active) { return; }
  // Replay mode: LWC chart must be ready
  if (!lwChart || !candleSeries) return;
  if (!candles?.length) return;

  const bars = _toSortedLWCBars(candles);
  if (!bars.length) return;

  candleSeries.setData(bars.map(b => ({ time:b.time, open:b.open, high:b.high, low:b.low, close:b.close })));
  volSeries.setData(bars.map(b => ({ time:b.time, value:b.vol, color: b.close>=b.open?'rgba(53,210,127,0.25)':'rgba(255,83,104,0.25)' })));

  // Session markers (BOS / CHoCH / session labels)
  try {
    const struct = detectStructure(candles);
    const markers = [];

    // Session boundary markers
    let lastSess = '';
    bars.forEach(b => {
      const et = new Date(new Date(b.time*1000).toLocaleString('en-US',{timeZone:'America/Chicago'}));
      const h  = et.getHours() + et.getMinutes()/60;
      let sess = '';
      if (h >= 19 || h < 1)         sess = 'ASIA';
      else if (h >= 1  && h < 6.5)  sess = 'LONDON';
      else if (h >= 8.5 && h < 9.5) sess = 'NY OPEN';
      else if (h >= 9.5 && h < 16)  sess = 'NY';
      if (sess && sess !== lastSess) {
        markers.push({ time:b.time, position:'aboveBar', color: sess==='ASIA'?'#7c6fcd':sess==='LONDON'?'#4a8fd4':sess==='NY OPEN'?'#35d27f':'#2d7a4f', shape:'arrowDown', text:sess });
        lastSess = sess;
      }
    });

    // CHOCH markers
    struct.chochPoints.slice(-4).forEach(ch => {
      const bar = bars.find(b => b.time >= (candles[ch.idx]?.time||0));
      if (bar) markers.push({ time:bar.time, position: ch.type==='CHOCH_UP'?'belowBar':'aboveBar', color:ch.type==='CHOCH_UP'?'#35d27f':'#ff5368', shape:'circle', text:'CHoCH' });
    });
    // BOS markers
    struct.bosPoints.slice(-5).forEach(bos => {
      const bar = bars.find(b => b.time >= (candles[bos.idx]?.time||0));
      if (bar) markers.push({ time:bar.time, position: bos.type==='BOS_UP'?'belowBar':'aboveBar', color:bos.type==='BOS_UP'?'rgba(53,210,127,0.7)':'rgba(255,83,104,0.7)', shape:'circle', text:'BOS' });
    });

    markers.sort((a,b) => a.time - b.time);
    window._chartBaseMarkers = markers; // stored so drawSignalMarkers() can merge into them
    candleSeries.setMarkers(markers);
  } catch(_){}

  drawChartOverlays();
  // scrollToRealTime is only called on initial load and TF switch, NOT here
  // so the user can freely scroll back to look at older bars without being snapped forward
}

// Real-time tick — called from SSE stream, updates last bar or appends new one
function updateChartTick(price) {
  // In live mode the TV widget handles price display; we only monitor trade exits
  if (!state.replay.active) {
    if (state.day.tradeActive && state.signal) monitorActiveTrade(price);
    return;
  }
  if (!candleSeries || !state.candles.length) return;
  const last = state.candles.at(-1);
  if (!last?.time) return;

  const p           = +Number(price).toFixed(2);
  const tfSecs      = (parseInt(currentTF) || 5) * 60;
  const nowSec      = Math.floor(Date.now() / 1000);
  // Use TL bar timestamps directly: next bar opens exactly tfSecs after the last TL bar
  // This stays in sync regardless of UTC/session alignment quirks
  const nextBarTime = last.time + tfSecs;

  if (nowSec >= nextBarTime) {
    // ── New candle just started — open it at the exact next TL bar boundary ──
    const etDt = new Date(new Date(nextBarTime * 1000).toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    const newBar = {
      time: nextBarTime, open: p, high: p, low: p, close: p, volume: 0,
      etH: etDt.getHours() + etDt.getMinutes() / 60,
    };
    state.candles.push(newBar);
    try { candleSeries.update({ time: nextBarTime, open: p, high: p, low: p, close: p }); } catch(_){}
    try { volSeries.update({ time: nextBarTime, value: 0, color: 'rgba(38,166,154,0.25)' }); } catch(_){}
    drawChartOverlays();
  } else {
    // ── Update current candle in-place ─────────────────────────────────────────
    last.close = p;
    last.high  = Math.max(last.high, p);
    last.low   = Math.min(last.low,  p);
    try {
      candleSeries.update({ time: last.time, open: +Number(last.open).toFixed(2), high: +Number(last.high).toFixed(2), low: +Number(last.low).toFixed(2), close: p });
    } catch(_){}
  }

  // Keep the live price line on the right scale
  _setPL('live', p, '', '#f5b84b', 2, 1);

  // Exit monitor
  if (state.day.tradeActive && state.signal) monitorActiveTrade(p);
}

// Backwards-compat shim — everything still calls drawChart()
function drawChart() {
  updateChart(state.replay.active ? state.candles.slice(0, state.replay.cursor) : state.candles);
}

// Legacy canvas drawChart — replaced (kept as comment block start marker)
function _drawChartLEGACY_REMOVED() {
  const canvas = $('chart');
  const shell  = canvas.parentElement;
  const dpr    = window.devicePixelRatio || 1;
  canvas.width  = shell.clientWidth  * dpr;
  canvas.height = shell.clientHeight * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = shell.clientWidth, H = shell.clientHeight;

  ctx.fillStyle = '#10131a';
  ctx.fillRect(0, 0, W, H);

  const rows = state.replay.active
    ? state.candles.slice(0, state.replay.cursor)
    : state.candles.slice(-120);

  if (!rows.length) return;

  const maxP = Math.max(...rows.map(c => c.high));
  const minP = Math.min(...rows.map(c => c.low));
  const pad  = (maxP - minP) * 0.08;
  const yHi  = maxP + pad, yLo = minP - pad;
  const toY  = p => H - 24 - ((p - yLo) / Math.max(1, yHi - yLo)) * (H - 48);
  const cw   = Math.max(3, (W - 72) / rows.length);

  // Grid
  ctx.strokeStyle = '#1e2432'; ctx.lineWidth = 1;
  for (let i = 0; i < 6; i++) {
    const yy = 16 + i * ((H - 32) / 5);
    ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(W, yy); ctx.stroke();
    const price = yHi - i * (yHi - yLo) / 5;
    ctx.fillStyle = '#556'; ctx.font = '10px Inter,sans-serif';
    ctx.fillText(fmtP(price), 4, yy - 3);
  }

  // Session shading + labels
  let lastLbl = '';
  rows.forEach((c, i) => {
    const x = 36 + i * cw;
    const h = c.etH;
    let col = null, lbl = null;
    if (h >= 20 || h < 2)            { col = SESSION_DEF.asia.canvasCol;   lbl = 'ASIA'; }
    else if (h >= 2  && h < 8)       { col = SESSION_DEF.london.canvasCol; lbl = 'LONDON'; }
    else if (h >= 8  && h < 10.5)    { col = SESSION_DEF.nyopen.canvasCol; lbl = 'NY OPEN'; }
    else if (h >= 10.5 && h < 16)    { col = SESSION_DEF.ny.canvasCol;     lbl = 'NY'; }

    if (col) { ctx.fillStyle = col; ctx.fillRect(x, 0, cw, H); }
    if (lbl && lbl !== lastLbl) {
      ctx.strokeStyle = '#2e3650'; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#5a6480'; ctx.font = '10px Inter,sans-serif';
      ctx.fillText(lbl, x + 3, 12);
      lastLbl = lbl;
    }
  });

  // Asia H/L horizontal lines — liquidity pools / targets
  const det0 = detectScenario(rows);
  if (det0.asia && det0.asia.high) {
    const drawAsiaLine = (price, label, isHigh) => {
      if (price < yLo || price > yHi) return;
      const yy = toY(price);
      const col = isHigh ? 'rgba(167,139,250,0.7)' : 'rgba(167,139,250,0.7)';
      ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(36, yy); ctx.lineTo(W - 16, yy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(167,139,250,0.9)'; ctx.font = 'bold 9px Inter,sans-serif';
      ctx.fillText(label + ' ' + fmtP(price), W - 100, yy - 3);
    };
    drawAsiaLine(det0.asia.high, 'AS.H', true);
    drawAsiaLine(det0.asia.low,  'AS.L', false);
    // London H/L in blue
    if (det0.london && det0.london.high) {
      const drawLondonLine = (price, label) => {
        if (price < yLo || price > yHi) return;
        const yy = toY(price);
        ctx.strokeStyle = 'rgba(83,167,255,0.5)'; ctx.lineWidth = 1; ctx.setLineDash([3, 6]);
        ctx.beginPath(); ctx.moveTo(36, yy); ctx.lineTo(W - 16, yy); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(83,167,255,0.8)'; ctx.font = '9px Inter,sans-serif';
        ctx.fillText(label + ' ' + fmtP(price), W - 100, yy - 3);
      };
      drawLondonLine(det0.london.high, 'LON.H');
      drawLondonLine(det0.london.low,  'LON.L');
    }
    // Manipulation sweep point highlight (yellow dot line)
    if (det0.manip) {
      const sweepY = toY(det0.manip.sweepPt);
      ctx.strokeStyle = '#f5b84b'; ctx.lineWidth = 1.5; ctx.setLineDash([2, 4]);
      ctx.beginPath(); ctx.moveTo(36, sweepY); ctx.lineTo(W - 16, sweepY); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#f5b84b'; ctx.font = 'bold 9px Inter,sans-serif';
      ctx.fillText('SWEEP ' + fmtP(det0.manip.sweepPt), W - 105, sweepY - 3);
    }
  }

  // Fib lines
  if (state.fibHigh && state.fibLow && state.fibBias !== 'WAIT') {
    const fibs = calcFibs(state.fibHigh, state.fibLow, state.fibBias);
    const ote  = fibs.filter(f => f.ote);
    if (ote.length === 2) {
      const yTop = toY(Math.max(ote[0].price, ote[1].price));
      const yBot = toY(Math.min(ote[0].price, ote[1].price));
      ctx.fillStyle = 'rgba(83,167,255,0.09)';
      ctx.fillRect(36, yTop, W - 52, Math.max(2, yBot - yTop));
    }
    fibs.forEach(f => {
      const yy = toY(f.price);
      ctx.strokeStyle = f.ote ? (state.fibBias === 'BUY' ? '#35d27f' : '#ff5368') : '#2a3040';
      ctx.lineWidth = f.ote ? 1.5 : 1;
      ctx.setLineDash(f.ote ? [] : [4, 6]);
      ctx.beginPath(); ctx.moveTo(36, yy); ctx.lineTo(W - 16, yy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = f.ote ? '#eef3fb' : '#556';
      ctx.font = f.ote ? 'bold 10px Inter,sans-serif' : '10px Inter,sans-serif';
      ctx.fillText(f.label + ' ' + fmtP(f.price), W - 110, yy - 3);
    });
  }

  // ── Market Structure Annotations (BOS / CHOCH / EQH / EQL) ─────────────────
  try {
    const struct = detectStructure(rows);
    // Draw EQL / EQH as horizontal dotted lines (liquidity pools)
    struct.eqHighs.slice(-3).forEach(eq => {
      if (eq.price < yLo || eq.price > yHi) return;
      const yy = toY(eq.price);
      ctx.strokeStyle = 'rgba(255,83,104,0.5)'; ctx.lineWidth = 1; ctx.setLineDash([2, 5]);
      ctx.beginPath(); ctx.moveTo(36, yy); ctx.lineTo(W - 16, yy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,83,104,0.7)'; ctx.font = '9px Inter,sans-serif';
      ctx.fillText('EQH ' + fmtP(eq.price), W - 108, yy - 3);
    });
    struct.eqLows.slice(-3).forEach(eq => {
      if (eq.price < yLo || eq.price > yHi) return;
      const yy = toY(eq.price);
      ctx.strokeStyle = 'rgba(53,210,127,0.5)'; ctx.lineWidth = 1; ctx.setLineDash([2, 5]);
      ctx.beginPath(); ctx.moveTo(36, yy); ctx.lineTo(W - 16, yy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(53,210,127,0.7)'; ctx.font = '9px Inter,sans-serif';
      ctx.fillText('EQL ' + fmtP(eq.price), W - 108, yy + 10);
    });
    // Draw BOS labels on swing points
    struct.bosPoints.slice(-5).forEach(bos => {
      const idx = Math.min(rows.length - 1, bos.idx);
      const x   = 36 + idx * cw;
      const yy  = bos.type === 'BOS_UP' ? toY(bos.price) - 12 : toY(bos.price) + 14;
      if (yy < 10 || yy > H - 10) return;
      ctx.fillStyle = bos.type === 'BOS_UP' ? 'rgba(53,210,127,0.8)' : 'rgba(255,83,104,0.8)';
      ctx.font = 'bold 8px Inter,sans-serif';
      ctx.fillText('BOS', x - 6, yy);
    });
    // Draw CHOCH labels — more prominent (these are the reversal signals)
    struct.chochPoints.slice(-3).forEach(choch => {
      const idx = Math.min(rows.length - 1, choch.idx);
      const x   = 36 + idx * cw;
      const yy  = choch.type === 'CHOCH_UP' ? toY(choch.price) - 14 : toY(choch.price) + 16;
      if (yy < 10 || yy > H - 10) return;
      ctx.fillStyle = choch.type === 'CHOCH_UP' ? '#35d27f' : '#ff5368';
      ctx.font = 'bold 9px Inter,sans-serif';
      ctx.fillText('CHoCH', x - 12, yy);
    });
    // Draw TP1/TP2/TP3 lines when signal is active
    if (state.signal && state.signal.bias !== 'WAIT' && state.signal.tp2) {
      const sig = state.signal;
      const tpLines = [
        { price: sig.tp1, label: 'TP1', col: 'rgba(245,184,75,0.7)' },
        { price: sig.tp2, label: 'TP2', col: 'rgba(53,210,127,0.9)' },
        { price: sig.tp3, label: 'TP3', col: 'rgba(83,167,255,0.7)' },
      ];
      tpLines.forEach(({ price, label, col }) => {
        if (!price || price < yLo || price > yHi) return;
        const yy = toY(price);
        ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash([6, 3]);
        ctx.beginPath(); ctx.moveTo(36, yy); ctx.lineTo(W - 16, yy); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = col; ctx.font = 'bold 9px Inter,sans-serif';
        ctx.fillText(label + ' ' + fmtP(price), W - 82, yy - 3);
      });
    }
  } catch (_) {}

  // Candles
  rows.forEach((c, i) => {
    const x  = 36 + i * cw;
    const up = c.close >= c.open;
    ctx.strokeStyle = up ? '#35d27f' : '#ff5368';
    ctx.fillStyle   = up ? '#35d27f' : '#ff5368';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + cw / 2, toY(c.high)); ctx.lineTo(x + cw / 2, toY(c.low)); ctx.stroke();
    const top = toY(Math.max(c.open, c.close));
    const bot = toY(Math.min(c.open, c.close));
    ctx.fillRect(x + 1, top, Math.max(2, cw - 2), Math.max(2, bot - top));
  });

  // Open trade stop/target lines
  const rp = state.replay;
  if (rp.active && rp.trade) {
    const t = rp.trade;
    [{ p: t.entry, col: '#f5b84b', lbl: 'ENTRY' },
     { p: t.stop,  col: '#ff5368', lbl: 'STOP' },
     { p: t.target,col: '#35d27f', lbl: 'TARGET' }].forEach(({ p, col, lbl }) => {
      const yy = toY(p);
      ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(36, yy); ctx.lineTo(W - 16, yy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = col; ctx.font = 'bold 10px Inter,sans-serif';
      ctx.fillText(lbl + ' ' + fmtP(p), W - 108, yy - 4);
    });
  }

  // Current price tag
  const last = rows.at(-1).close;
  const yL = toY(last);
  ctx.strokeStyle = '#f5b84b'; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
  ctx.beginPath(); ctx.moveTo(36, yL); ctx.lineTo(W - 16, yL); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#f5b84b'; ctx.font = 'bold 11px Inter,sans-serif';
  ctx.fillText(fmtP(last), W - 68, yL - 4);

  // Replay cursor line
  if (rp.active) {
    const cx = 36 + (rows.length - 1) * cw + cw / 2;
    ctx.strokeStyle = 'rgba(167,139,250,.8)'; ctx.lineWidth = 2; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
  }
}

// ─── Render Panels ────────────────────────────────────────────────────────────
function renderSessionRanges(det) {
  if (!det.asia) return;
  $('asiaHigh').textContent   = fmtP(det.asia.high);
  $('asiaLow').textContent    = fmtP(det.asia.low);
  $('asiaRange').textContent  = fmtP(det.asia.range) + ' pts';
  $('londonHigh').textContent  = fmtP(det.london.high);
  $('londonLow').textContent   = fmtP(det.london.low);
  $('londonRange').textContent = fmtP(det.london.range) + ' pts';

  const nyam = sessionRange(state.candles, 8, 10.5);
  $('nyamHigh').textContent  = nyam.high ? fmtP(nyam.high) : '--';
  $('nyamLow').textContent   = nyam.low  ? fmtP(nyam.low)  : '--';
  $('nyamRange').textContent = nyam.range ? fmtP(nyam.range) + ' pts' : '--';
}

function renderScenario(id) {
  const s = SCENARIOS[id];
  const card = $('scenarioCard');
  card.className = 'scenario-card ' + s.cls;
  $('scenarioIcon').textContent = s.icon;
  $('scenarioName').textContent = (id ? 'S' + id + ': ' : '') + s.name;
  $('scenarioDesc').textContent = s.desc;
}

function renderFibTable(high, low, bias) {
  if (!high || !low) return;
  $('fibHigh').textContent = 'H ' + fmtP(high);
  $('fibLow').textContent  = 'L ' + fmtP(low);
  if (bias === 'WAIT') {
    $('fibTable').innerHTML = '<div class="fib-row header"><span colspan="3" class="yellow">Search &amp; Destroy — No trade today</span></div>';
    return;
  }
  const fibs = calcFibs(high, low, bias);
  $('fibTable').innerHTML = '<div class="fib-row header"><span>Level</span><span>Price</span><span>Zone</span></div>' +
    fibs.map(f => `<div class="fib-row ${f.ote ? 'ote' : ''}">
      <span ${f.ote ? 'class="blue"':''}>${f.label}</span>
      <span ${f.ote ? 'class="blue"':''}>${fmtP(f.price)}</span>
      <span ${f.ote ? 'class="blue"':'class="muted"'}>${f.ote ? '★ ENTRY' : ''}</span>
    </div>`).join('');
}

// ─── Market Structure Engine ──────────────────────────────────────────────────
// Detects BOS, CHOCH, MSS, Equal Highs/Lows from raw candle array.
// Delegates to engine/structure_engine.js (loaded via <script> in index.html,
// shared with server.js/sandbox/build.js so this logic exists in exactly one
// place) when available; falls back to the inline copy below if the shared
// script didn't load, so this never becomes a hard dependency.
function detectStructure(candles) {
  if (typeof window !== 'undefined' && window.StructureEngine && window.StructureEngine.detectStructure) {
    return window.StructureEngine.detectStructure(candles);
  }
  return detectStructureInline(candles);
}

function detectStructureInline(candles) {
  if (candles.length < 10) return { swingHighs: [], swingLows: [], bosPoints: [], chochPoints: [], eqHighs: [], eqLows: [] };

  // ── Find swing highs / lows (3-bar lookback each side) ─────────────────────
  const swingHighs = [], swingLows = [];
  const LB = 3;
  for (let i = LB; i < candles.length - LB; i++) {
    const c = candles[i];
    let isHigh = true, isLow = true;
    for (let j = 1; j <= LB; j++) {
      if (c.high <= candles[i - j].high || c.high <= candles[i + j].high) isHigh = false;
      if (c.low  >= candles[i - j].low  || c.low  >= candles[i + j].low)  isLow  = false;
    }
    if (isHigh) swingHighs.push({ idx: i, price: c.high, candle: c });
    if (isLow)  swingLows.push({ idx: i, price: c.low,  candle: c });
  }

  // ── BOS: consecutive swing high/low that exceeds prior ─────────────────────
  const bosPoints = [];
  for (let i = 1; i < swingHighs.length; i++) {
    if (swingHighs[i].price > swingHighs[i - 1].price) {
      bosPoints.push({ type: 'BOS_UP', idx: swingHighs[i].idx, price: swingHighs[i].price, broke: swingHighs[i - 1].price });
    }
  }
  for (let i = 1; i < swingLows.length; i++) {
    if (swingLows[i].price < swingLows[i - 1].price) {
      bosPoints.push({ type: 'BOS_DN', idx: swingLows[i].idx, price: swingLows[i].price, broke: swingLows[i - 1].price });
    }
  }
  bosPoints.sort((a, b) => a.idx - b.idx);

  // ── CHOCH: first BOS that reverses the prior BOS direction ─────────────────
  const chochPoints = [];
  for (let i = 1; i < bosPoints.length; i++) {
    const prev = bosPoints[i - 1], curr = bosPoints[i];
    if ((prev.type === 'BOS_UP' && curr.type === 'BOS_DN') ||
        (prev.type === 'BOS_DN' && curr.type === 'BOS_UP')) {
      chochPoints.push({ ...curr, type: curr.type === 'BOS_UP' ? 'CHOCH_UP' : 'CHOCH_DN' });
    }
  }

  // ── Equal Highs / Equal Lows (within 8 pts, double-top/bottom liquidity) ───
  const EQ_THR = 8;
  const eqHighs = [], eqLows = [];
  for (let i = 0; i < swingHighs.length - 1; i++) {
    if (Math.abs(swingHighs[i].price - swingHighs[i + 1].price) <= EQ_THR) {
      eqHighs.push({ price: (swingHighs[i].price + swingHighs[i + 1].price) / 2, idx1: swingHighs[i].idx, idx2: swingHighs[i + 1].idx });
    }
  }
  for (let i = 0; i < swingLows.length - 1; i++) {
    if (Math.abs(swingLows[i].price - swingLows[i + 1].price) <= EQ_THR) {
      eqLows.push({ price: (swingLows[i].price + swingLows[i + 1].price) / 2, idx1: swingLows[i].idx, idx2: swingLows[i + 1].idx });
    }
  }

  // ── Trend bias from last 3 BOS points ──────────────────────────────────────
  const recentBos = bosPoints.slice(-3);
  const upCount   = recentBos.filter(b => b.type === 'BOS_UP').length;
  const dnCount   = recentBos.filter(b => b.type === 'BOS_DN').length;
  const structureBias = upCount > dnCount ? 'BULLISH' : dnCount > upCount ? 'BEARISH' : 'NEUTRAL';

  return { swingHighs, swingLows, bosPoints, chochPoints, eqHighs, eqLows, structureBias };
}

function buildSignal(id, fibHigh, fibLow, fibBias, det) {
  if (id === 0 || fibBias === 'WAIT') return null;
  const fibs = calcFibs(fibHigh, fibLow, fibBias);
  const ote  = fibs.filter(f => f.ote);
  const entryHigh = Math.max(ote[0].price, ote[1].price);
  const entryLow  = Math.min(ote[0].price, ote[1].price);
  const entryMid  = (entryHigh + entryLow) / 2;
  const range     = fibHigh - fibLow;

  // Stop: just beyond the sweep point (below London low for BUY, above London high for SELL)
  // Target: the OPPOSITE Asia liquidity pool (Asia High for BUY, Asia Low for SELL)
  let stop, target;
  if (fibBias === 'BUY') {
    stop   = det?.manip?.stop ?? +(fibLow  - range * 0.06).toFixed(2);
    // Target = Asia High (liquidity pool above) or 0.618 extension fallback
    target = det?.manip?.target ?? det?.asia?.high ?? +(fibHigh + range * 0.618).toFixed(2);
  } else {
    stop   = det?.manip?.stop ?? +(fibHigh + range * 0.06).toFixed(2);
    // Target = Asia Low (liquidity pool below) or 0.618 extension fallback
    target = det?.manip?.target ?? det?.asia?.low ?? +(fibLow  - range * 0.618).toFixed(2);
  }

  const stopPts   = +Math.abs(entryMid - stop).toFixed(2);
  const targetPts = +Math.abs(target - entryMid).toFixed(2);
  const rr        = +(targetPts / Math.max(0.25, stopPts)).toFixed(1);

  // TP1 = halfway to target (take partials, move stop to BE)
  // TP2 = the main liquidity target (Asia H/L)
  // TP3 = 1.272 extension of the manipulation leg beyond target
  const tp1 = +(fibBias === 'BUY' ? entryMid + (target - entryMid) * 0.5 : entryMid - (entryMid - target) * 0.5).toFixed(2);
  const tp2 = target;
  const manipRange = fibHigh - fibLow;
  const tp3 = +(fibBias === 'BUY' ? fibLow + manipRange * 1.272 : fibHigh - manipRange * 1.272).toFixed(2);
  const tp1Pts = +Math.abs(tp1 - entryMid).toFixed(2);
  const tp2Pts = targetPts;
  const tp3Pts = +Math.abs(tp3 - entryMid).toFixed(2);

  return {
    id, bias: fibBias, scenario: SCENARIOS[id],
    entryHigh, entryLow, entryMid, stop, target, stopPts, targetPts, rr,
    tp1, tp2, tp3, tp1Pts, tp2Pts, tp3Pts,
    entryWindow: 'nyopen',
    entryWindowNote: 'NY opens — price should sweep a level then pull back to OTE (0.618–0.705). Enter on the pull.',
    confidence: null,
  };
}

function renderSignalCard(sig) {
  state.signal = sig;
  if (!sig) {
    $('signalCard').className = 'signal-card wait';
    $('sigBiasLabel').textContent = 'WAIT'; $('sigBiasLabel').className = 'sig-bias wait';
    $('sigTitle').textContent = 'Search & Destroy — No Trade';
    $('sigLevels').innerHTML = '';
    $('sigReason').textContent = SCENARIOS[4].desc;
    $('stripBias').textContent = 'AVOID'; $('stripBias').style.color = 'var(--yellow)';
    ['stripScenario','stripEntry','stripStop','stripTarget','stripRR'].forEach(id => $(id).textContent = '--');
    return;
  }
  const dir = sig.bias === 'BUY' ? 'long' : 'short';
  const col = sig.bias === 'BUY' ? 'green' : 'red';
  $('signalCard').className = 'signal-card ' + dir;
  $('sigBiasLabel').textContent = sig.bias; $('sigBiasLabel').className = 'sig-bias ' + dir;
  $('sigTitle').textContent = 'S' + sig.id + ': ' + sig.scenario.name;
  $('sigReason').textContent = sig.scenario.desc;
  const WIN_LABELS = {
    preasia:   '🌅 PRE-ASIA 6–7 PM CT',
    prelondon: '🌙 PRE-LONDON Midnight CT',
    premarket: '🟡 PRE-MKT 6–8:30 AM CT',
    nyopen:    '🔥 NY OPEN 8:30–9:30 AM CT',
    wait:      '⏳ NO WINDOW — WAIT',
  };
  const winLabel = WIN_LABELS[sig.entryWindow] || '⏳ WATCH FOR WINDOW';
  const winNote   = sig.entryWindowNote || 'Wait for price to pull into the OTE zone during the entry window.';
  const tp1 = sig.tp1 || 0, tp2 = sig.tp2 || sig.target || 0, tp3 = sig.tp3 || 0;
  const tp1Pts = sig.tp1Pts || 0, tp2Pts = sig.tp2Pts || sig.targetPts || 0, tp3Pts = sig.tp3Pts || 0;
  $('sigLevels').innerHTML = `
    <div class="sig-lv entry-zone" style="grid-column:1/-1"><span>Entry Window</span><strong class="${sig.entryWindow==='nyopen'?'green':'yellow'}">${winLabel}</strong></div>
    <div class="sig-lv" style="grid-column:1/-1"><span>What to watch</span><strong style="font-size:11px;font-weight:500;color:var(--muted)">${winNote}</strong></div>
    <div class="sig-lv entry-zone"><span>OTE Zone</span><strong class="${col}">${fmtP(sig.entryLow)} – ${fmtP(sig.entryHigh)}</strong></div>
    <div class="sig-lv"><span>Stop</span><strong class="red">${fmtP(sig.stop)}</strong></div>
    <div class="sig-lv tp-row"><span>TP1 <span class="muted" style="font-size:10px">½ target</span></span><strong class="yellow">${tp1 ? fmtP(tp1) + ' (+' + fmtP(tp1Pts) + 'pts)' : '--'}</strong></div>
    <div class="sig-lv tp-row"><span>TP2 <span class="muted" style="font-size:10px">main</span></span><strong class="green">${tp2 ? fmtP(tp2) + ' (+' + fmtP(tp2Pts) + 'pts)' : '--'}</strong></div>
    <div class="sig-lv tp-row"><span>TP3 <span class="muted" style="font-size:10px">extended</span></span><strong class="cyan">${tp3 ? fmtP(tp3) + ' (+' + fmtP(tp3Pts) + 'pts)' : '--'}</strong></div>
    <div class="sig-lv"><span>Stop pts</span><strong>${fmtP(sig.stopPts)}</strong></div>
    <div class="sig-lv"><span>R:R (TP2)</span><strong class="${sig.rr >= 2 ? 'green':'yellow'}">${sig.rr}R</strong></div>
    ${sig.confluenceScore ? `<div class="sig-lv conf-row" style="grid-column:1/-1"><span>Confluence</span><strong class="cyan" style="font-size:10px">${sig.confluenceScore}</strong></div>` : ''}
    ${(sig.obInOTE || sig.fvgInOTE || sig.premDiscAligned) ? `<div class="sig-badges" style="grid-column:1/-1;display:flex;gap:5px;flex-wrap:wrap;margin-top:2px">
      ${sig.obInOTE      ? '<span class="badge badge-ob">OB in OTE ✦</span>'        : ''}
      ${sig.fvgInOTE     ? '<span class="badge badge-fvg">FVG in OTE ✦</span>'       : ''}
      ${sig.premDiscAligned ? '<span class="badge badge-pd">Premium/Discount ✓</span>' : ''}
    </div>` : ''}
    ${sig.manipDesc ? `<div class="sig-lv" style="grid-column:1/-1"><span>Manipulation</span><strong style="font-size:10px;font-weight:400;color:var(--muted)">${sig.manipDesc}</strong></div>` : ''}`;

  $('stripScenario').textContent = 'S' + sig.id;
  $('stripBias').textContent = sig.bias; $('stripBias').style.color = `var(--${dir === 'long' ? 'green':'red'})`;
  $('stripEntry').textContent  = fmtP(sig.entryLow) + ' – ' + fmtP(sig.entryHigh);
  $('stripStop').textContent   = fmtP(sig.stop);
  $('stripTarget').textContent = fmtP(sig.target);
  $('stripRR').textContent = sig.rr + 'R'; $('stripRR').style.color = sig.rr >= 2 ? 'var(--green)' : 'var(--yellow)';

  // Draw overlays + trade box on chart
  drawChartOverlays();
  if (sig && sig.bias !== 'WAIT') showTradeBox(sig); else clearTradeBox();
}

function renderPremarket(sig) {
  const det = sig;
  const pb = $('premarketBias'), pn = $('premarketNote');
  if (!det) { pb.textContent = 'No signal yet'; pb.className = 'yellow'; pn.textContent = ''; return; }
  const col = det.bias === 'BUY' ? 'green' : 'red';
  pb.textContent = det.bias === 'BUY' ? '▲ BUY – Pre-Market Watch' : '▼ SELL – Pre-Market Watch';
  pb.className = col;
  pn.textContent = `S${det.id} (${det.scenario.name}). Pre-market entry valid if price sweeps into OTE ` +
    `(${fmtP(det.entryLow)}–${fmtP(det.entryHigh)}) before 9:30am ET. Same stop/target apply.`;
}

// Entry windows (ET decimal hours)
// SIGNAL_WINDOWS is defined above with SESSION_DEF

function fmtCountdown(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return (h > 0 ? h + 'h ' : '') + String(m).padStart(2,'0') + 'm ' + String(s).padStart(2,'0') + 's';
}

function renderSessionPill() {
  const ctDt = ctDate();
  const h    = ctDt.getHours() + ctDt.getMinutes() / 60 + ctDt.getSeconds() / 3600;

  // Clock shows CT
  $('clock').textContent = ctDt.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', second:'2-digit', hour12:true }) + ' CT';

  // Session pill (CT)
  let label = 'OVERNIGHT', cls = 'muted-pill';
  if      (h >= 19 || h < 1)  { label = 'ASIA';          cls = 'muted-pill'; }
  else if (h >= 1  && h < 6)  { label = 'LONDON';        cls = 'blue-pill'; }
  else if (h >= 6  && h < 8.5){ label = 'PRE-MARKET';    cls = 'yellow-pill'; }
  else if (h >= 8.5&& h < 9.5){ label = 'NY OPEN ✦';    cls = 'green-pill'; }
  else if (h >= 9.5&& h < 15) { label = 'NY SESSION';    cls = 'muted-pill'; }
  const pill = $('sessionPill');
  pill.textContent = label; pill.className = 'pill ' + cls;

  // Determine active signal window
  const alert   = $('windowAlert');
  const waInner = alert.querySelector('.wa-inner');
  const countdown = $('windowCountdown');

  const inPreAsia   = h >= 18.0 && h < 19.0;
  const inPreLondon = h >= 0.0  && h < 1.0;
  const inPremarket = h >= 6.0  && h < 8.5;
  const inNyOpen    = h >= 8.5  && h < 9.5;

  const activeWin = inNyOpen    ? SIGNAL_WINDOWS.nyopen
                  : inPremarket ? SIGNAL_WINDOWS.premarket
                  : inPreLondon ? SIGNAL_WINDOWS.preLondon
                  : inPreAsia   ? SIGNAL_WINDOWS.preAsia
                  : null;

  if (activeWin) {
    const endSec  = Math.floor((activeWin.endH - h) * 3600);
    alert.style.display   = 'block';
    waInner.className     = 'wa-inner ' + activeWin.cls;
    $('waTitle').textContent = activeWin.title;
    $('waDesc').textContent  = activeWin.desc;
    $('waTimer').textContent = 'closes in ' + fmtCountdown(Math.max(0, endSec));
    countdown.textContent   = inNyOpen ? '🔥 NY OPEN NOW' : inPremarket ? '🟡 PRE-MKT NOW' : inPreLondon ? '🌙 PRE-LONDON' : '🌅 PRE-ASIA';
    countdown.className     = 'window-countdown ' + (inNyOpen ? 'live-open' : 'live-pre');
  } else {
    alert.style.display = 'none';

    // Countdown to next signal window (CT)
    // Order: Pre-Asia 18:00 → Pre-London 00:00 → Pre-Market 06:00 → NY Open 08:30
    let nextLabel = 'Window closed', secsAway = 0;
    const windows = [
      { h: 18.0, label: 'Pre-Asia (6PM CT)' },
      { h: 0.0,  label: 'Pre-London (Midnight CT)' },
      { h: 6.0,  label: 'Pre-Market (6AM CT)' },
      { h: 8.5,  label: 'NY Open (8:30AM CT)' },
    ];
    const next = windows.find(w => w.h > h) || { h: 18.0, label: 'Pre-Asia (tomorrow 6PM CT)' };
    secsAway  = Math.floor(((next.h > h ? next.h : next.h + 24) - h) * 3600);
    nextLabel = next.label + ' in ' + fmtCountdown(secsAway);
    countdown.textContent = nextLabel;
    countdown.className   = 'window-countdown';
  }

  // ── Auto-AI trigger: fire signal when a window opens (once per window) ──────
  autoTriggerAI(h);

  // ── Hold-time countdown (when trade is active and AI gave hold time) ─────────
  const htEl = $('holdTimeCountdown');
  if (htEl) {
    if (state.day.tradeActive && state.signal?.holdTimeMaxMinutes) {
      const openedAt   = state._tradeOpenedAt || 0;
      const elapsedMin = openedAt ? (Date.now() - openedAt) / 60000 : 0;
      const maxMin     = state.signal.holdTimeMaxMinutes;
      const remMin     = Math.max(0, maxMin - elapsedMin);
      htEl.style.display = 'block';
      htEl.textContent   = remMin > 0
        ? `⏱ Max hold: ${Math.ceil(remMin)}m left — exit by ${state.signal.hardTimeExit || '9:30 AM CT'}`
        : `⚠️ MAX HOLD TIME REACHED — exit now (${state.signal.hardTimeExit || '9:30 AM CT'})`;
      htEl.style.color   = remMin < 10 ? 'var(--red)' : remMin < 20 ? 'var(--yellow)' : 'var(--muted)';
    } else {
      htEl.style.display = 'none';
    }
  }
}

// Auto-fire AI signal once when each signal window first opens
const _aiAutoFired = {};
function autoTriggerAI(h) {
  const windowKeys = [
    { key: 'preAsia',   range: [18.0, 19.0] },
    { key: 'preLondon', range: [0.0,  1.0]  },
    { key: 'premarket', range: [6.0,  8.5]  },
    { key: 'nyopen',    range: [8.5,  9.5]  },
  ];
  for (const { key, range } of windowKeys) {
    if (h >= range[0] && h < range[1]) {
      const dayKey = todayKey() + '-' + key;
      if (!_aiAutoFired[dayKey]) {
        _aiAutoFired[dayKey] = true;
        console.log('[PXBOT] Auto-triggering AI for window:', key);
        setTimeout(() => runAISignal(true), 2000); // 2s delay so UI settles
      }
      return;
    }
  }
}

// ─── Journal ──────────────────────────────────────────────────────────────────
function renderJournal() {
  const rows = state.journal.slice(0, 40);
  $('journal').innerHTML = rows.length
    ? rows.map(x => `<div class="entry">
        <div class="meta"><span>${x.time}</span><span>S${x.scenId} ${x.mode || ''}</span></div>
        <b class="${x.bias==='BUY'?'green':'red'}">${x.bias} NQ @ ${x.entry}</b>
        <p>Stop ${x.stop} &nbsp; Target ${x.target} &nbsp; R:R ${x.rr}R${x.result ? ' &nbsp; <span class="'+(x.result>0?'green':'red')+'">'+fmt(x.result,0)+'</span>' : ''}</p>
      </div>`).join('')
    : '<div class="entry"><p class="muted">No trades logged yet.</p></div>';
}

function logSignal(mode) {
  const sig = state.signal;
  if (!sig) return;

  // Check can still take signal before logging
  const check = canTakeSignal();
  if (!check.ok && mode !== 'REPLAY') { alert(check.reason); return; }

  state.journal.unshift({
    time:     nowStamp(), scenId: sig.id, bias: sig.bias,
    entry:    fmtP(sig.entryMid), stop: fmtP(sig.stop), target: fmtP(sig.target),
    rr:       sig.rr, mode: mode || 'LIVE',
    chartTime: state.candles.at(-1)?.time || null,  // for chart markers
    result:   null, exitChartTime: null,
  });
  localStorage.setItem('px_nq_journal', JSON.stringify(state.journal.slice(0, 500)));
  renderJournal();

  if (mode !== 'REPLAY') {
    openTrade();  // marks trade active, locks new signals
  }
}

function closeCurrentTrade(result) {
  const sig = state.signal;
  // Save signal feedback for AI self-improvement
  if (sig && sig.bias !== 'WAIT') {
    const feedback = JSON.parse(localStorage.getItem('px_signal_feedback') || '[]');
    feedback.unshift({
      ts:         Date.now(),
      date:       new Date().toISOString().slice(0, 10),
      scenario:   sig.id,
      bias:       sig.bias,
      entry:      sig.entryMid,
      stop:       sig.stop,
      target:     sig.target,
      tp1:        sig.tp1 || null,
      tp2:        sig.tp2 || null,
      rr:         sig.rr,
      confidence: sig.confidence || null,
      result,
      price:      lastStreamPrice || 0,
    });
    localStorage.setItem('px_signal_feedback', JSON.stringify(feedback.slice(0, 200)));
  }
  // Tag the matching journal entry with result + exit bar time (for chart markers)
  const entry = state.journal.find(j => j.mode === 'LIVE' && j.result === null);
  if (entry) {
    entry.result = result === 'win' ? 1 : -1;
    entry.exitChartTime = state.candles.at(-1)?.time || null;
  }
  localStorage.setItem('px_nq_journal', JSON.stringify(state.journal.slice(0, 500)));
  recordTrade(sig?.bias || 'UNKNOWN', result);
  renderJournal();
  renderDayPanel();
  drawSignalMarkers();
}

function exportCsv() {
  const h = 'time,scenario,bias,entry,stop,target,rr,result,mode\n';
  const b = state.journal.map(x =>
    [x.time,x.scenId,x.bias,x.entry,x.stop,x.target,x.rr,x.result||'',x.mode||'']
    .map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([h+b],{type:'text/csv'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='pxbot_nq.csv'; a.click(); URL.revokeObjectURL(a.href);
}

// ─── Bar Replay — TradingView-grade engine ────────────────────────────────────
// Uses series.update() for each bar reveal — never setData() during playback.
// This gives smooth, flicker-free replay identical to TradingView's bar replay.

let _rpTradeLines = [];   // LWC price lines for entry/SL/TP during replay
let _rpKeyHandler  = null; // keyboard shortcut handler

function _rpClearTradeLines() {
  _rpTradeLines.forEach(l => { try { candleSeries.removePriceLine(l); } catch(_){} });
  _rpTradeLines = [];
}

function _rpDrawTradeLines(trade) {
  _rpClearTradeLines();
  if (!trade || !candleSeries) return;
  const isLong = trade.dir === 'long';
  const lines = [
    { price: trade.entry, color: '#f0c040', lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: 'ENTRY' },
    { price: trade.stop,  color: '#ff5368', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'STOP' },
    { price: trade.target,color: '#35d27f', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'TARGET' },
  ];
  if (trade.tp1) lines.push({ price: trade.tp1, color: '#ffd700', lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: 'TP1' });
  if (trade.tp2 && trade.tp2 !== trade.target) lines.push({ price: trade.tp2, color: '#35d27f', lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: 'TP2' });
  lines.forEach(cfg => { try { _rpTradeLines.push(candleSeries.createPriceLine(cfg)); } catch(_){} });
}

function _rpSetCursor(newCursor) {
  // Reveal bars from old cursor to new cursor using update() — no setData()
  const rp = state.replay;
  const total = state.candles.length;
  newCursor = Math.max(1, Math.min(total, newCursor));

  if (newCursor < rp.cursor) {
    // Going backward: must do a full setData for the slice, then update cursor
    const slice = state.candles.slice(0, newCursor);
    candleSeries.setData(slice.map(b => ({ time: b.time, open: +b.open.toFixed(2), high: +b.high.toFixed(2), low: +b.low.toFixed(2), close: +b.close.toFixed(2) })));
    volSeries.setData(slice.map(b => ({ time: b.time, value: b.volume || 0, color: b.close >= b.open ? 'rgba(53,210,127,0.25)' : 'rgba(255,83,104,0.25)' })));
    rp.cursor = newCursor;
  } else {
    // Going forward: push each new bar with update() — fast, no flicker
    for (let i = rp.cursor; i < newCursor; i++) {
      const b = state.candles[i];
      if (!b) break;
      try {
        candleSeries.update({ time: b.time, open: +b.open.toFixed(2), high: +b.high.toFixed(2), low: +b.low.toFixed(2), close: +b.close.toFixed(2) });
        volSeries.update({ time: b.time, value: b.volume || 0, color: b.close >= b.open ? 'rgba(53,210,127,0.25)' : 'rgba(255,83,104,0.25)' });
      } catch(_) {}
    }
    rp.cursor = newCursor;
  }

  _rpUpdateUI();
  _rpDrawTradeLines(rp.trade);
}

function _rpUpdateUI() {
  const rp    = state.replay;
  const total = state.candles.length;
  const cur   = rp.cursor;
  const bar   = state.candles[cur - 1];

  // Progress bar
  const pct = total > 1 ? ((cur - 1) / (total - 1) * 100).toFixed(1) : 0;
  const prog = $('rpProgress');
  if (prog) { prog.value = cur; prog.max = total; }
  const progPct = $('rpProgressPct');
  if (progPct) progPct.textContent = pct + '%';

  // Date/time display
  if (bar) {
    const dt = new Date(bar.time * 1000);
    const etDt = new Date(dt.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    const dStr = etDt.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
    const tStr = etDt.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:true });
    const el = $('rpDateTime');
    if (el) el.textContent = dStr + ' ' + tStr + ' CT';

    // OHLCV readout
    const ohlcEl = $('rpOHLC');
    const dir = bar.close >= bar.open ? 'green' : 'red';
    if (ohlcEl) ohlcEl.innerHTML =
      `O <span class="${dir}">${fmtP(bar.open)}</span>  ` +
      `H <span class="${dir}">${fmtP(bar.high)}</span>  ` +
      `L <span class="${dir}">${fmtP(bar.low)}</span>  ` +
      `C <span class="${dir}">${fmtP(bar.close)}</span>  ` +
      `V <span class="muted">${Math.round(bar.volume||0).toLocaleString()}</span>`;

    // Session tag
    const h = bar.etH || 0;
    let sess = 'CLOSED';
    if (h >= 20 || h < 2)        sess = 'ASIA';
    else if (h >= 2 && h < 8)    sess = 'LONDON';
    else if (h >= 8 && h < 8.5)  sess = 'PRE-MKT';
    else if (h >= 8.5 && h < 11) sess = 'NY OPEN';
    else if (h >= 11 && h < 16)  sess = 'NY MID';
    const sessEl = $('rpSession');
    if (sessEl) { sessEl.textContent = sess; sessEl.className = 'rp-sess-tag ' + sess.toLowerCase().replace(' ','-'); }
  }

  // Bar counter
  const cntEl = $('rpBarCount');
  if (cntEl) cntEl.textContent = cur + ' / ' + total;

  // Live P&L for active replay trade
  if (rp.trade && bar) {
    const t   = rp.trade;
    const pnl = (bar.close - t.entry) * (t.dir === 'long' ? 1 : -1) * NQ_PT_VAL * t.contracts;
    const pts = (bar.close - t.entry) * (t.dir === 'long' ? 1 : -1);
    const pnlEl = $('rpLivePnl');
    if (pnlEl) {
      pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + fmt(Math.abs(pnl), 0) + ' (' + (pts >= 0 ? '+' : '') + pts.toFixed(2) + 'pts)';
      pnlEl.className   = pnl >= 0 ? 'green' : 'red';
    }
  } else {
    const pnlEl = $('rpLivePnl');
    if (pnlEl) { pnlEl.textContent = '--'; pnlEl.className = 'muted'; }
  }

  replayUpdatePnl();
}

async function replayStart() {
  const rp = state.replay;
  if (rp.active) { replayStop(); return; }

  rp.active    = true;
  rp.playing   = false;
  rp.cursor    = 1;
  rp.trade     = null;
  rp.paperPnl  = rp.paperPnl || 0;
  rp.sessionPnl = 0;
  _rpClearTradeLines();

  $('replayBar').style.display    = 'flex';
  $('replayToggle').textContent   = '⏳ Loading…';
  $('replayToggle').className     = 'replay-btn active';
  $('rpCloseTrade').style.display = 'none';
  stopLivePolling();
  stopAutoSignalEngine();

  // Swap: hide TV widget, show LWC replay chart
  const tvDiv  = $('chart');
  const lwcDiv = $('chartReplay');
  if (tvDiv)  tvDiv.style.display  = 'none';
  if (lwcDiv) { lwcDiv.style.display = 'block'; initLWCChart(lwcDiv); }

  // Load data — prefer TL live data, fall back to current state.candles
  let src = 'SIM';
  try {
    if (proxyOnline) {
      const d = await proxyGet('/api/candles?resolution=5&count=500');
      if (d.bars?.length > 40) {
        src = d.source === 'tradelocker' ? 'TL' : 'YF';
        rp.allBars = normalizeBars(d.bars, 'tl');
      }
    }
  } catch (e) { console.warn('[PXBOT] Replay load:', e.message); }

  if (!rp.allBars?.length) rp.allBars = [...state.candles];
  state.candles = rp.allBars;

  // Find start of today's Asia session for a natural start point
  const asiaIdx = state.candles.findIndex(c => c.etH >= 19 && c.etH < 20.5);
  rp.startIdx   = asiaIdx > 10 ? asiaIdx : Math.max(1, state.candles.length - 250);
  rp.cursor     = rp.startIdx;

  // Initial chart draw — show bars up to start cursor via setData (initial load only)
  const initSlice = state.candles.slice(0, rp.cursor);
  candleSeries.setData(initSlice.map(b => ({ time: b.time, open: +b.open.toFixed(2), high: +b.high.toFixed(2), low: +b.low.toFixed(2), close: +b.close.toFixed(2) })));
  volSeries.setData(initSlice.map(b => ({ time: b.time, value: b.volume || 0, color: b.close >= b.open ? 'rgba(53,210,127,0.25)' : 'rgba(255,83,104,0.25)' })));
  if (lwChart) lwChart.timeScale().scrollToRealTime();
  drawChartOverlays();

  $('chartTitle').textContent = `Bar Replay — NQ 5m (${src}) | ${state.candles.length} bars`;
  $('replayToggle').textContent = '◼ Exit Replay';
  $('replayPlay').textContent   = '▶ Play';

  // Keyboard shortcuts (arrow keys + space)
  if (_rpKeyHandler) document.removeEventListener('keydown', _rpKeyHandler);
  _rpKeyHandler = (e) => {
    if (!state.replay.active) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowRight') { e.preventDefault(); replayStep(1); }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); replayStep(-1); }
    if (e.key === 'ArrowUp')    { e.preventDefault(); replayStep(10); }
    if (e.key === 'ArrowDown')  { e.preventDefault(); replayStep(-10); }
    if (e.key === ' ')          { e.preventDefault(); replayPlayPause(); }
  };
  document.addEventListener('keydown', _rpKeyHandler);

  // Progress slider scrubbing
  const prog = $('rpProgress');
  if (prog) {
    prog.min = 1; prog.max = state.candles.length; prog.value = rp.cursor;
    prog.oninput = () => { _rpSetCursor(Number(prog.value)); };
  }

  _rpUpdateUI();
  console.log('[PXBOT] Replay started — ' + state.candles.length + ' bars from ' + src);
}

function replayStop() {
  const rp = state.replay;
  if (rp.intervalId) { clearInterval(rp.intervalId); rp.intervalId = null; }
  rp.active  = false;
  rp.playing = false;
  rp.trade   = null;
  _rpClearTradeLines();

  if (_rpKeyHandler) { document.removeEventListener('keydown', _rpKeyHandler); _rpKeyHandler = null; }

  $('replayBar').style.display  = 'none';
  $('replayToggle').textContent = '▶ Bar Replay';
  $('replayToggle').className   = 'replay-btn';
  const rpPlayBtn = $('rpPlay') || $('replayPlay');
  if (rpPlayBtn) rpPlayBtn.textContent = '▶ Play';

  // Destroy LWC, restore TV widget
  destroyLWCChart();
  const tvDiv  = $('chart');
  const lwcDiv = $('chartReplay');
  if (lwcDiv) lwcDiv.style.display = 'none';
  if (tvDiv)  tvDiv.style.display  = 'block';

  // Restore full chart — refetch live TL data if connected so chart isn't stuck on replay slice
  if (state.tl?.connected) {
    fetchLiveCandles(currentTF).then(fresh => {
      if (fresh && fresh.length > 0) {
        state.candles = fresh;
      }
      updateChart(state.candles);
      drawChartOverlays();
      if (lwChart) lwChart.timeScale().scrollToRealTime();
      renderSignalCard(state.signal);
      startLivePolling();
      startAutoSignalEngine();
    });
  } else {
    updateChart(state.candles);
    drawChartOverlays();
    if (lwChart) lwChart.timeScale().scrollToRealTime();
    renderSignalCard(state.signal);
  }
}

function replayPlayPause() {
  const rp = state.replay;
  if (!rp.active) return;
  rp.playing = !rp.playing;

  const btn = $('replayPlay') || $('rpPlay');
  if (btn) btn.textContent = rp.playing ? '⏸ Pause' : '▶ Play';

  if (rp.intervalId) { clearInterval(rp.intervalId); rp.intervalId = null; }

  if (rp.playing) {
    const tick = () => {
      if (!rp.active || !rp.playing) return;
      const spd = Number($('replaySpeed')?.value) || 1;
      const next = Math.min(state.candles.length, rp.cursor + spd);
      if (next === rp.cursor || rp.cursor >= state.candles.length) {
        rp.playing = false;
        if (btn) btn.textContent = '▶ Play';
        return;
      }
      _rpSetCursor(next);
      replayCheckTrade();
    };
    rp.intervalId = setInterval(tick, 200);
  }
}

function replayStep(steps) {
  if (!state.replay.active) return;
  const next = state.replay.cursor + (steps || 1);
  _rpSetCursor(next);
  replayCheckTrade();
}

function replayEnterTrade(dir) {
  const rp = state.replay;
  if (!rp.active) return;
  if (rp.trade) { return; } // silently ignore if trade already open
  const bar = state.candles[rp.cursor - 1];
  if (!bar) return;

  const price     = bar.close;
  const stopPts   = Math.max(1, Number($('rpStop')?.value)   || 20);
  const targetPts = Math.max(1, Number($('rpTarget')?.value) || 40);
  const contractsEl = $('contracts');
  const numContracts = Math.max(1, Number(contractsEl?.textContent) || 1);

  // Auto-calculate TP1/TP2
  const tp1 = dir === 'long' ? price + targetPts * 0.5 : price - targetPts * 0.5;
  const tp2 = dir === 'long' ? price + targetPts       : price - targetPts;

  rp.trade = {
    dir,
    entry:     price,
    stop:      dir === 'long' ? price - stopPts   : price + stopPts,
    target:    dir === 'long' ? price + targetPts : price - targetPts,
    tp1, tp2,
    contracts: numContracts,
    openIdx:   rp.cursor,
    openTime:  bar.time,
  };

  $('rpCloseTrade').style.display = 'inline-flex';
  const tradeLabel = $('rpTradeLabel');
  if (tradeLabel) {
    tradeLabel.textContent = (dir === 'long' ? '▲ LONG' : '▼ SHORT') + ' @ ' + fmtP(price);
    tradeLabel.className   = dir === 'long' ? 'green' : 'red';
    tradeLabel.style.display = 'inline';
  }

  _rpDrawTradeLines(rp.trade);
  _rpUpdateUI();
}

function replayCheckTrade() {
  const rp = state.replay;
  if (!rp.trade) return;
  const bar = state.candles[rp.cursor - 1];
  if (!bar) return;
  const t = rp.trade;

  // Check stop or target hit
  let result = null;
  let outcome = '';
  if (t.dir === 'long') {
    if (bar.low  <= t.stop)   { result = (t.stop   - t.entry) * NQ_PT_VAL * t.contracts; outcome = 'STOP'; }
    if (bar.high >= t.target) { result = (t.target - t.entry) * NQ_PT_VAL * t.contracts; outcome = 'WIN'; }
  } else {
    if (bar.high >= t.stop)   { result = (t.entry - t.stop)   * NQ_PT_VAL * t.contracts; outcome = 'STOP'; }
    if (bar.low  <= t.target) { result = (t.entry - t.target) * NQ_PT_VAL * t.contracts; outcome = 'WIN'; }
  }

  if (result !== null) replayCloseTrade(result, outcome);
}

function replayCloseTrade(result, outcome) {
  const rp = state.replay;
  if (!rp.trade) return;
  const t   = rp.trade;
  const bar = state.candles[rp.cursor - 1];

  const pnl = result !== undefined
    ? result
    : (t.dir === 'long'
        ? (bar?.close || t.entry) - t.entry
        : t.entry - (bar?.close || t.entry)) * NQ_PT_VAL * t.contracts;

  rp.paperPnl   = (rp.paperPnl   || 0) + pnl;
  rp.sessionPnl = (rp.sessionPnl || 0) + pnl;

  const rr = +(Math.abs(t.target - t.entry) / Math.max(0.25, Math.abs(t.stop - t.entry))).toFixed(1);
  state.journal.unshift({
    time:   nowStamp(),
    scenId: state.scenarioId || 0,
    bias:   t.dir === 'long' ? 'BUY' : 'SELL',
    entry:  fmtP(t.entry),
    stop:   fmtP(t.stop),
    target: fmtP(t.target),
    rr,
    result: pnl,
    mode:   'REPLAY',
  });
  localStorage.setItem('px_nq_journal', JSON.stringify(state.journal.slice(0, 500)));
  renderJournal();

  // Flash outcome on chart
  if (outcome) {
    const flash = document.createElement('div');
    flash.className = 'rp-outcome-flash ' + (outcome === 'WIN' ? 'win' : 'loss');
    flash.textContent = outcome === 'WIN'
      ? '✓ TARGET HIT +$' + fmt(Math.abs(pnl), 0)
      : '✗ STOP HIT  −$' + fmt(Math.abs(pnl), 0);
    const chartEl = $('chart');
    if (chartEl?.parentElement) {
      chartEl.parentElement.appendChild(flash);
      setTimeout(() => flash.remove(), 2500);
    }
  }

  rp.trade = null;
  $('rpCloseTrade').style.display = 'none';
  const tradeLabel = $('rpTradeLabel');
  if (tradeLabel) tradeLabel.style.display = 'none';

  _rpClearTradeLines();
  replayUpdatePnl();
  _rpUpdateUI();
}

function replayUpdatePnl() {
  const rp = state.replay;
  const pnl = rp.paperPnl || 0;
  const el  = $('rpPnl');
  if (el) {
    el.textContent = (pnl >= 0 ? '+' : '-') + '$' + fmt(Math.abs(pnl), 0);
    el.className   = pnl >= 0 ? 'green' : 'red';
  }
}

// ─── Weekly Backtest — uses TradeLocker 1H chart data (35 days) ───────────────
async function runWeeklyBacktest() {
  const btn = $('runWeekly');
  btn.textContent = 'Fetching data…'; btn.disabled = true;

  let allCandles = [];
  // TradeLocker only — /api/backtest returns 35 days of 1H TL data
  if (!proxyOnline) {
    $('backtestBody').textContent = 'Server not running. Start server.js first, then connect to TradeLocker.';
    btn.textContent = 'Run Sunday Refresh'; btn.disabled = false;
    return;
  }
  try {
    btn.textContent = 'Loading TL chart data…';
    const d = await proxyGet('/api/backtest');
    if (d.bars?.length > 40) {
      allCandles = normalizeBars(d.bars, 'tl');
      $('backtestBody').textContent = `Analyzing ${allCandles.length} TL bars…`;
    } else if (d.error) {
      $('backtestBody').textContent = 'TradeLocker returned no data: ' + d.error;
      btn.textContent = 'Run Sunday Refresh'; btn.disabled = false;
      return;
    }
  } catch (e) {
    console.warn('[PXBOT] Backtest fetch:', e.message);
    $('backtestBody').textContent = 'Failed to fetch backtest data: ' + e.message;
    btn.textContent = 'Run Sunday Refresh'; btn.disabled = false;
    return;
  }

  const wins = {1:0,2:0,3:0,4:0}, total = {1:0,2:0,3:0,4:0}, rSum = {1:0,2:0,3:0,4:0};

  if (allCandles.length > 40) {
    // Walk through each day in the data and detect scenario + outcome
    btn.textContent = 'Analyzing…';
    // Group candles into "days" (24h windows starting at 19h CT = Asia open)
    const dayGroups = [];
    let dayBuf = [];
    for (let i = 0; i < allCandles.length; i++) {
      const c = allCandles[i];
      if (c.etH >= 19 && (dayBuf.length === 0 || allCandles[i-1]?.etH < 19)) {
        if (dayBuf.length >= 12) dayGroups.push([...dayBuf]);
        dayBuf = [c];
      } else {
        dayBuf.push(c);
      }
    }
    if (dayBuf.length >= 12) dayGroups.push(dayBuf);

    for (const dayCandles of dayGroups.slice(-30)) {
      const det = detectScenario(dayCandles);
      const s   = det.id || 0;
      if (!s || s === 0) continue;
      total[s]++;
      if (s === 4) continue; // never trade S4

      // Evaluate if the trade would have worked:
      // For S1/S2: did price hit the OTE zone and then reach the target?
      // Use fibHigh/fibLow/fibBias to determine outcome
      if (det.fibHigh && det.fibLow && det.fibBias !== 'WAIT') {
        const fibs     = calcFibs(det.fibHigh, det.fibLow, det.fibBias);
        const ote      = fibs.filter(f => f.ote);
        const entryMid = ote.reduce((acc, f) => acc + f.price, 0) / ote.length || 0;
        const range    = det.fibHigh - det.fibLow;
        const stop     = det.fibBias === 'BUY' ? det.fibLow - range * 0.06 : det.fibHigh + range * 0.06;
        const target   = det.manip?.target || (det.fibBias === 'BUY' ? det.fibHigh + range * 0.3 : det.fibLow - range * 0.3);
        const dir      = det.fibBias === 'BUY' ? 1 : -1;

        // Check NY open candles (etH 8.5–10.5)
        const nyCandles = dayCandles.filter(c => c.etH >= 8.5 && c.etH <= 10.5);
        let hitEntry = false, hitTarget = false, hitStop = false, r = 0;
        for (const c of nyCandles) {
          if (!hitEntry && ((dir === 1 && c.low <= entryMid) || (dir === -1 && c.high >= entryMid))) hitEntry = true;
          if (hitEntry && !hitStop && !hitTarget) {
            if (dir === 1 && c.low <= stop)    { hitStop   = true; break; }
            if (dir === -1 && c.high >= stop)  { hitStop   = true; break; }
            if (dir === 1 && c.high >= target) { hitTarget = true; break; }
            if (dir === -1 && c.low <= target) { hitTarget = true; break; }
          }
        }
        if (hitEntry) {
          const stopPts   = Math.abs(entryMid - stop);
          const targetPts = Math.abs(target - entryMid);
          if (hitTarget) { wins[s]++; r = targetPts / Math.max(1, stopPts); rSum[s] += r; }
          else if (hitStop) { rSum[s] -= 1; }
        }
      }
    }
  } else {
    $('backtestBody').textContent = 'TradeLocker returned no historical data for backtest. Make sure you are connected and the account has chart history.';
    btn.textContent = 'Run Sunday Refresh'; btn.disabled = false;
    return;
  }

  const stats = [1,2,3,4].map(id => ({
    id, wins: wins[id], total: total[id],
    pct: total[id] && id !== 4 ? Math.round(wins[id] / total[id] * 100) : 0,
    avgR: total[id] && id !== 4 ? +(rSum[id] / Math.max(1, total[id])).toFixed(1) : 0,
  })).sort((a, b) => b.pct - a.pct);

  const best = stats.find(s => s.id !== 4 && s.total > 0) || stats[0];
  state.weeklyStats = stats;
  localStorage.setItem('px_weekly', JSON.stringify(stats));

  const dataNote = 'TradeLocker real chart data';
  $('backtestTitle').textContent = `A+ This Week: S${best.id} — ${SCENARIOS[best.id].name}`;
  $('backtestTitle').className   = best.pct >= 60 ? 'green' : 'yellow';
  $('backtestBody').textContent  = `${dataNote} · 30-day analysis. Focus on Scenario ${best.id} (${best.pct}% win rate, avg R: ${best.avgR}R, ${best.wins}/${best.total} setups). S4 = always skip.`;
  $('scenarioWinGrid').innerHTML = stats.map(s => `
    <div class="win-card">
      <div class="win-pct ${s.id===best.id?'green':s.id===4?'yellow':'muted'}">${s.id===4?'SKIP':s.pct+'%'}</div>
      <div class="win-label">S${s.id}: ${SCENARIOS[s.id].name}<br>${s.id!==4?(s.wins+'/'+s.total+' · avg '+s.avgR+'R'):'No trade day'}</div>
      <div class="win-bar"><div class="win-bar-fill" style="width:${s.pct}%;background:${s.id===best.id?'var(--green)':s.id===4?'var(--yellow)':'var(--line)'}"></div></div>
    </div>`).join('');
  btn.textContent = 'Run Sunday Refresh'; btn.disabled = false;
}

// ─── TradeLocker ──────────────────────────────────────────────────────────────
function tlShowError(msg) {
  // Always try to show the error — create the element if missing
  let el = document.getElementById('tlError');
  if (!el) {
    const btn = document.getElementById('tlLoginBtn');
    if (btn) {
      el = document.createElement('div');
      el.id = 'tlError';
      el.style.cssText = 'margin-top:10px;padding:10px 12px;background:#3a1c1c;border:1px solid #ff5368;border-radius:8px;color:#ff8a96;font-size:13px;line-height:1.5;white-space:pre-wrap';
      btn.parentNode.insertBefore(el, btn.nextSibling);
    }
  }
  if (el) { el.textContent = msg; el.style.display = msg ? 'block' : 'none'; }
  if (msg) console.error('[PXBOT TL]', msg);
}

async function tlLogin() {
  const btn        = document.getElementById('tlLoginBtn');
  const baseUrl    = (document.getElementById('tlBaseUrl')?.value   || 'https://live.tradelocker.com').trim().replace(/\/+$/, '');
  const serverName = (document.getElementById('tlServerName')?.value || '').trim();
  const email      = (document.getElementById('tlEmail')?.value      || '').trim();
  const pass       =  document.getElementById('tlPass')?.value        || '';

  tlShowError('');

  if (!serverName || !email || !pass) {
    tlShowError('Fill in all fields — Broker Server Name, Email, and Password are required.\n\nYour Broker Server Name from your Genesis FX email is: GenFX');
    return;
  }

  if (btn) { btn.textContent = '⏳ Connecting…'; btn.disabled = true; }

  try {
    // Auth goes through Node proxy (which uses curl to bypass Cloudflare TLS detection)
    const data  = await proxyPost('/api/auth', { server: baseUrl, accServer: serverName, email, password: pass });
    const token = data.accessToken || data.token || data.access_token;
    if (!token) {
      const detail = data.message || data.error || JSON.stringify(data).slice(0, 200);
      throw new Error(detail);
    }

    const resolvedServer = data._resolvedServer || baseUrl;
    tlShowError('');
    state.tl = { ...state.tl, connected: true, token, server: resolvedServer, accServer: serverName };

    document.getElementById('tlConnect')?.style     && (document.getElementById('tlConnect').style.display = 'none');
    document.getElementById('tlDash')?.style        && (document.getElementById('tlDash').style.display    = 'block');
    document.getElementById('tlPill') && Object.assign(document.getElementById('tlPill'), { textContent: 'TradeLocker: ON', className: 'pill green-pill' });
    document.getElementById('tlStatusLabel') && Object.assign(document.getElementById('tlStatusLabel'), { textContent: 'Connected', className: 'pill green-pill' });

    await tlFetchAccount();
    // TV widget already has full history — just fetch recent bars for AI context
    const candles = await fetchLiveCandles(currentTF);
    if (candles && candles.length) state.candles = candles;
    // Ensure chart is initialized
    if (!window._tvWidget) initChart();
    startPriceStream();
    startLivePolling();
    // Auto-run AI signal as soon as TL data is loaded
    setTimeout(() => {
      const aiOut = $('aiOutput');
      if (aiOut) aiOut.textContent = '🔄 TradeLocker connected — running AI analysis…';
      runAISignal();
    }, 1500);
    startAutoSignalEngine();

  } catch (err) {
    tlShowError('❌ Login failed: ' + err.message);
  }
  if (btn) { btn.textContent = 'Connect to TradeLocker'; btn.disabled = false; }
}

async function tlFetchAccount() {
  if (!state.tl.connected) return;
  try {
    const data = await proxyGet('/api/accounts');
    // Server returns {accounts:[{id, accNum, accountBalance, ...}]}
    const acctList = data.accounts || (Array.isArray(data) ? data : [data]);
    const acct = acctList[0] || {};
    state.tl.acct = acct;
    const balance = acct.accountBalance ?? acct.balance ?? acct.cash ?? 0;
    const equity  = acct.equity ?? acct.nav ?? balance; // TL demo doesn't always return equity
    $('tlAcctName').textContent = acct.accNum ? ('Acct #' + acct.accNum) : (acct.name || acct.id || '--');
    $('tlBalance').textContent  = '$' + fmt(balance, 2);
    $('tlEquity').textContent   = '$' + fmt(equity,  2);
    // Also update risk calculator with real account size
    const accSzEl = $('accountSize');
    if (accSzEl && balance > 0) accSzEl.value = Math.round(balance);
    renderRisk();
    await tlFetchPositions(acct.id || acct.accountId || '');
  } catch (err) { console.error('[PXBOT] TL account fetch:', err); }
}

async function tlFetchPositions(acctId) {
  try {
    const data = await proxyGet(`/api/positions?accountId=${acctId}`);
    const pos  = Array.isArray(data) ? data : data.positions || [];
    $('tlPositions').innerHTML = pos.length
      ? pos.map(p => `<div class="pos-row ${p.side==='buy'?'long-pos':'short-pos'}">
          <span class="${p.side==='buy'?'green':'red'}">${(p.side||'').toUpperCase()}</span>
          <span>${p.symbol||p.instrument||'--'}</span>
          <span>${p.quantity||p.lots||'--'} lots</span>
          <span>${fmtP(p.openPrice||p.avgPrice||0)}</span>
          <span class="${(p.pnl||0)>=0?'green':'red'}">${p.pnl!=null?'$'+fmt(p.pnl,0):'--'}</span>
        </div>`).join('')
      : 'No open positions.';
  } catch (err) { console.error('TL positions:', err); }
}

function tlDisconnect() {
  state.tl = { connected:false, token:null, server:'', acct:null, positions:[] };
  $('tlConnect').style.display='block'; $('tlDash').style.display='none';
  $('tlPill').textContent='TradeLocker: OFF'; $('tlPill').className='pill red-pill';
  $('tlStatusLabel').textContent='Disconnected'; $('tlStatusLabel').className='pill red-pill';
}

// ─── Proxy / Live Data Layer ──────────────────────────────────────────────────
const PROXY = 'http://127.0.0.1:8899';
let proxyOnline  = false;
let liveInterval = null;
let currentTF    = '5'; // active timeframe resolution in minutes

async function proxyGet(path) {
  const r = await fetch(PROXY + path);
  if (!r.ok) throw new Error(`Proxy ${r.status}`);
  return r.json();
}

async function proxyPost(path, body) {
  const r = await fetch(PROXY + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${json.error || json.message || JSON.stringify(json)}`);
  return json;
}

async function checkProxy() {
  try {
    const d = await proxyGet('/api/health');
    proxyOnline = d.ok === true;
  } catch (_) { proxyOnline = false; }
  return proxyOnline;
}

// TF resolution → display label
function tfLabel(res) {
  const n = parseInt(res) || 5;
  if (n >= 1440) return 'D';
  if (n >= 240)  return '4H';
  if (n >= 60)   return '1H';
  if (n >= 30)   return '30m';
  if (n >= 15)   return '15m';
  if (n >= 5)    return '5m';
  return '1m';
}

// Bar count per TF — TL has different history depth limits
function tfCount(res) {
  const n = parseInt(res) || 5;
  if (n >= 1440) return 200;   // Daily: last 200 sessions (~10 months)
  if (n >= 240)  return 150;   // 4H: last 150 bars (~25 days)
  if (n >= 60)   return 200;   // 1H: last 200 bars (~8 days)
  if (n >= 30)   return 300;   // 30m: last 300 bars (~6 days)
  if (n >= 15)   return 300;   // 15m
  return 300;                  // 1m / 5m: last 300 bars
}

// Fetch live NQ candles from TradeLocker via proxy
async function fetchLiveCandles(resolution) {
  resolution = resolution || currentTF;
  const count = tfCount(resolution);
  try {
    const d = await proxyGet(`/api/candles?resolution=${resolution}&count=${count}`);
    if (d.bars && d.bars.length > 0) {
      const candles = d.bars.map(b => {
        const ts   = b.time * 1000;
        const etDt = new Date(new Date(ts).toLocaleString('en-US', { timeZone: 'America/Chicago' }));
        return {
          time: b.time,
          open: b.open, high: b.high, low: b.low, close: b.close,
          volume: b.volume, etH: etDt.getHours() + etDt.getMinutes() / 60, idx: 0,
        };
      });
      $('liveTag').textContent = 'LIVE TL';
      $('liveTag').className   = 'pill green-pill';
      return candles;
    }
    if (d.error) console.warn('[PXBOT] TL candles:', d.error);
    if (d.marketClosed) {
      $('liveTag').textContent = 'CLOSED';
      $('liveTag').className   = 'pill red-pill';
      $('liveTag').title       = 'NQ Globex closed — reopens Sun ~10PM UTC / 5PM ET';
      $('chartTitle').textContent = `NQ Futures — Market Closed (Weekend)  ${tfLabel(resolution)}`;
      // Only toast once per page load
      if (!window._closedToastShown) {
        window._closedToastShown = true;
        showToast('NQ Globex closed — showing SIM. Live data returns tonight ~5PM ET.', 'warn');
      }
      return null;
    }
  } catch (e) { console.warn('[PXBOT] Candle fetch:', e.message); }
  if (state?.tl?.connected) {
    $('liveTag').textContent = 'TL CACHED'; $('liveTag').className = 'pill yellow-pill';
  } else {
    $('liveTag').textContent = 'SIM'; $('liveTag').className = 'pill yellow-pill';
  }
  return null;
}

// ─── Real-Time SSE Price Stream ───────────────────────────────────────────────
let sseSource      = null;
let lastStreamPrice = 0;
let lastStreamDir   = 0;   // +1 up, -1 down, 0 flat

function startPriceStream() {
  if (sseSource) sseSource.close();
  sseSource = new EventSource(PROXY + '/api/stream');

  sseSource.onmessage = e => {
    try {
      const q = JSON.parse(e.data);
      if (!q.last || q.last <= 0) return;

      const prev = lastStreamPrice;
      lastStreamPrice = q.last;
      lastStreamDir   = q.last > prev ? 1 : q.last < prev ? -1 : lastStreamDir;
      // Store for SIM seed so buildCandles uses real current price
      if (q.last > 5000) window._tlLivePrice = q.last;

      // Update price display
      const priceEl = $('livePrice');
      if (priceEl) {
        priceEl.textContent = fmtP(q.last);
        priceEl.className   = 'live-price ' + (lastStreamDir >= 0 ? 'price-up' : 'price-dn');
      }
      // Bid/ask spread
      const bidEl = $('liveBid'), askEl = $('liveAsk');
      if (bidEl) bidEl.textContent = fmtP(q.bid);
      if (askEl) askEl.textContent = fmtP(q.ask);
      // Change
      const chEl = $('liveChange');
      if (chEl && q.change !== undefined) {
        const sign = q.change >= 0 ? '+' : '';
        chEl.textContent = sign + fmtP(q.change) + ' (' + sign + (q.changePct||0).toFixed(2) + '%)';
        chEl.className   = q.change >= 0 ? 'green' : 'red';
      }
      // Day H/L
      const dhEl = $('liveDayHigh'), dlEl = $('liveDayLow');
      if (dhEl && q.dayHigh) dhEl.textContent = fmtP(q.dayHigh);
      if (dlEl && q.dayLow)  dlEl.textContent = fmtP(q.dayLow);
      // Source tag
      if (q.source === 'tradelocker') {
        $('liveTag').textContent = 'LIVE TL'; $('liveTag').className = 'pill green-pill';
      }

      // Real-time chart tick (also drives monitorActiveTrade internally)
      updateChartTick(q.last);
      checkPreEntryInvalidation(q.last);
    } catch(_) {}
  };

  sseSource.onerror = () => {
    console.warn('SSE stream lost — falling back to 5s polling');
    if (sseSource) { sseSource.close(); sseSource = null; }
    setTimeout(startLivePolling, 3000);
  };
}

function checkPreEntryInvalidation(price) {
  const sig = state.signal;
  if (!sig || state.day.tradeActive) return;
  const inv = sig.preEntryInvalidation;
  if (!inv) return;
  const dir = sig.bias === 'BUY' ? 1 : -1;
  const broken = dir === 1 ? price < inv : price > inv;
  if (broken && !state._preEntryInvShown) {
    state._preEntryInvShown = true;
    fireExitAlert('full', '⛔ SETUP INVALIDATED — DO NOT ENTER',
      `Price hit pre-entry invalidation at ${fmtP(price)}. The manipulation leg has been violated. Skip this trade.`, '');
  }
}

// Fetch latest price tick
async function fetchLiveQuote() {
  try {
    const d = await proxyGet('/api/quote');
    if (d.last) return d.last;
  } catch (_) {}
  return null;
}

// Start live polling — merges only the latest bars without full chart redraw
// This is the key to matching TL's smooth chart behavior:
// TL never redraws the full chart — it only appends/updates the latest bars.
// We do the same: fetch the last 10 bars and merge via series.update(), not setData().
function startLivePolling() {
  stopLivePolling();
  liveInterval = setInterval(async () => {
    if (state.replay.active) return;
    try {
      // Fetch only the latest 10 bars for the current TF (lightweight, fast)
      const d = await proxyGet(`/api/candles?resolution=${currentTF}&count=10`);
      if (!d?.bars?.length) return;
      const recentBars = d.bars.slice(-10);
      recentBars.forEach(b => {
        if (!b.time || !b.close) return;
        const ts = b.time;
        // Merge into state.candles
        const idx = state.candles.findIndex(c => c.time === ts);
        const etDt = new Date(new Date(ts*1000).toLocaleString('en-US',{timeZone:'America/Chicago'}));
        const enriched = { time:ts, open:b.open, high:b.high, low:b.low, close:b.close,
                           volume:b.volume||0, etH:etDt.getHours()+etDt.getMinutes()/60, idx:0 };
        if (idx >= 0) {
          state.candles[idx] = enriched;
        } else if (ts > (state.candles.at(-1)?.time || 0)) {
          state.candles.push(enriched);
        }
        // Push to LWC series using update() — smooth, no redraw, no scroll reset
        try {
          candleSeries.update({ time:ts, open:+b.open.toFixed(2), high:+b.high.toFixed(2),
                                low:+b.low.toFixed(2), close:+b.close.toFixed(2) });
          volSeries.update({ time:ts, value:b.volume||0,
                             color:b.close>=b.open?'rgba(53,210,127,0.25)':'rgba(255,83,104,0.25)' });
        } catch(_){}
      });
    } catch(_) {}
  }, 10000);
}

function stopLivePolling() {
  if (liveInterval) { clearInterval(liveInterval); liveInterval = null; }
}

// ─── Auto-Signal Engine ───────────────────────────────────────────────────────
// Checks the validated engine automatically at start and every 5 min while
// Trading Mode (BOT ON) is active. User can always override manually.
let _autoSigInterval = null;
let _lastAutoSigH    = -1;

function startAutoSignalEngine() {
  if (_autoSigInterval) return; // already running
  if (!state.tradingMode) { console.log('[PXBOT] Auto-signal skipped — Trading Mode is OFF'); return; }
  // Fire immediately on start (after brief delay for data to load)
  setTimeout(() => { if (state.tl?.connected && !state.day.tradeActive && state.tradingMode) runAISignal(); }, 3000);
  // Then fire every 5 minutes continuously
  _autoSigInterval = setInterval(async () => {
    if (!state.tl?.connected)  return;
    if (!state.tradingMode)    return;
    if (state.day.tradeActive) return;
    if (state.replay.active)   return;
    const aiOut = $('aiOutput');
    if (aiOut && !aiOut.classList.contains('has-signal')) {
      aiOut.textContent = '🔄 Auto-scan: checking validated signals…';
    }
    await runAISignal();
  }, 5 * 60 * 1000); // every 5 minutes
  console.log('[PXBOT] Auto-signal engine started — scanning every 5 min');
}

function stopAutoSignalEngine() {
  if (_autoSigInterval) { clearInterval(_autoSigInterval); _autoSigInterval = null; }
}

// ─── Exit Signal Engine ───────────────────────────────────────────────────────
const exitAlertShown = { target: false, partial: false, be: false, killzone: false, structure: false };

function resetExitAlerts() {
  Object.keys(exitAlertShown).forEach(k => exitAlertShown[k] = false);
  $('exitAlert').style.display    = 'none';
  $('tradeMgrPanel').style.display = 'none';
}

function monitorActiveTrade(currentPrice) {
  if (!state.day.tradeActive || !state.signal) return;
  const sig = state.signal;
  if (!sig || sig.bias === 'WAIT') return;

  const dir    = sig.bias === 'BUY' ? 1 : -1;
  const entry  = sig.entryMid;
  const stop   = sig.stop;
  const target = sig.target;
  const contracts = Math.max(1, Number($('contracts').textContent) || 1);
  const pnl    = (currentPrice - entry) * dir * NQ_PT_VAL * contracts;
  const pnlFmt = (pnl >= 0 ? '+$' : '-$') + fmt(Math.abs(pnl), 0);

  const totalRange  = Math.abs(target - entry);
  const progress    = Math.max(0, Math.min(1, (currentPrice - entry) * dir / Math.max(1, totalRange)));
  const toTarget    = +((target - currentPrice) * dir).toFixed(2);
  const toStop      = +((currentPrice - stop) * dir).toFixed(2);

  updateTradeManager(currentPrice, entry, stop, target, pnl, pnlFmt, progress, toTarget, toStop, contracts);

  const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const etH   = etNow.getHours() + etNow.getMinutes() / 60;

  // ── 1. TARGET HIT ──────────────────────────────────────────────────────────
  if (!exitAlertShown.target && toTarget <= 2) {
    exitAlertShown.target = true;
    fireExitAlert('full', '🎯 TARGET HIT — EXIT NOW', `Price at ${fmtP(currentPrice)} — take your full profit`, pnlFmt);
    return;
  }

  // ── 2. PARTIAL EXIT at 50% of target ──────────────────────────────────────
  if (!exitAlertShown.partial && progress >= 0.5 && progress < 0.9) {
    exitAlertShown.partial = true;
    fireExitAlert('partial', '💛 TAKE PARTIAL — 50% to target', `Consider closing half and moving stop to breakeven. Price: ${fmtP(currentPrice)}`, pnlFmt);
  }

  // ── 3. MOVE TO BREAKEVEN at 30pts profit ──────────────────────────────────
  if (!exitAlertShown.be && (currentPrice - entry) * dir >= 30) {
    exitAlertShown.be = true;
    fireExitAlert('be', '🔵 MOVE STOP TO BREAKEVEN', `You are 30+ pts in profit. Move stop to ${fmtP(entry + dir * 5)} to protect the trade.`, pnlFmt);
  }

  // ── 4. KILL ZONE CLOSING ───────────────────────────────────────────────────
  if (!exitAlertShown.killzone && etH >= 9.25 && etH < 9.5) {   // 9:15–9:30 AM CT warning
    exitAlertShown.killzone = true;
    fireExitAlert('full', '⏰ KILL ZONE CLOSING — EXIT', 'NY open kill zone ends at 10:30 AM ET. Exit now unless already at target.', pnlFmt);
  }

  // ── 5. STRUCTURE BREAK — early exit warning ────────────────────────────────
  const structureBreak = dir === 1
    ? currentPrice < sig.entryLow - 5    // price broke below OTE entry zone
    : currentPrice > sig.entryHigh + 5;
  if (!exitAlertShown.structure && structureBreak && progress < 0.3) {
    exitAlertShown.structure = true;
    fireExitAlert('full', '⚠️ STRUCTURE BREAK — CONSIDER EXIT', `Price has moved against the setup. Entry zone invalidated. Re-evaluate.`, pnlFmt);
  }

  // ── 6. STOP HIT ────────────────────────────────────────────────────────────
  if (toStop <= 0) {
    fireExitAlert('full', '🛑 STOP HIT — EXIT', `Price reached stop at ${fmtP(stop)}. Take the loss and protect your account.`, pnlFmt);
    exitAlertShown.target = true; // prevent further alerts
  }
}

function fireExitAlert(type, title, desc, pnlFmt) {
  const alert  = $('exitAlert');
  const inner  = alert.querySelector('.ea-inner');
  const isGood = type === 'partial' || type === 'be';

  alert.style.display = 'block';
  inner.className     = 'ea-inner' + (type === 'partial' ? ' partial' : type === 'be' ? ' be' : '');
  $('exitAlertTitle').textContent = title;
  $('exitAlertDesc').textContent  = desc;
  $('exitAlertPnl').textContent   = pnlFmt;
  $('exitAlertPnl').className     = pnlFmt.startsWith('+') ? 'green' : 'red';
  $('exitAlertIcon').textContent  = type === 'partial' ? '💛' : type === 'be' ? '🔵' : '🚨';
  // Scroll to top so user sees it
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateTradeManager(cur, entry, stop, target, pnl, pnlFmt, progress, toTarget, toStop, contracts) {
  const panel = $('tradeMgrPanel');
  panel.style.display = 'block';

  $('tmEntry').textContent   = fmtP(entry);
  $('tmCurrent').textContent = fmtP(cur);
  $('tmStop').textContent    = fmtP(stop);
  $('tmTarget').textContent  = fmtP(target);

  const pnlEl = $('tmPnl');
  pnlEl.textContent = pnlFmt;
  pnlEl.className   = pnl >= 0 ? 'green' : 'red';

  $('tmToTarget').textContent = toTarget > 0 ? fmtP(toTarget) + ' pts' : 'AT TARGET';
  $('tmToStop').textContent   = toStop   > 0 ? fmtP(toStop)   + ' pts' : 'AT STOP';

  const fill = $('tmProgressFill');
  fill.style.width = Math.max(0, Math.min(100, progress * 100)).toFixed(1) + '%';
  fill.style.background = progress >= 0.8
    ? 'linear-gradient(90deg,var(--green),#00ffaa)'
    : progress >= 0.5
    ? 'linear-gradient(90deg,var(--yellow),var(--green))'
    : progress > 0
    ? 'var(--blue)'
    : 'var(--red)';
  $('tmProgressPct').textContent = (progress * 100).toFixed(0) + '%';

  // Kill zone countdown
  const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const etH   = etNow.getHours() + etNow.getMinutes() / 60;
  const secsToClose = Math.max(0, Math.floor((9.5 - etH) * 3600));  // 9:30 AM CT kill zone close
  $('tmKillCountdown').textContent = secsToClose > 0 ? fmtCountdown(secsToClose) + ' left' : 'CLOSED';
  $('tmKillCountdown').className   = secsToClose < 900 ? 'red' : 'muted';

  // Exit note based on progress
  const note = $('tmExitNote');
  if (progress >= 0.5 && progress < 0.9) {
    note.style.display = 'block';
    note.textContent   = '💡 At 50%+ to target: consider closing half, move stop to breakeven.';
  } else if (secsToClose < 900 && secsToClose > 0) {
    note.style.display = 'block';
    note.textContent   = '⏰ Kill zone closing in under 15 min — prepare to exit.';
  } else {
    note.style.display = 'none';
  }
}

// ─── Signal Engine ────────────────────────────────────────────────────────────
// The validated backtested engine (server-side /api/signal) decides every
// signal now. This file just fetches it and drives the UI panels.

function setAiThinking(label) {
  $('aiThinking').style.display = label ? 'flex' : 'none';
  if (label) $('aiThinkingLabel').textContent = label;
  setBotScanning(!!label);
}

function normalizeBars(bars, src) {
  return bars.map(b => {
    const ts   = src === 'yf' ? b.time * 1000 : (b.time || b.timestamp || b.t || 0) * 1000;
    const etH  = ts ? (() => {
      const d = new Date(ts);
      const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
      return et.getHours() + et.getMinutes() / 60;
    })() : 0;
    return {
      time:   Math.floor(ts / 1000),
      open:   b.open   || b.o || 0,
      high:   b.high   || b.h || 0,
      low:    b.low    || b.l || 0,
      close:  b.close  || b.c || 0,
      volume: b.volume || b.v || 0,
      etH,
    };
  }).filter(b => b.close > 0);
}

// Quick bias button — runs the full AI signal (alias so both buttons work)
async function getAiBias() { return runAISignal(); }

// ─── Validated Signal Engine ────────────────────────────────────────────────
// Replaced the Ollama-decides-everything pipeline. The deterministic engine
// backtested this session (backtest/ict_engine.js + orb_engine.js, exposed
// live via /api/signal) is now the actual decision-maker — not a small local
// LLM guessing at numbers from a text prompt. Neither approach is proven at
// scale; every result below says so plainly rather than presenting a
// confidence score this system hasn't earned.
async function runAISignal() {
  // ── Pre-flight checks ───────────────────────────────────────────────────────
  const check = canTakeSignal();
  if (!check.ok) {
    $('aiOutput').classList.remove('has-signal');
    $('aiOutput').textContent = '🚫 ' + check.reason;
    return;
  }

  const btn = $('runAiSignal');
  const out = $('aiOutput');

  btn.classList.add('running');
  btn.textContent = '⏳ Checking validated signals…';
  btn.disabled    = true;
  $('aiConfidence').style.display = 'none';
  out.classList.remove('has-signal');
  out.textContent = '';

  try {
    const sig = await proxyGet('/api/signal');
    if (sig.error) throw new Error(sig.error);

    const dsEl = $('aiDataSource');
    if (dsEl) { dsEl.textContent = 'LIVE TL DATA'; dsEl.className = 'pill green-pill'; }

    const ict = sig.ict, orb = sig.orb, premarket = sig.premarket;
    const ictFired = ict && ict.bias !== 'WAIT';
    const orbFired = orb && orb.bias !== 'WAIT';
    const premarketFired = premarket && premarket.bias !== 'WAIT';

    // Confirmation engine (server.js:computeSignalConfirmation) — additive
    // context only, does not change ict/orb above. Falls back to the
    // original null/false behavior if a server without this field is ever
    // hit, so this stays backward compatible.
    const conf = (sig.confirmation && !sig.confirmation.error) ? sig.confirmation : null;
    const factorAgrees = name => !!conf?.factors?.find(f => f.name === name && f.agrees === true);
    const confFields = conf ? {
      confidence: conf.confidence,
      confluence_score: `${conf.tier} · ${conf.confidence}% (${conf.agreeingCount} of ${conf.factors.length - (conf.factors.filter(f=>f.excluded).length)} confirmations agree)`,
      order_block_in_ote: factorAgrees('orderBlockConfluence'),
      fvg_in_ote: factorAgrees('fvgConfluence'),
      premium_discount_aligned: factorAgrees('dailyPricePosition') || factorAgrees('mtfFractalAlignment'),
    } : { confidence: null, confluence_score: null, order_block_in_ote: false, fvg_in_ote: false, premium_discount_aligned: false };

    // Only the premarket breakout is shown as an actionable trade — it's the
    // only one of the three that passed every validation check without a
    // real caveat attached to the core number (see PREMARKET_TRACK_RECORD).
    // ICT (thin held-out sample, negative on the bigger test) and ORB
    // (currently losing in the most recent weeks tested) still compute and
    // log to the journal every check — server.js unchanged, still gathering
    // real evidence in case either one's picture improves — but neither
    // surfaces as something to trade right now. Fewer signals, on purpose.
    let json;
    if (premarketFired) {
      const risk = Math.abs(premarket.entry - premarket.sl);
      json = {
        scenario: 0, scenario_name: 'NY Premarket Breakout (validated engine — strongest evidence)',
        bias: premarket.bias, wait_reason: null,
        entry_window: 'premarket', entry_window_note: 'Breakout of the 7:00-9:30 AM CT premarket range — already triggered, this is a market entry. Tue/Wed/Thu only.',
        ote_entry_low: premarket.entry, ote_entry_high: premarket.entry,
        stop: premarket.sl, target: premarket.target, stop_pts: +risk.toFixed(2), target_pts: +Math.abs(premarket.target - premarket.entry).toFixed(2),
        tp1: 0, tp2: premarket.target, tp3: 0,
        tp1_pts: 0, tp2_pts: +Math.abs(premarket.target - premarket.entry).toFixed(2), tp3_pts: 0,
        rr: +(Math.abs(premarket.target - premarket.entry) / Math.max(0.25, risk)).toFixed(1),
        ...confFields,
        reasoning: `Validated NY premarket breakout: real-1-minute-execution confirmed, 5/5 walk-forward folds profitable. Track record: ${premarket.trackRecord}`
          + (conf ? ` | Confirmation engine: ${conf.tier} tier, ${conf.confidence}% confidence (${conf.agreeingCount} agree / ${conf.disagreeingCount} disagree) — context only, not a live-validated gate yet.` : ''),
        invalidation: premarket.sl,
      };
    } else {
      const heldBackNote = (ictFired || orbFired)
        ? ` (ICT and/or ORB did fire today, but are intentionally not shown as trades right now — weaker/mixed evidence, kept as background research only. See the rundown for why.)`
        : '';
      json = {
        scenario: 0, scenario_name: 'No signal', bias: 'WAIT',
        wait_reason: `Premarket: ${premarket ? premarket.reason : 'not available yet today'}.${heldBackNote}`,
        reasoning: 'Only trading the premarket breakout right now — the one strategy with real evidence behind it at every check applied. Fewer signals, on purpose.',
      };
    }

    applyAISignal(json);
    out.classList.toggle('has-signal', json.bias !== 'WAIT');
    out.textContent = json.bias === 'WAIT'
      ? '⏸ WAIT\n\n' + json.wait_reason
      : `✅ ${json.bias} signal — ${json.scenario_name}\n\n${json.reasoning}\n\nInvalidation: ${json.invalidation}`;
    $('aiPill').textContent = json.bias === 'WAIT' ? 'Engine: WAIT' : 'Engine: LIVE ✦';
    $('aiPill').className   = json.bias === 'WAIT' ? 'pill yellow-pill' : 'pill cyan-pill';

  } catch (err) {
    out.textContent = 'Signal engine error: ' + err.message + (err.message.includes('Not connected') ? '' : '\n\nIs server.js running and connected to TradeLocker?');
    $('aiPill').textContent = 'Engine: OFF'; $('aiPill').className = 'pill red-pill';
    const dsEl = $('aiDataSource');
    if (dsEl) { dsEl.textContent = 'NO DATA'; dsEl.className = 'pill red-pill'; }
  }

  btn.classList.remove('running');
  btn.textContent = '🎯 Check Validated Signal';
  btn.disabled    = false;
}

// Apply parsed AI JSON to every UI panel — AI fully drives the display
function applyAISignal(json) {
  const bias = (json.bias || 'WAIT').toUpperCase();
  const id   = Number(json.scenario) || 0;
  const high = Number(json.fib_swing_high) || state.fibHigh;
  const low  = Number(json.fib_swing_low)  || state.fibLow;

  // Update state
  state.fibHigh    = high;
  state.fibLow     = low;
  state.fibBias    = bias === 'WAIT' ? 'WAIT' : bias;
  state.scenarioId = id;

  // Confirmation-engine confidence bar (engine/confirmation_engine.js, via
  // server.js:computeSignalConfirmation) — was permanently hidden before
  // since confidence was always hardcoded null; now shows the real score
  // when the server provides one, hidden otherwise (backward compatible).
  const confEl = $('aiConfidence');
  if (confEl) {
    const confidence = Number(json.confidence);
    if (json.confidence !== null && json.confidence !== undefined && !Number.isNaN(confidence)) {
      confEl.style.display = 'flex';
      const fillEl = $('confFill'), pctEl = $('confPct');
      if (fillEl) fillEl.style.width = Math.max(0, Math.min(100, confidence)) + '%';
      if (pctEl) pctEl.textContent = confidence.toFixed(0) + '%';
    } else {
      confEl.style.display = 'none';
    }
  }

  // Scenario panel
  const sName = json.scenario_name || (SCENARIOS[id] ? SCENARIOS[id].name : 'AI Signal');
  const sDesc = json.reasoning || '';
  const cls   = bias === 'BUY' ? 'buy-card' : bias === 'SELL' ? 'sell-card' : 'wait-card';
  const icon  = bias === 'BUY' ? '▲' : bias === 'SELL' ? '▼' : '?';
  $('scenarioCard').className = 'scenario-card ' + cls;
  $('scenarioIcon').textContent = icon;
  $('scenarioName').textContent = (id ? 'S' + id + ': ' : '') + sName + ' (AI)';
  $('scenarioDesc').textContent = sDesc;

  // Fib table
  renderFibTable(high, low, bias);

  // Build and render signal card from AI values
  if (bias === 'WAIT') {
    renderSignalCard(null);
  } else {
    const entryLow  = Number(json.ote_entry_low)  || 0;
    const entryHigh = Number(json.ote_entry_high) || 0;
    const entryMid  = (entryLow + entryHigh) / 2;
    const stop      = Number(json.stop)   || 0;
    const target    = Number(json.target) || 0;
    const stopPts   = Number(json.stop_pts)   || +Math.abs(entryMid - stop).toFixed(2);
    const targetPts = Number(json.target_pts) || +Math.abs(target - entryMid).toFixed(2);
    const rr        = Number(json.rr) || +(targetPts / Math.max(0.25, stopPts)).toFixed(1);

    const tp1     = Number(json.tp1)     || +(bias === 'BUY' ? entryMid + (target - entryMid) * 0.5 : entryMid - (entryMid - target) * 0.5).toFixed(2);
    const tp2     = Number(json.tp2)     || target;
    const tp3     = Number(json.tp3)     || 0;
    const tp1Pts  = Number(json.tp1_pts) || +Math.abs(tp1 - entryMid).toFixed(2);
    const tp2Pts  = Number(json.tp2_pts) || targetPts;
    const tp3Pts  = Number(json.tp3_pts) || (tp3 ? +Math.abs(tp3 - entryMid).toFixed(2) : 0);

    const aiSig = {
      id, bias,
      scenario: { name: sName, desc: sDesc },
      entryHigh, entryLow, entryMid,
      stop, target, stopPts, targetPts, rr,
      tp1, tp2, tp3, tp1Pts, tp2Pts, tp3Pts,
      entryWindow:          json.entry_window          || 'nyopen',
      entryWindowNote:      json.entry_window_note     || null,
      confidence:           json.confidence            || null,
      holdTimeMinMinutes:   Number(json.hold_time_min_minutes) || 30,
      holdTimeMaxMinutes:   Number(json.hold_time_max_minutes) || 90,
      hardTimeExit:         json.hard_time_exit        || '9:30 AM CT',
      preEntryInvalidation: Number(json.pre_entry_invalidation) || null,
      reasoning:            json.reasoning             || null,
      manipDesc:            json.manipulation_leg_description || null,
      fibLegRationale:      json.fib_leg_rationale     || null,
      confluenceScore:      json.confluence_score      || null,
      obInOTE:              json.order_block_in_ote    || false,
      fvgInOTE:             json.fvg_in_ote            || false,
      premDiscAligned:      json.premium_discount_aligned || false,
      chartTime:            state.candles.at(-1)?.time || null, // anchor to bar for marker
    };
    renderSignalCard(aiSig);
    renderPremarket(aiSig);
    markSignalOnTVChart(aiSig); // pin arrow on the TradingView chart
  }

  // Refresh chart overlays and trade box — don't redraw all bars
  drawChartOverlays();
  if (state.signal && state.signal.bias !== 'WAIT') showTradeBox(state.signal); else clearTradeBox();

  // Strip
  $('stripScenario').textContent = id ? 'S' + id + ' AI' : 'AI';
  const col = bias === 'BUY' ? 'var(--green)' : bias === 'SELL' ? 'var(--red)' : 'var(--yellow)';
  $('stripBias').textContent = bias; $('stripBias').style.color = col;
}

// ─── Main Scan ────────────────────────────────────────────────────────────────
function scan() {
  const scenId = Math.ceil(Math.random() * 4);
  state.scenarioId = scenId;
  state.candles = buildCandles(scenId);

  const det = detectScenario(state.candles);
  state.fibHigh = det.fibHigh;
  state.fibLow  = det.fibLow;
  state.fibBias = det.fibBias;

  $('todayDate').textContent = new Date().toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
  renderSessionRanges(det);
  renderScenario(det.id);
  renderFibTable(det.fibHigh, det.fibLow, det.fibBias);
  updateChart(state.candles);

  const sig = buildSignal(det.id, det.fibHigh, det.fibLow, det.fibBias, det);
  renderSignalCard(sig);
  renderPremarket(sig);
  renderRisk();
  if (sig && sig.bias !== 'WAIT') showTradeBox(sig); else clearTradeBox();
}

function tick() {
  if (!state.candles.length || state.replay.active || state.tl?.connected) return;
  const last = state.candles.at(-1);
  const move = (Math.random() - 0.49) * 6 + Math.sin(Date.now() / 22000) * 2;
  const close = Math.max(1000, last.close + move);
  const newBar = {
    time:   (last.time || Math.floor(Date.now()/1000 - 300)) + 300,
    open:   last.close,
    high:   Math.max(last.close, close) + Math.random() * 5,
    low:    Math.min(last.close, close) - Math.random() * 5,
    close,  volume: 400 + Math.random() * 2000,
    etH:    last.etH, idx: (last.idx || 0) + 1,
  };
  state.candles.push(newBar);
  if (state.candles.length > 420) state.candles.shift();
  // Use update() for real-time perf — cheaper than full redraw
  if (candleSeries) {
    try { candleSeries.update({ time: newBar.time, open: newBar.open, high: newBar.high, low: newBar.low, close: newBar.close }); } catch(_){}
  }
}

// ─── Safe element wire-up helper ──────────────────────────────────────────────
// Uses optional chaining so a missing element never crashes boot()
function on(id, ev, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(ev, fn);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
function boot() {
  try {
    // ── Init LWC chart — deferred so LWC CDN and CSS layout are ready ─────────
    // initChart() has its own retry loop for LWC/dimensions — safe to call now
    initChart();

    // ── Signal / scan buttons ──────────────────────────────────────────────────
    on('runAiSignal', 'click', runAISignal);
    on('scanNow',     'click', scan);
    on('exportCsv',   'click', exportCsv);
    on('resetDayBtn', 'click', resetDay);
    on('runWeekly',   'click', runWeeklyBacktest);
    on('getAiBias',   'click', getAiBias);

    // ── TradeLocker — inline onclick already set in HTML as backup ─────────────
    on('tlLoginBtn',   'click', tlLogin);
    on('tlRefresh',    'click', tlFetchAccount);
    on('tlDisconnect', 'click', tlDisconnect);

    // ── Trade log buttons ──────────────────────────────────────────────────────
    on('logSignal', 'click', () => {
      logSignal('LIVE');
      document.getElementById('logSignal')?.style && (document.getElementById('logSignal').style.display = 'none');
      document.getElementById('closeWin')?.style  && (document.getElementById('closeWin').style.display  = 'inline-flex');
      document.getElementById('closeLoss')?.style && (document.getElementById('closeLoss').style.display = 'inline-flex');
    });

    on('closeWin', 'click', () => {
      closeCurrentTrade('win');
      document.getElementById('logSignal')?.style && (document.getElementById('logSignal').style.display = 'inline-flex');
      document.getElementById('closeWin')?.style  && (document.getElementById('closeWin').style.display  = 'none');
      document.getElementById('closeLoss')?.style && (document.getElementById('closeLoss').style.display = 'none');
      document.getElementById('tradeMgrPanel')?.style && (document.getElementById('tradeMgrPanel').style.display = 'none');
      document.getElementById('exitAlert')?.style && (document.getElementById('exitAlert').style.display = 'none');
      resetExitAlerts();
    });

    on('closeLoss', 'click', () => {
      closeCurrentTrade('loss');
      document.getElementById('logSignal')?.style && (document.getElementById('logSignal').style.display = 'inline-flex');
      document.getElementById('closeWin')?.style  && (document.getElementById('closeWin').style.display  = 'none');
      document.getElementById('closeLoss')?.style && (document.getElementById('closeLoss').style.display = 'none');
      document.getElementById('tradeMgrPanel')?.style && (document.getElementById('tradeMgrPanel').style.display = 'none');
      document.getElementById('exitAlert')?.style && (document.getElementById('exitAlert').style.display = 'none');
      resetExitAlerts();
    });

    // ── Bar replay ─────────────────────────────────────────────────────────────
    on('replayToggle',     'click', () => state.replay.active ? replayStop() : replayStart());
    on('replayPlay',       'click', replayPlayPause);
    on('replayStepBack',   'click', () => replayStep(-1));
    on('replayStepFwd',    'click', () => replayStep(1));
    on('replayStepBack10', 'click', () => replayStep(-10));
    on('replayStepFwd10',  'click', () => replayStep(10));
    on('replayStop',       'click', replayStop);
    on('rpLong',           'click', () => replayEnterTrade('long'));
    on('rpShort',          'click', () => replayEnterTrade('short'));
    on('rpCloseTrade',     'click', () => replayCloseTrade());
    on('replaySpeed', 'input', () => {
      const rs = document.getElementById('replaySpeed');
      const rv = document.getElementById('replaySpeedVal');
      if (rs && rv) { rv.textContent = rs.value; }
    });

    // ── Exit alert ─────────────────────────────────────────────────────────────
    on('exitAlertAck', 'click', () => {
      const ea = document.getElementById('exitAlert');
      if (ea) ea.style.display = 'none';
    });

    // ── Risk inputs ────────────────────────────────────────────────────────────
    ['accountSize','riskPct','stopPts'].forEach(id => on(id, 'input', renderRisk));

    // ── Timeframe buttons — drive TradingView widget directly ─────────────────
    document.querySelectorAll('[data-tf]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tf = btn.dataset.tf;
        document.querySelectorAll('[data-tf]').forEach(x => x.classList.remove('active'));
        btn.classList.add('active');
        currentTF = tf;
        if (state.replay.active) {
          // During replay, re-fetch and reload LWC with new TF
          fetchLiveCandles(tf).then(bars => {
            if (bars?.length) { state.candles = normalizeBars(bars, 'tl'); drawChart(); }
          });
          return;
        }
        if (window._tvWidget) {
          // Must wait for chart ready before calling setResolution
          window._tvWidget.onChartReady(() => {
            try { window._tvWidget.chart().setResolution(tvIntervalFor(tf)); } catch(_) {}
          });
        } else {
          initChart();
        }
      });
    });

    // ── Weekly stats restore ───────────────────────────────────────────────────
    if (state.weeklyStats) {
      const best = state.weeklyStats.find(s => s.id !== 4);
      if (best) {
        const bt = document.getElementById('backtestTitle');
        const bb = document.getElementById('backtestBody');
        if (bt) { bt.textContent = `A+ Last Week: S${best.id} — ${SCENARIOS[best.id].name}`; bt.className = 'green'; }
        if (bb)   bb.textContent  = 'Saved from last Sunday refresh. Click to update for this week.';
      }
    }

    renderJournal();
    renderDayPanel();
    renderSessionPill();
    renderTradingMode();
    setInterval(renderSessionPill, 1000);
    // LWC autoSize handles resize — no manual handler needed

  } catch (err) {
    // Boot error — log it but DON'T let it prevent the page from being usable.
    // The TL connect button has inline onclick in HTML so it works regardless.
    console.error('[PXBOT] boot() error:', err);
  }

  // ── Auto-load data on startup ────────────────────────────────────────────────
  // Runs after boot() so a boot error doesn't block data loading either.
  checkProxy().then(async online => {
    try {
      if (online) {
        // Check if we already have TL auth from a prior session stored in the server
        const health = await proxyGet('/api/health').catch(() => ({}));
        if (!health.authenticated) {
          // Server lost auth on restart — auto-reconnect with saved credentials
          const savedEmail = document.getElementById('tlEmail')?.value;
          const savedPass  = document.getElementById('tlPass')?.value;
          if (savedEmail && savedPass) {
            console.log('[PXBOT] Auto-reconnecting TL after server restart...');
            await tlLogin().catch(() => {});
          }
        }
        if (health.authenticated || state.tl?.connected) {
          // TL auto-connected — fetch candles for AI context (TV widget has the full chart)
          const candles = await fetchLiveCandles(currentTF);
          if (candles && candles.length) {
            state.candles = candles;
            state.tl = { ...state.tl, connected: true };
            const det = detectScenario(state.candles);
            state.fibHigh = det.fibHigh; state.fibLow = det.fibLow; state.fibBias = det.fibBias;
            renderSessionRanges(det);
            renderScenario(det.id);
            renderFibTable(det.fibHigh, det.fibLow, det.fibBias);
            const sig = buildSignal(det.id, det.fibHigh, det.fibLow, det.fibBias, det);
            renderSignalCard(sig);
            startPriceStream();
            startLivePolling();
            startAutoSignalEngine();
            setTimeout(runAISignal, 2000);
            return;
          }
        }
      }
    } catch (e) { console.warn('[PXBOT] startup data load:', e.message); }
    // Fallback: sim mode — try to seed SIM at real TL price if quote available
    try {
      const q = await proxyGet('/api/quote').catch(() => null);
      if (q?.last > 5000) window._tlLivePrice = q.last;
    } catch (_) {}
    scan();
    setInterval(tick, 2000);
  }).catch(() => { scan(); setInterval(tick, 2000); });
}

boot();
