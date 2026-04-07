const express = require('express');
const http    = require('http');
const { WebSocketServer } = require('ws');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static('public'));

const SHEETS_URL    = process.env.SHEETS_URL    || '';
const LOCATIONS_URL = process.env.LOCATIONS_URL || '';
const PORT          = process.env.PORT          || 8080;
const TAKT_SECONDS  = 3 * 60 * 60;

// ── Apollo stations ──────────────────────────────────────────
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

const OTHER_LINES = ['XF/PRO', 'TITAN', 'VULCAN', 'XR', 'MR1'];

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

// ── Global request store (persists across takt restarts) ─────
let allRequests = [];
let nextReqId   = 1;

// ── Apollo state ─────────────────────────────────────────────
function resetStations() {
  const now = Date.now();
  return STATIONS.map(s => ({
    ...s,
    done: false, completedAt: null,
    stationStatus: 'active', holdReason: null,
    stationStartTime: now, activeMs: 0,
    andon: null, andonTime: null,
    andonPauseStart: null, totalAndonPause: 0,
    requests: [],
  }));
}

let state = {
  running: false, paused: false,
  pauseLabel: null, pauseStart: null, totalPausedMs: 0,
  startTime: null, cycleCount: 0, cycleDate: todayStr(),
  stations: resetStations(),
};

let autoEndTimer    = null;
let breakCheckTimer = null;

// ── Station timer helpers ────────────────────────────────────
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
function effectiveElapsedMs() {
  if (!state.running || !state.startTime) return 0;
  let e = Date.now() - state.startTime - state.totalPausedMs;
  if (state.paused && state.pauseStart) e -= (Date.now() - state.pauseStart);
  return Math.max(0, e);
}

// ── WebSocket client sets ────────────────────────────────────
const apolloClients = new Set();
const pickerClients = new Set();

function broadcastApollo(msg) {
  const data = JSON.stringify(msg);
  apolloClients.forEach(c => { if (c.readyState === 1) c.send(data); });
}
function broadcastState() {
  broadcastApollo({ type: 'state', state, taktSeconds: TAKT_SECONDS, holdReasons: HOLD_REASONS });
}
function broadcastRequests() {
  const priOrder = { high: 0, medium: 1, low: 2 };
  const active = allRequests
    .filter(r => !r.fulfilled)
    .sort((a, b) => (priOrder[a.priority] ?? 2) - (priOrder[b.priority] ?? 2));
  const msg = JSON.stringify({ type: 'requests', requests: active });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

// ── Pause / Resume ───────────────────────────────────────────
function pauseCycle(label) {
  if (!state.running || state.paused) return;
  state.paused = true; state.pauseLabel = label; state.pauseStart = Date.now();
  state.stations.forEach(st => pauseStationTimer(st));
  if (autoEndTimer) { clearTimeout(autoEndTimer); autoEndTimer = null; }
  broadcastState();
}
function resumeCycle() {
  if (!state.running || !state.paused) return;
  state.totalPausedMs += Date.now() - state.pauseStart;
  state.paused = false; state.pauseLabel = null; state.pauseStart = null;
  state.stations.forEach(st => resumeStationTimer(st));
  broadcastState();
}
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
  state.stations.forEach(st => pauseStationTimer(st));
  state.running = false; state.paused = false;
  state.pauseLabel = null; state.pauseStart = null;
  state.cycleCount++;
  const elapsed = Math.round(effectiveElapsedMs() / 1000);
  broadcastState();
  postToSheets({
    cycle: state.cycleCount,
    date: new Date().toLocaleDateString(),
    time: new Date().toLocaleTimeString(),
    elapsedSeconds: elapsed,
    stations: state.stations.map(s => ({
      id: s.id, name: s.name, type: s.type,
      completedAt: s.completedAt,
      activeSeconds: Math.round(s.activeMs / 1000),
    })),
  });
}

// ── Locations cache ──────────────────────────────────────────
let locationsCache = [];
async function fetchLocations() {
  if (!LOCATIONS_URL) return;
  try {
    const r = await fetch(LOCATIONS_URL, { redirect: 'follow' });
    const d = await r.json();
    if (d.success && d.locations) {
      locationsCache = d.locations;
      console.log('Locations loaded:', locationsCache.length);
    }
  } catch(e) { console.error('Locations fetch failed:', e.message); }
}
fetchLocations();
setInterval(fetchLocations, 5 * 60 * 1000);

// ── Inventory cache ──────────────────────────────────────────
let inventoryCache = null;
async function fetchInventory() {
  if (!LOCATIONS_URL) return;
  try {
    const r = await fetch(LOCATIONS_URL, { redirect: 'follow' });
    const d = await r.json();
    if (d.success) {
      inventoryCache = d;
      console.log('Inventory cached:', Object.keys(d.inventory || {}).length, 'groups');
    }
  } catch(e) { console.error('Inventory cache failed:', e.message); }
}
fetchInventory();
setInterval(fetchInventory, 10 * 60 * 1000);

