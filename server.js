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

// Apollo line takt (scheduled cadence reference; does not gate station cycles)
const APOLLO_TAKT_SECONDS = 3 * 60 * 60;
// Legacy alias kept for any inline references; remove in 5b.
const TAKT_SECONDS = APOLLO_TAKT_SECONDS;

// Titan line takt (2h reference; Titan cycles are still driven by manual unit-complete clicks)
const TITAN_TAKT_SECONDS = 2 * 60 * 60;

// Green-flash window after a station Done — keeps index.html's completed-state
// visual cue until 5b gives 'break'/new states proper treatment. See spec §4.
const DONE_FLASH_MS = 5000;

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

const ALL_LINES   = ['Apollo', 'XF/PRO', 'TITAN', 'VULCAN', 'XR', 'MR1', 'Shipping'];
const OTHER_LINES = ['XF/PRO', 'TITAN', 'VULCAN', 'XR', 'MR1', 'Shipping'];

// Apollo break schedule: 10:30 break, 13:00 lunch, 15:00 break
const SCHEDULED_BREAKS = [
  { id: 'break1', label: 'Morning Break',   start: [10, 30], end: [10, 45] },
  { id: 'lunch',  label: 'Lunch',           start: [13,  0], end: [13, 30] },
  { id: 'break2', label: 'Afternoon Break', start: [15,  0], end: [15, 15] },
];

// Titan break schedule: same breaks but lunch at 12:20 (30 min)
const TITAN_BREAKS = [
  { id: 'break1', label: 'Morning Break',   start: [10, 30], end: [10, 45] },
  { id: 'lunch',  label: 'Lunch',           start: [12, 20], end: [12, 50] },
  { id: 'break2', label: 'Afternoon Break', start: [15,  0], end: [15, 15] },
];

function getCSTDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
}
function getScheduledBreak(schedule = SCHEDULED_BREAKS) {
  const cst  = getCSTDate();
  const mins = cst.getHours() * 60 + cst.getMinutes();
  for (const b of schedule) {
    const start = b.start[0] * 60 + b.start[1];
    const end   = b.end[0]   * 60 + b.end[1];
    if (mins >= start && mins < end) return b;
  }
  return null;
}
function todayStr() { return new Date().toDateString(); }

// ── Global request store ─────────────────────────────────────
let allRequests      = [];
let nextReqId        = 1;
let recentlyFulfilled = []; // max 2, server-side persisted

// ═══════════════════════════════════════════════════════════════
// PR 5a — Per-line state model
// ═══════════════════════════════════════════════════════════════
// `states` replaces the old globals `state` and `titanState`.
// `states.apollo` owns the Apollo board; `states.titan` owns Titan.
// Future lines (XF/PRO, VULCAN, etc.) plug in here.
//
// Key semantic shift for Apollo:
//   - `running` = "line is open for the day" (not "cycle in progress")
//   - Stations cycle INDEPENDENTLY. Each tracks its own cycle count.
//   - `lineCycleCount` stays 0 in 5a — will be driven by Skirting in PR 5c.
// ═══════════════════════════════════════════════════════════════

function newApolloStations() {
  return STATIONS.map(s => ({
    id: s.id, name: s.name, type: s.type,
    stationStatus: 'idle',           // 'idle' | 'active' | 'hold' | 'break'
    holdReason: null,
    stationStartTime: null,          // epoch ms when current 'active' span began
    activeMs: 0,                     // active time in CURRENT cycle
    stationCycleCount: 0,            // cycles this station completed today
    lastCycleSeconds: null,          // active-time of most-recent completed cycle
    // Per-cycle accumulators — reset at the start of each new cycle.
    holdMs: 0,
    breakMs: 0,
    holdSpanStart: null,             // epoch ms when current 'hold' span began
    breakSpanStart: null,            // epoch ms when current 'break' span began
    preBreakStatus: null,            // 'active' | 'hold' — what to restore to after break
    // Transient done flash — see spec §4.
    done: false,
    completedAt: null,
    _doneTimeoutId: null,            // stripped from broadcasts
    // Andon — unchanged from pre-5a.
    andon: null, andonTime: null,
    andonPauseStart: null, totalAndonPause: 0,
    // Inventory requests — unchanged.
    requests: [],
  }));
}

let states = {
  apollo: {
    taktSeconds:      APOLLO_TAKT_SECONDS,
    lineCycleCount:   0,
    cycleDate:        todayStr(),
    running:          false,
    paused:           false,
    pauseLabel:       null,
    pauseStart:       null,
    totalPausedMs:    0,
    startTime:        null,            // when the line was opened today
    lastCycleSeconds: null,            // active time of most-recent line cycle (5b)
    stations:         newApolloStations(),
    _breakCheckTimer: null,
  },
  titan: {
    taktSeconds:      TITAN_TAKT_SECONDS,
    running:          false,
    paused:           false,
    pauseLabel:       null,
    pauseStart:       null,
    totalPausedMs:    0,
    startTime:        null,          // start of current Titan cycle (resets on unit-complete)
    cycleCount:       0,             // units completed today
    cycleDate:        todayStr(),
    lastCycleSeconds: null,
    _breakCheckTimer: null,
  },
};

// ── Serialization helper ──────────────────────────────────────
// Strips internal fields (prefixed with _) before broadcasting.
function serializeLine(line) {
  const copy = {};
  for (const k of Object.keys(line)) {
    if (k.startsWith('_')) continue;
    if (k === 'stations') {
      copy.stations = line.stations.map(st => {
        const s = {};
        for (const sk of Object.keys(st)) {
          if (sk.startsWith('_')) continue;
          s[sk] = st[sk];
        }
        return s;
      });
    } else {
      copy[k] = line[k];
    }
  }
  // Backward-compat alias — index.html reads state.cycleCount for the line counter.
  if (line === states.apollo) copy.cycleCount = line.lineCycleCount;
  return copy;
}

// ── Apollo line helpers ───────────────────────────────────────
function apolloEffectiveElapsedMs() {
  const s = states.apollo;
  if (!s.running || !s.startTime) return 0;
  let e = Date.now() - s.startTime - s.totalPausedMs;
  if (s.paused && s.pauseStart) e -= (Date.now() - s.pauseStart);
  return Math.max(0, e);
}

// Pauses the 'active' timer WITHOUT changing stationStatus. Used by manual
// line-level pause (not by break — break transitions status to 'break').
function suspendActiveTimer(st) {
  if (st.stationStatus === 'active' && st.stationStartTime) {
    st.activeMs += Date.now() - st.stationStartTime;
    st.stationStartTime = null;
  }
}
function resumeActiveTimer(st) {
  if (st.stationStatus === 'active' && !st.stationStartTime) {
    st.stationStartTime = Date.now();
  }
}

// ── Station lifecycle transitions ─────────────────────────────
// Invariant: exactly one of (stationStartTime, holdSpanStart, breakSpanStart)
// is non-null at any time, matching the current stationStatus.

function cancelDoneFlash(st) {
  if (st._doneTimeoutId) {
    clearTimeout(st._doneTimeoutId);
    st._doneTimeoutId = null;
  }
  st.done = false;
  st.completedAt = null;
}

function resetPerCycleAccumulators(st) {
  st.activeMs         = 0;
  st.holdMs           = 0;
  st.breakMs          = 0;
  st.totalAndonPause  = 0;
  st.stationStartTime = null;
  st.holdSpanStart    = null;
  st.breakSpanStart   = null;
}

