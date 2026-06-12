/* ════════════════════════════════════════════════════════════════
   PMS v2 core — WebSocket client, op pipeline, store, shared UI.
   Loaded on every screen before the role modules.

   Key v2 behaviors (see PMS_V2_DESIGN.md):
   • Reconnect WITHOUT reloading the page — screen state survives blips.
   • Every mutating send carries an opId; the server processes it once.
   • sendOp() keeps the initiating button locked until the server answers
     (45s hard timeout) — no more "give up at 8s and re-enable".
   ════════════════════════════════════════════════════════════════ */
'use strict';

var PMS = {
  ws: null,
  connected: false,
  listeners: {},          // msgType -> [fn]
  state: {                // shared caches, filled by REST + WS
    requests: [],
    locations: [],
    inventory: {},
    catalog: [],
    bundles: [],
    lineInventory: [],
    epicorOnHand: {},
    orphanAssignedLines: {},
    places: { bins: [], areas: [], lines: [] },
    holdReasons: [],
    allLines: ['Apollo', 'XF/PRO', 'TITAN', 'VULCAN', 'XR', 'MR1', 'Shipping'],
  },
  pendingOps: {},          // opId -> { resultTypes:[..], onResult, btn, label, slowT, failT }
  role: null,
};

function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function uid(prefix) { return (prefix || 'op') + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }

