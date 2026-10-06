/* Kankana — pricing & date helpers shared by the browser and the server.
   The server always recomputes quotes with this same code, so what a
   customer sees in the live preview is exactly what they are charged. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KankanaPricing = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseISO = s => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parseISO(s); d.setDate(d.getDate() + n); return iso(d); };
  const isISODate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && iso(parseISO(s)) === s;
  const eventDates = (start, days) => Array.from({ length: Math.max(1, days | 0) }, (_, i) => addDays(start, i));

  /** Today's date in India (bookings are managed from India). */
  function todayIST() {
    const now = new Date(Date.now() + (5.5 * 60 + new Date().getTimezoneOffset()) * 60000);
    return iso(now);
  }

  const STATUSES = {
    enquiry:   { label: 'Enquiry',        tone: 'neutral', blocks: false },
    quoted:    { label: 'Quotation Sent', tone: 'amber',   blocks: 'hold' },
    confirmed: { label: 'Advance Paid',   tone: 'green',   blocks: 'booked' },
    planning:  { label: 'In Planning',    tone: 'blue',    blocks: 'booked' },
    paid:      { label: 'Fully Paid',     tone: 'green',   blocks: 'booked' },
    completed: { label: 'Completed',      tone: 'ink',     blocks: 'booked' },
    cancelled: { label: 'Cancelled',      tone: 'red',     blocks: false }
  };

  /**
   * Build quotation lines.
   * sel: {venueId, days, guests, packageId, addons[], rooms, customLines[], discount}
   * catalog: {venues[], packages[], addons[]}
   * settings: {gstPct, advancePct, roomRate}
   */
  function buildQuote(sel, catalog, settings) {
    const days = Math.max(1, +sel.days || 1);
    const guests = Math.max(1, +sel.guests || 1);
    const find = (list, id) => (list || []).find(x => x.id === id);
    const lines = [];
    const v = find(catalog.venues, sel.venueId);
    if (v) lines.push({ desc: `Venue — ${v.name}`, qty: days, unit: 'day', rate: +v.perDay });
    const p = find(catalog.packages, sel.packageId);
    if (p) lines.push({ desc: `${p.name} hospitality package (${String(p.desc || '').toLowerCase()})`.replace(' ()', ''), qty: guests * days, unit: 'guest-day', rate: +p.perGuest });
    (sel.addons || []).forEach(id => {
      const a = find(catalog.addons, id); if (!a) return;
      lines.push(a.unit === 'perGuest'
        ? { desc: a.name, qty: guests, unit: 'guest', rate: +a.price }
        : { desc: a.name, qty: 1, unit: 'lot', rate: +a.price });
    });
    const rooms = Math.max(0, +sel.rooms || 0);
    if (rooms && +settings.roomRate) lines.push({ desc: 'Guest stays', qty: rooms * days, unit: 'room-night', rate: +settings.roomRate });
    (sel.customLines || []).forEach(l => {
      if (l && String(l.desc || '').trim() && +l.qty > 0 && +l.rate > 0)
        lines.push({ desc: String(l.desc).trim().slice(0, 200), qty: Math.round(+l.qty), unit: String(l.unit || 'lot').slice(0, 20), rate: Math.round(+l.rate), custom: true });
    });
    lines.forEach(l => { l.amount = Math.round(l.qty * l.rate); });
    const gross = lines.reduce((s, l) => s + l.amount, 0);
    const discount = Math.min(gross, Math.max(0, Math.round(+sel.discount || 0)));
    const subtotal = gross - discount;
    const gstPct = +settings.gstPct || 0;
    const gst = Math.round(subtotal * gstPct / 100);
    const total = subtotal + gst;
    const advancePct = +settings.advancePct || 30;
    const advance = Math.round(total * advancePct / 100);
    return { lines, gross, discount, subtotal, gstPct, gst, total, advancePct, advance };
  }

  const inr = n => '₹' + Math.round(n || 0).toLocaleString('en-IN');

  return { pad, iso, parseISO, addDays, isISODate, eventDates, todayIST, STATUSES, buildQuote, inr };
});
