const express = require('express');
const http = require('http');
const https = require('https');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static('public'));

const SHEETS_URL   = process.env.SHEETS_URL || '';
const PORT         = process.env.PORT || 8080;
const TAKT_SECONDS = 3 * 60 * 60;

const STATIONS = [
  { id: 1,  name: 'Framing',               type: 'main' },
  { id: 2,  name: 'Machining',             type: 'main' },
  { id: 3,  name: 'Lower Assembly',        type: 'main' },
  { id: 4,  name: 'Cut Bed',               type: 'main' },
  { id: 5,  name: 'Gantry and Z-Axis',     type: 'main' },
  { id: 6,  name: 'Laser and Wiring',      type: 'main' },
  { id: 7,  name: 'Skirting',              type: 'main' },
  { id: 8,  name: 'Testing',               type: 'main' },
  { id: 9,  name: 'Uprights and Z/X Axis', type: 'sub'  },
  { id: 10, name: 'Electrical Box',        type: 'sub'  },
  { id: 11, name: 'Kitting',               type: 'sub'  },
];

const HOLD_REASONS = [
  'No operator assigned',
  'No frame/material at station',
  'Secured (end of day)',
  'Waiting for previous station',
];

const SCHEDULED_BREAKS = [
  { id: 'break1', label: 'Morning Break',   start: [10, 30], end: [10, 45] },
  { id: 'lunch',  label: 'Lunch',           start: [13,  0], end: [13, 30] },
  { id: 'break2', label: 'Afternoon Break', start: [15,  0], end: [15, 15] },
];

function getCSTDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
}

function getScheduledBreak() {
  const cst  = getCSTDate();
  const mins = cst.getHours() * 60 + cst.getMinutes();
  for (const b of SCHEDULED_BREAKS) {
    const start = b.start[0] * 60 + b.start[1];
    const end   = b.end[0]   * 60 + b.end[1];
    if (mins >= start && mins < end) return b;
  }
  return null;
}

function todayStr() { return new Date().toDateString(); }

function resetStations() {
  return STATIONS.map(s => ({
    ...s,
    // Takt progress
    done: false,
    completedAt: null,
    // Station status
    stationStatus: 'hold',      // 'active' | 'hold' — worker starts via app
    holdReason: null,
    stationStartTime: null,     // ms when current active period started
    activeMs: 0,                // accumulated active ms this cycle
    // Andon
    andon: null,
    andonTime: null,
    andonPauseStart: null,
    totalAndonPause: 0,
    // Inventory
    requests: [],
  }));
}

let state = {
  running: false,
  paused: false,
  pauseLabel: null,
  pauseStart: null,
  totalPausedMs: 0,
  startTime: null,
  cycleCount: 0,
  cycleDate: todayStr(),
  stations: resetStations(),
};

let autoEndTimer    = null; // kept for scheduled break re-arm only
let breakCheckTimer = null;
let nextReqId       = 1;

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(data); });
}
function broadcastState() {
  broadcast({ type: 'state', state, taktSeconds: TAKT_SECONDS });
}

// ── Station active time helpers ──────────────────────────────
function stationActiveMs(st) {
  let ms = st.activeMs;
  if (st.stationStatus === 'active' && st.stationStartTime) {
    ms += Date.now() - st.stationStartTime;
  }
  return ms;
}

function pauseStationTimer(st) {
  if (st.stationStatus === 'active' && st.stationStartTime) {
    st.activeMs += Date.now() - st.stationStartTime;
    st.stationStartTime = null;
  }
}

function resumeStationTimer(st) {
  if (st.stationStatus === 'active' && !st.stationStartTime) {
    st.stationStartTime = Date.now();
  }
}

// ── Effective takt elapsed (excluding pauses) ────────────────
function effectiveElapsedMs() {
  if (!state.running || !state.startTime) return 0;
  let e = Date.now() - state.startTime - state.totalPausedMs;
  if (state.paused && state.pauseStart) e -= (Date.now() - state.pauseStart);
  return Math.max(0, e);
}