/* ── WebSocket with reconnect-no-reload ─────────────────────── */
PMS.connect = function(query) {
  var url = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + (query || '');
  var ws = new WebSocket(url);
  PMS.ws = ws;
  ws.onopen = function() {
    PMS.connected = true;
    var b = document.getElementById('conn-banner');
    if (b && b.classList.contains('show')) {
      b.textContent = '✓ Reconnected'; b.classList.add('reconnected');
      setTimeout(function(){ b.classList.remove('show', 'reconnected'); }, 1800);
    }
    PMS.emit('_open', {});
  };
  ws.onclose = ws.onerror = function() {
    if (!PMS.connected) return reconnectSoon();
    PMS.connected = false;
    var b = document.getElementById('conn-banner');
    if (b) { b.textContent = '⚠ Connection lost — reconnecting…'; b.classList.remove('reconnected'); b.classList.add('show'); }
    reconnectSoon();
  };
  var reconnectScheduled = false;
  function reconnectSoon() {
    if (reconnectScheduled) return;
    reconnectScheduled = true;
    setTimeout(function(){ PMS.connect(query); }, 2500);
  }
  ws.onmessage = function(ev) {
    var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
    // Route op results back to their pending op first
    if (msg.type && /-result$/.test(msg.type)) PMS._resolveOp(msg);
    PMS.emit(msg.type, msg);
  };
  setInterval(function(){ if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' })); }, 25000);
};
PMS.on = function(type, fn) { (PMS.listeners[type] = PMS.listeners[type] || []).push(fn); };
PMS.emit = function(type, msg) { (PMS.listeners[type] || []).forEach(function(fn){ try { fn(msg); } catch (e) { console.error(e); } }); };
PMS.send = function(obj) { if (PMS.ws && PMS.ws.readyState === 1) { PMS.ws.send(JSON.stringify(obj)); return true; } return false; };

/* ── The op pipeline (P1) ────────────────────────────────────
   sendOp(payload, opts):
     opts.btn        button to lock ('Working…') until resolved
     opts.btnLabel   restore label
     opts.resultType e.g. 'stow-result' — which message resolves this op
     opts.onResult   fn(msg) called once with the result
     opts.fireAndForget  resolve immediately (request/dismiss/fulfill broadcast state)
*/
PMS.sendOp = function(payload, opts) {
  opts = opts || {};
  if (!PMS.connected) { toast('err', 'Connection lost — wait for reconnect, then try again'); return null; }
  var opId = payload.opId || uid('op');
  payload.opId = opId;
  var entry = { onResult: opts.onResult, btn: opts.btn, btnLabel: opts.btnLabel, resultType: opts.resultType };
  if (opts.btn) { opts.btn.disabled = true; opts.btn.dataset.prevText = opts.btn.textContent; opts.btn.textContent = opts.working || 'Working… please wait'; }
  PMS.send(payload);
  if (opts.fireAndForget) { PMS._finishOp(opId, entry); return opId; }
  PMS.pendingOps[opId] = entry;
  entry.slowT = setTimeout(function() {
    if (PMS.pendingOps[opId]) toast('wait', 'Still working — the sheet is slow. Do NOT tap again.', 8000);
  }, 8000);
  entry.failT = setTimeout(function() {
    if (PMS.pendingOps[opId]) {
      delete PMS.pendingOps[opId];
      PMS._finishOp(opId, entry);
      toast('err', 'No confirmation after 45s — check Recent Activity or the sheet BEFORE retrying');
    }
  }, 45000);
  return opId;
};
PMS._resolveOp = function(msg) {
  // Results don't echo opId today; resolve the oldest pending op expecting this type.
  var ids = Object.keys(PMS.pendingOps);
  for (var i = 0; i < ids.length; i++) {
    var e = PMS.pendingOps[ids[i]];
    if (e.resultType === msg.type) {
      delete PMS.pendingOps[ids[i]];
      clearTimeout(e.slowT); clearTimeout(e.failT);
      PMS._finishOp(ids[i], e);
      if (e.onResult) e.onResult(msg);
      return;
    }
  }
};
PMS._finishOp = function(opId, e) {
  if (e.btn) { e.btn.disabled = false; e.btn.textContent = e.btnLabel || e.btn.dataset.prevText || e.btn.textContent; }
};

/* ── Toasts ── */
function toast(kind, message, ms) {
  var wrap = document.getElementById('toast-wrap');
  if (!wrap) { wrap = document.createElement('div'); wrap.id = 'toast-wrap'; document.body.appendChild(wrap); }
  var el = document.createElement('div');
  el.className = 'toast ' + (kind === true ? 'ok' : kind);
  el.textContent = (kind === 'ok' ? '✓ ' : kind === 'wait' ? '⏳ ' : '✗ ') + message;
  wrap.appendChild(el);
  setTimeout(function(){ el.remove(); }, ms || 4000);
}

/* ── Modal confirm ──
   confirmDialog({title, body, okLabel, warn}) -> Promise<bool> */
function confirmDialog(opts) {
  return new Promise(function(resolve) {
    var ov = document.getElementById('modal-root');
    ov.innerHTML =
      '<div class="modal">' +
        '<div class="m-title ' + (opts.warn ? 'warn' : '') + '">' + esc(opts.title || 'Confirm') + '</div>' +
        '<div class="m-body">' + opts.body + '</div>' +
        '<div class="m-actions">' +
          '<button class="btn" id="m-cancel">Cancel</button>' +
          '<button class="btn ' + (opts.warn ? 'warn' : 'primary') + '" id="m-ok">' + esc(opts.okLabel || 'Confirm') + '</button>' +
        '</div>' +
      '</div>';
    ov.classList.add('show');
    function close(v) { ov.classList.remove('show'); ov.innerHTML = ''; resolve(v); }
    document.getElementById('m-cancel').onclick = function(){ close(false); };
    document.getElementById('m-ok').onclick = function(){ close(true); };
    ov.onclick = function(e){ if (e.target === ov) close(false); };
  });
}
/* Pick-one modal: choiceDialog(title, [{label, value}]) -> Promise<value|null> */
function choiceDialog(title, choices) {
  return new Promise(function(resolve) {
    var ov = document.getElementById('modal-root');
    ov.innerHTML =
      '<div class="modal"><div class="m-title">' + esc(title) + '</div>' +
      '<div style="display:flex;flex-direction:column;gap:8px;">' +
      choices.map(function(c, i){ return '<button class="btn big" data-i="' + i + '">' + esc(c.label) + '</button>'; }).join('') +
      '<button class="btn ghost" id="m-cancel">Cancel</button></div></div>';
    ov.classList.add('show');
    function close(v) { ov.classList.remove('show'); ov.innerHTML = ''; resolve(v); }
    ov.querySelectorAll('[data-i]').forEach(function(b){ b.onclick = function(){ close(choices[parseInt(b.dataset.i)].value); }; });
    document.getElementById('m-cancel').onclick = function(){ close(null); };
    ov.onclick = function(e){ if (e.target === ov) close(null); };
  });
}

/* ── SLA helpers (P3) ── */
function slaChip(req) {
  // Compute live from submittedAt — slaLeftMs from the broadcast goes stale
  // between updates; the queue re-renders every second.
  var left = req.submittedAt
    ? (req.submittedAt + (req.targetMs || ((req.sla === 'urgent' || req.priority === 'high') ? 10 : 20) * 60000) - Date.now())
    : (req.slaLeftMs != null ? req.slaLeftMs : 0);
  var cls = left < 0 ? 'breach' : left < 5 * 60000 ? 'warn' : 'ok';
  var a = Math.abs(left), m = Math.floor(a / 60000), s = Math.floor((a % 60000) / 1000);
  var txt = (left < 0 ? '+' : '') + m + ':' + String(s).padStart(2, '0');
  return '<span class="sla-chip ' + cls + '">' + (left < 0 ? '⚠ ' : '') + txt + '</span>';
}
function reqAge(req) {
  var s = Math.max(0, Math.floor((Date.now() - (req.submittedAt || Date.now())) / 1000));
  var m = Math.floor(s / 60);
  return m < 60 ? (m + 'm ' + (s % 60) + 's') : (Math.floor(m / 60) + 'h ' + (m % 60) + 'm');
}
function cardAgingClass(req) {
  var left = (req.submittedAt || Date.now()) + (req.targetMs || 20 * 60000) - Date.now();
  return left < 0 ? 'aging-breach' : left < 5 * 60000 ? 'aging-warn' : '';
}

/* ── Data loading ── */
PMS.loadInventory = function(cb) {
  fetch('/api/inventory').then(function(r){ return r.json(); }).then(function(d) {
    if (!d || !d.success) { if (cb) cb(false); return; }
    var s = PMS.state;
    s.locations = d.locations || [];
    s.inventory = d.inventory || {};
    s.catalog = d.catalog || [];
    s.bundles = d.bundles || [];
    s.lineInventory = d.lineInventory || [];
    s.epicorOnHand = d.epicorOnHand || {};
    s.orphanAssignedLines = d.orphanAssignedLines || {};
    PMS.emit('_inventory', d);
    if (cb) cb(true);
  }).catch(function(){ if (cb) cb(false); });
};
PMS.loadPlaces = function() {
  fetch('/api/places').then(function(r){ return r.json(); }).then(function(d) {
    if (d && d.success) PMS.state.places = d;
  }).catch(function(){});
};
PMS.epicorQty = function(partNum) {
  var v = PMS.state.epicorOnHand[String(partNum || '').toLowerCase()];
  return v === undefined ? null : Number(v);
};
PMS.sheetTotal = function(partNum) {
  var pn = String(partNum || '').toLowerCase();
  return PMS.state.locations.filter(function(l){ return String(l.partNum).toLowerCase() === pn; })
    .reduce(function(s, l){ return s + (parseInt(l.quantity) || 0); }, 0);
};

/* ── Part search (shared): searches catalog + locations + bundles ──
   renderPartSearch(inputEl, listEl, opts{ bundles:bool, onPick(item) }) */
function attachPartSearch(inputEl, listEl, opts) {
  opts = opts || {};
  inputEl.addEventListener('input', function() {
    var q = inputEl.value.trim().toLowerCase();
    if (!q) { listEl.innerHTML = ''; listEl.classList.add('hidden'); return; }
    var seen = {}, out = [];
    function add(pn, pa, meta, isBundle, bundle) {
      var key = (isBundle ? 'b:' + pa : pn).toLowerCase();
      if (!key || seen[key]) return;
      seen[key] = true;
      out.push({ partNum: pn, partName: pa, meta: meta, isBundle: !!isBundle, bundle: bundle });
    }
    PMS.state.locations.forEach(function(l) {
      var pn = String(l.partNum || ''), pa = String(l.partName || '');
      if (pn.toLowerCase().includes(q) || pa.toLowerCase().includes(q)) add(pn, pa, null);
    });
    PMS.state.catalog.forEach(function(c) {
      var pn = String(c.partNum || ''), pa = String(c.partName || '');
      if (pn.toLowerCase().includes(q) || pa.toLowerCase().includes(q)) add(pn, pa, null);
    });
    if (opts.bundles !== false) PMS.state.bundles.forEach(function(b) {
      if (String(b.name).toLowerCase().includes(q)) add('', b.name, 'Bundle — ' + (b.children || []).length + ' parts', true, b);
    });
    out = out.slice(0, 30);
    if (!out.length) { listEl.innerHTML = '<div class="empty">No parts found</div>'; listEl.classList.remove('hidden'); return; }
    listEl.innerHTML = out.map(function(item, i) {
      var stock = item.isBundle ? '' : PMS.sheetTotal(item.partNum);
      var ep = item.isBundle ? null : PMS.epicorQty(item.partNum);
      var meta = item.isBundle ? item.meta :
        ('Warehouse: ' + stock + (ep !== null ? ' · Factory: ' + ep : ''));
      return '<div class="result-item" data-i="' + i + '">' +
        '<div class="pn ' + (item.isBundle ? 'bundle' : '') + '">' + esc(item.isBundle ? 'BUNDLE' : item.partNum) + '</div>' +
        '<div class="pa">' + esc(item.partName) + '</div>' +
        (meta ? '<div class="meta">' + esc(meta) + '</div>' : '') + '</div>';
    }).join('');
    listEl.classList.remove('hidden');
    listEl.querySelectorAll('.result-item').forEach(function(el) {
      el.onclick = function() {
        listEl.innerHTML = ''; listEl.classList.add('hidden'); inputEl.value = '';
        opts.onPick(out[parseInt(el.dataset.i)]);
      };
    });
  });
}

/* ── Place picker (P2): bins / areas / lines, no free text ──
   openPlacePicker({ kinds:['bin','area','line'], excludeLine }) -> Promise<{kind, place}|null> */
function openPlacePicker(opts) {
  opts = opts || {};
  var kinds = opts.kinds || ['bin', 'area', 'line'];
  return new Promise(function(resolve) {
    var ov = document.getElementById('modal-root');
    var tab = kinds[0];
    var binVal = '';
    function close(v) { ov.classList.remove('show'); ov.innerHTML = ''; resolve(v); }
    function render() {
      var tabsHtml = kinds.map(function(k) {
        var label = k === 'bin' ? 'Bin' : k === 'area' ? 'Named Area' : 'Line';
        return '<button class="place-tab ' + (tab === k ? 'sel' : '') + '" data-k="' + k + '">' + label + '</button>';
      }).join('');
      var body = '';
      if (tab === 'bin') {
        var canonical = binVal.toUpperCase();
        var valid = /^\d{2}-[A-Z]\d-[A-Z]$/.test(canonical);
        var known = valid && PMS.state.places.bins.indexOf(canonical) !== -1;
        body =
          '<div class="bin-preview ' + (valid ? 'valid' : '') + (known ? ' known' : '') + '">' + (canonical || 'NN-XN-X') + '</div>' +
          '<input class="input" id="pp-bin" placeholder="Type bin e.g. 02-B3-A" autocomplete="off" autocapitalize="characters" value="' + esc(binVal) + '" style="margin-bottom:10px">' +
          '<div class="place-grid" id="pp-bin-list">' +
            PMS.state.places.bins.filter(function(b){ return !binVal || b.includes(canonical); }).slice(0, 60)
              .map(function(b){ return '<button class="place-opt" data-p="' + esc(b) + '">' + esc(b) + '</button>'; }).join('') +
          '</div>' +
          '<button class="btn primary big" id="pp-bin-ok" style="margin-top:10px" ' + (valid ? '' : 'disabled') + '>' +
            (valid && !known ? 'Use NEW bin ' + canonical : 'Use ' + (canonical || 'bin')) + '</button>';
      } else if (tab === 'area') {
        body = '<div class="place-grid">' + PMS.state.places.areas.map(function(a){ return '<button class="place-opt" data-p="' + esc(a) + '">' + esc(a) + '</button>'; }).join('') + '</div>';
      } else {
        body = '<div class="place-grid">' + PMS.state.places.lines.filter(function(l){ return l !== opts.excludeLine; }).map(function(l){ return '<button class="place-opt" data-p="' + esc(l) + '">⚙ ' + esc(l) + '</button>'; }).join('') + '</div>';
      }
      ov.innerHTML = '<div class="modal"><div class="m-title">Choose destination</div>' +
        '<div class="place-tabs">' + tabsHtml + '</div>' + body +
        '<button class="btn ghost" id="pp-cancel" style="width:100%;margin-top:10px">Cancel</button></div>';
      ov.classList.add('show');
      ov.querySelectorAll('.place-tab').forEach(function(t){ t.onclick = function(){ tab = t.dataset.k; render(); }; });
      ov.querySelectorAll('.place-opt').forEach(function(p) {
        p.onclick = function() {
          if (tab === 'bin') { binVal = p.dataset.p; render(); var okB = document.getElementById('pp-bin-ok'); if (okB) okB.focus(); }
          else close({ kind: tab, place: p.dataset.p });
        };
      });
      var binInput = document.getElementById('pp-bin');
      if (binInput) {
        binInput.oninput = function() {
          binVal = binInput.value;
          var pos = binInput.selectionStart;
          render();
          var ni = document.getElementById('pp-bin');
          ni.focus(); ni.setSelectionRange(pos, pos);
        };
      }
      var okBtn = document.getElementById('pp-bin-ok');
      if (okBtn) okBtn.onclick = function() {
        var canonical = binVal.toUpperCase();
        var known = PMS.state.places.bins.indexOf(canonical) !== -1;
        if (!known) {
          confirmDialog({ title: 'New bin', warn: true, okLabel: 'Create ' + canonical,
            body: '<b>' + esc(canonical) + '</b> doesn\'t exist yet. Create it as a new bin?' })
            .then(function(yes){ if (yes) close({ kind: 'bin', place: canonical, isNew: true }); else render(); });
        } else close({ kind: 'bin', place: canonical });
      };
      document.getElementById('pp-cancel').onclick = function(){ close(null); };
      ov.onclick = function(e){ if (e.target === ov) close(null); };
    }
    render();
  });
}

/* ── App shell ── */
function setScreenTitle(t) { document.querySelector('.screen-title').textContent = t; }
function startClock() {
  var el = document.querySelector('.topbar .clock');
  setInterval(function(){ el.textContent = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }, 1000);
}
