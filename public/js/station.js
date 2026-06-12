/* ════════════════════════════════════════════════════════════════
   PMS v2 — Station screen (operator at an Apollo station) and the
   shared request composer used by both Station and Line screens.
   Three taps for the common case: part → qty → send.
   Urgent = "my line is blocked", one toggle (P3).
   ════════════════════════════════════════════════════════════════ */
'use strict';

/* Shared request composer. mount(el, { line, stationId, station }) */
function buildRequestComposer(el, ctx) {
  var sel = null, sla = 'standard';
  el.innerHTML =
    '<div class="card">' +
      '<input class="input" id="rc-search" placeholder="Search any part, description, or bundle…" autocomplete="off">' +
      '<div class="result-list hidden" id="rc-results" style="margin-top:8px"></div>' +
      '<div id="rc-form" class="hidden" style="margin-top:12px">' +
        '<div class="kv"><span class="k">Part</span><span id="rc-label" style="font-weight:900"></span></div>' +
        '<div id="rc-stock" style="margin:6px 0"></div>' +
        '<div class="sec-label">Quantity</div>' +
        '<div class="qty-row"><button class="qty-btn" id="rc-minus">−</button>' +
        '<input class="input qty-input" id="rc-qty" type="number" inputmode="numeric" value="1" min="1">' +
        '<button class="qty-btn" id="rc-plus">+</button></div>' +
        '<div class="sec-label">How urgent?</div>' +
        '<div class="row">' +
          '<button class="btn grow sel" id="rc-std">Standard · 20 min</button>' +
          '<button class="btn grow" id="rc-urg">🚨 Line blocked · 10 min</button>' +
        '</div>' +
        '<button class="btn primary big" id="rc-send" style="margin-top:14px">Send Request</button>' +
        '<button class="btn ghost big" style="margin-top:8px" id="rc-clear">Clear</button>' +
      '</div>' +
    '</div>';

  attachPartSearch(el.querySelector('#rc-search'), el.querySelector('#rc-results'), {
    onPick: function(item) {
      sel = item;
      el.querySelector('#rc-form').classList.remove('hidden');
      el.querySelector('#rc-label').textContent = item.isBundle ? item.partName + ' (BUNDLE)' : item.partNum + ' — ' + item.partName;
      var stockEl = el.querySelector('#rc-stock');
      if (item.isBundle) { stockEl.innerHTML = ''; }
      else {
        var wh = PMS.sheetTotal(item.partNum);
        var onLine = PMS.state.lineInventory.find(function(e) {
          return String(e.partNum).toLowerCase() === item.partNum.toLowerCase() && String(e.line).toLowerCase() === String(ctx.line).toLowerCase();
        });
        stockEl.innerHTML =
          '<span class="stock-pill ' + (wh > 0 ? 'ok' : 'none') + '">Warehouse: ' + wh + '</span> ' +
          (onLine ? '<span class="stock-pill ok" style="background:var(--purple-bg);color:var(--purple)">On ' + esc(ctx.line) + ': ' + Math.floor(parseFloat(onLine.onLineQty) || 0) + '</span>' : '');
      }
    },
  });
  el.querySelector('#rc-minus').onclick = function(){ var q = el.querySelector('#rc-qty'); q.value = Math.max(1, (parseInt(q.value) || 1) - 1); };
  el.querySelector('#rc-plus').onclick  = function(){ var q = el.querySelector('#rc-qty'); q.value = Math.max(1, (parseInt(q.value) || 1) + 1); };
  el.querySelector('#rc-std').onclick = function(){ sla = 'standard'; el.querySelector('#rc-std').classList.add('sel'); el.querySelector('#rc-urg').classList.remove('sel'); };
  el.querySelector('#rc-urg').onclick = function(){ sla = 'urgent'; el.querySelector('#rc-urg').classList.add('sel'); el.querySelector('#rc-std').classList.remove('sel'); };
  function clear() {
    sel = null; sla = 'standard';
    el.querySelector('#rc-form').classList.add('hidden');
    el.querySelector('#rc-qty').value = 1;
    el.querySelector('#rc-std').classList.add('sel'); el.querySelector('#rc-urg').classList.remove('sel');
  }
  el.querySelector('#rc-clear').onclick = clear;
  el.querySelector('#rc-send').onclick = function() {
    if (!sel) return;
    var qty = Math.max(1, parseInt(el.querySelector('#rc-qty').value) || 1);
    var payload = {
      type: 'request', line: ctx.line, qty: qty, unit: 'Part', sla: sla,
      priority: sla === 'urgent' ? 'high' : 'low',
    };
    if (ctx.stationId) { payload.stationId = ctx.stationId; payload.station = ctx.station; }
    if (sel.isBundle) { payload.isBundle = true; payload.bundleName = sel.partName; payload.partName = sel.partName; payload.text = sel.partName; }
    else { payload.partNum = sel.partNum; payload.partName = sel.partName; payload.text = sel.partNum + ' — ' + sel.partName; }
    PMS.sendOp(payload, { fireAndForget: true, btn: el.querySelector('#rc-send'), btnLabel: 'Send Request' });
    toast('ok', (sla === 'urgent' ? '🚨 Urgent request sent' : 'Request sent') + ' — ' + qty + ' × ' + (sel.partNum || sel.partName));
    clear();
  };
}