// ── Pause / Resume takt ──────────────────────────────────────
function pauseCycle(label) {
  if (!state.running || state.paused) return;
  state.paused     = true;
  state.pauseLabel = label;
  state.pauseStart = Date.now();
  // Pause all active station timers
  state.stations.forEach(st => pauseStationTimer(st));
  if (autoEndTimer) { clearTimeout(autoEndTimer); autoEndTimer = null; }
  broadcastState();
}

function resumeCycle() {
  if (!state.running || !state.paused) return;
  state.totalPausedMs += Date.now() - state.pauseStart;
  state.paused      = false;
  state.pauseLabel  = null;
  state.pauseStart  = null;
  // Resume active station timers
  state.stations.forEach(st => resumeStationTimer(st));
  broadcastState();
}

// ── Scheduled break checker ──────────────────────────────────
function checkBreaks() {
  if (!state.running) return;
  const brk = getScheduledBreak();
  if (brk && !state.paused) pauseCycle(brk.label);
  else if (!brk && state.paused && state.pauseLabel !== 'Paused') resumeCycle();
}

function startBreakChecker() {
  if (breakCheckTimer) clearInterval(breakCheckTimer);
  breakCheckTimer = setInterval(checkBreaks, 15000);
  checkBreaks();
}
function stopBreakChecker() {
  if (breakCheckTimer) { clearInterval(breakCheckTimer); breakCheckTimer = null; }
}

// ── End cycle ────────────────────────────────────────────────
function endCycle() {
  if (!state.running) return;
  if (autoEndTimer) { clearTimeout(autoEndTimer); autoEndTimer = null; }
  stopBreakChecker();
  // Freeze all station timers
  state.stations.forEach(st => pauseStationTimer(st));
  state.running    = false;
  state.paused     = false;
  state.pauseLabel = null;
  state.pauseStart = null;
  state.cycleCount++;
  const elapsed = Math.round(effectiveElapsedMs() / 1000);
  broadcastState();
  postToSheets({
    cycle: state.cycleCount,
    date: new Date().toLocaleDateString(),
    time: new Date().toLocaleTimeString(),
    elapsedSeconds: elapsed,
    stations: state.stations.map(s => ({
      id: s.id,
      name: s.name,
      type: s.type,
      completedAt: s.completedAt,
      activeSeconds: Math.round(s.activeMs / 1000),
    })),
  });
}

// ── Sheets (redirect-safe) ───────────────────────────────────
async function postToSheets(payload) {
  if (!SHEETS_URL) return;
  try {
    const res = await fetch(SHEETS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });
    const text = await res.text();
    console.log('Sheets post response:', res.status, text);
  } catch (e) { console.error('Sheets post failed:', e.message); }
}

// ── REST fallback ────────────────────────────────────────────
app.get('/api/state', (req, res) => {
  res.json({ state, taktSeconds: TAKT_SECONDS, holdReasons: HOLD_REASONS });
});