// ── Location lookup ──────────────────────────────────────────
function lookupLocation(partNum) {
  const matches = locationsCache.filter(l =>
    l.partNum.toLowerCase() === String(partNum).toLowerCase()
  );
  if (!matches.length) return { location: '—', quantity: '—', totalQty: '—', allLocations: [] };
  const totalQty = matches.reduce((sum, l) => sum + (parseInt(l.quantity) || 0), 0);
  return {
    location:     matches[0].location,
    quantity:     matches[0].quantity,
    totalQty:     String(totalQty),
    allLocations: matches.map(l => ({ location: l.location, quantity: l.quantity })),
    partNum:      matches[0].partNum,
    partName:     matches[0].partName,
  };
}

// ── Sheets post ──────────────────────────────────────────────
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
  } catch(e) { console.error('Sheets post failed:', e.message); }
}

// ── REST endpoints ───────────────────────────────────────────
app.get('/api/state', (req, res) => {
  res.json({ state, taktSeconds: TAKT_SECONDS, holdReasons: HOLD_REASONS });
});
app.get('/api/requests', (req, res) => {
  const priOrder = { high: 0, medium: 1, low: 2 };
  const active = allRequests
    .filter(r => !r.fulfilled)
    .sort((a, b) => (priOrder[a.priority] ?? 2) - (priOrder[b.priority] ?? 2));
  res.json({ requests: active });
});
app.get('/api/inventory', (req, res) => {
  if (inventoryCache) return res.json(inventoryCache);
  res.json({ success: false, error: 'Inventory not yet loaded — please wait a moment and refresh' });
});
app.get('/api/locations', (req, res) => {
  res.json({ success: true, locations: locationsCache });
});
app.get('/api/lines', (req, res) => {
  res.json({ lines: OTHER_LINES });
});
app.get('/api/refresh-locations', async (req, res) => {
  await fetchLocations();
  await fetchInventory();
  res.json({ success: true, count: locationsCache.length });
});

