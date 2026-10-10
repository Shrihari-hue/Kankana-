/* =========================================================================
   KANKANA — browser client for the booking server.
   Used by book.html, my-booking.html and admin.html.
   Requires assets/kankana-pricing.js to be loaded first.
   ========================================================================= */
(function (global) {
  'use strict';
  const P = global.KankanaPricing;

  /* ---------------------------------------------------------------- API */
  async function api(method, url, body) {
    const opts = { method, headers: { 'X-Kankana': '1' }, credentials: 'same-origin' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(url, opts); }
    catch (e) { throw Object.assign(new Error('Network error — please check your connection and try again.'), { status: 0 }); }
    let data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON */ }
    if (!res.ok) throw Object.assign(new Error((data && data.error) || `Request failed (${res.status})`), { status: res.status });
    return data;
  }

  /* ---------------------------------------------------------------- formatting */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = s => s ? P.parseISO(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const fmtDateTime = t => new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const range = b => P.describe(b).whenShort;
  const paidAmount = b => (b.payments || []).reduce((s, p) => s + p.amount, 0);
  const balanceDue = b => Math.max(0, (b.quote ? b.quote.total : 0) - paidAmount(b));

  function docUrl(type, b, paymentId, key) {
    const k = key || b.key || b.accessKey;
    const q = new URLSearchParams();
    if (k) q.set('key', k);
    if (paymentId) q.set('pay', paymentId);
    const qs = q.toString();
    return `/api/docs/${encodeURIComponent(b.id)}/${type}.pdf${qs ? '?' + qs : ''}`;
  }

  function toast(msg, ms) {
    let t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'k-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms || 3600);
  }

  /* ---------------------------------------------------------------- PAYMENTS */
  let rzpLoading = null;
  function loadRazorpay() {
    if (global.Razorpay) return Promise.resolve();
    if (rzpLoading) return rzpLoading;
    rzpLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js'; s.async = true;
      s.onload = resolve; s.onerror = () => { rzpLoading = null; reject(new Error('Could not load the payment window. Please check your connection.')); };
      document.head.appendChild(s);
    });
    return rzpLoading;
  }

  /**
   * Full payment flow for whatever is due on a booking (advance or balance).
   * Creates a server-side order, opens checkout, verifies the signature on the
   * server. Resolves with the updated booking; rejects with 'dismissed' if closed.
   */
  async function pay(booking) {
    const order = await api('POST', `/api/bookings/${encodeURIComponent(booking.id)}/order`, { key: booking.key });
    let result;
    if (order.mode === 'mock') result = await mockCheckout(order);
    else {
      await loadRazorpay();
      result = await new Promise((resolve, reject) => {
        const rz = new global.Razorpay({
          key: order.keyId, order_id: order.orderId, amount: order.amountPaise, currency: 'INR',
          name: 'Kankana', description: `${order.type === 'balance' ? 'Balance' : 'Advance'} payment — ${order.bookingId}`,
          prefill: order.prefill, notes: { booking_id: order.bookingId }, theme: { color: '#b8894a' },
          handler: r => resolve({ orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature }),
          modal: { ondismiss: () => reject(new Error('dismissed')), confirm_close: true }
        });
        rz.on('payment.failed', r => reject(new Error((r.error && r.error.description) || 'Payment failed')));
        rz.open();
      });
    }
    const v = await api('POST', '/api/payments/verify', result);
    return v.booking;
  }

  /* Local development only (PAYMENTS_MODE=mock): simulated checkout. */
  function mockCheckout(order) {
    return new Promise((resolve, reject) => {
      const wrap = document.createElement('div');
      wrap.className = 'k-pay-overlay';
      wrap.innerHTML = `
        <div class="k-pay" role="dialog" aria-modal="true" aria-label="Test payment">
          <div class="k-pay-head"><div><div class="k-pay-brand">Kankana</div><div class="k-pay-sub">${order.type === 'balance' ? 'Balance' : 'Advance'} · ${esc(order.bookingId)}</div></div>
            <div class="k-pay-amt">${P.inr(order.amount)}</div></div>
          <div class="k-pay-test">Development test mode — no money is charged. Add Razorpay keys on the server to take real payments.</div>
          <div class="k-pay-body"><label>UPI ID<input value="success@razorpay" autocomplete="off"></label></div>
          <button type="button" class="k-pay-go">Pay ${P.inr(order.amount)}</button>
          <button type="button" class="k-pay-cancel">Cancel</button>
          <div class="k-pay-secure">Simulated checkout</div>
        </div>`;
      document.body.appendChild(wrap);
      const close = () => wrap.remove();
      wrap.querySelector('.k-pay-cancel').onclick = () => { close(); reject(new Error('dismissed')); };
      wrap.querySelector('.k-pay-go').onclick = async (e) => {
        e.currentTarget.disabled = true; e.currentTarget.textContent = 'Processing…';
        try { const r = await api('POST', '/api/payments/mock-complete', { orderId: order.orderId }); close(); resolve(r); }
        catch (err) { close(); reject(err); }
      };
    });
  }

  /* ---------------------------------------------------------------- CALENDAR */
  /**
   * opts: { month:Date, today:'YYYY-MM-DD', occ:{date:state|{state,bookingId}}, selStart, selDays,
   *         mode:'customer'|'admin', multi:{venueId:occMap}, venueNames:{}, onPick(date, info), onMonth(m) }
   */
  function renderCalendar(el, opts) {
    const m = new Date(opts.month.getFullYear(), opts.month.getMonth(), 1);
    const first = (m.getDay() + 6) % 7;
    const dim = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
    const sel = opts.selStart ? P.eventDates(opts.selStart, opts.selDays || 1) : [];
    const t = opts.today || P.todayIST();
    const stateOf = v => v ? (typeof v === 'string' ? v : v.state) : null;
    const minMonth = new Date(P.parseISO(t).getFullYear(), P.parseISO(t).getMonth(), 1);
    let html = `<div class="k-cal-head">
      <button type="button" class="k-cal-nav" data-nav="-1" aria-label="Previous month" ${opts.mode === 'customer' && m <= minMonth ? 'disabled' : ''}>‹</button>
      <div class="k-cal-title">${m.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</div>
      <button type="button" class="k-cal-nav" data-nav="1" aria-label="Next month">›</button></div>
      <div class="k-cal-grid">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div class="k-cal-dow">${d}</div>`).join('')}`;
    for (let i = 0; i < first; i++) html += '<div class="k-cal-day empty"></div>';
    for (let d = 1; d <= dim; d++) {
      const ds = P.iso(new Date(m.getFullYear(), m.getMonth(), d));
      const past = ds < t;
      const cls = ['k-cal-day']; let dots = '', st = null;
      if (opts.multi) {
        const hits = Object.entries(opts.multi).map(([vid, occ]) => occ[ds] ? { vid, s: stateOf(occ[ds]) } : null).filter(Boolean);
        dots = hits.map(h => `<i class="dot ${h.s}" title="${esc((opts.venueNames || {})[h.vid] || h.vid)} — ${h.s}"></i>`).join('');
        if (hits.length) cls.push('has');
      } else { st = stateOf(opts.occ[ds]); if (st) cls.push(st); }
      if (past) cls.push('past');
      if (ds === t) cls.push('today');
      if (sel.includes(ds)) cls.push('sel');
      const disabled = opts.mode === 'customer' && (past || st);
      const label = `${P.parseISO(ds).toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })}${st ? ' — ' + ({ booked: 'booked', hold: 'on hold', blocked: 'unavailable' }[st]) : past ? '' : ' — available'}`;
      const badge = opts.badges && opts.badges[ds] != null && !past ? `<small class="k-cal-badge">${esc(opts.badges[ds])}</small>` : '';
      html += `<button type="button" class="${cls.join(' ')}" data-date="${ds}" ${disabled ? 'disabled' : ''} aria-label="${label}${badge ? ' · ' + esc(opts.badges[ds]) : ''}"><span>${d}</span>${dots ? `<em>${dots}</em>` : ''}${badge}</button>`;
    }
    el.innerHTML = html + '</div>';
    el.querySelectorAll('.k-cal-nav').forEach(b => b.onclick = () => {
      opts.month = new Date(m.getFullYear(), m.getMonth() + (+b.dataset.nav), 1);
      renderCalendar(el, opts); opts.onMonth && opts.onMonth(opts.month);
    });
    el.querySelectorAll('.k-cal-day[data-date]').forEach(b => b.onclick = () => {
      const ds = b.dataset.date;
      const info = opts.multi
        ? Object.entries(opts.multi).map(([vid, occ]) => occ[ds] ? Object.assign({ venueId: vid }, typeof occ[ds] === 'string' ? { state: occ[ds] } : occ[ds]) : null).filter(Boolean)
        : opts.occ[ds] || null;
      opts.onPick && opts.onPick(ds, info);
    });
  }

  function rangeFree(occ, start, days, today) {
    if (!start || start < (today || P.todayIST())) return false;
    return P.eventDates(start, days).every(d => !occ[d]);
  }

  global.Kankana = {
    api, pay, docUrl, toast, renderCalendar, rangeFree,
    STATUSES: P.STATUSES, buildQuote: P.buildQuote, paidAmount, balanceDue,
    util: { esc, fmtDate, fmtDateTime, range, inr: P.inr, iso: P.iso, parseISO: P.parseISO, addDays: P.addDays, eventDates: P.eventDates,
      describe: P.describe, kindOf: P.kindOf, fmtHour: P.fmtHour, findResource: P.findResource, lastDate: P.lastDate, occupiedDates: P.occupiedDates, slotUsage: P.slotUsage, slotHours: P.slotHours }
  };
})(window);