// Close out whichever span is currently open and roll its elapsed ms into the
// appropriate accumulator.
function closeOpenSpan(st) {
  const now = Date.now();
  if (st.stationStatus === 'active' && st.stationStartTime) {
    st.activeMs += now - st.stationStartTime;
    st.stationStartTime = null;
  } else if (st.stationStatus === 'hold' && st.holdSpanStart) {
    st.holdMs += now - st.holdSpanStart;
    st.holdSpanStart = null;
  } else if (st.stationStatus === 'break' && st.breakSpanStart) {
    st.breakMs += now - st.breakSpanStart;
    st.breakSpanStart = null;
  }
}

function stationStart(line, st) {
  // Allowed from: idle (fresh cycle) or hold (resume).
  if (st.stationStatus !== 'idle' && st.stationStatus !== 'hold') return false;
  cancelDoneFlash(st);
  if (st.stationStatus === 'idle') {
    resetPerCycleAccumulators(st);
  } else {
    closeOpenSpan(st);  // roll closing hold span into holdMs
  }
  st.stationStatus    = 'active';
  st.holdReason       = null;
  st.stationStartTime = Date.now();
  return true;
}

function stationHold(line, st, reason) {
  if (st.stationStatus !== 'active') return false;
  closeOpenSpan(st);
  st.stationStatus = 'hold';
  st.holdReason    = reason || HOLD_REASONS[0];
  st.holdSpanStart = Date.now();
  return true;
}

function stationDone(line, st) {
  if (st.stationStatus !== 'active') return false;
  closeOpenSpan(st);
  st.stationCycleCount += 1;
  st.lastCycleSeconds   = Math.round(st.activeMs / 1000);
  // Log to Apollo Cycle Log BEFORE resetting — log reads the accumulators.
  logStationCycle(line, st);
  // Transient done flash for frontend compat.
  st.done          = true;
  st.completedAt   = st.lastCycleSeconds;
  st.stationStatus = 'idle';
  st._doneTimeoutId = setTimeout(() => {
    cancelDoneFlash(st);
    resetPerCycleAccumulators(st);
    broadcastApolloState();
  }, DONE_FLASH_MS);
  return true;
}

// Transition an active/hold station into 'break' when break starts.
function stationEnterBreak(st) {
  if (st.stationStatus !== 'active' && st.stationStatus !== 'hold') return;
  st.preBreakStatus = st.stationStatus;
  closeOpenSpan(st);
  st.stationStatus  = 'break';
  st.breakSpanStart = Date.now();
}
// Transition a 'break' station back to its prior status when break ends.
function stationExitBreak(st) {
  if (st.stationStatus !== 'break') return;
  closeOpenSpan(st);
  const prior = st.preBreakStatus || 'active';
  st.preBreakStatus = null;
  if (prior === 'active') {
    st.stationStatus    = 'active';
    st.stationStartTime = Date.now();
  } else { // was 'hold'
    st.stationStatus = 'hold';
    st.holdSpanStart = Date.now();
    // holdReason preserved from before the break.
  }
}

// ── Apollo pause / resume ────────────────────────────────────
// Per spec decision (a): during breaks, line-level `paused` stays true so
// existing frontend (index.html, worker.html) still shows its pause overlay.
// Stations ALSO transition to 'break' status for per-cycle break-time logging.
// Manual pauses (label='Paused') only suspend active timers without changing
// station status.
function apolloPauseCycle(label) {
  const s = states.apollo;
  if (!s.running || s.paused) return;
  s.paused     = true;
  s.pauseLabel = label;
  s.pauseStart = Date.now();
  const isBreak = label && label !== 'Paused';
  s.stations.forEach(st => {
    if (isBreak) stationEnterBreak(st);
    else         suspendActiveTimer(st);
  });
  broadcastApolloState();
}
function apolloResumeCycle() {
  const s = states.apollo;
  if (!s.running || !s.paused) return;
  s.totalPausedMs += Date.now() - s.pauseStart;
  const wasBreak = s.pauseLabel && s.pauseLabel !== 'Paused';
  s.paused     = false;
  s.pauseLabel = null;
  s.pauseStart = null;
  s.stations.forEach(st => {
    if (wasBreak) stationExitBreak(st);
    else          resumeActiveTimer(st);
  });
  broadcastApolloState();
}
function apolloCheckBreaks() {
  const s = states.apollo;
  if (!s.running) return;
  const brk = getScheduledBreak(SCHEDULED_BREAKS);
  if (brk && !s.paused) apolloPauseCycle(brk.label);
  else if (!brk && s.paused && s.pauseLabel !== 'Paused') apolloResumeCycle();
}
function apolloStartBreakChecker() {
  const s = states.apollo;
  if (s._breakCheckTimer) clearInterval(s._breakCheckTimer);
  s._breakCheckTimer = setInterval(apolloCheckBreaks, 15000);
  apolloCheckBreaks();
}
function apolloStopBreakChecker() {
  const s = states.apollo;
  if (s._breakCheckTimer) { clearInterval(s._breakCheckTimer); s._breakCheckTimer = null; }
}

// ── Titan pause / resume ─────────────────────────────────────
function titanEffectiveElapsedMs() {
  const t = states.titan;
  if (!t.running || !t.startTime) return 0;
  let e = Date.now() - t.startTime - t.totalPausedMs;
  if (t.paused && t.pauseStart) e -= (Date.now() - t.pauseStart);
  return Math.max(0, e);
}
function titanPauseCycle(label) {
  const t = states.titan;
  if (!t.running || t.paused) return;
  t.paused     = true;
  t.pauseLabel = label;
  t.pauseStart = Date.now();
  broadcastTitanState();
}
function titanResumeCycle() {
  const t = states.titan;
  if (!t.running || !t.paused) return;
  t.totalPausedMs += Date.now() - t.pauseStart;
  t.paused     = false;
  t.pauseLabel = null;
  t.pauseStart = null;
  broadcastTitanState();
}
function titanCheckBreaks() {
  const t = states.titan;
  if (!t.running) return;
  const brk = getScheduledBreak(TITAN_BREAKS);
  if (brk && !t.paused) titanPauseCycle(brk.label);
  else if (!brk && t.paused && t.pauseLabel !== 'Paused') titanResumeCycle();
}
function titanStartBreakChecker() {
  const t = states.titan;
  if (t._breakCheckTimer) clearInterval(t._breakCheckTimer);
  t._breakCheckTimer = setInterval(titanCheckBreaks, 15000);
  titanCheckBreaks();
}
function titanStopBreakChecker() {
  const t = states.titan;
  if (t._breakCheckTimer) { clearInterval(t._breakCheckTimer); t._breakCheckTimer = null; }
}
function titanMaybeResetDay() {
  const t = states.titan;
  const today = todayStr();
  if (t.cycleDate !== today) {
    t.cycleCount       = 0;
    t.cycleDate        = today;
    t.lastCycleSeconds = null;
  }
}

