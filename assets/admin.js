/* admin.html — Kankana studio dashboard (talks to /api/admin/*) */
(() => {
  'use strict';
  const K = Kankana, U = K.util, $ = id => document.getElementById(id);
  const toast = K.toast;
  const pill = s => `<span class="pill ${K.STATUSES[s].tone}">${K.STATUSES[s].label}</span>`;
  let S = null;              // server state
  let tab = 'overview';

  /* ------------------------------------------------ data */
  const venueName = id => (S.catalog.venues.find(v => v.id === id) || { name: id }).name;
  function occupancy(venueId, ignoreId) {
    const map = {}, now = Date.now();
    S.bookings.forEach(b => {
      if (b.venueId !== venueId || b.id === ignoreId) return;
      const st = K.STATUSES[b.status].blocks; if (!st) return;
      if (st === 'hold' && b.holdUntil && b.holdUntil < now) return;
      U.eventDates(b.startDate, b.days).forEach(d => { if (!map[d] || map[d].state === 'hold') map[d] = { state: st, bookingId: b.id }; });
    });
    S.blocked.forEach(x => { if (x.venueId === venueId && !map[x.date]) map[x.date] = { state: 'blocked', reason: x.reason }; });
    return map;
  }
  async function reload() { S = await K.api('GET', '/api/admin/state'); return S; }
  async function act(fn, okMsg) {
    try { const r = await fn(); await reload(); render(); if (okMsg) toast(okMsg); return r; }
    catch (e) { if (e.status === 401) return showLogin(); toast(e.message, 5000); throw e; }
  }

  /* ------------------------------------------------ auth */
  function showLogin() { $('app').style.display = 'none'; $('login').style.display = 'flex'; }
  $('loginForm').onsubmit = async e => {
    e.preventDefault(); $('pwErr').textContent = '';
    try { await K.api('POST', '/api/admin/login', { email: $('em').value.trim(), password: $('pw').value }); $('pw').value = ''; await boot(); }
    catch (err) { $('pwErr').textContent = err.message; }
  };
  $('logout').onclick = async () => { try { await K.api('POST', '/api/admin/logout', {}); } catch (e) {} location.reload(); };

  /* ------------------------------------------------ navigation */
  const TABS = ['overview', 'bookings', 'calendar', 'quote', 'customers', 'payments', 'outbox', 'catalog', 'settings'];
  function go(t) {
    tab = t;
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    document.querySelectorAll('.tab').forEach(s => s.classList.toggle('on', s.id === 't-' + t));
    $('side').classList.remove('open');
    if (history.replaceState) history.replaceState(null, '', '#' + t);
    render(); window.scrollTo(0, 0);
  }
  $('tabs').onclick = e => { const b = e.target.closest('button'); if (b) go(b.dataset.tab); };
  document.addEventListener('click', e => { const g = e.target.closest('[data-go]'); if (g) { if (g.dataset.go === 'quote') resetQuote(); go(g.dataset.go); } });
  $('menuBtn').onclick = () => $('side').classList.toggle('open');

  function render() {
    if (!S) return;
    $('bCount').textContent = S.bookings.filter(b => ['enquiry', 'quoted'].includes(b.status)).length || '';
    ({ overview: rOverview, bookings: rBookings, calendar: rCalendar, quote: qPreview, customers: rCustomers, payments: rPayments, outbox: rOutbox, catalog: rCatalog, settings: rSettings })[tab]();
  }

  /* ------------------------------------------------ overview */
  function rOverview() {
    $('todayLbl').textContent = U.parseISO(S.today).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const live = S.bookings.filter(b => ['confirmed', 'planning', 'paid', 'completed'].includes(b.status));
    const collected = S.bookings.reduce((s, b) => s + K.paidAmount(b), 0);
    const outstanding = live.reduce((s, b) => s + K.balanceDue(b), 0);
    const pending = S.bookings.filter(b => ['enquiry', 'quoted'].includes(b.status));
    $('kpis').innerHTML = [
      ['Confirmed bookings', live.length, `${U.inr(live.reduce((s, b) => s + b.quote.total, 0))} booked value`],
      ['Collected', U.inr(collected), `${S.bookings.reduce((n, b) => n + b.payments.length, 0)} payments`],
      ['Outstanding balance', U.inr(outstanding), 'across confirmed bookings'],
      ['Open quotations', pending.length, `${U.inr(pending.reduce((s, b) => s + b.quote.total, 0))} in pipeline`]
    ].map(k => `<div class="kpi"><div class="l">${k[0]}</div><div class="v">${k[1]}</div><div class="s">${k[2]}</div></div>`).join('');
    const up = S.bookings.filter(b => b.status !== 'cancelled' && U.addDays(b.startDate, b.days - 1) >= S.today).sort((a, b) => a.startDate.localeCompare(b.startDate)).slice(0, 8);
    $('upcoming').innerHTML = up.length ? `<table class="t"><tbody>${up.map(b => `
      <tr class="click" data-open="${b.id}"><td><b style="font-weight:500">${U.esc(b.customer.name)}</b><div class="sub">${U.esc(venueName(b.venueId))} · ${b.guests} guests</div></td>
      <td class="sub" style="white-space:nowrap">${U.range(b)}</td><td class="r">${pill(b.status)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No upcoming celebrations yet. New bookings from the website appear here.</div>';
    const acts = S.bookings.flatMap(b => b.history.map(h => Object.assign({ id: b.id, name: b.customer.name }, h))).sort((a, b) => b.at - a.at).slice(0, 8);
    $('activity').innerHTML = acts.map(a => `<li data-open="${a.id}" style="cursor:pointer"><div class="t">${U.fmtDateTime(a.at)} · ${a.id}</div><div class="n">${U.esc(a.name)} — ${U.esc(a.note)}</div></li>`).join('') || '<div class="empty">No activity yet.</div>';
    const warn = [];
    if (S.system.payments === 'off') warn.push('Online payments are off — add Razorpay keys on the server.');
    if (S.system.payments === 'mock') warn.push('Payments are in development test mode.');
    if (!S.system.email) warn.push('Email is not configured — clients will not receive quotations or receipts.');
    $('kpis').insertAdjacentHTML('beforebegin', warn.length && !document.getElementById('sysWarn') ? `<div id="sysWarn" class="card" style="background:var(--amber-bg);color:var(--amber);border:none;margin-bottom:18px;font-size:14px">${warn.map(U.esc).join('<br>')} <a href="#settings" data-go="settings" style="text-decoration:underline">Settings</a></div>` : '');
  }

  /* ------------------------------------------------ bookings */
  Object.entries(K.STATUSES).forEach(([k, s]) => $('fStatus').insertAdjacentHTML('beforeend', `<option value="${k}">${s.label}</option>`));
  ['fSearch', 'fStatus', 'fVenue', 'fWhen'].forEach(id => $(id).addEventListener('input', () => rBookings()));
  function fillVenueSelects() {
    const opts = S.catalog.venues.map(v => `<option value="${U.esc(v.id)}">${U.esc(v.name)}${v.active === false ? ' (hidden)' : ''}</option>`).join('');
    const keep = id => $(id).value;
    const fv = keep('fVenue'), cv = keep('calVenue'), qv = keep('q_venue');
    $('fVenue').innerHTML = '<option value="">All venues</option>' + opts;
    $('calVenue').innerHTML = '<option value="__all">All venues</option>' + opts;
    $('q_venue').innerHTML = opts;
    $('q_pkg').innerHTML = S.catalog.packages.map(p => `<option value="${U.esc(p.id)}">${U.esc(p.name)} — ${U.inr(p.perGuest)}/guest/day</option>`).join('');
    $('q_addons').innerHTML = S.catalog.addons.map(a => `<label><input type="checkbox" value="${U.esc(a.id)}">${U.esc(a.name)} <span class="muted" style="margin-left:auto;font-size:12px">${U.inr(a.price)}${a.unit === 'perGuest' ? '/guest' : ''}</span></label>`).join('');
    $('q_days').innerHTML = Array.from({ length: S.settings.maxDays || 5 }, (_, i) => `<option>${i + 1}</option>`).join('');
    if (fv) $('fVenue').value = fv; if (cv) $('calVenue').value = cv; if (qv) $('q_venue').value = qv;
  }
  function rBookings() {
    const q = $('fSearch').value.trim().toLowerCase(), st = $('fStatus').value, vn = $('fVenue').value, wh = $('fWhen').value;
    const rows = S.bookings.filter(b =>
      (!st || b.status === st) && (!vn || b.venueId === vn) &&
      (!wh || (wh === 'upcoming' ? b.startDate >= S.today : b.startDate < S.today)) &&
      (!q || [b.id, b.customer.name, b.customer.email, b.customer.phone].join(' ').toLowerCase().includes(q)));
    $('bTable').innerHTML = `<thead><tr><th>Booking</th><th>Client</th><th>Venue</th><th>Dates</th><th class="r">Guests</th><th class="r">Total</th><th class="r">Paid</th><th>Status</th></tr></thead>
      <tbody>${rows.map(b => `<tr class="click" data-open="${b.id}">
        <td class="id">${b.id}<div class="sub" style="font-family:Jost">${U.fmtDateTime(b.createdAt).split(',')[0]}</div></td>
        <td>${U.esc(b.customer.name)}<div class="sub">${U.esc(b.customer.phone)}</div></td>
        <td>${U.esc(venueName(b.venueId))}</td><td style="white-space:nowrap">${U.range(b)}</td>
        <td class="r">${b.guests}</td><td class="r">${U.inr(b.quote.total)}</td>
        <td class="r">${U.inr(K.paidAmount(b))}</td><td>${pill(b.status)}</td></tr>`).join('') || `<tr><td colspan="8" class="empty">No bookings match.</td></tr>`}</tbody>`;
  }

  /* ------------------------------------------------ drawer */
  document.addEventListener('click', e => { const o = e.target.closest('[data-open]'); if (o && !e.target.closest('.drawer')) openDrawer(o.dataset.open); });
  $('drawerBg').onclick = closeDrawer;
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
  function closeDrawer() { $('drawer').classList.remove('open'); $('drawerBg').classList.remove('open'); }

  function openDrawer(id) {
    const b = S.bookings.find(x => x.id === id); if (!b) return;
    const due = K.balanceDue(b);
    const link = `${location.origin}/my-booking.html?id=${encodeURIComponent(b.id)}&email=${encodeURIComponent(b.customer.email)}`;
    const emails = S.emails.filter(m => m.bookingId === b.id).slice(0, 5);
    $('drawer').innerHTML = `
      <div class="dr-h"><div><div class="eyebrow">${b.id} · ${U.esc(b.quoteNo)}</div><h2>${U.esc(b.customer.name)}</h2><div style="margin-top:8px">${pill(b.status)}</div></div>
        <button class="dr-x" id="drX" aria-label="Close">×</button></div>
      <div class="dr-b">
        <div class="dr-sec"><h4>Update status</h4>
          <div class="row">
            <label class="field"><span>Status</span><select id="dStatus">${Object.entries(K.STATUSES).map(([k, s]) => `<option value="${k}" ${k === b.status ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>
            <label class="field" style="flex:2"><span>Note (emailed to client)</span><input id="dNote" placeholder="e.g. Décor walkthrough scheduled"></label>
            <button class="btn sm solid" id="dStatusSave">Update</button>
          </div>
          <label style="display:flex;gap:8px;align-items:center;font-size:13px;margin-top:8px"><input type="checkbox" id="dNotify" checked style="accent-color:var(--ink)"> Email the client about this change</label>
        </div>
        <div class="dr-sec"><h4>Client</h4><dl class="kv">
          <dt>Email</dt><dd><a href="mailto:${U.esc(b.customer.email)}">${U.esc(b.customer.email)}</a></dd>
          <dt>Phone</dt><dd><a href="tel:${U.esc(b.customer.phone)}">${U.esc(b.customer.phone)}</a> · <a href="https://wa.me/${U.esc(b.customer.phone.replace(/\D/g, ''))}" target="_blank" rel="noopener">WhatsApp</a></dd>
          <dt>City</dt><dd>${U.esc([b.customer.city, b.customer.state].filter(Boolean).join(', ') || '—')}</dd>
          ${b.customer.gstin ? `<dt>GSTIN</dt><dd>${U.esc(b.customer.gstin)}</dd>` : ''}
          <dt>Source</dt><dd>${b.source === 'admin' ? 'Created by team' : 'Website'}</dd></dl></div>
        <div class="dr-sec"><h4>Event</h4><dl class="kv">
          <dt>Venue</dt><dd>${U.esc(venueName(b.venueId))}</dd><dt>Dates</dt><dd>${U.range(b)} (${b.days} day${b.days > 1 ? 's' : ''})</dd>
          <dt>Guests</dt><dd>${b.guests}</dd><dt>Package</dt><dd>${U.esc(b.packageName || '—')}</dd>
          <dt>Rooms</dt><dd>${b.rooms || '—'}</dd>
          ${b.notes ? `<dt>Notes</dt><dd>${U.esc(b.notes)}</dd>` : ''}</dl></div>
        <div class="dr-sec"><h4>Money</h4>
          <div class="pay-list">
            <div><span>Quotation total</span><b style="font-weight:500">${U.inr(b.quote.total)}</b></div>
            ${b.payments.map(pm => `<div><span>${U.fmtDateTime(pm.at)} · ${U.esc(pm.method)} <span class="muted">${U.esc(pm.receiptNo)}</span></span><span>${U.inr(pm.amount)} <a href="${K.docUrl('receipt', b, pm.id)}" target="_blank" style="color:var(--gold-deep)">receipt</a></span></div>`).join('')}
            <div><span>Balance due</span><b style="font-weight:500">${U.inr(due)}</b></div>
          </div>
          ${due > 0 && b.status !== 'cancelled' ? `
          <div class="row" style="margin-top:14px">
            <label class="field"><span>Record offline payment (₹)</span><input id="dAmt" type="number" min="1" max="${due}" value="${['enquiry', 'quoted'].includes(b.status) ? b.quote.advance : due}"></label>
            <label class="field"><span>Method</span><select id="dMethod"><option>Bank transfer</option><option>UPI</option><option>Cheque</option><option>Cash</option><option>Card (POS)</option></select></label>
            <label class="field"><span>Reference</span><input id="dRef" placeholder="UTR / cheque no."></label>
            <button class="btn sm solid" id="dPay">Record</button>
          </div>` : ''}
        </div>
        <div class="dr-sec"><h4>Documents &amp; emails</h4>
          <div class="row">
            <a class="btn sm" href="${K.docUrl('quotation', b)}" target="_blank">Quotation PDF</a>
            ${b.invoiceNo ? `<a class="btn sm" href="${K.docUrl('invoice', b)}" target="_blank">Tax invoice PDF</a>` : ''}
            <button class="btn sm" id="dEdit">Edit quotation</button>
            <button class="btn sm" id="dResend">Re-send quotation</button>
            <button class="btn sm" id="dLink">Copy client link</button>
          </div>
          ${emails.length ? `<div class="pay-list" style="margin-top:12px">${emails.map(m => `<div><span>${U.esc(m.subject)}</span><span class="muted">${emailStatus(m)}</span></div>`).join('')}</div>` : ''}
        </div>
        <div class="dr-sec"><h4>History</h4><ul class="k-timeline">${b.history.slice().reverse().map(h => `<li><div class="t">${U.fmtDateTime(h.at)} · ${K.STATUSES[h.status] ? K.STATUSES[h.status].label : ''}</div><div class="n">${U.esc(h.note)}</div></li>`).join('')}</ul></div>
      </div>`;
    $('drawer').classList.add('open'); $('drawerBg').classList.add('open');
    $('drX').onclick = closeDrawer;
    $('dStatusSave').onclick = () => act(() => K.api('POST', `/api/admin/bookings/${b.id}/status`, { status: $('dStatus').value, note: $('dNote').value.trim(), notify: $('dNotify').checked }), 'Status updated').then(() => openDrawer(b.id)).catch(() => {});
    const dp = $('dPay');
    if (dp) dp.onclick = () => {
      const amount = Math.round(+$('dAmt').value);
      if (!(amount > 0)) return toast('Enter an amount');
      dp.disabled = true;
      act(() => K.api('POST', `/api/admin/bookings/${b.id}/payments`, { amount, method: $('dMethod').value, ref: $('dRef').value.trim() }), 'Payment recorded — receipt & invoice emailed').then(() => openDrawer(b.id)).catch(() => { dp.disabled = false; });
    };
    $('dEdit').onclick = () => { closeDrawer(); loadQuote(b); go('quote'); };
    $('dResend').onclick = () => act(() => K.api('POST', `/api/admin/bookings/${b.id}/resend`, { kind: 'quotation' }), 'Quotation re-sent').then(() => openDrawer(b.id)).catch(() => {});
    $('dLink').onclick = async () => {
      try { await navigator.clipboard.writeText(link); toast('Client link copied — share it on WhatsApp or email'); }
      catch (e) { $('dLink').outerHTML = `<input class="k-input" value="${U.esc(link)}" readonly onclick="this.select()">`; }
    };
  }
  const emailStatus = m => ({ sent: '✓ sent', failed: '✕ failed', sending: 'sending…', not_configured: 'email off' })[m.status] || m.status;

  /* ------------------------------------------------ calendar */
  let calMonth = null;
  $('calVenue').onchange = () => { $('blockPanel').style.display = 'none'; rCalendar(); };
  function rCalendar() {
    if (!calMonth) calMonth = U.parseISO(S.today);
    const vid = $('calVenue').value || '__all';
    const all = vid === '__all';
    const multi = {}; const names = {};
    if (all) S.catalog.venues.forEach(v => { multi[v.id] = occupancy(v.id); names[v.id] = v.name; });
    K.renderCalendar($('adminCal'), {
      occ: all ? {} : occupancy(vid), multi: all ? multi : null, venueNames: names, today: S.today, month: calMonth, mode: 'admin',
      onMonth: m => { calMonth = m; listMonth(); },
      onPick: (d, info) => {
        if (all) { const hit = (info || []).find(h => h.bookingId); if (hit) return openDrawer(hit.bookingId); return toast('Choose a single venue to block dates'); }
        if (info && info.bookingId) return openDrawer(info.bookingId);
        if (d < S.today) return;
        const bp = $('blockPanel'); bp.style.display = 'block';
        bp.innerHTML = info && info.state === 'blocked'
          ? `<div class="row"><div style="flex:1;font-size:14px"><b style="font-weight:500">${U.fmtDate(d)}</b> is blocked — ${U.esc(info.reason)}</div><button class="btn sm" id="unblock">Unblock</button></div>`
          : `<div class="row"><label class="field" style="flex:2"><span>Block ${U.fmtDate(d)} — reason</span><input id="blkReason" placeholder="Maintenance, private event…"></label><button class="btn sm solid" id="doBlock">Block date</button></div>`;
        const ub = $('unblock'); if (ub) ub.onclick = () => act(() => K.api('POST', '/api/admin/blocked', { venueId: vid, date: d }), 'Date reopened').then(() => bp.style.display = 'none').catch(() => {});
        const bl = $('doBlock'); if (bl) bl.onclick = () => act(() => K.api('POST', '/api/admin/blocked', { venueId: vid, date: d, reason: $('blkReason').value.trim() || 'Blocked' }), 'Date blocked').then(() => bp.style.display = 'none').catch(() => {});
      }
    });
    listMonth();
    function listMonth() {
      const y = calMonth.getFullYear(), m = calMonth.getMonth();
      const mStart = U.iso(new Date(y, m, 1)), mEnd = U.iso(new Date(y, m + 1, 0));
      $('calMonthTitle').textContent = calMonth.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
      const evs = S.bookings.filter(b => (all || b.venueId === vid) && b.status !== 'cancelled' && b.startDate <= mEnd && U.addDays(b.startDate, b.days - 1) >= mStart).sort((a, b) => a.startDate.localeCompare(b.startDate));
      const blocks = S.blocked.filter(x => (all || x.venueId === vid) && x.date >= mStart && x.date <= mEnd);
      $('calEvents').innerHTML = (evs.map(b => `<div class="ev" data-open="${b.id}"><div style="display:flex;justify-content:space-between;gap:8px"><b style="font-weight:500">${U.esc(b.customer.name)}</b>${pill(b.status)}</div><div class="muted" style="font-size:12px;margin-top:3px">${U.range(b)} · ${U.esc(venueName(b.venueId))} · ${b.guests} guests</div></div>`).join('')
        + blocks.map(x => `<div class="ev" style="cursor:default"><b style="font-weight:500">Blocked</b> · ${U.fmtDate(x.date)}<div class="muted" style="font-size:12px">${U.esc(venueName(x.venueId))} — ${U.esc(x.reason)}</div></div>`).join('')) || '<div class="empty">Nothing scheduled this month.</div>';
    }
  }

  /* ------------------------------------------------ quotation generator */
  let editingId = null, customLines = [];
  function drawLines() {
    $('q_lines').innerHTML = customLines.map((l, i) => `<div class="cl-row" data-i="${i}">
      <input class="k-input" data-k="desc" value="${U.esc(l.desc)}" placeholder="e.g. Fireworks display">
      <input class="k-input" data-k="qty" type="number" min="1" value="${l.qty}">
      <input class="k-input" data-k="rate" type="number" min="0" value="${l.rate}">
      <button type="button" data-del="${i}" aria-label="Remove">×</button></div>`).join('');
  }
  $('q_lines').addEventListener('input', e => { const r = e.target.closest('.cl-row'); if (!r) return; customLines[+r.dataset.i][e.target.dataset.k] = e.target.dataset.k === 'desc' ? e.target.value : +e.target.value; qPreview(); });
  $('q_lines').addEventListener('click', e => { if (e.target.dataset.del != null) { customLines.splice(+e.target.dataset.del, 1); drawLines(); qPreview(); } });
  $('q_addLine').onclick = () => { customLines.push({ desc: '', qty: 1, rate: 0 }); drawLines(); };
  $('t-quote').addEventListener('input', e => { if (!e.target.closest('#q_lines')) qPreview(); });
  $('t-quote').addEventListener('change', e => { if (!e.target.closest('#q_lines')) qPreview(); });

  function qData() {
    return {
      customer: { name: $('q_name').value.trim(), email: $('q_email').value.trim(), phone: $('q_phone').value.trim(), city: $('q_city').value.trim(), state: $('q_state').value.trim(), gstin: $('q_gstin').value.trim() },
      venueId: $('q_venue').value, startDate: $('q_date').value, days: +$('q_days').value || 1, guests: +$('q_guests').value || 1,
      packageId: $('q_pkg').value, rooms: +$('q_rooms').value || 0,
      addons: [...$('q_addons').querySelectorAll('input:checked')].map(i => i.value),
      customLines: customLines.filter(l => l.desc && l.qty && l.rate).map(l => ({ desc: l.desc, qty: +l.qty, rate: +l.rate, unit: 'lot' })),
      discount: +$('q_discount').value || 0, notes: $('q_notes').value.trim()
    };
  }
  function qPreview() {
    if (!S) return;
    $('q_date').min = S.today;
    const d = qData(), q = K.buildQuote(d, S.catalog, S.settings);
    const av = $('q_avail');
    if (d.startDate) {
      const ok = K.rangeFree(occupancy(d.venueId, editingId), d.startDate, d.days, S.today);
      av.style.display = 'block'; av.className = 'avail ' + (ok ? 'ok' : 'bad');
      av.textContent = ok ? `✓ Available ${d.days > 1 ? U.fmtDate(d.startDate) + ' – ' + U.fmtDate(U.addDays(d.startDate, d.days - 1)) : U.fmtDate(d.startDate)}` : 'These dates clash with a booking, hold or blocked date at this venue.';
    } else av.style.display = 'none';
    $('q_preview').innerHTML = `
      <div style="font-size:14px;line-height:1.6;margin-bottom:10px"><b style="font-weight:500">${U.esc(d.customer.name || 'Client name')}</b><br><span class="muted">${U.esc(venueName(d.venueId))} · ${d.startDate ? U.fmtDate(d.startDate) : 'date TBC'} · ${d.guests} guests</span></div>
      <table class="q-table"><tbody>${q.lines.map(l => `<tr><td>${U.esc(l.desc.replace(/ \(.*\)$/, ''))}<div class="muted" style="font-size:11px">${l.qty.toLocaleString('en-IN')} × ${U.inr(l.rate)}</div></td><td class="r">${U.inr(l.amount)}</td></tr>`).join('')}</tbody></table>
      <div class="q-totals" style="width:100%">
        ${q.discount ? `<div><span>Discount</span><span>− ${U.inr(q.discount)}</span></div>` : ''}
        <div><span>Subtotal</span><span>${U.inr(q.subtotal)}</span></div>
        <div><span>GST (${q.gstPct}%)</span><span>${U.inr(q.gst)}</span></div>
        <div class="grand"><span>Total</span><span>${U.inr(q.total)}</span></div>
        <div class="adv"><span>Advance (${q.advancePct}%)</span><span>${U.inr(q.advance)}</span></div>
      </div>`;
  }
  function resetQuote() {
    editingId = null; customLines = [];
    ['q_name', 'q_email', 'q_phone', 'q_city', 'q_state', 'q_gstin', 'q_date', 'q_notes'].forEach(id => $(id).value = '');
    $('q_venue').selectedIndex = 0; $('q_days').selectedIndex = 0; $('q_guests').value = 150; $('q_pkg').selectedIndex = 0; $('q_rooms').value = 0; $('q_discount').value = 0;
    $('q_addons').querySelectorAll('input').forEach(i => i.checked = false);
    $('qbTitle').textContent = 'Quotation Generator'; $('q_save').textContent = 'Save & email quotation'; $('q_enquiry').style.display = '';
    $('q_err').textContent = '';
    drawLines(); qPreview();
  }
  function loadQuote(b) {
    resetQuote(); editingId = b.id;
    const c = b.customer;
    $('q_name').value = c.name; $('q_email').value = c.email; $('q_phone').value = c.phone; $('q_city').value = c.city || ''; $('q_state').value = c.state || ''; $('q_gstin').value = c.gstin || '';
    $('q_venue').value = b.venueId; $('q_date').value = b.startDate; $('q_days').value = String(b.days); $('q_guests').value = b.guests;
    $('q_pkg').value = b.packageId; $('q_rooms').value = b.rooms; $('q_discount').value = b.discount || 0; $('q_notes').value = b.notes || '';
    $('q_addons').querySelectorAll('input').forEach(i => i.checked = b.addons.includes(i.value));
    customLines = (b.customLines || []).map(l => Object.assign({}, l));
    $('qbTitle').textContent = `Edit ${b.id}`; $('q_save').textContent = 'Update & email revised quotation'; $('q_enquiry').style.display = 'none';
    drawLines(); qPreview();
  }
  $('qbReset').onclick = resetQuote;
  $('q_save').onclick = async () => {
    const d = qData(); $('q_err').textContent = '';
    if (!d.startDate) { $('q_err').textContent = 'Choose a start date.'; return; }
    $('q_save').disabled = true;
    try {
      const r = editingId
        ? await K.api('PUT', `/api/admin/bookings/${editingId}`, Object.assign(d, { sendQuote: true }))
        : await K.api('POST', '/api/admin/bookings', Object.assign(d, { status: 'quoted' }));
      await reload();
      toast(`${r.booking.quoteNo} saved & emailed to ${r.booking.customer.email}`);
      resetQuote(); go('bookings'); openDrawer(r.booking.id);
    } catch (e) { if (e.status === 401) return showLogin(); $('q_err').textContent = e.message; }
    finally { $('q_save').disabled = false; }
  };
  $('q_enquiry').onclick = async () => {
    const d = qData(); $('q_err').textContent = '';
    if (!d.startDate) d.startDate = S.today;
    try { const r = await K.api('POST', '/api/admin/bookings', Object.assign(d, { status: 'enquiry' })); await reload(); toast(`Enquiry ${r.booking.id} saved`); resetQuote(); go('bookings'); }
    catch (e) { if (e.status === 401) return showLogin(); $('q_err').textContent = e.message; }
  };

  /* ------------------------------------------------ customers */
  $('cSearch').oninput = () => rCustomers();
  function rCustomers() {
    const map = {};
    S.bookings.forEach(b => {
      const k = b.customer.email.toLowerCase();
      const c = map[k] || (map[k] = { name: b.customer.name, email: b.customer.email, phone: b.customer.phone, city: b.customer.city, bookings: 0, value: 0, paid: 0, last: 0, latest: b.status });
      c.bookings++; if (b.status !== 'cancelled') c.value += b.quote.total; c.paid += K.paidAmount(b);
      if (b.createdAt > c.last) { c.last = b.createdAt; c.latest = b.status; }
    });
    const q = $('cSearch').value.trim().toLowerCase();
    const rows = Object.values(map).filter(c => !q || [c.name, c.email, c.phone, c.city].join(' ').toLowerCase().includes(q)).sort((a, b) => b.last - a.last);
    $('cTable').innerHTML = `<thead><tr><th>Customer</th><th>Contact</th><th>City</th><th class="r">Bookings</th><th class="r">Value</th><th class="r">Paid</th><th class="r">Balance</th><th>Latest</th></tr></thead>
      <tbody>${rows.map(c => `<tr class="click" data-cust="${U.esc(c.email)}"><td><b style="font-weight:500">${U.esc(c.name)}</b></td>
        <td>${U.esc(c.email)}<div class="sub">${U.esc(c.phone)}</div></td><td>${U.esc(c.city || '—')}</td>
        <td class="r">${c.bookings}</td><td class="r">${U.inr(c.value)}</td><td class="r">${U.inr(c.paid)}</td><td class="r">${U.inr(Math.max(0, c.value - c.paid))}</td>
        <td>${pill(c.latest)}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No customers yet.</td></tr>'}</tbody>`;
    $('cTable').querySelectorAll('[data-cust]').forEach(r => r.onclick = () => { $('fSearch').value = r.dataset.cust; $('fStatus').value = ''; $('fVenue').value = ''; $('fWhen').value = ''; go('bookings'); });
  }

  /* ------------------------------------------------ payments */
  function rPayments() {
    const all = S.bookings.flatMap(b => b.payments.map(p => Object.assign({ b }, p))).sort((a, b) => b.at - a.at);
    const sum = all.reduce((s, p) => s + p.amount, 0);
    const ym = S.today.slice(0, 7);
    const month = all.filter(p => new Date(p.at + 19800000).toISOString().slice(0, 7) === ym).reduce((s, p) => s + p.amount, 0);
    const online = all.filter(p => p.gatewayPaymentId).reduce((s, p) => s + p.amount, 0);
    const out = S.bookings.filter(b => ['confirmed', 'planning'].includes(b.status)).reduce((s, b) => s + K.balanceDue(b), 0);
    $('payKpis').innerHTML = [['Total collected', U.inr(sum), `${all.length} transactions`], ['This month', U.inr(month), ''], ['Online (Razorpay)', U.inr(online), ''], ['Balance receivable', U.inr(out), '']]
      .map(k => `<div class="kpi"><div class="l">${k[0]}</div><div class="v">${k[1]}</div><div class="s">${k[2]}</div></div>`).join('');
    $('pTable').innerHTML = `<thead><tr><th>Date</th><th>Receipt</th><th>Booking</th><th>Client</th><th>Type</th><th>Method</th><th>Reference</th><th class="r">Amount</th></tr></thead>
      <tbody>${all.map(p => `<tr><td style="white-space:nowrap">${U.fmtDateTime(p.at)}</td>
        <td><a href="${K.docUrl('receipt', p.b, p.id)}" target="_blank" style="color:var(--gold-deep)">${U.esc(p.receiptNo)}</a></td>
        <td class="id" data-open="${p.b.id}" style="cursor:pointer">${p.b.id}</td><td>${U.esc(p.b.customer.name)}</td>
        <td>${p.type === 'balance' ? 'Balance' : 'Advance'}</td><td>${U.esc(p.method)}</td><td class="sub">${U.esc(p.ref || '—')}</td><td class="r">${U.inr(p.amount)}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No payments yet.</td></tr>'}</tbody>`;
  }

  /* ------------------------------------------------ outbox */
  function rOutbox() {
    const tone = { sent: 'green', failed: 'red', sending: 'amber', not_configured: 'neutral' };
    $('outbox').innerHTML = S.emails.map(m => `<div class="mail">
      <div class="top"><span>To ${U.esc(m.to)} · <span data-open="${m.bookingId}" style="cursor:pointer;text-decoration:underline">${m.bookingId}</span><span class="pill st ${tone[m.status] || 'neutral'}">${emailStatus(m)}</span></span><span>${U.fmtDateTime(m.at)}</span></div>
      <div class="subj">${U.esc(m.subject)}</div><p style="white-space:pre-line">${U.esc(m.body)}</p>
      ${m.error ? `<p style="color:var(--red)">${U.esc(m.error)}</p>` : ''}
      ${(m.attachments || []).map(a => { const b = S.bookings.find(x => x.id === m.bookingId); return b ? `<a href="${K.docUrl(a.type, b, a.paymentId)}" target="_blank">📎 ${a.type} (PDF)</a> ` : ''; }).join('')}
    </div>`).join('') || '<div class="empty card">No emails yet.</div>';
  }

  /* ------------------------------------------------ catalog editor */
  let CAT = null;
  const CAT_COLS = {
    venues: [['name', 'Name', 'text'], ['region', 'Region', 'text'], ['capacity', 'Capacity', 'number'], ['perDay', '₹ / day', 'number'], ['blurb', 'Short description', 'text']],
    packages: [['name', 'Name', 'text'], ['perGuest', '₹ / guest / day', 'number'], ['desc', 'What’s included', 'text']],
    addons: [['name', 'Name', 'text'], ['price', 'Price ₹', 'number'], ['unit', 'Charged', 'unit']]
  };
  function rCatalog() {
    if (!CAT) CAT = JSON.parse(JSON.stringify(S.catalog));
    [['venues', 'catVenues'], ['packages', 'catPackages'], ['addons', 'catAddons']].forEach(([k, el]) => {
      const cols = CAT_COLS[k];
      $(el).innerHTML = `<thead><tr>${cols.map(c => `<th>${c[1]}</th>`).join('')}<th>Live</th><th></th></tr></thead><tbody>${CAT[k].map((row, i) => `<tr data-k="${k}" data-i="${i}">
        ${cols.map(([f, , t]) => `<td>${t === 'unit' ? `<select data-f="${f}"><option value="flat" ${row[f] !== 'perGuest' ? 'selected' : ''}>Flat</option><option value="perGuest" ${row[f] === 'perGuest' ? 'selected' : ''}>Per guest</option></select>`
          : `<input data-f="${f}" type="${t}" value="${U.esc(row[f] == null ? '' : row[f])}" ${f === 'blurb' || f === 'desc' ? 'style="min-width:220px"' : ''}>`}</td>`).join('')}
        <td style="text-align:center"><input type="checkbox" data-f="active" ${row.active !== false ? 'checked' : ''} style="width:auto;accent-color:var(--ink)"></td>
        <td><button class="x" data-del="${i}" aria-label="Remove">×</button></td></tr>`).join('')}</tbody>`;
    });
  }
  $('t-catalog').addEventListener('input', e => {
    const tr = e.target.closest('tr[data-k]'); if (!tr) return;
    const f = e.target.dataset.f; const row = CAT[tr.dataset.k][+tr.dataset.i];
    row[f] = f === 'active' ? e.target.checked : (e.target.type === 'number' ? +e.target.value : e.target.value);
  });
  $('t-catalog').addEventListener('click', e => {
    const del = e.target.closest('[data-del]'); const add = e.target.closest('[data-add]');
    if (del) { const tr = del.closest('tr[data-k]'); CAT[tr.dataset.k].splice(+del.dataset.del, 1); rCatalog(); }
    if (add) { const k = add.dataset.add; CAT[k].push(k === 'venues' ? { name: '', region: '', capacity: 100, perDay: 0, blurb: '', active: true } : k === 'packages' ? { name: '', perGuest: 0, desc: '', active: true } : { name: '', price: 0, unit: 'flat', active: true }); rCatalog(); }
  });
  $('catSave').onclick = () => act(() => K.api('PUT', '/api/admin/catalog', CAT), 'Venues & pricing saved').then(() => { CAT = null; fillVenueSelects(); rCatalog(); }).catch(() => {});

  /* ------------------------------------------------ settings */
  function rSettings() {
    const s = S.settings, c = s.company, y = S.system;
    const row = (ok, label, detail) => `<div><span class="${ok ? 'ok-dot' : 'warn-dot'}"></span><b>${label}</b> <span class="muted">${U.esc(detail)}</span></div>`;
    $('sysStatus').innerHTML = `<h3 style="margin-bottom:12px">System status</h3><div class="sys">
      ${row(y.payments === 'live', 'Payments', { live: 'Razorpay live', test: 'Razorpay TEST mode (no real money)', mock: 'Development simulator', off: 'Not configured — add RAZORPAY_KEY_ID / SECRET' }[y.payments])}
      ${row(y.webhook, 'Payment webhook', y.webhook ? 'Configured' : 'Not set — add RAZORPAY_WEBHOOK_SECRET')}
      ${row(y.email, 'Email', y.email ? 'Configured' : 'Not configured — add SMTP or Resend settings')}
      ${row(!!y.siteUrl, 'Site URL', y.siteUrl || 'Not set — add SITE_URL')}
      </div>${y.email ? '<button class="btn sm" id="testMail" style="margin-top:14px">Send me a test email</button>' : ''}
      <p class="muted" style="font-size:12px;margin-top:12px">Payment keys, email passwords and the site URL are kept in the server's <b>.env</b> file for security — they can't be edited from the browser.</p>`;
    const tm = $('testMail'); if (tm) tm.onclick = () => act(() => K.api('POST', '/api/admin/test-email', {}), `Test email sent to ${y.admin}`).catch(() => {});
    $('s_adv').value = s.advancePct; $('s_gst').value = s.gstPct; $('s_hold').value = s.holdHours; $('s_room').value = s.roomRate; $('s_maxd').value = s.maxDays; $('s_bal').value = s.balanceDueDaysBefore;
    $('s_cname').value = c.name || ''; $('s_legal').value = c.legalName || ''; $('s_gstin').value = c.gstin || ''; $('s_state').value = c.state || '';
    $('s_cemail').value = c.email || ''; $('s_cphone').value = c.phone || ''; $('s_caddr').value = c.address || '';
    $('s_terms').value = (s.terms || []).join('\n');
  }
  $('s_save').onclick = () => act(() => K.api('PUT', '/api/admin/settings', {
    advancePct: +$('s_adv').value, gstPct: +$('s_gst').value, holdHours: +$('s_hold').value, roomRate: +$('s_room').value, maxDays: +$('s_maxd').value, balanceDueDaysBefore: +$('s_bal').value,
    company: { name: $('s_cname').value, legalName: $('s_legal').value, gstin: $('s_gstin').value.toUpperCase(), state: $('s_state').value, email: $('s_cemail').value, phone: $('s_cphone').value, address: $('s_caddr').value },
    terms: $('s_terms').value.split('\n').map(t => t.trim()).filter(Boolean)
  }), 'Settings saved').then(fillVenueSelects).catch(() => {});
  $('pw_save').onclick = () => act(() => K.api('POST', '/api/admin/password', { current: $('pw_cur').value, next: $('pw_new').value }), 'Password changed').then(() => { $('pw_cur').value = $('pw_new').value = ''; }).catch(() => {});

  /* ------------------------------------------------ boot */
  async function boot() {
    try { await reload(); }
    catch (e) { if (e.status === 401) return showLogin(); $('login').style.display = 'flex'; $('pwErr').textContent = e.message; return; }
    $('login').style.display = 'none'; $('app').style.display = 'grid';
    fillVenueSelects(); resetQuote();
    const h = location.hash.slice(1);
    go(TABS.includes(h) ? h : 'overview');
  }
  $('login').style.display = 'none';
  boot();
  setInterval(() => { if (S && document.visibilityState === 'visible' && !$('drawer').classList.contains('open') && tab !== 'quote' && tab !== 'catalog' && tab !== 'settings') reload().then(render).catch(() => {}); }, 60000);
})();