/* My-requests list shared by Station + Line screens */
function renderMyRequests(el, filterFn) {
  var reqs = PMS.state.requests.filter(filterFn);
  if (!reqs.length) { el.innerHTML = '<div class="empty">No open requests</div>'; return; }
  el.innerHTML = reqs.map(function(r) {
    var name = r.isBundle ? r.bundleName : (r.partNum ? r.partNum + ' — ' + r.partName : r.text);
    return '<div class="req-card ' + cardAgingClass(r) + '">' +
      '<div class="row"><div class="grow">' +
        '<div style="font-weight:800">' + esc(name) + '</div>' +
        '<div style="font-size:12px;color:var(--text-mute)">#' + r.queuePosition + ' in queue · ' + (r.qty || 1) + ' ' + esc(r.unit || 'Part') + (r.qtyFulfilled ? ' · ' + r.qtyFulfilled + ' picked' : '') + ' · waiting ' + reqAge(r) + '</div>' +
      '</div>' + slaChip(r) +
      '<button class="btn" style="min-height:38px;font-size:11px" onclick="myReqCancel(' + r.id + ')">✕</button></div></div>';
  }).join('');
}
window.myReqCancel = function(id) {
  choiceDialog('Cancel this request — why?', [
    { label: 'Found it on the line',  value: 'already have' },
    { label: 'Requested wrong part',  value: 'wrong part' },
    { label: 'No longer needed',      value: 'not needed' },
  ]).then(function(reason) {
    if (reason === null) return;
    PMS.sendOp({ type: 'dismiss', reqId: id, reason: reason }, { fireAndForget: true });
    toast('ok', 'Request cancelled');
  });
};