// ── Day boundary reset (runs every 60s) ──────────────────────
function maybeResetApolloDay() {
  const s = states.apollo;
  const today = todayStr();
  if (s.cycleDate === today) return;
  console.log('Apollo day rollover — resetting station state');
  s.cycleDate        = today;
  s.lineCycleCount   = 0;
  s.lastCycleSeconds = null;
  s.stations.forEach(st => {
    if (st._doneTimeoutId) { clearTimeout(st._doneTimeoutId); st._doneTimeoutId = null; }
    st.stationCycleCount = 0;
    st.lastCycleSeconds  = null;
    st.stationStatus     = 'idle';
    st.holdReason        = null;
    st.activeMs          = 0;
    st.holdMs            = 0;
    st.breakMs           = 0;
    st.totalAndonPause   = 0;
    st.stationStartTime  = null;
    st.holdSpanStart     = null;
    st.breakSpanStart    = null;
    st.preBreakStatus    = null;
    st.done              = false;
    st.completedAt       = null;
    st.andon             = null;
    st.andonTime         = null;
    st.andonPauseStart   = null;
    st.requests          = [];
  });
  broadcastApolloState();
}
function dayBoundaryCheck() {
  titanMaybeResetDay();
  maybeResetApolloDay();
}
setInterval(dayBoundaryCheck, 60 * 1000);

// ── WebSocket client sets ────────────────────────────────────
const apolloClients = new Set();
const pickerClients = new Set();
const titanClients  = new Set();

function getActiveRequestsWithPositions() {
  const priOrder = { high: 0, medium: 1, low: 2 };
  return allRequests
    .filter(r => !r.fulfilled)
    .sort((a, b) => {
      const p = (priOrder[a.priority] ?? 2) - (priOrder[b.priority] ?? 2);
      if (p !== 0) return p;
      return (a.submittedAt || 0) - (b.submittedAt || 0);
    })
    .map((r, i) => Object.assign({}, r, { queuePosition: i + 1 }));
}

function broadcastApollo(msg) {
  const data = JSON.stringify(msg);
  apolloClients.forEach(c => { if (c.readyState === 1) c.send(data); });
}
function broadcastApolloState() {
  broadcastApollo({
    type: 'state',
    state: serializeLine(states.apollo),
    taktSeconds: APOLLO_TAKT_SECONDS,
    holdReasons: HOLD_REASONS,
  });
}
function broadcastRequests() {
  const msg = JSON.stringify({ type: 'requests', requests: getActiveRequestsWithPositions() });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}
function broadcastTitanState() {
  const data = JSON.stringify({
    type: 'titan-state',
    state: serializeLine(states.titan),
    taktSeconds: TITAN_TAKT_SECONDS,
  });
  titanClients.forEach(c => { if (c.readyState === 1) c.send(data); });
}

// ── Fetch with retry ─────────────────────────────────────────
async function fetchWithRetry(url, options, retries = 2, delayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      const r    = await fetch(url, options);
      const text = await r.text();
      return JSON.parse(text);
    } catch(e) {
      console.warn(`Fetch attempt ${i + 1} failed: ${e.message}`);
      if (i < retries - 1) await new Promise(res => setTimeout(res, delayMs));
    }
  }
  return null;
}

// ── Locations cache ──────────────────────────────────────────
let locationsCache = [];
async function fetchLocations() {
  if (!LOCATIONS_URL) return;
  const d = await fetchWithRetry(LOCATIONS_URL, { redirect: 'follow' });
  if (d && d.success && d.locations) {
    locationsCache = d.locations;
    console.log('Locations loaded:', locationsCache.length);
  } else if (!d) {
    console.error('Locations fetch failed after retries');
  }
}
fetchLocations();
setInterval(fetchLocations, 5 * 60 * 1000);

// ── Inventory + orphan cache ─────────────────────────────────
let inventoryCache    = null;
let orphanPartsCache  = [];
let orphanAssignCache = {};
let bundlesCache      = [];   // [{name, children: [{partNum, qty}]}]
let epicorCache       = {};   // { partNumLower: qtyOnHand } from Epicor BAQ
let epicorLastRefresh = null; // ISO timestamp from Refresh_Log!B1

async function fetchInventory() {
  if (!LOCATIONS_URL) return;
  const d = await fetchWithRetry(LOCATIONS_URL, { redirect: 'follow' });
  if (d && d.success) {
    inventoryCache    = d;
    orphanPartsCache  = d.orphanParts      || [];
    orphanAssignCache = d.orphanAssignments || {};
    bundlesCache      = d.bundles           || [];
    epicorCache       = d.epicorOnHand      || {};
    epicorLastRefresh = d.epicorLastRefresh || null;
    console.log('Inventory cached:', Object.keys(d.inventory || {}).length, 'groups,',
      (d.bomList || []).length, 'BOM parts,', orphanPartsCache.length, 'orphans,',
      bundlesCache.length, 'bundles,', Object.keys(epicorCache).length, 'Epicor parts');
  } else if (!d) {
    console.error('Inventory fetch failed after retries');
  }
}
fetchInventory();
setInterval(fetchInventory, 10 * 60 * 1000);

// Epicor on-hand refreshes every minute (separate lightweight endpoint).
// Apps Script's doGet?epicorOnly=1 just reads BAQ_Data, skipping the heavier
// Locations/BOM/Bundles work. Keeps execution-time cost minimal.
async function fetchEpicorOnly() {
  if (!LOCATIONS_URL) return;
  // Apps Script web apps don't easily route by query param without server code,
  // so the contract is: this URL still hits doGet, but we look at the response
  // and only update the Epicor fields. Safe even if doGet always returns the
  // full payload — we just ignore everything else.
  // To use a dedicated lighter endpoint, add ?epicorOnly=1 here AND have
  // doGet(e) check e.parameter.epicorOnly and short-circuit.
  const url = LOCATIONS_URL + (LOCATIONS_URL.includes('?') ? '&' : '?') + 'epicorOnly=1';
  const d = await fetchWithRetry(url, { redirect: 'follow' });
  if (d && d.success) {
    if (d.epicorOnHand) {
      epicorCache = d.epicorOnHand;
      epicorLastRefresh = d.epicorLastRefresh || null;
      // Also patch into inventoryCache so /api/inventory reflects fresh data
      if (inventoryCache) {
        inventoryCache.epicorOnHand = d.epicorOnHand;
        inventoryCache.epicorLastRefresh = d.epicorLastRefresh;
      }
    }
  }
}
setInterval(fetchEpicorOnly, 60 * 1000);

// ── Bundle lookup ────────────────────────────────────────────
// Find a bundle by name (case-insensitive). Returns definition or null.
function lookupBundle(name) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  return bundlesCache.find(b => b.name.toLowerCase() === n) || null;
}

// For a given bundle, compute how many complete bundles can be picked from
// each location. Returns [{location, completeBundles, limitingChild}] sorted
// most-complete first. Locations that are missing any child return 0 with
// the name of the missing child recorded.
function computeBundleLocations(bundle) {
  if (!bundle || !bundle.children.length) return [];
  // Collect every location that has at least one child of this bundle, so we
  // can then ask "how many complete sets?" at each.
  const locSet = new Set();
  for (const child of bundle.children) {
    const childPn = child.partNum.toLowerCase();
    for (const l of locationsCache) {
      if (l.partNum.toLowerCase() === childPn) locSet.add(l.location);
    }
  }
  const results = [];
  for (const loc of locSet) {
    let maxBundles   = Infinity;
    let limitingChild = null;
    const childQtys  = [];
    for (const child of bundle.children) {
      const row = locationsCache.find(l =>
        l.location === loc &&
        l.partNum.toLowerCase() === child.partNum.toLowerCase()
      );
      const onHand = row ? (parseInt(row.quantity) || 0) : 0;
      const possible = Math.floor(onHand / child.qty);
      childQtys.push({ partNum: child.partNum, perBundle: child.qty, onHand });
      if (possible < maxBundles) {
        maxBundles    = possible;
        limitingChild = child.partNum;
      }
    }
    if (maxBundles === Infinity) maxBundles = 0;
    results.push({ location: loc, completeBundles: maxBundles, limitingChild, children: childQtys });
  }
  results.sort((a, b) => b.completeBundles - a.completeBundles);
  return results;
}