// ── WebSocket ────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const url      = req.url || '';
  const isPicker = url.includes('picker=1');

  if (isPicker) {
    pickerClients.add(ws);
    ws.send(JSON.stringify({ type: 'requests', requests: allRequests.filter(r => !r.fulfilled) }));
  } else {
    apolloClients.add(ws);
    ws.send(JSON.stringify({ type: 'state', state, taktSeconds: TAKT_SECONDS, holdReasons: HOLD_REASONS }));
    ws.send(JSON.stringify({ type: 'requests', requests: allRequests.filter(r => !r.fulfilled) }));
  }

  ws.on('close', () => { apolloClients.delete(ws); pickerClients.delete(ws); });

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    // ── Ping keepalive ───────────────────────────────────────
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    // ── Start takt ───────────────────────────────────────────
    if (msg.type === 'start') {
      if (state.running) return;
      const today = todayStr();
      if (state.cycleDate !== today) { state.cycleCount = 0; state.cycleDate = today; }
      state.running = true; state.paused = false;
      state.pauseLabel = null; state.pauseStart = null; state.totalPausedMs = 0;
      state.stations = resetStations();
      const startTime = Date.now() + 100;
      state.startTime = startTime;
      state.stations.forEach(st => { st.stationStartTime = startTime; });
      broadcastApollo({ type: 'start', startTime, taktSeconds: TAKT_SECONDS, stations: state.stations, cycleCount: state.cycleCount, holdReasons: HOLD_REASONS });
      startBreakChecker();
    }

    // ── Pause toggle ─────────────────────────────────────────
    if (msg.type === 'pause') {
      if (!state.running) return;
      if (state.paused && state.pauseLabel === 'Paused') resumeCycle();
      else if (!state.paused) pauseCycle('Paused');
    }

    // ── Station start ────────────────────────────────────────
    if (msg.type === 'station-start') {
      const st = state.stations.find(s => s.id === msg.stationId);
      if (st && !st.done && state.running && !state.paused) {
        st.stationStatus = 'active'; st.holdReason = null;
        st.stationStartTime = Date.now();
        broadcastState();
      }
    }

    // ── Station hold ─────────────────────────────────────────
    if (msg.type === 'station-hold') {
      const st = state.stations.find(s => s.id === msg.stationId);
      if (st && !st.done) {
        pauseStationTimer(st);
        st.stationStatus = 'hold';
        st.holdReason = msg.reason || 'No operator assigned';
        st.stationStartTime = null;
        broadcastState();
      }
    }

    // ── Station done ─────────────────────────────────────────
    if (msg.type === 'done') {
      const st = state.stations.find(s => s.id === msg.stationId);
      if (st && !st.done && state.running) {
        pauseStationTimer(st);
        st.stationStatus = 'hold'; st.done = true;
        const andonMs = (st.totalAndonPause || 0) + (st.andonPauseStart ? Date.now() - st.andonPauseStart : 0);
        st.completedAt = Math.round((effectiveElapsedMs() - andonMs) / 1000);
        broadcastState();
        if (state.stations.every(s => s.done)) endCycle();
      }
    }

    // ── Inventory request ────────────────────────────────────
    if (msg.type === 'request') {
      console.log('Request received:', msg.line, msg.partNum || msg.text, 'priority:', msg.priority);
      const stName = msg.station || (msg.stationId ? (state.stations.find(s => s.id === msg.stationId)?.name || null) : null);
      const loc    = lookupLocation(msg.partNum || '');
      const req = {
        id:           nextReqId++,
        line:         msg.line     || 'Apollo',
        station:      stName,
        partNum:      msg.partNum  || '',
        partName:     msg.partName || '',
        text:         msg.text     || '',
        qty:          msg.qty      || 1,
        priority:     String(msg.priority || 'low'),
        totalQty:     loc.totalQty,
        allLocations: loc.allLocations,
        location:     loc.location,
        stockQty:     loc.quantity,
        time:         new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        fulfilled:    false,
      };
      console.log('Stored request priority:', req.priority);
      if (msg.stationId) {
        const st = state.stations.find(s => s.id === msg.stationId);
        if (st) {
          st.requests = st.requests || [];
          st.requests.push({ id: req.id, text: req.text || (req.partNum + ' — ' + req.partName), time: req.time });
          broadcastState();
        }
      }
      allRequests.push(req);
      broadcastRequests();
    }

    // ── Dismiss inventory request ────────────────────────────
    if (msg.type === 'dismiss') {
      const st = state.stations.find(s => s.id === msg.stationId);
      if (st) { st.requests = (st.requests || []).filter(r => r.id !== msg.reqId); broadcastState(); }
      const req = allRequests.find(r => r.id === msg.reqId);
      if (req) { req.fulfilled = true; broadcastRequests(); }
    }

    // ── Andon call ───────────────────────────────────────────
    if (msg.type === 'andon') {
      const st = state.stations.find(s => s.id === msg.stationId);
      if (st && (msg.level === 'line-lead' || msg.level === 'floor-manager')) {
        st.andon = msg.level;
        st.andonTime = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        st.andonPauseStart = Date.now();
        pauseStationTimer(st);
        broadcastState();
      }
    }

    // ── Andon clear ──────────────────────────────────────────
    if (msg.type === 'andon-clear') {
      const st = state.stations.find(s => s.id === msg.stationId);
      if (st) {
        if (st.andonPauseStart) {
          st.totalAndonPause += Date.now() - st.andonPauseStart;
          st.andonPauseStart = null;
        }
        st.andon = null; st.andonTime = null;
        if (st.stationStatus === 'active' && !state.paused) st.stationStartTime = Date.now();
        broadcastState();
      }
    }

    // ── Fulfill (picker picks a request) ────────────────────
    if (msg.type === 'fulfill') {
      const req = allRequests.find(r => r.id === msg.reqId);
      console.log('Fulfill received:', { reqId: msg.reqId, location: msg.location, partNum: req?.partNum, qty: msg.qty });
      if (req) {
        req.fulfilled = true;
        const actualQty = (msg.qty !== undefined && msg.qty !== null) ? msg.qty : (req.qty || 1);
        // Only subtract if qty > 0 (qty=0 means cancelled, no inventory change)
        if (LOCATIONS_URL && req.partNum && actualQty > 0) {
          fetch(LOCATIONS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action:   'subtract',
              partNum:  req.partNum  || '',
              partName: req.partName || '',
              location: msg.location || '',
              qty:      actualQty,
            }),
            redirect: 'follow',
          }).then(r => r.json())
            .then(d => {
              console.log('Qty subtracted:', d);
              if (d.success && d.newQty !== undefined) {
                const loc = locationsCache.find(l =>
                  l.partNum.toLowerCase()  === (req.partNum || '').toLowerCase() &&
                  l.location.toLowerCase() === (msg.location || '').toLowerCase()
                );
                if (loc) {
                  loc.quantity = String(d.newQty);
                  const locMsg = JSON.stringify({ type: 'locations', locations: locationsCache });
                  pickerClients.forEach(c => { if (c.readyState === 1) c.send(locMsg); });
                }
              }
            })
            .catch(e => console.error('Subtract failed:', e.message));
        }
        state.stations.forEach(st => {
          if (st.requests) st.requests = st.requests.filter(r => r.id !== msg.reqId);
        });
        broadcastState();
        broadcastRequests();
      }
    }

    // ── Stow inventory ───────────────────────────────────────
    if (msg.type === 'stow') {
      if (!LOCATIONS_URL) return;
      fetch(LOCATIONS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action:   'stow',
          location: msg.location || '',
          partNum:  msg.partNum  || '',
          partName: msg.partName || '',
          qty:      msg.qty      || 1,
        }),
        redirect: 'follow',
      }).then(r => r.json())
        .then(d => {
          console.log('Stow response:', d);
          if (d.success) { fetchLocations(); fetchInventory(); }
          ws.send(JSON.stringify({ type: 'stow-result', success: d.success, message: d.message || d.error }));
        })
        .catch(e => {
          console.error('Stow failed:', e.message);
          ws.send(JSON.stringify({ type: 'stow-result', success: false, message: e.message }));
        });
    }

    // ── Manual end takt ──────────────────────────────────────
    if (msg.type === 'end') endCycle();
  });
});

server.listen(PORT, () => console.log(`LangmuirPMS running on port ${PORT}`));