// ── Inventory proxy — fetches fresh from Sheets on each call ─
app.get('/api/inventory', async (req, res) => {
  if (!SHEETS_URL) return res.json({ success: false, error: 'SHEETS_URL not set' });
  try {
    // Convert POST url to GET (same base URL, Apps Script routes by method)
    const r = await fetch(SHEETS_URL, { method: 'GET', redirect: 'follow' });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    console.error('Inventory fetch failed:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// ── WebSocket ────────────────────────────────────────────────
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'state', state, taktSeconds: TAKT_SECONDS, holdReasons: HOLD_REASONS }));

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    // ── Start takt ───────────────────────────────────────────
    if (msg.type === 'start') {
      if (state.running) return;
      const today = todayStr();
      if (state.cycleDate !== today) { state.cycleCount = 0; state.cycleDate = today; }
      state.running       = true;
      state.paused        = false;
      state.pauseLabel    = null;
      state.pauseStart    = null;
      state.totalPausedMs = 0;
      state.stations      = resetStations();
      const startTime     = Date.now() + 100;
      state.startTime     = startTime;
      // Fix stationStartTime to match actual startTime
      state.stations.forEach(st => { st.stationStartTime = startTime; });
      broadcast({ type: 'start', startTime, taktSeconds: TAKT_SECONDS, stations: state.stations, cycleCount: state.cycleCount, holdReasons: HOLD_REASONS });
      startBreakChecker();
    }

    // ── Manual pause toggle ──────────────────────────────────
    if (msg.type === 'pause') {
      if (!state.running) return;
      if (state.paused && state.pauseLabel === 'Paused') resumeCycle();
      else if (!state.paused) pauseCycle('Paused');
    }

    // ── Station start (worker presses Start) ─────────────────
    if (msg.type === 'station-start') {
      const st = state.stations.find(s => s.id === msg.stationId);
      if (st && !st.done && state.running && !state.paused) {
        st.stationStatus    = 'active';
        st.holdReason       = null;
        st.stationStartTime = Date.now();
        broadcastState();
      }
    }

    // ── Station hold (worker or board puts on hold) ──────────
    if (msg.type === 'station-hold') {
      const st = state.stations.find(s => s.id === msg.stationId);
      if (st && !st.done) {
        pauseStationTimer(st);
        st.stationStatus = 'hold';
        st.holdReason    = msg.reason || 'No operator assigned';
        st.stationStartTime = null;
        broadcastState();
      }
    }

    // ── Station done ─────────────────────────────────────────
    if (msg.type === 'done') {
      const st = state.stations.find(s => s.id === msg.stationId);
      if (st && !st.done && state.running) {
        // Freeze station timer
        pauseStationTimer(st);
        st.stationStatus = 'hold';
        st.done          = true;
        const andonPausedMs = (st.totalAndonPause || 0) + (st.andonPauseStart ? Date.now() - st.andonPauseStart : 0);
        st.completedAt   = Math.round((effectiveElapsedMs() - andonPausedMs) / 1000);
        broadcastState();
        if (state.stations.every(s => s.done)) endCycle();
      }
    }

    // ── Inventory request ────────────────────────────────────
    if (msg.type === 'request') {
      const st = state.stations.find(s => s.id === msg.stationId);
      if (st && typeof msg.text === 'string' && msg.text.trim()) {
        st.requests.push({
          id: nextReqId++,
          text: msg.text.trim().slice(0, 120),
          time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        });
        broadcastState();
      }
    }

    // ── Dismiss inventory request ────────────────────────────
    if (msg.type === 'dismiss') {
      const st = state.stations.find(s => s.id === msg.stationId);
      if (st) { st.requests = st.requests.filter(r => r.id !== msg.reqId); broadcastState(); }
    }

    // ── Andon call ───────────────────────────────────────────
    if (msg.type === 'andon') {
      const st = state.stations.find(s => s.id === msg.stationId);
      if (st && (msg.level === 'line-lead' || msg.level === 'floor-manager')) {
        st.andon           = msg.level;
        st.andonTime       = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        st.andonPauseStart = Date.now();
        // Also pause station active timer
        pauseStationTimer(st);
        broadcastState();
      }
    }

    // ── Andon clear ──────────────────────────────────────────
    if (msg.type === 'andon-clear') {
      const st = state.stations.find(s => s.id === msg.stationId);
      if (st) {
        if (st.andonPauseStart) {
          st.totalAndonPause  += Date.now() - st.andonPauseStart;
          st.andonPauseStart   = null;
        }
        st.andon     = null;
        st.andonTime = null;
        // Resume station timer if it was active before andon
        if (st.stationStatus === 'active' && !state.paused) {
          st.stationStartTime = Date.now();
        }
        broadcastState();
      }
    }

    // ── Manual end ───────────────────────────────────────────
    if (msg.type === 'end') endCycle();
  });
});

server.listen(PORT, () => console.log(`Lightboard running on port ${PORT}`));
