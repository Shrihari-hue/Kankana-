'use strict';
/* Business logic: bookings, quotations, payments, status, automated emails. */
const crypto = require('node:crypto');
const P = require('../../assets/kankana-pricing.js');
const pdf = require('./pdf');
const mailer = require('./mailer');
const rzp = require('./razorpay');

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = m => new HttpError(400, m);

function createService(store, opts) {
  const siteUrl = () => (process.env.SITE_URL || opts.defaultUrl).replace(/\/$/, '');
  // Optional listeners (the CRM): onPayment(booking, payment, actor), onStatus(booking, status, actor). Never allowed to break a booking.
  const hooks = opts.hooks || {};
  const fire = (name, ...a) => { try { if (hooks[name]) hooks[name](...a); } catch (e) { console.error(`[hook ${name}]`, e.message); } };
  const inr = P.inr;

  /* ---------------- validation ---------------- */
  const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$/;
  const clean = (s, n = 200) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);

  function validate(input, { admin = false, ignoreId = null, requireFree = true } = {}) {
    const cat = admin ? store.catalog() : store.activeCatalog();
    const s = store.settings();
    const c = input.customer || {};
    const customer = { name: clean(c.name, 120), email: clean(c.email, 200).toLowerCase(), phone: clean(c.phone, 30), city: clean(c.city, 80), state: clean(c.state, 60), gstin: clean(c.gstin, 20).toUpperCase() };
    if (!customer.name) throw bad('Please enter your name.');
    if (!EMAIL_RE.test(customer.email)) throw bad('Please enter a valid email address.');
    if (!/^[+0-9 ()-]{8,20}$/.test(customer.phone)) throw bad('Please enter a valid phone number.');
    const kind = P.kindOf(input);
    const startDate = String(input.startDate || '');
    if (!P.isISODate(startDate)) throw bad('Please choose your dates.');
    if (startDate < P.todayIST()) throw bad('Please choose a future date.');
    const int = (v, lo, hi) => Math.round(+v) >= lo && Math.round(+v) <= hi ? Math.round(+v) : NaN;
    const common = {
      customer, kind, startDate, notes: clean(input.notes, 1000),
      customLines: admin ? (input.customLines || []).slice(0, 30).map(l => ({ desc: clean(l.desc, 200), qty: Math.round(+l.qty) || 0, rate: Math.round(+l.rate) || 0, unit: clean(l.unit || 'lot', 20) })).filter(l => l.desc && l.qty > 0 && l.rate > 0) : [],
      discount: admin ? Math.max(0, Math.round(+input.discount || 0)) : 0
    };
    let sel;
    if (kind === 'event') {
      const venue = cat.venues.find(v => v.id === input.venueId);
      if (!venue) throw bad('Please choose a venue.');
      const pkg = cat.packages.find(p => p.id === input.packageId);
      if (!pkg) throw bad('Please choose a package.');
      const days = int(input.days, 1, s.maxDays || 5);
      if (!days) throw bad(`Celebrations can be 1–${s.maxDays || 5} days.`);
      const guests = int(input.guests, 1, 5000);
      if (!guests) throw bad('Please enter the number of guests.');
      if (!admin && guests > venue.capacity) throw bad(`${venue.name} hosts up to ${venue.capacity} guests.`);
      const accommodation = (Array.isArray(input.accommodation) ? input.accommodation : [])
        .map(a => { const st = (cat.stays || []).find(x => x.id === a.id); const n = st ? Math.max(0, Math.min(st.units, Math.round(+a.units || 0))) : 0; return st && n ? { id: st.id, name: st.name, unitWord: st.unitWord || 'unit', units: n } : null; })
        .filter(Boolean);
      const addons = [...new Set((input.addons || []).filter(id => cat.addons.some(a => a.id === id)))];
      const rooms = admin ? Math.max(0, Math.min(1000, Math.round(+input.rooms || 0))) : 0;
      sel = Object.assign(common, { venueId: venue.id, venueName: venue.name, packageId: pkg.id, packageName: pkg.name, days, guests, addons, accommodation, rooms });
    } else if (kind === 'stay') {
      const st = (cat.stays || []).find(x => x.id === input.venueId);
      if (!st) throw bad('Please choose a villa or room.');
      const days = int(input.days, 1, s.maxNights || 14);
      if (!days) throw bad(`Stays can be 1–${s.maxNights || 14} nights.`);
      const units = int(input.units, 1, st.units);
      if (!units) throw bad(`Choose 1–${st.units} ${st.unitWord || 'unit'}s.`);
      const guests = int(input.guests, 1, units * (st.sleeps || 2));
      if (!guests) throw bad(`${units} ${st.unitWord || 'unit'}${units > 1 ? 's sleep' : ' sleeps'} up to ${units * (st.sleeps || 2)} guests.`);
      sel = Object.assign(common, { venueId: st.id, venueName: st.name, unitWord: st.unitWord || 'unit', days, units, guests, addons: [], accommodation: [] });
    } else {
      const sl = (cat.slots || []).find(x => x.id === input.venueId);
      if (!sl) throw bad('Please choose what you would like to book.');
      const guests = int(input.guests, 1, sl.maxGuests || 50);
      if (!guests) throw bad(`${sl.name}: up to ${sl.maxGuests} ${sl.per === 'guest' ? 'guests per table' : 'players'}.`);
      const startHour = int(input.startHour, 0, 23);
      if (Number.isNaN(startHour)) throw bad('Please choose a time.');
      const hours = sl.per === 'guest' ? P.slotHours(sl, {}) : int(input.hours, 1, sl.maxHours || 3);
      if (!hours) throw bad(`${sl.name} can be booked for 1–${sl.maxHours} hours.`);
      const units = sl.per === 'guest' ? 1 : 1;
      sel = Object.assign(common, { venueId: sl.id, venueName: sl.name, per: sl.per, days: 1, guests, startHour, hours, units, addons: [], accommodation: [] });
      sel.usage = P.slotUsage(sl, sel);
    }
    if (requireFree) { const why = store.checkFree(sel, ignoreId); if (why) throw new HttpError(409, why); }
    sel.quote = P.buildQuote(sel, store.catalog(), s);
    return sel;
  }
  /** How long an unpaid quotation keeps its dates/slot. */
  function holdMs(b) {
    const s = store.settings(), k = P.kindOf(b);
    return k === 'slot' ? (s.slotHoldMinutes || 30) * 60000 : k === 'stay' ? (s.stayHoldHours || 24) * 3600000 : (s.holdHours || 72) * 3600000;
  }

  /* ---------------- bookings ---------------- */
  function createBooking(input, { source = 'website', status = 'quoted', actor = null, silent = false } = {}) {
    const b = store.tx(() => {
      const sel = validate(input, { admin: source === 'admin', requireFree: status !== 'enquiry' });
      const s = store.settings();
      const n = store.next('booking', 1000);
      const booking = Object.assign(sel, {
        id: 'KNK-' + n, createdAt: Date.now(), source, status,
        holdUntil: status === 'quoted' ? Date.now() + holdMs(sel) : null,
        quoteNo: store.docNo('quote', 'KNK/Q'), invoiceNo: null
      });
      store.insertBooking(booking, crypto.randomBytes(18).toString('base64url'));
      store.addHistory(booking.id, status, source === 'admin' ? (status === 'enquiry' ? 'Enquiry logged by Kankana team' : 'Quotation created by Kankana team') : 'Booking request & quotation generated online', actor);
      return store.getBooking(booking.id, { withKey: true });
    });
    if (!silent) notify(b, 'quotation', null, { bccAdmin: source === 'website' });
    return b;
  }

  function updateBooking(id, input, actor) {
    const b = store.tx(() => {
      const cur = store.getBooking(id, { withKey: true });
      if (!cur) throw new HttpError(404, 'Booking not found');
      const blocking = ['quoted', 'confirmed', 'planning', 'paid', 'completed'].includes(cur.status);
      const sel = validate(input, { admin: true, ignoreId: cur.id, requireFree: blocking });
      Object.assign(cur, sel);
      if (cur.status === 'quoted') cur.holdUntil = Date.now() + holdMs(cur);
      store.saveBooking(cur);
      store.addHistory(cur.id, cur.status, `Quotation revised — new total ${inr(cur.quote.total)}`, actor);
      return store.getBooking(cur.id, { withKey: true });
    });
    notify(b, 'quotation', null, { revised: true });
    return b;
  }

  function setStatus(id, status, note, actor, { email = true } = {}) {
    if (!P.STATUSES[status]) throw bad('Unknown status');
    const b = store.tx(() => {
      const cur = store.getBooking(id, { withKey: true });
      if (!cur) throw new HttpError(404, 'Booking not found');
      const willBlock = P.STATUSES[status].blocks;
      const wasBlocking = P.STATUSES[cur.status].blocks === 'booked';
      if (willBlock && !wasBlocking && store.checkFree(cur, cur.id))
        throw new HttpError(409, 'Those dates now clash with another booking or blocked date. Change the dates first.');
      cur.status = status;
      if (status === 'quoted') cur.holdUntil = Date.now() + holdMs(cur);
      store.saveBooking(cur);
      store.addHistory(cur.id, status, clean(note, 500) || `Status changed to ${P.STATUSES[status].label}`, actor);
      return store.getBooking(cur.id, { withKey: true });
    });
    if (email) notify(b, 'status', null, { note: clean(note, 500) });
    fire('onStatus', b, status, actor);
    return b;
  }

  /** Records a payment (idempotent on gatewayPaymentId) and advances status. */
  function recordPayment(id, p, actor) {
    const out = store.tx(() => {
      if (p.gatewayPaymentId) {
        const ex = store.paymentByGatewayId(p.gatewayPaymentId);
        if (ex) return { booking: store.getBooking(ex.booking_id, { withKey: true }), payment: null, duplicate: true };
      }
      const b = store.getBooking(id, { withKey: true });
      if (!b) throw new HttpError(404, 'Booking not found');
      const amount = Math.round(+p.amount);
      if (!(amount > 0)) throw bad('Enter a valid amount');
      const paidBefore = b.payments.reduce((s, x) => s + x.amount, 0);
      const pay = {
        id: 'PAY-' + crypto.randomBytes(6).toString('hex').toUpperCase(), bookingId: b.id, at: Date.now(), amount,
        method: clean(p.method, 60) || 'Online', ref: clean(p.ref, 100), type: paidBefore > 0 ? 'balance' : 'advance',
        receiptNo: store.docNo('receipt', 'KNK/R'), gatewayPaymentId: p.gatewayPaymentId || null, gatewayOrderId: p.gatewayOrderId || null, recordedBy: actor || 'gateway'
      };
      store.insertPayment(pay);
      if (!b.invoiceNo) b.invoiceNo = store.docNo('invoice', 'KNK/INV');
      const paid = paidBefore + amount;
      let st = b.status;
      if (paid >= b.quote.total) st = 'paid';
      else if (['enquiry', 'quoted', 'cancelled'].includes(st)) st = 'confirmed';
      b.status = st; b.holdUntil = null;
      store.saveBooking(b);
      store.addHistory(b.id, st, `${pay.type === 'balance' ? 'Balance' : 'Advance'} payment of ${inr(amount)} received (${pay.method}${pay.ref ? ' · ' + pay.ref : ''})`, actor);
      const fresh = store.getBooking(b.id, { withKey: true });
      return { booking: fresh, payment: fresh.payments.find(x => x.id === pay.id) };
    });
    if (out.payment) { notify(out.booking, 'receipt', out.payment, { bccAdmin: true }); fire('onPayment', out.booking, out.payment, actor); }
    return out;
  }

  /* ---------------- online payments ---------------- */
  function paymentKind(b) {
    const paid = b.payments.reduce((s, x) => s + x.amount, 0);
    if (b.status === 'cancelled' || b.status === 'completed') return null;
    if (['enquiry', 'quoted'].includes(b.status) && paid === 0) return { type: 'advance', amount: b.quote.advance };
    const due = b.quote.total - paid;
    return due > 0 ? { type: 'balance', amount: due } : null;
  }

  async function createOrder(b) {
    const k = paymentKind(b);
    if (!k) throw bad('Nothing is due on this booking right now.');
    if (k.type === 'advance' && store.checkFree(b, b.id))
      throw new HttpError(409, P.kindOf(b) === 'slot' ? 'Sorry — your reservation hold expired and that time has since been booked. Please choose another time.' : 'Sorry — your hold expired and these dates have since been booked. Please contact us to choose new dates.');
    const order = await rzp.createOrder({ amountPaise: k.amount * 100, receipt: `${b.id}-${k.type}`, notes: { booking_id: b.id, type: k.type } });
    store.insertOrder({ id: order.id, bookingId: b.id, amount: k.amount, type: k.type });
    return { orderId: order.id, amount: k.amount, amountPaise: k.amount * 100, type: k.type, mode: rzp.mode(), keyId: rzp.keys() ? rzp.keys().id : null };
  }

  async function completeOnlinePayment(orderId, paymentId, signature) {
    const order = store.getOrder(orderId);
    if (!order) throw bad('Unknown order');
    if (!rzp.verifyPayment(orderId, paymentId, signature)) throw new HttpError(400, 'Payment verification failed. If money was deducted, it will be reconciled automatically — please contact us.');
    let method = 'Razorpay';
    try { const pay = await rzp.fetchPayment(paymentId); if (pay && pay.method) method = `Razorpay · ${String(pay.method).toUpperCase()}`; } catch (_) {}
    if (String(orderId).startsWith('order_mock_')) method = 'Test payment';
    const r = recordPayment(order.booking_id, { amount: order.amount, method, ref: paymentId, gatewayPaymentId: paymentId, gatewayOrderId: orderId }, 'customer');
    store.setOrderStatus(orderId, 'paid');
    return r.booking;
  }

  /** Webhook fallback — if the customer closed the tab before verification. */
  function handleWebhook(evt) {
    const type = evt && evt.event;
    if (!['payment.captured', 'order.paid'].includes(type)) return { ignored: true };
    const pay = evt.payload && evt.payload.payment && evt.payload.payment.entity;
    if (!pay || !pay.order_id) return { ignored: true };
    const order = store.getOrder(pay.order_id);
    if (!order) return { ignored: true };
    if (Math.round(pay.amount / 100) !== order.amount) return { ignored: true, reason: 'amount mismatch' };
    const r = recordPayment(order.booking_id, { amount: order.amount, method: `Razorpay · ${String(pay.method || '').toUpperCase()}`, ref: pay.id, gatewayPaymentId: pay.id, gatewayOrderId: pay.order_id }, 'webhook');
    store.setOrderStatus(pay.order_id, 'paid');
    return { ok: true, duplicate: !!r.duplicate };
  }

  /* ---------------- documents ---------------- */
  function docCtx(b) {
    const cat = store.catalog(); const r = P.findResource(cat, b.venueId);
    return { settings: store.settings(), venue: r ? r.item : null, pkg: cat.packages.find(p => p.id === b.packageId), siteUrl: siteUrl() };
  }
  function renderPdf(b, type, paymentId) {
    const ctx = docCtx(b);
    if (type === 'quotation') return { name: `Kankana-Quotation-${b.id}.pdf`, buf: pdf.quotation(b, ctx) };
    if (type === 'invoice') { if (!b.invoiceNo) throw new HttpError(404, 'No invoice yet'); return { name: `Kankana-Invoice-${b.id}.pdf`, buf: pdf.invoice(b, ctx) }; }
    if (type === 'receipt') {
      const p = b.payments.find(x => x.id === paymentId) || b.payments[b.payments.length - 1];
      if (!p) throw new HttpError(404, 'No payment found');
      return { name: `Kankana-Receipt-${p.receiptNo.replace(/\//g, '-')}.pdf`, buf: pdf.receipt(b, p, ctx) };
    }
    throw new HttpError(404, 'Unknown document');
  }

  /* ---------------- emails ---------------- */
  function trackUrl(b) { return `${siteUrl()}/my-booking.html?id=${encodeURIComponent(b.id)}&email=${encodeURIComponent(b.customer.email)}`; }

  function emailHtml(b, heading, paras, cta) {
    const s = store.settings(); const C = s.company;
    const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return `<!doctype html><html><body style="margin:0;background:#f6ecd8;font-family:Helvetica,Arial,sans-serif;color:#26080e">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6ecd8;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fffdf8;border:1px solid #e6d7b8">
<tr><td style="background:#26080e;padding:26px 30px;text-align:center"><div style="font-family:Georgia,serif;font-size:24px;letter-spacing:8px;color:#f6ecd8">KANKANA</div><div style="font-size:10px;letter-spacing:4px;color:#c9a35c;margin-top:6px">WEDDINGS &amp; RESORTS</div></td></tr>
<tr><td style="padding:30px">
<div style="font-family:Georgia,serif;font-size:24px;line-height:1.3;margin-bottom:14px">${esc(heading)}</div>
${paras.map(p => `<p style="font-size:15px;line-height:1.7;margin:0 0 14px;color:#3d2429">${p}</p>`).join('')}
${b ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:18px 0;border-top:1px solid #eadfca;border-bottom:1px solid #eadfca;font-size:14px">
<tr><td style="padding:10px 0;color:#8a7378">Booking</td><td style="padding:10px 0;text-align:right"><b>${esc(b.id)}</b></td></tr>
<tr><td style="padding:10px 0;color:#8a7378">${esc(P.describe(b).resourceLabel)}</td><td style="padding:10px 0;text-align:right">${esc(b.venueName || b.venueId)}</td></tr>
<tr><td style="padding:10px 0;color:#8a7378">When</td><td style="padding:10px 0;text-align:right">${esc(P.describe(b).when)}</td></tr>
<tr><td style="padding:10px 0;color:#8a7378">Guests</td><td style="padding:10px 0;text-align:right">${esc(P.describe(b).people)}</td></tr>
<tr><td style="padding:10px 0;color:#8a7378">Total</td><td style="padding:10px 0;text-align:right">${esc(inr(b.quote.total))}</td></tr>
<tr><td style="padding:10px 0;color:#8a7378">Paid</td><td style="padding:10px 0;text-align:right">${esc(inr(b.payments.reduce((s, p) => s + p.amount, 0)))}</td></tr>
</table>` : ''}
${cta ? `<div style="text-align:center;margin:26px 0 8px"><a href="${cta.url}" style="display:inline-block;background:#26080e;color:#f6ecd8;text-decoration:none;padding:14px 28px;font-size:12px;letter-spacing:3px">${esc(cta.label.toUpperCase())}</a></div>` : ''}
</td></tr>
<tr><td style="padding:18px 30px;background:#f8f1e4;font-size:12px;color:#8a7378;line-height:1.6">${esc(C.name)} · ${esc(C.address)}<br>${esc(C.email)} · ${esc(C.phone)}</td></tr>
</table></td></tr></table></body></html>`;
  }
  const fmtDate = s => P.parseISO(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const balanceDueText = b => P.kindOf(b) === 'event' ? `by ${fmtDate(P.addDays(b.startDate, -(store.settings().balanceDueDaysBefore || 30)))}` : P.kindOf(b) === 'stay' ? `at check-in (${fmtDate(b.startDate)})` : 'before your reservation';

  function compose(b, kind, payment, o = {}) {
    const name = b.customer.name.split(/\s|&/)[0] || b.customer.name;
    const url = trackUrl(b);
    if (kind === 'quotation') {
      const subject = `${o.revised ? 'Updated quotation' : 'Your Kankana quotation'} ${b.quoteNo}`;
      const paras = [`Dear ${escT(name)},`, o.revised ? 'We have updated your quotation as discussed. The revised quotation is attached.' : 'Thank you for choosing Kankana. Your quotation is attached.',
        b.status === 'quoted' ? `We are holding your ${P.kindOf(b) === 'slot' ? 'reservation' : 'dates'} until <b>${new Date(b.holdUntil).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</b>. Pay ${b.quote.advance >= b.quote.total ? 'the' : 'the ' + inr(b.quote.advance) + ' advance'}${b.quote.advance >= b.quote.total ? ' ' + inr(b.quote.total) : ''} to confirm your booking.` : 'Reply to this email if you would like any changes.'];
      return { subject, html: emailHtml(b, o.revised ? 'Your updated quotation' : 'Your quotation is ready', paras, { url, label: b.status === 'quoted' ? 'Confirm & pay advance' : 'View booking' }), text: `Dear ${name},\n\nYour Kankana quotation ${b.quoteNo} for ${b.venueName} (${P.describe(b).when}) is attached. Total: ${inr(b.quote.total)}. Advance to confirm: ${inr(b.quote.advance)}.\n\nView and pay: ${url}\n`, docs: [['quotation']] };
    }
    if (kind === 'receipt') {
      const due = Math.max(0, b.quote.total - b.payments.reduce((s, p) => s + p.amount, 0));
      const paras = [`Dear ${escT(name)},`, `We have received your payment of <b>${inr(payment.amount)}</b>. Your receipt and GST tax invoice are attached.`,
        due ? `Balance due: <b>${inr(due)}</b>, payable ${balanceDueText(b)}.` : 'Your booking is now fully paid. Thank you!'];
      if (payment.type === 'advance') paras.push(P.kindOf(b) === 'event' ? 'Your dates are confirmed. Our planning team will call you within 24 hours.' : P.kindOf(b) === 'stay' ? 'Your stay is confirmed. We look forward to welcoming you.' : `Your reservation is confirmed — ${escT(P.describe(b).when)}. See you then.`);
      return { subject: `Payment received — ${b.id} (${inr(payment.amount)})`, html: emailHtml(b, payment.type === 'advance' ? 'Your booking is confirmed' : 'Payment received', paras, { url, label: 'View booking' }), text: `Dear ${name},\n\nWe received ${inr(payment.amount)} for booking ${b.id}. Receipt and invoice attached. Balance due: ${inr(due)}.\n\n${url}\n`, docs: [['receipt', payment.id], ['invoice']] };
    }
    const st = P.STATUSES[b.status].label;
    const paras = [`Dear ${escT(name)},`, `Your booking status is now <b>${escT(st)}</b>.`].concat(o.note ? [escT(o.note)] : []);
    return { subject: `Booking ${b.id}: ${st}`, html: emailHtml(b, `Booking update: ${st}`, paras, { url, label: 'View booking' }), text: `Dear ${name},\n\nYour booking ${b.id} is now: ${st}.${o.note ? '\n\n' + o.note : ''}\n\n${url}\n`, docs: [] };
  }
  const escT = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function notify(b, kind, payment, o = {}) {
    let m;
    try { m = compose(b, kind, payment, o); } catch (e) { console.error('[email] compose failed', e); return; }
    const id = 'MSG-' + crypto.randomBytes(6).toString('hex');
    const attachMeta = m.docs.map(([type, pid]) => ({ type, paymentId: pid || null }));
    const status = mailer.configured() ? 'sending' : 'not_configured';
    store.logEmail({ id, to: b.customer.email, bookingId: b.id, subject: m.subject, body: m.text, attachments: attachMeta, status });
    if (!mailer.configured()) return;
    setImmediate(async () => {
      try {
        const attachments = m.docs.map(([type, pid]) => { const d = renderPdf(b, type, pid); return { filename: d.name, content: d.buf, type: 'application/pdf' }; });
        await mailer.send({ to: b.customer.email, bcc: o.bccAdmin ? process.env.ADMIN_NOTIFY_EMAIL : undefined, replyTo: store.settings().company.email, subject: m.subject, html: m.html, text: m.text, attachments });
        store.setEmailStatus(id, 'sent');
      } catch (e) {
        console.error('[email] send failed:', e.message);
        store.setEmailStatus(id, 'failed', e.message.slice(0, 300));
      }
    });
  }

  /**
   * A message the team (or an automation) writes from a template: plain text in, branded email out.
   * Logged in the outbox against the booking and/or the CRM lead. Resolves to { id, status }.
   */
  function sendCustom({ to, subject, text, bookingId = null, leadId = null }) {
    to = clean(to, 200).toLowerCase();
    if (!EMAIL_RE.test(to)) throw bad('This client has no valid email address.');
    subject = clean(subject, 200) || 'A message from Kankana';
    text = String(text || '').replace(/\r/g, '').slice(0, 8000).trim();
    if (!text) throw bad('The message is empty.');
    const b = bookingId ? store.getBooking(bookingId, { withKey: true }) : null;
    const link = u => `<a href="${u}" style="color:#8f6630">${u}</a>`;
    const paras = text.split(/\n{2,}/).map(p => escT(p).replace(/https?:\/\/[^\s<]+/g, link).replace(/\n/g, '<br>'));
    const html = emailHtml(b, subject, paras, b ? { url: trackUrl(b), label: 'View booking' } : null);
    const id = 'MSG-' + crypto.randomBytes(6).toString('hex');
    const status = mailer.configured() ? 'sending' : 'not_configured';
    store.logEmail({ id, to, bookingId: b ? b.id : null, leadId, subject, body: text, attachments: [], status });
    if (mailer.configured()) {
      setImmediate(async () => {
        try { await mailer.send({ to, subject, text, html, replyTo: store.settings().company.email || undefined }); store.setEmailStatus(id, 'sent'); }
        catch (e) { console.error('[email] send failed:', e.message); store.setEmailStatus(id, 'failed', e.message.slice(0, 300)); }
      });
    }
    return { id, status };
  }

  function resendEmail(bookingId, kind) {
    const b = store.getBooking(bookingId, { withKey: true });
    if (!b) throw new HttpError(404, 'Booking not found');
    if (kind === 'receipt') { const p = b.payments[b.payments.length - 1]; if (!p) throw bad('No payments yet'); notify(b, 'receipt', p); }
    else notify(b, 'quotation', null, {});
    return true;
  }

  return { HttpError, validate, createBooking, updateBooking, setStatus, recordPayment, createOrder, completeOnlinePayment, handleWebhook, renderPdf, resendEmail, paymentKind, trackUrl, sendCustom, siteUrl };
}

module.exports = { createService, HttpError };
