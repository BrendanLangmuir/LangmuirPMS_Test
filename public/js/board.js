/* ════════════════════════════════════════════════════════════════
   PMS v2 — Production boards.
   Apollo: takt ring + line controls + station cards + alert rail.
   Titan:  takt ring + single-unit cycle controls + alert rail.
   Uses the v1 server messages unchanged (start/end/pause, station-*,
   andon, titan-*) — the proven state machines stay; the chrome is new.
   One-tap cycle logging: "✓ Unit Complete" is the biggest button on
   the board (J3: make logging cheaper than not logging).
   ════════════════════════════════════════════════════════════════ */
'use strict';

function fmtClock(totalSec) {
  totalSec = Math.max(0, Math.floor(totalSec));
  var h = Math.floor(totalSec / 3600), m = Math.floor(totalSec / 60) % 60, s = totalSec % 60;
  return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function taktRing(elapsedSec, taktSec, label) {
  var pct = Math.min(1, elapsedSec / taktSec);
  var R = 74, C = 2 * Math.PI * R;
  var color = pct < 0.75 ? 'var(--ok)' : pct < 1 ? 'var(--warn)' : 'var(--red)';
  return '<div class="takt-ring">' +
    '<svg width="168" height="168" viewBox="0 0 168 168">' +
      '<circle cx="84" cy="84" r="' + R + '" fill="none" stroke="var(--panel-3)" stroke-width="11"/>' +
      '<circle cx="84" cy="84" r="' + R + '" fill="none" stroke="' + color + '" stroke-width="11" stroke-linecap="round" ' +
        'stroke-dasharray="' + C + '" stroke-dashoffset="' + (C * (1 - pct)) + '"/>' +
    '</svg>' +
    '<div class="time"><div class="t" style="color:' + color + '">' + fmtClock(elapsedSec) + '</div><div class="l">' + esc(label) + '</div></div>' +
  '</div>';
}

function initBoard(root, which) {
  var isTitan = which === 'titan';
  setScreenTitle(isTitan ? 'TITAN Board' : 'Apollo Board');
  var state = null, taktSeconds = isTitan ? 7200 : 10800, holdReasons = [];

  fetch(isTitan ? '/api/titan-state' : '/api/state').then(function(r){ return r.json(); }).then(function(d) {
    state = d.state; taktSeconds = d.taktSeconds || taktSeconds; holdReasons = d.holdReasons || [];
    render();
  });
  PMS.on(isTitan ? 'titan-state' : 'state', function(msg) {
    state = msg.state; if (msg.taktSeconds) taktSeconds = msg.taktSeconds;
    if (msg.holdReasons) holdReasons = msg.holdReasons;
    render();
  });
  PMS.on('requests', function(){ renderAlerts(); });
  setInterval(tick, 1000);

  function elapsedSec() {
    if (!state || !state.running || !state.startTime) return 0;
    var ms = Date.now() - state.startTime - (state.totalPausedMs || 0);
    if (state.paused && state.pauseStart) ms -= Date.now() - state.pauseStart;
    return ms / 1000;
  }

  function render() {
    if (!state) return;
    root.innerHTML =
      '<div class="page wide">' +
        '<div class="card"><div class="takt-wrap">' +
          '<div id="bd-ring">' + taktRing(elapsedSec(), taktSeconds, isTitan ? 'this unit' : 'line open') + '</div>' +
          '<div class="board-stats">' +
            '<div class="bstat"><div class="v" id="bd-cycles">' + (isTitan ? (state.cycleCount || 0) : (state.lineCycleCount || state.cycleCount || 0)) + '</div><div class="k">Units today</div></div>' +
            '<div class="bstat"><div class="v" id="bd-last">' + (state.lastCycleSeconds ? fmtClock(state.lastCycleSeconds) : '—') + '</div><div class="k">Last cycle</div></div>' +
            '<div class="bstat"><div class="v" style="font-size:22px;padding-top:8px">' + (state.paused ? '⏸ ' + esc(state.pauseLabel || 'Paused') : state.running ? '▶ Running' : '⏹ Closed') + '</div><div class="k">Line status</div></div>' +
          '</div>' +
          '<div class="grow"></div>' +
          '<div style="display:flex;flex-direction:column;gap:8px;min-width:230px">' +
            (state.running
              ? '<button class="btn ok big" id="bd-unit">✓ Unit Complete</button>' +
                (state.paused
                  ? '<button class="btn warn" id="bd-resume">▶ Resume</button>'
                  : '<button class="btn" id="bd-pause">⏸ Pause</button>') +
                '<button class="btn ghost" id="bd-end">⏹ Close line</button>'
              : '<button class="btn primary big" id="bd-start">▶ Open line</button>') +
          '</div>' +
        '</div></div>' +
        '<div style="display:grid;grid-template-columns:1fr 320px;gap:14px" id="bd-cols">' +
          '<div id="bd-stations"></div>' +
          '<div class="alert-rail"><div class="sec-label" style="margin-top:0">Open requests</div><div id="bd-alerts"></div></div>' +
        '</div>' +
      '</div>';
    if (window.innerWidth < 800) document.getElementById('bd-cols').style.gridTemplateColumns = '1fr';

    var q = function(id){ return document.getElementById(id); };
    if (q('bd-start'))  q('bd-start').onclick  = function(){ PMS.send({ type: isTitan ? 'titan-start' : 'start' }); };
    if (q('bd-end'))    q('bd-end').onclick    = function() {
      confirmDialog({ title: 'Close line', warn: true, okLabel: 'Close line', body: 'Close the line for the day? Open cycles end without logging.' })
        .then(function(y){ if (y) PMS.send({ type: isTitan ? 'titan-end' : 'end' }); });
    };
    // Apollo 'pause' is a server-side toggle with a fixed label; Titan has
    // explicit pause/resume. Scheduled breaks pause/resume automatically.
    if (q('bd-pause'))  q('bd-pause').onclick  = function(){ PMS.send(isTitan ? { type: 'titan-pause' } : { type: 'pause' }); };
    if (q('bd-resume')) q('bd-resume').onclick = function(){ PMS.send(isTitan ? { type: 'titan-resume' } : { type: 'pause' }); };
    if (q('bd-unit'))   q('bd-unit').onclick   = function() {
      confirmDialog({ title: 'Unit complete', okLabel: '✓ Log unit', body: 'Log a completed unit? This records the cycle time and starts the next cycle.' })
        .then(function(y){ if (y) PMS.send({ type: isTitan ? 'titan-unit-complete' : 'apollo-unit-complete' }); });
    };

    renderStations();
    renderAlerts();
  }

  function renderStations() {
    var el = document.getElementById('bd-stations');
    if (!el) return;
    if (isTitan || !state.stations) { el.innerHTML = ''; return; }
    el.innerHTML = '<div class="station-grid">' + state.stations.map(function(st) {
      var cls = st.andon ? 'andon' : st.stationStatus === 'active' ? 'active' : st.stationStatus === 'hold' ? 'hold' : '';
      var ms = st.activeMs || 0;
      if (st.stationStatus === 'active' && st.stationStartTime) ms += Date.now() - st.stationStartTime;
      return '<div class="station-card ' + cls + '" data-st="' + st.id + '">' +
        '<div class="row"><div class="st-name grow">' + esc(st.name) + '</div>' +
          (st.andon ? '<span class="badge urgent">ANDON</span>' : '') +
          (st.done ? '<span class="badge" style="background:var(--ok-bg);color:var(--ok)">DONE ✓</span>' : '') + '</div>' +
        '<div class="st-time" data-time="' + st.id + '">' + fmtClock(ms / 1000) + '</div>' +
        '<div class="st-meta">' + esc(st.stationStatus) + (st.holdReason ? ' — ' + esc(st.holdReason) : '') +
          ' · cycles today: ' + (st.stationCycleCount || 0) +
          (st.lastCycleSeconds ? ' · last ' + fmtClock(st.lastCycleSeconds) : '') + '</div>' +
        ((st.requests || []).length ? '<div class="st-meta" style="color:var(--warn);margin-top:4px">📦 ' + st.requests.length + ' open request' + (st.requests.length === 1 ? '' : 's') + '</div>' : '') +
        '<div class="st-actions">' +
          (st.stationStatus === 'active'
            ? '<button class="btn ok" data-act="done">✓ Done</button><button class="btn warn" data-act="hold">Hold</button>'
            : '<button class="btn primary" data-act="start">▶ Start</button>') +
          (st.andon
            ? '<button class="btn" data-act="andon-clear">Clear andon</button>'
            : '<button class="btn" data-act="andon">🚨</button>') +
        '</div></div>';
    }).join('') + '</div>';
    el.querySelectorAll('[data-act]').forEach(function(b) {
      b.onclick = function() {
        var stId = parseInt(b.closest('.station-card').dataset.st);
        var act = b.dataset.act;
        if (act === 'start') PMS.send({ type: 'station-start', stationId: stId });
        if (act === 'done')  PMS.send({ type: 'done', stationId: stId });
        if (act === 'hold') {
          choiceDialog('Hold reason', holdReasons.map(function(r){ return { label: r, value: r }; }))
            .then(function(v){ if (v !== null) PMS.send({ type: 'station-hold', stationId: stId, reason: v }); });
        }
        if (act === 'andon') {
          choiceDialog('Call andon', [
            { label: '🟡 Line lead',     value: 'line-lead' },
            { label: '🔴 Floor manager', value: 'floor-manager' },
          ]).then(function(v){ if (v !== null) PMS.send({ type: 'andon', stationId: stId, level: v }); });
        }
        if (act === 'andon-clear') PMS.send({ type: 'andon-clear', stationId: stId });
      };
    });
  }

  function renderAlerts() {
    var el = document.getElementById('bd-alerts');
    if (!el) return;
    var lineName = isTitan ? 'TITAN' : 'Apollo';
    var reqs = PMS.state.requests.filter(function(r){ return r.line === lineName; });
    el.innerHTML = reqs.length ? reqs.map(function(r) {
      var name = r.isBundle ? r.bundleName : (r.partNum || r.text);
      return '<div class="req-card ' + cardAgingClass(r) + '"><div class="row">' +
        '<div class="grow"><div style="font-weight:800;font-size:13px">' + esc(name) + '</div>' +
        '<div style="font-size:11px;color:var(--text-mute)">' + (r.station ? esc(r.station) + ' · ' : '') + (r.qty || 1) + ' needed · #' + r.queuePosition + ' in queue</div></div>' +
        slaChip(r) + '</div></div>';
    }).join('') : '<div class="empty">No open requests ✓</div>';
  }

  function tick() {
    if (!state || !state.running) return;
    var ring = document.getElementById('bd-ring');
    if (ring) ring.innerHTML = taktRing(elapsedSec(), taktSeconds, isTitan ? 'this unit' : 'line open');
    // station timers tick in place without a full re-render
    (state.stations || []).forEach(function(st) {
      var el = document.querySelector('[data-time="' + st.id + '"]');
      if (!el) return;
      var ms = st.activeMs || 0;
      if (st.stationStatus === 'active' && st.stationStartTime) ms += Date.now() - st.stationStartTime;
      el.textContent = fmtClock(ms / 1000);
    });
    renderAlerts();
  }
}