// Find any bundle request's totalQty (for display): total across all locations.
function totalCompleteBundles(bundle) {
  return computeBundleLocations(bundle).reduce((sum, loc) => sum + loc.completeBundles, 0);
}

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

// ── Format helpers for logs ──────────────────────────────────
function fmtHMS(totalSec) {
  const hh = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  return hh + ':' + mm + ':' + ss;
}

// ── Apollo Cycle Log writer ──────────────────────────────────
// One row per completed station cycle. Called from stationDone() BEFORE
// per-cycle accumulators are reset.
function logStationCycle(line, st) {
  if (!LOCATIONS_URL) return;
  if (line !== states.apollo) return;  // future lines (5b/5c) will extend this
  const now          = Date.now();
  const totalSpanMs  = st.activeMs + st.holdMs + st.breakMs + (st.totalAndonPause || 0);
  const cycleStartMs = now - totalSpanMs;
  const activeSec    = Math.round(st.activeMs / 1000);
  const holdSec      = Math.round(st.holdMs / 1000);
  const breakSec     = Math.round(st.breakMs / 1000);
  const andonSec     = Math.round((st.totalAndonPause || 0) / 1000);

  fetch(LOCATIONS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action:      'logStationCycle',
      lineName:    'Apollo',
      stationName: st.name,
      cycleNumber: st.stationCycleCount,
      cycleStart:  new Date(cycleStartMs).toLocaleString('en-US', { timeZone: 'America/Chicago' }),
      cycleEnd:    new Date(now).toLocaleString('en-US',          { timeZone: 'America/Chicago' }),
      activeTime:  fmtHMS(activeSec),
      holdTime:    fmtHMS(holdSec),
      breakTime:   fmtHMS(breakSec),
      andonTime:   fmtHMS(andonSec),
    }),
    redirect: 'follow',
  }).then(r => r.json())
    .then(d => console.log('Station cycle log:', d))
    .catch(e => console.error('Station cycle log failed:', e.message));
}

// ── Line Cycle Log writer ────────────────────────────────────
// PR 5b: called from the manual apollo-unit-complete handler as a stopgap.
// PR 5c will replace the caller with Skirting completion.
function logLineCycle(lineName, cycleNumber, cycleStartMs, cycleEndMs, activeMs, taktSec) {
  if (!LOCATIONS_URL) return;
  const activeSec   = Math.round(activeMs / 1000);
  const varianceSec = activeSec - taktSec;
  const varSign     = varianceSec > 0 ? '+' : (varianceSec < 0 ? '-' : '');
  const variance    = varSign + fmtHMS(Math.abs(varianceSec));
  const compliance  = Math.abs(varianceSec) < 60 ? 'On Takt' : (varianceSec > 0 ? 'Over' : 'Under');
  fetch(LOCATIONS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action:      'logLineCycle',
      lineName:    lineName,
      cycleNumber: cycleNumber,
      cycleStart:  new Date(cycleStartMs).toLocaleString('en-US', { timeZone: 'America/Chicago' }),
      cycleEnd:    new Date(cycleEndMs).toLocaleString('en-US',   { timeZone: 'America/Chicago' }),
      activeTime:  fmtHMS(activeSec),
      taktTarget:  fmtHMS(taktSec),
      variance:    variance,
      compliance:  compliance,
    }),
    redirect: 'follow',
  }).then(r => r.json())
    .then(d => console.log('Line cycle log:', d))
    .catch(e => console.error('Line cycle log failed:', e.message));
}

// ── Titan cycle logger ───────────────────────────────────────
function logTitanCycle(cycleStartMs, cycleEndMs, cycleCount, totalPausedMs) {
  if (!LOCATIONS_URL) return;
  const activeMs    = Math.max(0, cycleEndMs - cycleStartMs - (totalPausedMs || 0));
  const activeSec   = Math.round(activeMs / 1000);
  const pauseSec    = Math.round((totalPausedMs || 0) / 1000);
  const taktSec     = TITAN_TAKT_SECONDS;
  const varianceSec = activeSec - taktSec;
  const varSign     = varianceSec > 0 ? '+' : (varianceSec < 0 ? '-' : '');
  const variance    = varSign + fmtHMS(Math.abs(varianceSec));
  const compliance  = Math.abs(varianceSec) < 60 ? 'On Takt' : (varianceSec > 0 ? 'Over' : 'Under');

  fetch(LOCATIONS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action:       'logTitanCycle',
      cycleNumber:  cycleCount,
      cycleStart:   new Date(cycleStartMs).toLocaleString('en-US', { timeZone: 'America/Chicago' }),
      cycleEnd:     new Date(cycleEndMs).toLocaleString('en-US',   { timeZone: 'America/Chicago' }),
      activeTime:   fmtHMS(activeSec),
      pauseTime:    fmtHMS(pauseSec),
      taktTarget:   '02:00:00',
      variance:     variance,
      compliance:   compliance,
    }),
    redirect: 'follow',
  }).then(r => r.json())
    .then(d => console.log('Titan cycle log:', d))
    .catch(e => console.error('Titan cycle log failed:', e.message));
}

// ── Request completion logger ────────────────────────────────
function logRequestCompletion(req, outcome) {
  if (!LOCATIONS_URL) return;
  const completedAtMs = Date.now();
  const submittedAtMs = req.submittedAt || completedAtMs;
  const totalSec      = Math.max(0, Math.round((completedAtMs - submittedAtMs) / 1000));
  const totalTime     = fmtHMS(totalSec);

  const submittedAtStr = new Date(submittedAtMs).toLocaleString('en-US', { timeZone: 'America/Chicago' });
  const completedAtStr = new Date(completedAtMs).toLocaleString('en-US', { timeZone: 'America/Chicago' });

  fetch(LOCATIONS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action:       'logRequest',
      partNum:      req.partNum  || '',
      partName:     req.partName || '',
      qty:          req.qty      || 0,
      qtyFulfilled: req.qtyFulfilled || 0,
      unit:         req.unit     || 'Part',
      priority:     req.priority || 'low',
      line:         req.line     || '',
      station:      req.station  || '',
      outcome:      outcome,
      submittedAt:  submittedAtStr,
      completedAt:  completedAtStr,
      totalTime:    totalTime,
    }),
    redirect: 'follow',
  }).then(r => r.json())
    .then(d => console.log('Request log:', d))
    .catch(e => console.error('Request log failed:', e.message));
}

// ── Orphan assignment post ───────────────────────────────────
async function postOrphanAssignment(partNum, partName, line, station) {
  if (!LOCATIONS_URL) return { success: false, error: 'No LOCATIONS_URL' };
  try {
    const res = await fetch(LOCATIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'assignOrphan', partNum, partName, line, station }),
      redirect: 'follow',
    });
    const d = await res.json();
    console.log('Orphan assignment response:', d);
    return d;
  } catch(e) {
    console.error('Orphan assignment failed:', e.message);
    return { success: false, error: e.message };
  }
}

