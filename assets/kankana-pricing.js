/* Kankana — pricing & date helpers shared by the browser and the server.
   The server always recomputes quotes with this same code, so what a
   customer sees in the live preview is exactly what they are charged.

   Three kinds of booking share one engine:
     event — a venue or hall booked by the day (celebrations)
     stay  — villas / rooms booked by the night, several units of each
     slot  — turf, pickleball court or café table, booked by the hour */
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

  /** Now in India (bookings are managed from India). */
  function nowIST() { return new Date(Date.now() + (5.5 * 60 + new Date().getTimezoneOffset()) * 60000); }
  function todayIST() { return iso(nowIST()); }
  function hourIST() { return nowIST().getHours(); }

  const STATUSES = {
    enquiry:   { label: 'Enquiry',        tone: 'neutral', blocks: false },
    quoted:    { label: 'Quotation Sent', tone: 'amber',   blocks: 'hold' },
    confirmed: { label: 'Advance Paid',   tone: 'green',   blocks: 'booked' },
    planning:  { label: 'In Planning',    tone: 'blue',    blocks: 'booked' },
    paid:      { label: 'Fully Paid',     tone: 'green',   blocks: 'booked' },
    completed: { label: 'Completed',      tone: 'ink',     blocks: 'booked' },
    cancelled: { label: 'Cancelled',      tone: 'red',     blocks: false }
  };

  const KINDS = {
    event: { label: 'Celebration', resource: 'Venue' },
    stay:  { label: 'Stay',        resource: 'Stay' },
    slot:  { label: 'Reservation', resource: 'Reservation' }
  };
  const kindOf = b => (b && (b.kind === 'stay' || b.kind === 'slot')) ? b.kind : 'event';
  const listFor = (catalog, kind) => (kind === 'stay' ? catalog.stays : kind === 'slot' ? catalog.slots : catalog.venues) || [];

  /** Finds any bookable resource by id: { kind, item } or null. */
  function findResource(catalog, id) {
    for (const kind of ['event', 'stay', 'slot']) {
      const item = listFor(catalog, kind).find(x => x.id === id);
      if (item) return { kind, item };
    }
    return null;
  }

  /** How many seats/units one slot booking takes: café counts guests, courts count 1 each. */
  const slotUsage = (item, sel) => item && item.per === 'guest' ? Math.max(1, +sel.guests || 1) : Math.max(1, +sel.units || 1);
  /** Hours a slot booking lasts (café tables have a fixed sitting length). */
  const slotHours = (item, sel) => item && item.per === 'guest' ? Math.max(1, +item.sitting || 2) : Math.max(1, +sel.hours || 1);

  /**
   * Build quotation lines.
   * sel: {kind, venueId, days, guests, units, startHour, hours, packageId, addons[], accommodation[], rooms, customLines[], discount}
   * catalog: {venues[], stays[], slots[], packages[], addons[]}
   * settings: {gstPct, advancePct, stayAdvancePct, slotAdvancePct, roomRate}
   */
  function buildQuote(sel, catalog, settings) {
    const kind = kindOf(sel);
    const days = Math.max(1, +sel.days || 1);
    const guests = Math.max(1, +sel.guests || 1);
    const find = (list, id) => (list || []).find(x => x.id === id);
    const defGst = +settings.gstPct || 0;
    const gstOf = item => (item && item.gstPct !== '' && item.gstPct != null && Number.isFinite(+item.gstPct)) ? +item.gstPct : defGst;
    const lines = [];
    let mainGst = defGst;

    if (kind === 'event') {
      const v = find(catalog.venues, sel.venueId);
      if (v) lines.push({ desc: `Venue — ${v.name}`, qty: days, unit: 'day', rate: +v.perDay, gstPct: gstOf(v) });
      const p = find(catalog.packages, sel.packageId);
      if (p) lines.push({ desc: `${p.name} hospitality package (${String(p.desc || '').toLowerCase()})`.replace(' ()', ''), qty: guests * days, unit: 'guest-day', rate: +p.perGuest, gstPct: defGst });
      (sel.addons || []).forEach(id => {
        const a = find(catalog.addons, id); if (!a) return;
        lines.push(a.unit === 'perGuest'
          ? { desc: a.name, qty: guests, unit: 'guest', rate: +a.price, gstPct: defGst }
          : { desc: a.name, qty: 1, unit: 'lot', rate: +a.price, gstPct: defGst });
      });
      (sel.accommodation || []).forEach(x => {
        const s = find(catalog.stays, x.id); const n = Math.max(0, +x.units || 0);
        if (s && n) lines.push({ desc: `Guest stays — ${s.name}`, qty: n * days, unit: 'night', rate: +s.perNight, gstPct: gstOf(s) });
      });
      const rooms = Math.max(0, +sel.rooms || 0); // older quotations only
      if (rooms && +settings.roomRate) lines.push({ desc: 'Guest stays', qty: rooms * days, unit: 'room-night', rate: +settings.roomRate, gstPct: defGst });
    } else if (kind === 'stay') {
      const s = find(catalog.stays, sel.venueId);
      const units = Math.max(1, +sel.units || 1);
      if (s) { mainGst = gstOf(s); lines.push({ desc: `${s.name} — ${units} × ${days} night${days > 1 ? 's' : ''}`, qty: units * days, unit: 'night', rate: +s.perNight, gstPct: mainGst }); }
    } else {
      const s = find(catalog.slots, sel.venueId);
      if (s) {
        mainGst = gstOf(s);
        if (s.per === 'guest') lines.push({ desc: `${s.name} — table reservation`, qty: guests, unit: 'guest', rate: +s.rate, gstPct: mainGst });
        else { const h = slotHours(s, sel), u = Math.max(1, +sel.units || 1); lines.push({ desc: s.name, qty: h * u, unit: 'hour', rate: +s.rate, gstPct: mainGst }); }
      }
    }
    (sel.customLines || []).forEach(l => {
      if (l && String(l.desc || '').trim() && +l.qty > 0 && +l.rate > 0)
        lines.push({ desc: String(l.desc).trim().slice(0, 200), qty: Math.round(+l.qty), unit: String(l.unit || 'lot').slice(0, 20), rate: Math.round(+l.rate), custom: true, gstPct: mainGst });
    });
    lines.forEach(l => { l.amount = Math.round(l.qty * l.rate); });
    const gross = lines.reduce((s, l) => s + l.amount, 0);
    const discount = Math.min(gross, Math.max(0, Math.round(+sel.discount || 0)));
    const subtotal = gross - discount;

    /* GST per rate (rooms, food and venues can carry different rates); discount spread pro rata */
    const groups = {};
    lines.forEach(l => { groups[l.gstPct] = (groups[l.gstPct] || 0) + l.amount; });
    const rates = Object.keys(groups).map(Number).sort((a, b) => a - b);
    let left = discount;
    const gstBreakdown = rates.map((pct, i) => {
      const share = i === rates.length - 1 ? left : Math.round(discount * groups[pct] / (gross || 1));
      left -= share;
      const taxable = groups[pct] - share;
      return { pct, taxable, gst: Math.round(taxable * pct / 100) };
    }).filter(g => g.taxable > 0 || rates.length === 1);
    const gst = gstBreakdown.reduce((s, g) => s + g.gst, 0);
    const gstPct = gstBreakdown.length === 1 ? gstBreakdown[0].pct : (gstBreakdown.length ? null : defGst);
    const total = subtotal + gst;
    const advancePct = kind === 'slot' ? (+settings.slotAdvancePct || 100) : kind === 'stay' ? (+settings.stayAdvancePct || 50) : (+settings.advancePct || 30);
    const advance = Math.min(total, Math.round(total * advancePct / 100));
    return { kind, lines, gross, discount, subtotal, gstPct, gstBreakdown, gst, total, advancePct, advance };
  }

  const inr = n => '₹' + Math.round(n || 0).toLocaleString('en-IN');
  const fmtDate = s => s ? parseISO(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  function fmtHour(h) { h = ((Math.round(h) % 24) + 24) % 24; return `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}`; }
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  /** Dates a booking occupies (event days, stay nights, or the slot's day). */
  function occupiedDates(b) { return kindOf(b) === 'slot' ? [b.startDate] : eventDates(b.startDate, b.days); }
  /** Last calendar day touched by a booking (check-out day for stays). */
  function lastDate(b) { const k = kindOf(b); return k === 'slot' ? b.startDate : k === 'stay' ? addDays(b.startDate, b.days) : addDays(b.startDate, b.days - 1); }

  /** Human description used by emails, PDFs, the admin and the customer pages. */
  function describe(b) {
    const kind = kindOf(b);
    const name = b.venueName || b.venueId;
    if (kind === 'stay') {
      const out = addDays(b.startDate, b.days);
      return { kind, label: 'Stay', resourceLabel: 'Stay', name,
        when: `${fmtDate(b.startDate)} – ${fmtDate(out)} · ${plural(b.days, 'night')}`,
        whenShort: `${fmtDate(b.startDate)} → ${fmtDate(out)}`,
        people: `${plural(b.units || 1, b.unitWord || 'unit')} · ${plural(b.guests, 'guest')}`, extras: [] };
    }
    if (kind === 'slot') {
      const t = `${fmtHour(b.startHour)} – ${fmtHour(b.startHour + (b.hours || 1))}`;
      return { kind, label: 'Reservation', resourceLabel: 'Reservation', name,
        when: `${fmtDate(b.startDate)} · ${t}`, whenShort: `${fmtDate(b.startDate)} · ${t}`,
        people: b.per === 'guest' ? `Table for ${b.guests}` : plural(b.guests, 'player'), extras: [] };
    }
    const range = b.days > 1 ? `${fmtDate(b.startDate)} – ${fmtDate(addDays(b.startDate, b.days - 1))}` : fmtDate(b.startDate);
    const extras = [];
    if (b.packageName) extras.push(`${b.packageName} package`);
    (b.accommodation || []).filter(x => x.units).forEach(x => extras.push(`${plural(x.units, x.name || x.id)} per night`));
    if (!(b.accommodation || []).length && b.rooms) extras.push(`${b.rooms} guest rooms per night`);
    return { kind, label: 'Celebration', resourceLabel: 'Venue', name, when: `${range} · ${plural(b.days, 'day')}`, whenShort: range,
      people: plural(b.guests, 'guest'), extras };
  }

  return { pad, iso, parseISO, addDays, isISODate, eventDates, todayIST, hourIST, STATUSES, KINDS, kindOf, listFor, findResource,
    slotUsage, slotHours, buildQuote, inr, fmtDate, fmtHour, occupiedDates, lastDate, describe };
});
