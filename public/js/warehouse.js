/* ════════════════════════════════════════════════════════════════
   PMS v2 — Warehouse screen.
   Tabs: Queue (SLA-sorted picks) · Stow · Transfer · Activity.
   Every write goes through PMS.sendOp (locked button until confirmed)
   and the place picker (no free-text locations). Write-health panel
   surfaces any failed background writes.
   ════════════════════════════════════════════════════════════════ */
'use strict';

function initWarehouse(root) {
  setScreenTitle('Warehouse');
  root.innerHTML =
    '<div class="page">' +
      '<div class="place-tabs" style="margin-bottom:14px">' +
        '<button class="place-tab sel" data-t="queue">Queue <span id="wq-count"></span></button>' +
        '<button class="place-tab" data-t="stow">Stow</button>' +
        '<button class="place-tab" data-t="transfer">Transfer</button>' +
        '<button class="place-tab" data-t="activity">Activity</button>' +
      '</div>' +
      '<div id="wh-health"></div>' +
      '<div id="wt-queue"></div>' +
      '<div id="wt-stow" class="hidden"></div>' +
      '<div id="wt-transfer" class="hidden"></div>' +
      '<div id="wt-activity" class="hidden"></div>' +
    '</div>';

  var tabs = root.querySelectorAll('.place-tab[data-t]');
  tabs.forEach(function(t) {
    t.onclick = function() {
      tabs.forEach(function(x){ x.classList.remove('sel'); });
      t.classList.add('sel');
      ['queue', 'stow', 'transfer', 'activity'].forEach(function(k) {
        document.getElementById('wt-' + k).classList.toggle('hidden', k !== t.dataset.t);
      });
      if (t.dataset.t === 'activity') renderActivity();
    };
  });

  buildStowTab();
  buildTransferTab();
  renderQueue();
  setInterval(renderQueue, 1000);        // SLA chips tick every second
  setInterval(pollWriteHealth, 30000);
  pollWriteHealth();
  PMS.on('requests', function(){ renderQueue(true); });
  PMS.on('_inventory', function(){ /* caches refreshed; queue rerenders on tick */ });

  /* ── Queue (P3): one column, sorted by time-to-breach ───────── */
  var pickOpen = {};   // reqId -> bool (expanded pick panel)
  function renderQueue(force) {
    var el = document.getElementById('wt-queue');
    if (!el || (el.classList.contains('hidden') && !force)) return;
    var reqs = PMS.state.requests;
    document.getElementById('wq-count').textContent = reqs.length ? '(' + reqs.length + ')' : '';
    if (!reqs.length) { el.innerHTML = '<div class="empty">Queue is clear ✓</div>'; return; }
    el.innerHTML = reqs.map(function(r) {
      var badges =
        (r.sla === 'urgent' || r.priority === 'high' ? '<span class="badge urgent">URGENT</span> ' : '') +
        (r.source === 'auto-reorder' ? '<span class="badge auto">AUTO</span> ' : '') +
        (r.isBundle ? '<span class="badge bundle">BUNDLE</span> ' : '') +
        '<span class="badge line">' + esc(r.line || '') + (r.station ? ' · ' + esc(r.station) : '') + '</span>';
      var name = r.isBundle ? (r.bundleName || r.partName) : (r.partNum ? r.partNum + ' — ' + r.partName : r.text);
      var qtyLeft = (r.qty || 1) - (r.qtyFulfilled || 0);
      var drift = '';
      if (!r.isBundle && r.partNum) {
        var ep = PMS.epicorQty(r.partNum), sh = PMS.sheetTotal(r.partNum);
        if (ep !== null && sh > 0 && ep >= 0 && Math.abs(sh - ep) > Math.max(5, ep * 0.25)) {
          drift = '<div class="drift-note">⚠ Sheet shows ' + sh + ', Epicor ' + ep + ' — worth a recount</div>';
        }
      }
      return '<div class="req-card ' + cardAgingClass(r) + '" id="req-' + r.id + '">' +
        '<div class="row">' +
          '<div class="grow">' +
            '<div style="font-weight:900;font-size:15px">' + esc(name) + '</div>' +
            '<div style="font-size:12px;color:var(--text-mute);margin-top:2px">' + badges + ' · ' + qtyLeft + ' ' + esc(r.unit || 'Part') + (qtyLeft === 1 ? '' : 's') + ' needed · waiting ' + reqAge(r) + '</div>' +
            drift +
          '</div>' + slaChip(r) +
        '</div>' +
        '<div class="row" style="margin-top:10px;gap:8px">' +
          '<button class="btn primary grow" onclick="whTogglePick(' + r.id + ')">' + (pickOpen[r.id] ? 'Close' : '📦 Pick') + '</button>' +
          '<button class="btn" onclick="whCancelReq(' + r.id + ')">✕</button>' +
        '</div>' +
        (pickOpen[r.id] ? pickPanel(r) : '') +
      '</div>';
    }).join('');
  }
  window.whTogglePick = function(id) { pickOpen[id] = !pickOpen[id]; renderQueue(true); };

  function pickPanel(r) {
    var locs = (r.allLocations || []).slice();
    if (!locs.length) return '<div class="empty">No tracked locations — pick from floor knowledge, then fulfill with qty</div>' + fulfillRow(r, '');
    var qtyLeft = (r.qty || 1) - (r.qtyFulfilled || 0);
    return '<div style="margin-top:10px">' + locs.map(function(l, i) {
      var have = parseInt(l.quantity) || 0;
      var already = (r.pickedLocations || {})[l.location] || 0;
      return '<div class="row" style="padding:8px 0;border-top:1px solid var(--border)">' +
        '<span class="mono grow" style="font-weight:900">' + esc(l.location) + '</span>' +
        '<span style="font-size:12.5px;color:' + (have > 0 ? 'var(--ok)' : 'var(--bad)') + '">' + have + (r.isBundle ? ' complete' : '') + ' avail</span>' +
        (already ? '<span style="font-size:11px;color:var(--text-mute)">✓ ' + already + ' picked</span>' : '') +
        (have > 0 ? '<button class="btn" style="min-height:40px" onclick="whFulfill(' + r.id + ',\'' + esc(l.location) + '\',' + Math.min(have, qtyLeft) + ')">Pick ' + Math.min(have, qtyLeft) + '</button>' : '') +
      '</div>';
    }).join('') + fulfillRow(r, locs[0] ? locs[0].location : '') + '</div>';
  }
  function fulfillRow(r, defLoc) {
    return '<div class="row" style="margin-top:8px">' +
      '<input class="input grow" type="number" inputmode="numeric" min="1" id="ffq-' + r.id + '" placeholder="Custom qty">' +
      '<button class="btn" onclick="whFulfillCustom(' + r.id + ',\'' + esc(defLoc) + '\')">Pick custom</button></div>';
  }
  window.whFulfill = function(id, location, qty) {
    var r = PMS.state.requests.find(function(x){ return x.id === id; });
    if (!r) return;
    confirmDialog({
      title: 'Confirm pick',
      okLabel: 'Confirm Pick',
      body: 'Pick <b>' + qty + '</b> × <b>' + esc(r.isBundle ? r.bundleName : r.partNum) + '</b> from <b class="mono">' + esc(location) + '</b> for <b>' + esc(r.line) + '</b>?',
    }).then(function(yes) {
      if (!yes) return;
      PMS.sendOp({ type: 'fulfill', reqId: id, location: location, qty: qty }, { fireAndForget: true });
      toast('ok', 'Pick sent — ' + qty + ' from ' + location);
      pickOpen[id] = false;
    });
  };
  window.whFulfillCustom = function(id, defLoc) {
    var q = parseInt(document.getElementById('ffq-' + id).value);
    if (!q || q < 1) { toast('err', 'Enter a quantity'); return; }
    window.whFulfill(id, defLoc, q);
  };
  window.whCancelReq = function(id) {
    // P5: one-tap cancel reason — this is how we learn why 9% get cancelled.
    choiceDialog('Why cancel this request?', [
      { label: 'Already delivered / line has it', value: 'already have' },
      { label: 'Wrong part requested',            value: 'wrong part' },
      { label: 'Duplicate request',               value: 'duplicate' },
      { label: 'No longer needed',                value: 'not needed' },
      { label: 'Out of stock everywhere',         value: 'out of stock' },
    ]).then(function(reason) {
      if (reason === null) return;
      PMS.sendOp({ type: 'dismiss', reqId: id, reason: reason }, { fireAndForget: true });
      toast('ok', 'Cancelled — reason logged');
    });
  };

  /* ── Stow tab ──────────────────────────────────────────────── */
  var stowSel = null, stowPlace = null;
  function buildStowTab() {
    var el = document.getElementById('wt-stow');
    el.innerHTML =
      '<div class="card">' +
        '<input class="input" id="stow-search" placeholder="Search part #, description, or bundle…" autocomplete="off">' +
        '<div class="result-list hidden" id="stow-results" style="margin-top:8px"></div>' +
        '<div id="stow-form" class="hidden" style="margin-top:12px">' +
          '<div class="kv"><span class="k">Part</span><span id="stow-part-label" style="font-weight:900"></span></div>' +
          '<div class="kv"><span class="k">Factory on-hand</span><span id="stow-epicor"></span></div>' +
          '<div id="stow-existing" style="margin:8px 0"></div>' +
          '<div class="sec-label">Quantity</div>' +
          '<div class="qty-row"><button class="qty-btn" onclick="stowQty(-1)">−</button>' +
          '<input class="input qty-input" id="stow-qty" type="number" inputmode="numeric" value="1" min="1">' +
          '<button class="qty-btn" onclick="stowQty(1)">+</button></div>' +
          '<div class="sec-label">Location</div>' +
          '<button class="btn big" id="stow-place-btn">📍 Choose location…</button>' +
          '<button class="btn primary big" id="stow-go" style="margin-top:12px" disabled>📥 Stow</button>' +
          '<button class="btn ghost big" style="margin-top:8px" onclick="stowClear()">Clear</button>' +
        '</div>' +
      '</div>' +
      '<div class="sec-label">Recent stows</div><div id="stow-recent"><div class="empty">None yet this session</div></div>';

    attachPartSearch(document.getElementById('stow-search'), document.getElementById('stow-results'), {
      onPick: function(item) {
        stowSel = item;
        document.getElementById('stow-form').classList.remove('hidden');
        document.getElementById('stow-part-label').textContent = item.isBundle ? item.partName + ' (BUNDLE)' : item.partNum + ' — ' + item.partName;
        var ep = item.isBundle ? null : PMS.epicorQty(item.partNum);
        document.getElementById('stow-epicor').textContent = ep === null ? '—' : ep;
        var ex = document.getElementById('stow-existing');
        if (item.isBundle) {
          ex.innerHTML = '<div class="sec-label">Per bundle</div>' + (item.bundle.children || []).map(function(c){ return '<div class="kv"><span class="mono">' + esc(c.partNum) + '</span><span>× ' + c.qty + '</span></div>'; }).join('');
        } else {
          var locs = PMS.state.locations.filter(function(l){ return String(l.partNum).toLowerCase() === item.partNum.toLowerCase(); });
          ex.innerHTML = locs.length
            ? '<div class="sec-label">Already at</div>' + locs.map(function(l){ return '<div class="kv"><span class="mono">' + esc(l.location) + '</span><span>' + esc(l.quantity) + '</span></div>'; }).join('')
            : '<div class="empty" style="padding:8px">No existing locations — first stow for this part</div>';
        }
        updateStowGo();
      },
    });
    document.getElementById('stow-place-btn').onclick = function() {
      openPlacePicker({ kinds: ['bin', 'area'] }).then(function(p) {
        if (!p) return;
        stowPlace = p;
        document.getElementById('stow-place-btn').textContent = '📍 ' + p.place + (p.isNew ? ' (new)' : '');
        updateStowGo();
      });
    };
    document.getElementById('stow-go').onclick = doStow;
    window.stowQty = function(d) { var e = document.getElementById('stow-qty'); e.value = Math.max(1, (parseInt(e.value) || 1) + d); };
    window.stowClear = function() { stowSel = null; stowPlace = null;
      document.getElementById('stow-form').classList.add('hidden');
      document.getElementById('stow-place-btn').textContent = '📍 Choose location…';
      updateStowGo(); };
  }
  function updateStowGo() { document.getElementById('stow-go').disabled = !(stowSel && stowPlace); }
  var recentStows = [];
  function doStow(force) {
    var qty = Math.max(1, parseInt(document.getElementById('stow-qty').value) || 1);
    var payload = stowSel.isBundle
      ? { type: 'stow', location: stowPlace.place, bundleName: stowSel.partName, qty: qty }
      : { type: 'stow', location: stowPlace.place, partNum: stowSel.partNum, partName: stowSel.partName, qty: qty };
    if (stowPlace.isNew) payload.allowNewBin = true;
    if (force === true) payload.force = true;
    PMS.sendOp(payload, {
      btn: document.getElementById('stow-go'), btnLabel: '📥 Stow', working: 'Stowing… do not tap again',
      resultType: 'stow-result',
      onResult: function(msg) {
        if (msg.duplicate) {
          confirmDialog({ title: 'Possible duplicate', warn: true, okLabel: 'Stow Anyway', body: esc(msg.message) })
            .then(function(yes){ if (yes) doStow(true); });
          return;
        }
        if (msg.newBin) {
          confirmDialog({ title: 'New bin', warn: true, okLabel: 'Create bin', body: esc(msg.message) })
            .then(function(yes){ if (yes) { stowPlace.isNew = true; doStow(force); } });
          return;
        }
        if (msg.success) {
          toast('ok', msg.message || 'Stowed');
          recentStows.unshift({ t: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }), txt: qty + ' × ' + (stowSel.isBundle ? stowSel.partName : stowSel.partNum) + ' → ' + stowPlace.place });
          if (recentStows.length > 12) recentStows.pop();
          document.getElementById('stow-recent').innerHTML = recentStows.map(function(s){ return '<div class="kv"><span>' + esc(s.txt) + '</span><span class="k">' + s.t + '</span></div>'; }).join('');
          window.stowClear();
          PMS.loadInventory();
        } else toast('err', msg.message || 'Stow failed');
      },
    });
  }

  /* ── Transfer tab (line-aware) ─────────────────────────────── */
  var trSel = null, trFrom = null, trTo = null;
  function buildTransferTab() {
    var el = document.getElementById('wt-transfer');
    el.innerHTML =
      '<div class="card">' +
        '<input class="input" id="tr-search" placeholder="Search part # or description… (bins + lines shown)" autocomplete="off">' +
        '<div class="result-list hidden" id="tr-results" style="margin-top:8px"></div>' +
        '<div id="tr-places" style="margin-top:10px"></div>' +
        '<div id="tr-form" class="hidden" style="margin-top:12px">' +
          '<div class="kv"><span class="k">From</span><span id="tr-from-label" style="font-weight:900"></span></div>' +
          '<div class="sec-label">Quantity</div>' +
          '<div class="qty-row"><button class="qty-btn" onclick="trQty(-1)">−</button>' +
          '<input class="input qty-input" id="tr-qty" type="number" inputmode="numeric" value="1" min="1">' +
          '<button class="qty-btn" onclick="trQty(1)">+</button></div>' +
          '<div class="sec-label">Destination</div>' +
          '<button class="btn big" id="tr-place-btn">📍 Choose destination…</button>' +
          '<button class="btn primary big" id="tr-go" style="margin-top:12px" disabled>↔ Transfer</button>' +
          '<button class="btn ghost big" style="margin-top:8px" onclick="trClear()">Clear</button>' +
        '</div>' +
      '</div>';
    attachPartSearch(document.getElementById('tr-search'), document.getElementById('tr-results'), {
      onPick: function(item) { trSel = item; trFrom = null; renderTrPlaces(); },
    });
    document.getElementById('tr-place-btn').onclick = function() {
      var kinds = trSel && trSel.isBundle ? ['bin', 'area'] : ['bin', 'area', 'line'];
      openPlacePicker({ kinds: kinds, excludeLine: trFrom && trFrom.kind === 'line' ? trFrom.place : null }).then(function(p) {
        if (!p) return;
        trTo = p;
        document.getElementById('tr-place-btn').textContent = '📍 ' + (p.kind === 'line' ? '⚙ ' : '') + p.place + (p.isNew ? ' (new)' : '');
        updateTrGo();
      });
    };
    document.getElementById('tr-go').onclick = doTransfer;
    window.trQty = function(d) { var e = document.getElementById('tr-qty'); e.value = Math.max(1, (parseInt(e.value) || 1) + d); };
    window.trClear = function() { trSel = null; trFrom = null; trTo = null;
      document.getElementById('tr-places').innerHTML = '';
      document.getElementById('tr-form').classList.add('hidden');
      document.getElementById('tr-place-btn').textContent = '📍 Choose destination…';
      updateTrGo(); };
  }
  function renderTrPlaces() {
    var el = document.getElementById('tr-places');
    if (!trSel) { el.innerHTML = ''; return; }
    var rows = [];
    if (trSel.isBundle) {
      // complete bundles per location (client-side mirror of the server calc)
      var children = trSel.bundle.children || [];
      var locSet = {};
      children.forEach(function(c) { PMS.state.locations.forEach(function(l) { if (String(l.partNum).toLowerCase() === String(c.partNum).toLowerCase()) locSet[l.location] = 1; }); });
      Object.keys(locSet).forEach(function(loc) {
        var maxB = Infinity;
        children.forEach(function(c) {
          var on = PMS.state.locations.filter(function(l){ return l.location === loc && String(l.partNum).toLowerCase() === String(c.partNum).toLowerCase(); })
            .reduce(function(s, l){ return s + (parseInt(l.quantity) || 0); }, 0);
          maxB = Math.min(maxB, Math.floor(on / Math.max(1, parseInt(c.qty) || 1)));
        });
        if (maxB > 0 && maxB !== Infinity) rows.push({ kind: 'warehouse', place: loc, qty: maxB, label: maxB + ' complete' });
      });
      if (!rows.length) { el.innerHTML = '<div class="empty">No complete bundle locations</div>'; return; }
    } else {
      PMS.state.locations.filter(function(l){ return String(l.partNum).toLowerCase() === trSel.partNum.toLowerCase(); })
        .forEach(function(l) { var q = parseInt(l.quantity) || 0; if (q > 0) rows.push({ kind: 'warehouse', place: l.location, qty: q, label: q + ' in stock' }); });
      PMS.state.lineInventory.filter(function(e){ return String(e.partNum).toLowerCase() === trSel.partNum.toLowerCase() && (parseFloat(e.onLineQty) || 0) > 0; })
        .forEach(function(e) { var q = Math.floor(parseFloat(e.onLineQty)); rows.push({ kind: 'line', place: e.line, qty: q, label: q + ' on line' }); });
      if (!rows.length) { el.innerHTML = '<div class="empty">No tracked stock anywhere for this part</div>'; return; }
    }
    el.innerHTML = '<div class="sec-label">Transfer from</div>' + rows.map(function(r, i) {
      return '<div class="row" style="padding:8px 0;border-top:1px solid var(--border)">' +
        '<span class="mono grow" style="font-weight:900;' + (r.kind === 'line' ? 'color:var(--purple)' : '') + '">' + (r.kind === 'line' ? '⚙ ' : '') + esc(r.place) + '</span>' +
        '<span style="font-size:12.5px;color:var(--ok)">' + esc(r.label) + '</span>' +
        '<button class="btn" style="min-height:40px" data-i="' + i + '">From here</button></div>';
    }).join('');
    el.querySelectorAll('[data-i]').forEach(function(b) {
      b.onclick = function() {
        var r = rows[parseInt(b.dataset.i)];
        trFrom = r;
        document.getElementById('tr-form').classList.remove('hidden');
        document.getElementById('tr-from-label').textContent = (r.kind === 'line' ? '⚙ ' : '') + r.place + ' (' + r.label + ')';
        document.getElementById('tr-qty').value = 1;
        document.getElementById('tr-qty').max = r.qty;
        updateTrGo();
      };
    });
  }
  function updateTrGo() { document.getElementById('tr-go').disabled = !(trSel && trFrom && trTo); }
  function doTransfer(force) {
    var qty = Math.max(1, parseInt(document.getElementById('tr-qty').value) || 1);
    if (qty > trFrom.qty) { toast('err', 'Only ' + trFrom.qty + ' available at source'); return; }
    if (trFrom.kind === trTo.kind && String(trFrom.place).toLowerCase() === String(trTo.place).toLowerCase() ||
        (trFrom.kind === 'line' && trTo.kind === 'line' && trFrom.place === trTo.place)) {
      toast('err', 'Destination must differ from source'); return;
    }
    var payload = {
      type: 'transfer',
      partNum: trSel.isBundle ? '' : trSel.partNum,
      partName: trSel.isBundle ? '' : trSel.partName,
      bundleName: trSel.isBundle ? trSel.partName : '',
      fromType: trFrom.kind === 'line' ? 'line' : 'warehouse',
      toType: trTo.kind === 'line' ? 'line' : 'warehouse',
      fromLocation: trFrom.place,
      toLocation: trTo.place,
      qty: qty,
    };
    if (force === true) payload.force = true;
    PMS.sendOp(payload, {
      btn: document.getElementById('tr-go'), btnLabel: '↔ Transfer', working: 'Transferring…',
      resultType: 'transfer-result',
      onResult: function(msg) {
        if (msg.duplicate) {
          confirmDialog({ title: 'Possible duplicate', warn: true, okLabel: 'Transfer Anyway', body: esc(msg.message) })
            .then(function(yes){ if (yes) doTransfer(true); });
          return;
        }
        if (msg.success) { toast('ok', msg.message || 'Transferred'); window.trClear(); PMS.loadInventory(); }
        else toast('err', msg.message || 'Transfer failed');
      },
    });
  }

  /* ── Activity + write health (P5) ──────────────────────────── */
  function renderActivity() {
    var el = document.getElementById('wt-activity');
    fetch('/api/recent-picks').then(function(r){ return r.json(); }).then(function(d) {
      var rows = (d && d.recentPicks) || [];
      el.innerHTML = '<div class="sec-label">Recently fulfilled</div>' +
        (rows.length ? rows.map(function(p) {
          return '<div class="card"><div class="row"><div class="grow"><b>' + esc(p.partNum || p.bundleName || p.text || '') + '</b>' +
            '<div style="font-size:12px;color:var(--text-mute)">' + esc(p.line || '') + ' · qty ' + esc(String(p.qtyFulfilled != null ? p.qtyFulfilled : p.qty || '')) + '</div></div></div></div>';
        }).join('') : '<div class="empty">Nothing fulfilled recently</div>');
    }).catch(function(){ el.innerHTML = '<div class="empty">Could not load activity</div>'; });
  }
  function pollWriteHealth() {
    fetch('/api/write-health').then(function(r){ return r.json(); }).then(function(d) {
      var el = document.getElementById('wh-health');
      if (!d || !d.failed || !d.failed.length) { el.innerHTML = ''; return; }
      el.innerHTML = '<div class="card" style="border-color:#b45309">' +
        '<div style="font-weight:900;color:var(--warn);margin-bottom:6px">⚠ ' + d.failed.length + ' background write' + (d.failed.length === 1 ? '' : 's') + ' failed — data may be missing from the sheet</div>' +
        d.failed.map(function(f) {
          return '<div class="row" style="padding:5px 0"><span class="grow" style="font-size:12.5px">' + esc(f.label) + ' · ' + new Date(f.at).toLocaleTimeString() + '</span>' +
            '<button class="btn" style="min-height:36px;font-size:11px" onclick="whRetryWrite(' + f.id + ')">Retry</button></div>';
        }).join('') + '</div>';
    }).catch(function(){});
  }
  window.whRetryWrite = function(id) {
    fetch('/api/write-health/retry/' + id, { method: 'POST' }).then(function(r){ return r.json(); })
      .then(function(d){ toast(d.success ? 'ok' : 'err', d.success ? 'Write retried successfully' : 'Retry failed — still queued'); pollWriteHealth(); });
  };
}