// ── REST endpoints ───────────────────────────────────────────
app.get('/api/state',    (req, res) => res.json({ state: serializeLine(states.apollo), taktSeconds: APOLLO_TAKT_SECONDS, holdReasons: HOLD_REASONS }));
app.get('/api/titan-state', (req, res) => res.json({ state: serializeLine(states.titan), taktSeconds: TITAN_TAKT_SECONDS }));
app.get('/api/requests', (req, res) => {
  res.json({ requests: getActiveRequestsWithPositions() });
});
app.get('/api/inventory', (req, res) => {
  if (inventoryCache) return res.json(inventoryCache);
  res.json({ success: false, error: 'Inventory not yet loaded — please wait a moment and refresh' });
});
app.get('/api/bom', (req, res) => {
  if (inventoryCache?.bomList) return res.json({ success: true, bomList: inventoryCache.bomList });
  res.json({ success: false, error: 'BOM not yet loaded' });
});
app.get('/api/locations',  (req, res) => res.json({ success: true, locations: locationsCache }));
app.get('/api/lines',      (req, res) => res.json({ lines: OTHER_LINES }));
app.get('/api/recent-picks', (req, res) => {
  res.json({ success: true, recentPicks: recentlyFulfilled });
});
app.get('/api/orphans',    (req, res) => res.json({ success: true, orphanParts: orphanPartsCache, orphanAssignments: orphanAssignCache, allLines: ALL_LINES }));
// Optional `line` query param filters bundles to those available on that line.
// A bundle with an empty assignedLines list is considered available on every line.
// `?line=Apollo` → returns bundles assigned to Apollo OR with no assignment.
// No param or unknown line → returns all bundles (backward compatible).
app.get('/api/bundles', (req, res) => {
  const line = String(req.query.line || '').trim().toLowerCase();
  if (!line) return res.json({ success: true, bundles: bundlesCache });
  const filtered = bundlesCache.filter(b => {
    const assigned = Array.isArray(b.assignedLines) ? b.assignedLines : [];
    if (!assigned.length) return true;  // unassigned → available everywhere
    return assigned.some(a => String(a).toLowerCase() === line);
  });
  res.json({ success: true, bundles: filtered });
});
app.get('/api/bundle-locations/:name', (req, res) => {
  const bundle = lookupBundle(req.params.name);
  if (!bundle) return res.json({ success: false, error: 'Bundle not found: ' + req.params.name });
  res.json({ success: true, bundle: bundle, locations: computeBundleLocations(bundle) });
});
app.get('/api/refresh-locations', async (req, res) => {
  await fetchLocations();
  await fetchInventory();
  res.json({ success: true, count: locationsCache.length });
});

// Epicor factory-wide on-hand. Lightweight — served from server cache.
// `/api/epicor-onhand` returns the full map plus last-refresh ISO timestamp.
// `/api/epicor-onhand/:partNum` returns just one part's qty (or null).
app.get('/api/epicor-onhand', (req, res) => {
  res.json({ success: true, onHand: epicorCache, lastRefresh: epicorLastRefresh });
});
app.get('/api/epicor-onhand/:partNum', (req, res) => {
  const pn = String(req.params.partNum || '').toLowerCase();
  const qty = epicorCache[pn];
  res.json({ success: true, partNum: req.params.partNum, qty: qty === undefined ? null : qty, lastRefresh: epicorLastRefresh });
});