/* ── Station screen ── */
function initStation(root) {
  var stations = [];
  fetch('/api/state').then(function(r){ return r.json(); }).then(function(d) {
    stations = ((d.state || {}).stations) || [];
    pick();
  });
  function pick() {
    setScreenTitle('Station');
    root.innerHTML = '<div class="page"><div class="sec-label">Choose your station</div><div class="role-grid" id="st-pick"></div></div>';
    document.getElementById('st-pick').innerHTML = stations.map(function(s) {
      return '<div class="role-card" data-id="' + s.id + '"><div class="icon">' + (s.type === 'sub' ? '🔧' : '🏭') + '</div><div class="name">' + esc(s.name) + '</div></div>';
    }).join('');
    root.querySelectorAll('.role-card').forEach(function(c) {
      c.onclick = function() { show(stations.find(function(s){ return s.id === parseInt(c.dataset.id); })); };
    });
  }
  function show(st) {
    setScreenTitle('Apollo · ' + st.name);
    var stState = st;
    root.innerHTML =
      '<div class="page">' +
        '<div class="card" style="text-align:center">' +
          '<div id="st-timer" style="font-size:54px;font-weight:900;font-variant-numeric:tabular-nums">0:00:00</div>' +
          '<div id="st-status" style="font-size:12px;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.1em;margin-top:2px">idle</div>' +
        '</div>' +
        '<div class="sec-label">Request parts</div><div id="st-composer"></div>' +
        '<div class="sec-label">My open requests</div><div id="st-reqs"></div>' +
        '<button class="btn ghost big" style="margin-top:14px" id="st-back">← Change station</button>' +
      '</div>';
    buildRequestComposer(document.getElementById('st-composer'), { line: 'Apollo', stationId: st.id, station: st.name });
    document.getElementById('st-back').onclick = pick;
    function isMine(r) { return !r.fulfilled && r.line === 'Apollo' && r.station === st.name; }
    function tick() {
      var el = document.getElementById('st-timer');
      if (!el) return;
      var ms = stState.activeMs || 0;
      if (stState.stationStatus === 'active' && stState.stationStartTime) ms += Date.now() - stState.stationStartTime;
      var s = Math.floor(ms / 1000);
      el.textContent = Math.floor(s / 3600) + ':' + String(Math.floor(s / 60) % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
      document.getElementById('st-status').textContent = stState.stationStatus + (stState.holdReason ? ' — ' + stState.holdReason : '');
      renderMyRequests(document.getElementById('st-reqs'), isMine);
    }
    PMS.on('state', function(msg) {
      var ns = ((msg.state || {}).stations || []).find(function(x){ return x.id === st.id; });
      if (ns) stState = ns;
    });
    PMS.on('requests', function(){ var el = document.getElementById('st-reqs'); if (el) renderMyRequests(el, isMine); });
    setInterval(tick, 1000); tick();
  }
}

/* ── Line request screen ── */
function initLine(root) {
  var line = localStorage.getItem('pms-line') || 'Apollo';
  render();
  function render() {
    setScreenTitle('Line · ' + line);
    root.innerHTML =
      '<div class="page">' +
        '<div class="row" style="margin-bottom:10px"><select class="select" id="ln-sel">' +
          PMS.state.allLines.map(function(l){ return '<option' + (l === line ? ' selected' : '') + '>' + esc(l) + '</option>'; }).join('') +
        '</select></div>' +
        '<div class="sec-label">Request parts for ' + esc(line) + '</div><div id="ln-composer"></div>' +
        '<div class="sec-label">Open requests — ' + esc(line) + '</div><div id="ln-reqs"></div>' +
        '<div class="sec-label">Tracked stock on ' + esc(line) + '</div><div id="ln-stock"></div>' +
      '</div>';
    document.getElementById('ln-sel').onchange = function() {
      line = this.value; localStorage.setItem('pms-line', line); render();
    };
    buildRequestComposer(document.getElementById('ln-composer'), { line: line });
    refresh();
  }
  function isMine(r) { return !r.fulfilled && r.line === line; }
  function refresh() {
    var reqsEl = document.getElementById('ln-reqs');
    if (reqsEl) renderMyRequests(reqsEl, isMine);
    var stockEl = document.getElementById('ln-stock');
    if (!stockEl) return;
    var rows = PMS.state.lineInventory.filter(function(e) {
      return String(e.line).toLowerCase() === line.toLowerCase() && (parseFloat(e.onLineQty) || 0) > 0;
    }).sort(function(a, b){ return String(a.partNum).localeCompare(String(b.partNum), undefined, { numeric: true }); });
    stockEl.innerHTML = rows.length
      ? '<div class="card">' + rows.map(function(e) {
          var st = e.status === 'OUT' ? 'none' : 'ok';
          return '<div class="kv"><span><span class="mono" style="font-weight:800">' + esc(e.partNum) + '</span> <span style="color:var(--text-mute)">' + esc(e.partName || '') + '</span></span>' +
            '<span class="stock-pill ' + st + '">' + Math.floor(parseFloat(e.onLineQty) || 0) + '</span></div>';
        }).join('') + '</div>'
      : '<div class="empty">No tracked stock on this line yet — picks land here automatically</div>';
  }
  PMS.on('requests', refresh);
  PMS.on('_inventory', refresh);
  setInterval(refresh, 5000);
}