// ── WebSocket ────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const url      = req.url || '';
  const isPicker = url.includes('picker=1');
  const isTitan  = url.includes('board=1') && /line=Titan/i.test(url);

  if (isPicker) {
    pickerClients.add(ws);
    ws.send(JSON.stringify({ type: 'requests', requests: getActiveRequestsWithPositions() }));
    ws.send(JSON.stringify({ type: 'recent-picks', recentPicks: recentlyFulfilled }));
  } else if (isTitan) {
    titanClients.add(ws);
    ws.send(JSON.stringify({ type: 'titan-state', state: serializeLine(states.titan), taktSeconds: TITAN_TAKT_SECONDS }));
    ws.send(JSON.stringify({ type: 'requests', requests: getActiveRequestsWithPositions() }));
  } else {
    apolloClients.add(ws);
    ws.send(JSON.stringify({ type: 'state', state: serializeLine(states.apollo), taktSeconds: APOLLO_TAKT_SECONDS, holdReasons: HOLD_REASONS }));
    ws.send(JSON.stringify({ type: 'requests', requests: getActiveRequestsWithPositions() }));
  }

  ws.on('close', () => { apolloClients.delete(ws); pickerClients.delete(ws); titanClients.delete(ws); });

  ws.on('message', async raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    // ── Ping ─────────────────────────────────────────────────
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    // ── Titan: Start line ────────────────────────────────────
    if (msg.type === 'titan-start') {
      const t = states.titan;
      if (t.running) return;
      titanMaybeResetDay();
      t.running       = true;
      t.paused        = false;
      t.pauseLabel    = null;
      t.pauseStart    = null;
      t.totalPausedMs = 0;
      t.startTime     = Date.now();
      broadcastTitanState();
      titanStartBreakChecker();
      return;
    }

    // ── Titan: End line ──────────────────────────────────────
    if (msg.type === 'titan-end') {
      const t = states.titan;
      if (!t.running) return;
      titanStopBreakChecker();
      t.running    = false;
      t.paused     = false;
      t.pauseLabel = null;
      t.pauseStart = null;
      t.startTime  = null;
      broadcastTitanState();
      return;
    }

    // ── Titan: Manual pause / resume ─────────────────────────
    if (msg.type === 'titan-pause') {
      const t = states.titan;
      if (!t.running || t.paused) return;
      titanPauseCycle('Paused');
      return;
    }
    if (msg.type === 'titan-resume') {
      const t = states.titan;
      if (!t.running || !t.paused) return;
      if (t.pauseLabel !== 'Paused') return;  // break pauses auto-resume only
      titanResumeCycle();
      return;
    }

    // ── Titan: Unit complete ─────────────────────────────────
    if (msg.type === 'titan-unit-complete') {
      const t = states.titan;
      if (!t.running || t.paused) return;
      titanMaybeResetDay();
      const now           = Date.now();
      const cycleStartMs  = t.startTime;
      const cycleEndMs    = now;
      const totalPausedMs = t.totalPausedMs;
      const activeMs      = Math.max(0, cycleEndMs - cycleStartMs - totalPausedMs);

      t.cycleCount       += 1;
      t.lastCycleSeconds  = Math.round(activeMs / 1000);
      t.startTime         = now;
      t.totalPausedMs     = 0;
      t.pauseStart        = null;
      broadcastTitanState();

      logTitanCycle(cycleStartMs, cycleEndMs, t.cycleCount, totalPausedMs);
      return;
    }

    // ── Apollo: Start line (open for the day) ────────────────
    if (msg.type === 'start') {
      const s = states.apollo;
      if (s.running) return;
      maybeResetApolloDay();  // belt-and-suspenders day reset
      s.running       = true;
      s.paused        = false;
      s.pauseLabel    = null;
      s.pauseStart    = null;
      s.totalPausedMs = 0;
      s.startTime     = Date.now();
      // Do NOT reset per-station state here — stations keep their today counts.
      // (Day rollover at midnight handles the reset.)
      broadcastApollo({
        type: 'start',
        startTime:   s.startTime,
        taktSeconds: APOLLO_TAKT_SECONDS,
        stations:    serializeLine(s).stations,
        cycleCount:  s.lineCycleCount,
        holdReasons: HOLD_REASONS,
      });
      broadcastApolloState();
      apolloStartBreakChecker();
    }

    // ── Apollo: End line (close for the day) ─────────────────
    if (msg.type === 'end') {
      const s = states.apollo;
      if (!s.running) return;
      apolloStopBreakChecker();
      // Close any open spans so accumulators are final. Do NOT log partial
      // cycles — a mid-cycle Done is not a cycle. Preserve station status so
      // end-of-day reporting can still read what each station was doing.
      s.stations.forEach(st => closeOpenSpan(st));
      s.running    = false;
      s.paused     = false;
      s.pauseLabel = null;
      s.pauseStart = null;
      broadcastApolloState();
    }

    // ── Apollo: Pause toggle (manual) ────────────────────────
    if (msg.type === 'pause') {
      const s = states.apollo;
      if (!s.running) return;
      if (s.paused && s.pauseLabel === 'Paused') apolloResumeCycle();
      else if (!s.paused) apolloPauseCycle('Paused');
    }

    // ── Apollo: Manual unit complete (PR 5b stopgap) ─────────
    // Increments the line cycle counter and resets the takt clock. This is
    // a temporary manual trigger until PR 5c wires Skirting station Done
    // as the automatic line-cycle trigger. Mirrors Titan's unit-complete
    // handler exactly. Does NOT touch station state — stations keep their
    // own independent cycles from 5a.
    if (msg.type === 'apollo-unit-complete') {
      const s = states.apollo;
      if (!s.running || s.paused) return;
      maybeResetApolloDay();
      const now           = Date.now();
      const cycleStartMs  = s.startTime;
      const cycleEndMs    = now;
      const totalPausedMs = s.totalPausedMs;
      const activeMs      = Math.max(0, cycleEndMs - cycleStartMs - totalPausedMs);

      s.lineCycleCount    += 1;
      s.lastCycleSeconds   = Math.round(activeMs / 1000);
      s.startTime          = now;
      s.totalPausedMs      = 0;
      s.pauseStart         = null;
      broadcastApolloState();

      logLineCycle('Apollo', s.lineCycleCount, cycleStartMs, cycleEndMs,
                   activeMs, APOLLO_TAKT_SECONDS);
      return;
    }

    // ── Station start ────────────────────────────────────────
    if (msg.type === 'station-start') {
      const s = states.apollo;
      const st = s.stations.find(x => x.id === msg.stationId);
      if (!st) return;
      if (!s.running || s.paused) return;
      if (stationStart(s, st)) broadcastApolloState();
    }

    // ── Station hold ─────────────────────────────────────────
    if (msg.type === 'station-hold') {
      const s = states.apollo;
      const st = s.stations.find(x => x.id === msg.stationId);
      if (!st) return;
      if (stationHold(s, st, msg.reason)) broadcastApolloState();
    }

    // ── Station done ─────────────────────────────────────────
    if (msg.type === 'done') {
      const s = states.apollo;
      const st = s.stations.find(x => x.id === msg.stationId);
      if (!st) return;
      if (!s.running) return;
      if (stationDone(s, st)) broadcastApolloState();
    }

    // ── Inventory request ────────────────────────────────────
    if (msg.type === 'request') {
      console.log('Request received:', msg.line, msg.partNum || msg.text, 'priority:', msg.priority);
      const s      = states.apollo;
      const stName = msg.station || (msg.stationId ? (s.stations.find(x => x.id === msg.stationId)?.name || null) : null);

      // Detect if this is a bundle request. msg.isBundle is set by the client,
      // but we also fall back to looking up partNum/partName against the bundle
      // cache to be defensive. Bundles don't live in Locations so the regular
      // lookupLocation would return '—' for them.
      const bundleHint = msg.isBundle || msg.bundleName || null;
      const bundle = bundleHint
        ? lookupBundle(bundleHint === true ? (msg.partName || msg.partNum) : bundleHint)
        : lookupBundle(msg.partName || msg.partNum);
      const isBundle = !!bundle;

      let loc;
      if (isBundle) {
        const bLocs = computeBundleLocations(bundle);
        const total = bLocs.reduce((sum, l) => sum + l.completeBundles, 0);
        loc = {
          location:     bLocs[0] ? bLocs[0].location : '—',
          quantity:     bLocs[0] ? String(bLocs[0].completeBundles) : '—',
          totalQty:     String(total),
          // For bundles, `allLocations` carries complete-bundle counts per location
          // rather than raw child qty. Picker reads these directly.
          allLocations: bLocs.map(l => ({
            location:        l.location,
            quantity:        String(l.completeBundles),
            completeBundles: l.completeBundles,
            limitingChild:   l.limitingChild,
            children:        l.children,
          })),
        };
      } else {
        loc = lookupLocation(msg.partNum || '');
      }

      const nowMs  = Date.now();
      const req = {
        id:              nextReqId++,
        line:            msg.line     || 'Apollo',
        station:         stName,
        partNum:         msg.partNum  || '',
        partName:        msg.partName || '',
        text:            msg.text     || '',
        qty:             (msg.qty !== undefined && msg.qty !== null) ? msg.qty : 1,
        unit:            String(msg.unit || 'Part'),
        qtyFulfilled:    0,
        pickedLocations: {},
        priority:        String(msg.priority || 'low'),
        escalation:      msg.qty === 0,
        totalQty:        loc.totalQty,
        allLocations:    loc.allLocations,
        location:        loc.location,
        stockQty:        loc.quantity,
        submittedAt:     nowMs,
        time:            new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        fulfilled:       false,
        // Bundle fields — only set if this is a bundle request.
        isBundle:        isBundle,
        bundleName:      isBundle ? bundle.name : null,
        bundleChildren:  isBundle ? bundle.children.map(c => ({ partNum: c.partNum, qty: c.qty })) : null,
      };
      if (msg.stationId) {
        const st = s.stations.find(x => x.id === msg.stationId);
        if (st) {
          st.requests = st.requests || [];
          st.requests.push({
            id: req.id,
            text: req.text || (req.partNum + ' — ' + req.partName),
            time: req.time,
            submittedAt: req.submittedAt,
            qty: req.qty,
            unit: req.unit,
            priority: req.priority,
            isBundle: isBundle,
            bundleName: req.bundleName,
          });
          broadcastApolloState();
        }
      }
      allRequests.push(req);
      broadcastRequests();
    }

    // ── Dismiss ──────────────────────────────────────────────
    if (msg.type === 'dismiss') {
      const s = states.apollo;
      const st = s.stations.find(x => x.id === msg.stationId);
      if (st) { st.requests = (st.requests || []).filter(r => r.id !== msg.reqId); broadcastApolloState(); }
      const req = allRequests.find(r => r.id === msg.reqId);
      if (req && !req.fulfilled) {
        req.fulfilled = true;
        logRequestCompletion(req, 'dismissed');
        broadcastRequests();
      }
    }

    // ── Andon ────────────────────────────────────────────────
    if (msg.type === 'andon') {
      const s = states.apollo;
      const st = s.stations.find(x => x.id === msg.stationId);
      if (st && (msg.level === 'line-lead' || msg.level === 'floor-manager')) {
        st.andon     = msg.level;
        st.andonTime = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        st.andonPauseStart = Date.now();
        // Andon suspends the active timer but keeps stationStatus='active'.
        // Matches pre-5a: operator is still assigned, just blocked. Andon time
        // is tracked separately from hold time and accumulated in totalAndonPause.
        if (st.stationStatus === 'active' && st.stationStartTime) {
          st.activeMs += Date.now() - st.stationStartTime;
          st.stationStartTime = null;
        }
        broadcastApolloState();
      }
    }

    // ── Andon clear ──────────────────────────────────────────
    if (msg.type === 'andon-clear') {
      const s = states.apollo;
      const st = s.stations.find(x => x.id === msg.stationId);
      if (st) {
        if (st.andonPauseStart) { st.totalAndonPause += Date.now() - st.andonPauseStart; st.andonPauseStart = null; }
        st.andon = null; st.andonTime = null;
        if (st.stationStatus === 'active' && !s.paused) st.stationStartTime = Date.now();
        broadcastApolloState();
      }
    }

    // ── Fulfill (partial fulfillment supported; bundle-aware) ──
    if (msg.type === 'fulfill') {
      const s   = states.apollo;
      const req = allRequests.find(r => r.id === msg.reqId);
      console.log('Fulfill received:', { reqId: msg.reqId, location: msg.location, partNum: req?.partNum, qty: msg.qty, isBundle: req?.isBundle });
      if (!req) return;

      const location = msg.location || '';
      let pickedQty;
      if (!location) {
        pickedQty = 0;
      } else {
        pickedQty = (msg.qty !== undefined && msg.qty !== null) ? Number(msg.qty) : (req.qty || 1);
      }

      // qty 0 + no location = cancel button, close immediately without subtracting
      if (pickedQty === 0 && !location) {
        req.fulfilled = true;
        logRequestCompletion(req, 'cancelled');
        s.stations.forEach(st => {
          if (st.requests) st.requests = st.requests.filter(r => r.id !== req.id);
        });
        broadcastApolloState();
        broadcastRequests();
        return;
      }

      if (!req.pickedLocations) req.pickedLocations = {};
      if (location) req.pickedLocations[location] = (req.pickedLocations[location] || 0) + pickedQty;

      if (!req.qtyFulfilled) req.qtyFulfilled = 0;
      req.qtyFulfilled += pickedQty;

      const qtyOriginal  = req.qty || 1;
      const qtyRemaining = Math.max(0, qtyOriginal - req.qtyFulfilled);
      console.log(`Fulfill: req ${req.id} | picked ${pickedQty} from ${location} | fulfilled ${req.qtyFulfilled}/${qtyOriginal} | remaining ${qtyRemaining}`);

      // ── Subtract from sheet ───────────────────────────────
      // Regular part: one subtract call for the part.
      // Bundle: one subtract call PER child, expanded by pickedQty * perBundle qty.
      if (LOCATIONS_URL && pickedQty > 0) {
        let totalTime = '';
        if (qtyRemaining <= 0 && req.submittedAt) {
          const totalSec = Math.max(0, Math.round((Date.now() - req.submittedAt) / 1000));
          totalTime = fmtHMS(totalSec);
        }
        const submittedAtStr = req.submittedAt ? new Date(req.submittedAt).toLocaleString('en-US', { timeZone: 'America/Chicago' }) : '';

        const subtractOne = async (childPartNum, childQty, bundleName) => {
          try {
            const r = await fetch(LOCATIONS_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action:      'subtract',
                partNum:     childPartNum,
                partName:    '',
                location:    location,
                qty:         childQty,
                line:        req.line     || '',
                priority:    req.priority || '',
                submittedAt: submittedAtStr,
                totalTime:   totalTime,
                bundleName:  bundleName || '',
              }),
              redirect: 'follow',
            });
            const d = await r.json();
            console.log('Qty subtracted' + (bundleName ? ' (bundle ' + bundleName + ')' : '') + ':', d);
            if (d.success && d.newQty !== undefined) {
              const cacheLoc = locationsCache.find(l =>
                l.partNum.toLowerCase()  === String(childPartNum).toLowerCase() &&
                l.location.toLowerCase() === location.toLowerCase()
              );
              if (cacheLoc) cacheLoc.quantity = String(d.newQty);
            }
          } catch(e) {
            console.error('Subtract failed for ' + childPartNum + ':', e.message);
          }
        };

        (async () => {
          if (req.isBundle && req.bundleChildren && req.bundleChildren.length) {
            // Expand: each bundle picked = children[i].qty units of children[i].partNum
            for (const child of req.bundleChildren) {
              const totalChildQty = pickedQty * child.qty;
              await subtractOne(child.partNum, totalChildQty, req.bundleName);
            }
          } else if (req.partNum) {
            await subtractOne(req.partNum, pickedQty, null);
          }
          // Keep request.allLocations in sync for display: for regular parts,
          // update the specific location's quantity; for bundles, recompute
          // complete-bundle counts from the now-updated locationsCache.
          if (req.isBundle) {
            const bDef = lookupBundle(req.bundleName);
            if (bDef) {
              const fresh = computeBundleLocations(bDef);
              req.allLocations = fresh.map(l => ({
                location:        l.location,
                quantity:        String(l.completeBundles),
                completeBundles: l.completeBundles,
                limitingChild:   l.limitingChild,
                children:        l.children,
              }));
            }
          } else {
            const reqLoc = req.allLocations && req.allLocations.find(l =>
              l.location.toLowerCase() === location.toLowerCase()
            );
            if (reqLoc) {
              const cacheLoc = locationsCache.find(l =>
                l.partNum.toLowerCase()  === (req.partNum || '').toLowerCase() &&
                l.location.toLowerCase() === location.toLowerCase()
              );
              if (cacheLoc) reqLoc.quantity = cacheLoc.quantity;
            }
          }
          pickerClients.forEach(c => {
            if (c.readyState === 1) c.send(JSON.stringify({ type: 'locations', locations: locationsCache }));
          });
          broadcastRequests();
        })();
      }

      if (qtyRemaining <= 0) {
        req.fulfilled = true;
        recentlyFulfilled.unshift({
          partNum:  req.isBundle ? '' : (req.partNum || ''),
          partName: req.isBundle ? req.bundleName : (req.partName || ''),
          qty:      req.qty      || 1,
          location: location,
          line:     req.line     || '',
          time:     new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
          isBundle: !!req.isBundle,
        });
        if (recentlyFulfilled.length > 2) recentlyFulfilled.pop();

        s.stations.forEach(st => {
          if (st.requests) st.requests = st.requests.filter(r => r.id !== req.id);
        });
        broadcastApolloState();

        pickerClients.forEach(c => {
          if (c.readyState === 1) c.send(JSON.stringify({ type: 'recent-picks', recentPicks: recentlyFulfilled }));
        });
      }

      broadcastRequests();
    }

    // ── Stow (bundle-aware) ──────────────────────────────────
    // Regular: stow N units of partNum at location.
    // Bundle:  if msg.bundleName is set, stow N bundles = for each child,
    //          stow (N × child.qty) units at location. Each child is a
    //          separate Apps Script call, reported as "Stow (Bundle Name)"
    //          in Transaction Log.
    if (msg.type === 'stow') {
      if (!LOCATIONS_URL) return;

      const stowOne = (partNum, partName, qty, bundleName) => fetch(LOCATIONS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action:     'stow',
          location:   msg.location || '',
          partNum:    partNum,
          partName:   partName || '',
          qty:        qty,
          line:       msg.line     || '',
          station:    msg.station  || '',
          bundleName: bundleName || '',
        }),
        redirect: 'follow',
      }).then(r => r.json());

      (async () => {
        try {
          if (msg.bundleName) {
            const bundle = lookupBundle(msg.bundleName);
            if (!bundle) {
              ws.send(JSON.stringify({ type: 'stow-result', success: false, message: 'Bundle not found: ' + msg.bundleName }));
              return;
            }
            const bundleQty = parseInt(msg.qty) || 1;
            if (bundleQty < 1) {
              ws.send(JSON.stringify({ type: 'stow-result', success: false, message: 'Bundle stow qty must be a positive integer' }));
              return;
            }
            const results = [];
            for (const child of bundle.children) {
              const total = bundleQty * child.qty;
              const d = await stowOne(child.partNum, '', total, bundle.name);
              console.log('Stow response (bundle child ' + child.partNum + '):', d);
              results.push(d);
              if (!d.success) break;  // stop on first failure
            }
            const allOk = results.every(d => d.success);
            if (allOk) { fetchLocations(); fetchInventory(); }
            ws.send(JSON.stringify({
              type:    'stow-result',
              success: allOk,
              message: allOk
                ? ('Stowed ' + bundleQty + ' × ' + bundle.name + ' at ' + (msg.location || ''))
                : ('Partial failure — ' + results.filter(d=>!d.success).length + ' of ' + bundle.children.length + ' child stows failed. Check sheet manually.'),
            }));
          } else {
            const d = await stowOne(msg.partNum || '', msg.partName || '', msg.qty || 1, null);
            console.log('Stow response:', d);
            if (d.success) { fetchLocations(); fetchInventory(); }
            ws.send(JSON.stringify({ type: 'stow-result', success: d.success, message: d.message || d.error }));
          }
        } catch(e) {
          ws.send(JSON.stringify({ type: 'stow-result', success: false, message: e.message }));
        }
      })();
    }

    // ── Transfer (bundle-aware) ──────────────────────────────
    // Regular: subtract from fromLocation, stow at toLocation (N units of partNum).
    // Bundle:  subtract each child × bundleQty from fromLocation, stow each child ×
    //          bundleQty at toLocation. Sequential: on first failure, reports a
    //          partial-transfer message and stops. Same Transaction Log tagging
    //          as bundle pick/stow.
    if (msg.type === 'transfer') {
      if (!LOCATIONS_URL) return;
      const { partNum, partName, fromLocation, toLocation, qty, bundleName } = msg;

      if (bundleName) {
        const bundle = lookupBundle(bundleName);
        if (!bundle) {
          ws.send(JSON.stringify({ type: 'transfer-result', success: false, message: 'Bundle not found: ' + bundleName }));
          return;
        }
        const bundleQty = parseInt(qty) || 1;
        if (bundleQty < 1) {
          ws.send(JSON.stringify({ type: 'transfer-result', success: false, message: 'Bundle transfer qty must be a positive integer' }));
          return;
        }
        console.log('Transfer bundle:', bundle.name, 'x' + bundleQty, fromLocation, '→', toLocation);

        let failedAt = null;
        for (const child of bundle.children) {
          const total = bundleQty * child.qty;
          const sr = await fetchWithRetry(LOCATIONS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'subtract', partNum: child.partNum, partName: '', location: fromLocation, qty: total, line: '', station: '', bundleName: bundle.name }),
            redirect: 'follow',
          });
          if (!sr || !sr.success) {
            failedAt = child.partNum + ' (subtract from ' + fromLocation + ')';
            break;
          }
          const st = await fetchWithRetry(LOCATIONS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'stow', partNum: child.partNum, partName: '', location: toLocation, qty: total, line: '', station: '', bundleName: bundle.name }),
            redirect: 'follow',
          });
          if (!st || !st.success) {
            failedAt = child.partNum + ' (stow at ' + toLocation + ')';
            break;
          }
        }

        await fetchLocations();
        pickerClients.forEach(c => {
          if (c.readyState === 1) c.send(JSON.stringify({ type: 'locations', locations: locationsCache }));
        });

        if (failedAt) {
          ws.send(JSON.stringify({ type: 'transfer-result', success: false, message: 'Bundle transfer partially failed at ' + failedAt + ' — check sheet manually' }));
        } else {
          ws.send(JSON.stringify({ type: 'transfer-result', success: true, message: 'Transferred ' + bundleQty + ' × ' + bundle.name + ' from ' + fromLocation + ' to ' + toLocation }));
        }
        return;
      }

      // ── Regular (non-bundle) transfer ─────────────────────
      console.log('Transfer:', partNum, fromLocation, '→', toLocation, 'qty:', qty);

      const subtractRes = await fetchWithRetry(LOCATIONS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'subtract', partNum, partName, location: fromLocation, qty, line: '', station: '' }),
        redirect: 'follow',
      });

      if (!subtractRes || !subtractRes.success) {
        ws.send(JSON.stringify({ type: 'transfer-result', success: false, message: subtractRes?.error || 'Failed to subtract from source location' }));
        return;
      }

      const stowRes = await fetchWithRetry(LOCATIONS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stow', partNum, partName, location: toLocation, qty, line: '', station: '' }),
        redirect: 'follow',
      });

      if (!stowRes || !stowRes.success) {
        ws.send(JSON.stringify({ type: 'transfer-result', success: false, message: 'Subtracted from source but failed to add to destination — check sheet manually' }));
        return;
      }

      const srcLoc = locationsCache.find(l => l.partNum.toLowerCase() === partNum.toLowerCase() && l.location.toLowerCase() === fromLocation.toLowerCase());
      if (srcLoc) srcLoc.quantity = String(subtractRes.newQty);

      await fetchLocations();

      pickerClients.forEach(c => {
        if (c.readyState === 1) c.send(JSON.stringify({ type: 'locations', locations: locationsCache }));
      });

      ws.send(JSON.stringify({ type: 'transfer-result', success: true, message: 'Transferred ' + qty + ' of ' + partNum + ' from ' + fromLocation + ' to ' + toLocation }));
      return;
    }

    if (msg.type === 'assign-orphan') {
      const { partNum, partName, line, station } = msg;
      console.log('assign-orphan received:', { partNum, line });
      if (!partNum || !line) {
        ws.send(JSON.stringify({ type: 'assign-orphan-result', success: false, error: 'partNum and line required' }));
        return;
      }
      const result = await postOrphanAssignment(partNum, partName || '', line, station || '');
      if (result.success) {
        orphanAssignCache[partNum.toLowerCase()] = { line, station: station || '' };
        const orphan = orphanPartsCache.find(o => o.partNum.toLowerCase() === partNum.toLowerCase());
        if (orphan) { orphan.assignedLine = line; orphan.assignedStation = station || ''; }
        await fetchInventory();
      }
      ws.send(JSON.stringify({ type: 'assign-orphan-result', success: result.success, partNum, line, station, message: result.message || result.error }));
    }

    // NOTE: The old "all stations done => endCycle()" Apollo line-cycle trigger
    // is removed. Apollo line cycles are no longer driven by station completion.
    // PR 5c will reintroduce line-cycle completion via the Skirting station
    // trigger and increment `states.apollo.lineCycleCount` at that point.
  });
});

server.listen(PORT, () => console.log(`LangmuirPMS running on port ${PORT}`));
