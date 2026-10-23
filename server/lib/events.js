'use strict';
/* =========================================================================
   Kankana CRM — phase 4: after the booking.
   Event planner per confirmed booking (checklist from a template, run-sheet,
   rooming list, notes), a vendor directory, and after-event care: feedback
   page with referrals, plus feedback-request and anniversary automations.
   ========================================================================= */
const crypto = require('node:crypto');
const P = require('../../assets/kankana-pricing.js');

const SECTIONS = ['Planning', 'Décor', 'Catering', 'Photography', 'Music & entertainment', 'Rituals', 'Stays', 'Transport', 'Payments', 'On the day', 'Other'];
const VENDOR_CATS = ['Décor', 'Catering', 'Photography & film', 'Music & DJ', 'Mehndi & makeup', 'Pandit & rituals', 'Transport', 'Lighting & sound', 'Flowers', 'Other'];
// offset = days from the event's first day (negative = before); from 'confirmed' = days after the advance is paid
const DEFAULT_TEMPLATE = {
  event: [
    { section: 'Planning', title: 'Kick-off call with the family', from: 'confirmed', offset: 2, role: 'events' },
    { section: 'Planning', title: 'Share the planning timeline with the family', from: 'confirmed', offset: 5, role: 'events' },
    { section: 'Photography', title: 'Photographer and videographer confirmed', from: 'start', offset: -45, role: 'events' },
    { section: 'Catering', title: 'Menu tasting', from: 'start', offset: -35, role: 'events' },
    { section: 'Catering', title: 'Final menu signed off', from: 'start', offset: -30, role: 'events' },
    { section: 'Décor', title: 'Décor theme and mandap design approved', from: 'start', offset: -30, role: 'events' },
    { section: 'Music & entertainment', title: 'Music, DJ and sangeet performers booked', from: 'start', offset: -30, role: 'events' },
    { section: 'Payments', title: 'Balance payment collected', from: 'balance', offset: 0, role: 'accounts' },
    { section: 'Planning', title: 'Final guest count confirmed', from: 'start', offset: -21, role: 'events' },
    { section: 'Stays', title: 'Rooming list received from the family', from: 'start', offset: -14, role: 'events' },
    { section: 'Rituals', title: 'Mehndi artist, haldi setup and pandit confirmed', from: 'start', offset: -14, role: 'events' },
    { section: 'Transport', title: 'Airport / station pick-up schedule', from: 'start', offset: -7, role: 'events' },
    { section: 'On the day', title: 'Run-sheet shared with family and vendors', from: 'start', offset: -7, role: 'events' },
    { section: 'On the day', title: 'Final walkthrough with the family', from: 'start', offset: -2, role: 'events' },
    { section: 'On the day', title: 'Vendor arrival and set-up check', from: 'start', offset: 0, role: 'events' }
  ],
  stay: [
    { section: 'Stays', title: 'Check-in details sent to the guest', from: 'start', offset: -2, role: 'events' },
    { section: 'Stays', title: 'Special requests noted (cot, diet, celebrations)', from: 'start', offset: -2, role: 'events' },
    { section: 'Stays', title: 'Room ready and welcome amenities placed', from: 'start', offset: 0, role: 'events' },
    { section: 'Payments', title: 'Balance collected at check-in', from: 'start', offset: 0, role: 'accounts' }
  ]
};
const LIVE = ['confirmed', 'planning', 'paid', 'completed'];
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
class EvError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = m => new EvError(400, m);

function createEvents({ store, crm, svc, msg }) {
  const db = store.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS plan_meta (booking_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, coordinator_id INTEGER, notes TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS plan_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id TEXT NOT NULL, section TEXT NOT NULL, title TEXT NOT NULL, due_date TEXT,
      owner_id INTEGER, vendor_id INTEGER, done_at INTEGER, done_by INTEGER, notes TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS ix_plan_items ON plan_items(booking_id);
    CREATE TABLE IF NOT EXISTS runsheet (
      id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id TEXT NOT NULL, day TEXT NOT NULL, time TEXT NOT NULL, title TEXT NOT NULL,
      place TEXT NOT NULL DEFAULT '', who TEXT NOT NULL DEFAULT '', vendor_id INTEGER, notes TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS ix_runsheet ON runsheet(booking_id, day, time);
    CREATE TABLE IF NOT EXISTS rooming (
      id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id TEXT NOT NULL, room TEXT NOT NULL, guests TEXT NOT NULL DEFAULT '', nights TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, category TEXT NOT NULL, contact TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id TEXT NOT NULL UNIQUE, token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, submitted_at INTEGER,
      rating INTEGER, loved TEXT, improve TEXT, consent INTEGER NOT NULL DEFAULT 0, recommend INTEGER, referrals INTEGER NOT NULL DEFAULT 0);
  `);

  /* ---------------- permissions ---------------- */
  const role = a => crm.roleOf(a);
  const canPlan = a => ['owner', 'events'].includes(role(a));
  const assertPlan = a => { if (!canPlan(a)) throw new EvError(403, 'Only Owner and Events logins can change event plans.'); };

  /* ---------------- template ---------------- */
  function template() {
    const t = store.getKV('events:template');
    return { event: Array.isArray(t && t.event) ? t.event : DEFAULT_TEMPLATE.event, stay: Array.isArray(t && t.stay) ? t.stay : DEFAULT_TEMPLATE.stay };
  }
  function setTemplate(b) {
    const norm = list => (Array.isArray(list) ? list : []).slice(0, 60).map(x => ({
      section: SECTIONS.includes(x.section) ? x.section : 'Other', title: clean(x.title, 160),
      from: ['start', 'confirmed', 'balance'].includes(x.from) ? x.from : 'start', offset: Math.max(-365, Math.min(365, Math.round(+x.offset || 0))),
      role: ['events', 'accounts', 'sales', 'owner'].includes(x.role) ? x.role : 'events'
    })).filter(x => x.title);
    const next = { event: b.event ? norm(b.event) : template().event, stay: b.stay ? norm(b.stay) : template().stay };
    store.setKV('events:template', next); return next;
  }

  /* ---------------- helpers ---------------- */
  const firstActive = r => db.prepare('SELECT * FROM admins WHERE role=? AND active=1 ORDER BY created_at LIMIT 1').get(r);
  const coordinatorFor = () => firstActive('events') || crm.defaultAssignee();
  const booking = id => store.getBooking(id, { withKey: true });
  const kindOf = b => P.kindOf(b);
  const nameOf = id => crm.nameOf(id);
  const vendorRow = v => v && { id: v.id, name: v.name, category: v.category, contact: v.contact, phone: v.phone, email: v.email, notes: v.notes, active: !!v.active, createdAt: v.created_at };
  const itemRow = r => ({ id: r.id, bookingId: r.booking_id, section: r.section, title: r.title, dueDate: r.due_date, ownerId: r.owner_id, owner: nameOf(r.owner_id), vendorId: r.vendor_id, doneAt: r.done_at, doneBy: nameOf(r.done_by), notes: r.notes, sort: r.sort });
  const runRow = r => ({ id: r.id, bookingId: r.booking_id, day: r.day, time: r.time, title: r.title, place: r.place, who: r.who, vendorId: r.vendor_id, notes: r.notes });
  const roomRow = r => ({ id: r.id, bookingId: r.booking_id, room: r.room, guests: r.guests, nights: r.nights, notes: r.notes });
  const lastDay = b => kindOf(b) === 'stay' ? P.addDays(b.startDate, b.days) : P.addDays(b.startDate, (b.days || 1) - 1);
  const isoOrNull = v => (v && P.isISODate(String(v))) ? String(v) : null;

  /** Builds the checklist for a confirmed celebration or stay from the template (once). */
  function createPlan(bookingId, actor = null) {
    const b = booking(bookingId); if (!b) throw new EvError(404, 'Booking not found');
    const k = kindOf(b); if (k === 'slot') throw bad('Turf, court and café reservations don’t need a plan.');
    if (db.prepare('SELECT 1 FROM plan_meta WHERE booking_id=?').get(b.id)) return getPlan(b.id);
    const today = P.todayIST(), s = store.settings();
    const coord = coordinatorFor();
    const leadOwner = (() => { const ids = crm.leadsForBooking(b.id); const l = ids.length ? crm.rawLead(ids[0]) : null; return l && l.ownerId; })();
    const who = r => r === 'accounts' ? (crm.accountsPerson() || coord) : r === 'sales' ? (leadOwner ? store.adminById(leadOwner) : coord) : r === 'owner' ? (firstActive('owner') || coord) : coord;
    return store.tx(() => {
      db.prepare('INSERT INTO plan_meta(booking_id,created_at,coordinator_id,notes) VALUES(?,?,?,?)').run(b.id, Date.now(), coord ? coord.id : null, '');
      template()[k].forEach((t, i) => {
        let due = t.from === 'confirmed' ? P.addDays(today, t.offset) : t.from === 'balance' ? P.addDays(b.startDate, -(s.balanceDueDaysBefore || 30) + t.offset) : P.addDays(b.startDate, t.offset);
        if (due < today) due = today;
        const o = who(t.role);
        db.prepare('INSERT INTO plan_items(booking_id,section,title,due_date,owner_id,sort,created_at) VALUES(?,?,?,?,?,?,?)').run(b.id, t.section, t.title, due, o ? o.id : null, i, Date.now());
      });
      if (k === 'event') {
        const day = b.startDate;
        [['09:00', 'Vendors arrive and set up', ''], ['17:00', 'Guests arrive', b.venueName], ['20:00', 'Dinner service', '']].forEach(([time, title, place]) =>
          db.prepare('INSERT INTO runsheet(booking_id,day,time,title,place) VALUES(?,?,?,?,?)').run(b.id, day, time, title, place || ''));
        (b.accommodation || []).forEach(a => { for (let i = 1; i <= Math.min(a.units, 40); i++) db.prepare('INSERT INTO rooming(booking_id,room,nights) VALUES(?,?,?)').run(b.id, `${a.name} ${i}`, `${b.days} night${b.days > 1 ? 's' : ''}`); });
      }
      if (b.status === 'confirmed') store.addHistory(b.id, b.status, 'Event plan created', actor ? actor.email : 'system');
      crm.leadsForBooking(b.id).forEach(id => crm.logContact(id, 'note', `Event plan started for ${b.id} — coordinator ${coord ? (coord.name || coord.email) : 'unassigned'}`, actor ? actor.id : null));
      return getPlan(b.id);
    });
  }

  function summary(b) {
    const items = db.prepare('SELECT * FROM plan_items WHERE booking_id=?').all(b.id);
    const today = P.todayIST();
    const open = items.filter(i => !i.done_at).sort((x, y) => (x.due_date || '9').localeCompare(y.due_date || '9'));
    const meta = db.prepare('SELECT * FROM plan_meta WHERE booking_id=?').get(b.id);
    const fb = db.prepare('SELECT * FROM feedback WHERE booking_id=?').get(b.id);
    const d = P.describe(b);
    return {
      bookingId: b.id, status: b.status, kind: kindOf(b), customer: b.customer.name, phone: b.customer.phone, email: b.customer.email,
      venue: b.venueName, when: d.when, whenShort: d.whenShort, startDate: b.startDate, endDate: lastDay(b), guests: b.guests, people: d.people,
      hasPlan: !!meta, coordinatorId: meta ? meta.coordinator_id : null, coordinator: meta ? nameOf(meta.coordinator_id) : null,
      total: items.length, done: items.length - open.length, overdue: open.filter(i => i.due_date && i.due_date < today).length,
      next: open[0] ? { title: open[0].title, dueDate: open[0].due_date } : null,
      balance: Math.max(0, b.quote.total - b.payments.reduce((s, p) => s + p.amount, 0)),
      feedback: fb ? { sent: true, submitted: !!fb.submitted_at, rating: fb.rating } : null
    };
  }
  function list() {
    const from = P.addDays(P.todayIST(), -60);
    return store.allBookings().filter(b => LIVE.includes(b.status) && kindOf(b) !== 'slot' && lastDay(b) >= from)
      .map(summary).sort((a, b) => a.startDate.localeCompare(b.startDate));
  }
  function getPlan(bookingId) {
    const b = booking(bookingId); if (!b) throw new EvError(404, 'Booking not found');
    const meta = db.prepare('SELECT * FROM plan_meta WHERE booking_id=?').get(b.id);
    const fb = db.prepare('SELECT * FROM feedback WHERE booking_id=?').get(b.id);
    return {
      summary: summary(b), notes: meta ? meta.notes : '',
      items: db.prepare('SELECT * FROM plan_items WHERE booking_id=? ORDER BY due_date IS NULL, due_date, sort, id').all(b.id).map(itemRow),
      runsheet: db.prepare('SELECT * FROM runsheet WHERE booking_id=? ORDER BY day, time, id').all(b.id).map(runRow),
      rooming: db.prepare('SELECT * FROM rooming WHERE booking_id=? ORDER BY id').all(b.id).map(roomRow),
      feedback: fb ? feedbackRow(fb) : null,
      days: P.eventDates(b.startDate, kindOf(b) === 'stay' ? b.days + 1 : b.days || 1)
    };
  }
  function setMeta(bookingId, { notes, coordinatorId }, actor) {
    assertPlan(actor);
    if (!db.prepare('SELECT 1 FROM plan_meta WHERE booking_id=?').get(bookingId)) createPlan(bookingId, actor);
    if (notes !== undefined) db.prepare('UPDATE plan_meta SET notes=? WHERE booking_id=?').run(clean(notes, 8000), bookingId);
    if (coordinatorId !== undefined) { const a = coordinatorId ? store.adminById(+coordinatorId) : null; if (coordinatorId && (!a || !a.active)) throw bad('Choose an active team member.'); db.prepare('UPDATE plan_meta SET coordinator_id=? WHERE booking_id=?').run(a ? a.id : null, bookingId); }
    return getPlan(bookingId);
  }

  /* ---------------- checklist items ---------------- */
  function addItem(b, actor) {
    assertPlan(actor);
    const bk = booking(b.bookingId); if (!bk) throw new EvError(404, 'Booking not found');
    if (!db.prepare('SELECT 1 FROM plan_meta WHERE booking_id=?').get(bk.id)) createPlan(bk.id, actor);
    const title = clean(b.title, 160); if (!title) throw bad('What needs doing?');
    const r = db.prepare('INSERT INTO plan_items(booking_id,section,title,due_date,owner_id,vendor_id,notes,sort,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(bk.id, SECTIONS.includes(b.section) ? b.section : 'Other', title, isoOrNull(b.dueDate), b.ownerId ? +b.ownerId : null, b.vendorId ? +b.vendorId : null, clean(b.notes, 1000), 999, Date.now());
    return itemRow(db.prepare('SELECT * FROM plan_items WHERE id=?').get(r.lastInsertRowid));
  }
  function updateItem(id, b, actor) {
    const it = db.prepare('SELECT * FROM plan_items WHERE id=?').get(+id); if (!it) throw new EvError(404, 'Item not found');
    const own = it.owner_id === actor.id;
    if (!canPlan(actor) && !(own && Object.keys(b).every(k => ['done', 'notes'].includes(k)))) throw new EvError(403, 'Only Owner and Events logins can change this — you can tick off items assigned to you.');
    const f = {};
    if (b.title !== undefined) { f.title = clean(b.title, 160); if (!f.title) throw bad('The item needs a title.'); }
    if (b.section !== undefined) f.section = SECTIONS.includes(b.section) ? b.section : 'Other';
    if (b.dueDate !== undefined) f.due_date = isoOrNull(b.dueDate);
    if (b.ownerId !== undefined) f.owner_id = b.ownerId ? +b.ownerId : null;
    if (b.vendorId !== undefined) f.vendor_id = b.vendorId ? +b.vendorId : null;
    if (b.notes !== undefined) f.notes = clean(b.notes, 1000);
    if (b.done !== undefined) { f.done_at = b.done ? Date.now() : null; f.done_by = b.done ? actor.id : null; }
    const keys = Object.keys(f); if (keys.length) db.prepare(`UPDATE plan_items SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`).run(...keys.map(k => f[k]), it.id);
    return itemRow(db.prepare('SELECT * FROM plan_items WHERE id=?').get(it.id));
  }
  function deleteItem(id, actor) { assertPlan(actor); db.prepare('DELETE FROM plan_items WHERE id=?').run(+id); return true; }

  /* ---------------- run-sheet & rooming ---------------- */
  const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
  function saveRun(b, actor, id = null) {
    assertPlan(actor);
    const cur = id ? db.prepare('SELECT * FROM runsheet WHERE id=?').get(+id) : null;
    if (id && !cur) throw new EvError(404, 'Run-sheet line not found');
    const bookingId = cur ? cur.booking_id : b.bookingId; if (!booking(bookingId)) throw new EvError(404, 'Booking not found');
    const was = cur || { day: null, time: '', title: '', place: '', who: '', vendor_id: null, notes: '' };
    const v = {
      day: b.day !== undefined ? isoOrNull(b.day) : was.day, time: b.time !== undefined ? String(b.time).trim() : was.time, title: b.title !== undefined ? clean(b.title, 160) : was.title,
      place: b.place !== undefined ? clean(b.place, 120) : was.place, who: b.who !== undefined ? clean(b.who, 120) : was.who,
      vendor_id: b.vendorId !== undefined ? (b.vendorId ? +b.vendorId : null) : was.vendor_id, notes: b.notes !== undefined ? clean(b.notes, 600) : was.notes
    };
    if (!v.day) throw bad('Choose the day.'); if (!TIME.test(v.time)) throw bad('Time should look like 18:30.'); if (!v.title) throw bad('What happens at this time?');
    if (cur) db.prepare('UPDATE runsheet SET day=?,time=?,title=?,place=?,who=?,vendor_id=?,notes=? WHERE id=?').run(v.day, v.time, v.title, v.place, v.who, v.vendor_id, v.notes, cur.id);
    else { const r = db.prepare('INSERT INTO runsheet(booking_id,day,time,title,place,who,vendor_id,notes) VALUES(?,?,?,?,?,?,?,?)').run(bookingId, v.day, v.time, v.title, v.place, v.who, v.vendor_id, v.notes); id = r.lastInsertRowid; }
    return runRow(db.prepare('SELECT * FROM runsheet WHERE id=?').get(cur ? cur.id : id));
  }
  function deleteRun(id, actor) { assertPlan(actor); db.prepare('DELETE FROM runsheet WHERE id=?').run(+id); return true; }
  function saveRoom(b, actor, id = null) {
    assertPlan(actor);
    const cur = id ? db.prepare('SELECT * FROM rooming WHERE id=?').get(+id) : null;
    if (id && !cur) throw new EvError(404, 'Room line not found');
    const bookingId = cur ? cur.booking_id : b.bookingId; if (!booking(bookingId)) throw new EvError(404, 'Booking not found');
    const was = cur || { room: '', guests: '', nights: '', notes: '' };
    const v = { room: b.room !== undefined ? clean(b.room, 80) : was.room, guests: b.guests !== undefined ? clean(b.guests, 300) : was.guests, nights: b.nights !== undefined ? clean(b.nights, 60) : was.nights, notes: b.notes !== undefined ? clean(b.notes, 300) : was.notes };
    if (!v.room) throw bad('Name the room (e.g. Villa 2).');
    if (cur) db.prepare('UPDATE rooming SET room=?,guests=?,nights=?,notes=? WHERE id=?').run(v.room, v.guests, v.nights, v.notes, cur.id);
    else { const r = db.prepare('INSERT INTO rooming(booking_id,room,guests,nights,notes) VALUES(?,?,?,?,?)').run(bookingId, v.room, v.guests, v.nights, v.notes); id = r.lastInsertRowid; }
    return roomRow(db.prepare('SELECT * FROM rooming WHERE id=?').get(cur ? cur.id : id));
  }
  function deleteRoom(id, actor) { assertPlan(actor); db.prepare('DELETE FROM rooming WHERE id=?').run(+id); return true; }

  /* ---------------- vendors ---------------- */
  function vendors() {
    const used = {}; db.prepare('SELECT vendor_id, COUNT(DISTINCT booking_id) AS n FROM plan_items WHERE vendor_id IS NOT NULL GROUP BY vendor_id').all().forEach(r => { used[r.vendor_id] = r.n; });
    return db.prepare('SELECT * FROM vendors ORDER BY active DESC, category, name').all().map(v => Object.assign(vendorRow(v), { events: used[v.id] || 0 }));
  }
  function saveVendor(b, actor, id = null) {
    if (!['owner', 'events', 'sales'].includes(role(actor))) throw new EvError(403, 'Your role can’t edit vendors.');
    const cur = id ? db.prepare('SELECT * FROM vendors WHERE id=?').get(+id) : null;
    if (id && !cur) throw new EvError(404, 'Vendor not found');
    const pick = (k, n) => b[k] !== undefined ? clean(b[k], n) : (cur ? cur[k] : '');
    const v = { name: pick('name', 120), category: b.category !== undefined ? (VENDOR_CATS.includes(b.category) ? b.category : 'Other') : (cur ? cur.category : 'Other'),
      contact: pick('contact', 80), phone: pick('phone', 30), email: pick('email', 200).toLowerCase(), notes: pick('notes', 1000), active: b.active !== undefined ? (b.active ? 1 : 0) : (cur ? cur.active : 1) };
    if (!v.name) throw bad('Enter the vendor’s name.');
    if (cur) db.prepare('UPDATE vendors SET name=?,category=?,contact=?,phone=?,email=?,notes=?,active=? WHERE id=?').run(v.name, v.category, v.contact, v.phone, v.email, v.notes, v.active, cur.id);
    else { const r = db.prepare('INSERT INTO vendors(name,category,contact,phone,email,notes,active,created_at) VALUES(?,?,?,?,?,?,?,?)').run(v.name, v.category, v.contact, v.phone, v.email, v.notes, v.active, Date.now()); id = r.lastInsertRowid; }
    return vendorRow(db.prepare('SELECT * FROM vendors WHERE id=?').get(cur ? cur.id : id));
  }

  /* ---------------- feedback & referrals ---------------- */
  function feedbackRow(f) {
    const b = booking(f.booking_id);
    return { id: f.id, bookingId: f.booking_id, customer: b ? b.customer.name : '', venue: b ? b.venueName : '', when: b ? P.describe(b).whenShort : '',
      createdAt: f.created_at, submittedAt: f.submitted_at, rating: f.rating, loved: f.loved || '', improve: f.improve || '', consent: !!f.consent, recommend: f.recommend, referrals: f.referrals, link: link(f.token) };
  }
  const link = token => `${svc.siteUrl()}/feedback.html?t=${encodeURIComponent(token)}`;
  function feedbackFor(bookingId) {
    const ex = db.prepare('SELECT * FROM feedback WHERE booking_id=?').get(bookingId);
    if (ex) return ex;
    if (!booking(bookingId)) throw new EvError(404, 'Booking not found');
    db.prepare('INSERT INTO feedback(booking_id,token,created_at) VALUES(?,?,?)').run(bookingId, crypto.randomBytes(18).toString('base64url'), Date.now());
    return db.prepare('SELECT * FROM feedback WHERE booking_id=?').get(bookingId);
  }
  const allFeedback = () => db.prepare('SELECT * FROM feedback ORDER BY COALESCE(submitted_at, created_at) DESC').all().map(feedbackRow);
  const byToken = t => (t && String(t).length >= 16) ? db.prepare('SELECT * FROM feedback WHERE token=?').get(String(t)) : null;
  function publicFeedback(token) {
    const f = byToken(token); if (!f) throw new EvError(404, 'This feedback link isn’t valid.');
    const b = booking(f.booking_id);
    return { name: b.customer.name.split(/\s+/)[0], venue: b.venueName, when: P.describe(b).whenShort, submitted: !!f.submitted_at, company: store.settings().company.name };
  }
  function submitFeedback(token, b) {
    const f = byToken(token); if (!f) throw new EvError(404, 'This feedback link isn’t valid.');
    if (f.submitted_at) throw bad('Thank you — we already have your feedback.');
    const rating = Math.round(+b.rating); if (!(rating >= 1 && rating <= 5)) throw bad('Please choose a rating from 1 to 5 stars.');
    const recommend = b.recommend === undefined || b.recommend === null || b.recommend === '' ? null : Math.max(0, Math.min(10, Math.round(+b.recommend)));
    const bk = booking(f.booking_id);
    const refs = (Array.isArray(b.referrals) ? b.referrals : []).slice(0, 5).map(r => ({ name: clean(r.name, 120), phone: clean(r.phone, 30), email: clean(r.email, 200), note: clean(r.note, 300) })).filter(r => r.name && (r.phone || r.email));
    let made = 0;
    const referrerLeads = crm.leadsForBooking(bk.id);
    refs.forEach(r => {
      try {
        const { lead } = crm.createLead({ name: r.name, phone: r.phone, email: r.email, message: `Referred by ${bk.customer.name} (${bk.id}).${r.note ? ' ' + r.note : ''}` }, { source: 'Referral' });
        made++;
        referrerLeads.forEach(id => crm.logContact(id, 'note', `Referred ${lead.name} (${lead.id}) through the feedback page`, null));
      } catch (e) { /* skip a bad referral, keep the rest */ }
    });
    db.prepare('UPDATE feedback SET submitted_at=?, rating=?, loved=?, improve=?, consent=?, recommend=?, referrals=? WHERE id=?')
      .run(Date.now(), rating, clean(b.loved, 3000), clean(b.improve, 3000), b.consent ? 1 : 0, recommend, made, f.id);
    referrerLeads.forEach(id => crm.logContact(id, 'note', `Left feedback: ${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}${b.loved ? ' — “' + clean(b.loved, 200) + '”' : ''}`, null));
    return { ok: true, referrals: made };
  }

  /* ---------------- hooks & automations ---------------- */
  /** When a celebration or stay is first paid for, start its plan automatically. */
  function onPayment(b) {
    try { if (kindOf(b) !== 'slot' && LIVE.includes(b.status) && !db.prepare('SELECT 1 FROM plan_meta WHERE booking_id=?').get(b.id)) createPlan(b.id, null); }
    catch (e) { console.error('[events] plan on payment', e.message); }
  }
  msg.addContext(({ booking: b }) => b && kindOf(b) !== 'slot' ? { feedback_link: link(feedbackFor(b.id).token) } : {});
  msg.addRule((now, h) => {
    const today = P.todayIST();
    const all = store.allBookings().filter(b => LIVE.includes(b.status) && kindOf(b) !== 'slot');
    const leadOf = b => { const ids = crm.leadsForBooking(b.id); return ids.length ? crm.rawLead(ids[0]) : null; };
    // Feedback: the day after the last day of a celebration or a stay's check-out.
    if (h.settings.feedbackRequest) all.filter(b => P.addDays(lastDay(b), 1) <= today && P.addDays(lastDay(b), 21) >= today).forEach(b => {
      const key = 'feedback:' + b.id; if (h.done(key)) return;
      const f = feedbackFor(b.id); if (f.submitted_at) return h.mark(key, 'Feedback request', b.id, 'already answered');
      const lead = leadOf(b);
      if (h.emailOn() && h.hasEmail(b.customer.email)) h.autoEmail('feedback_request', { lead, booking: b, to: b.customer.email });
      const coord = (db.prepare('SELECT coordinator_id FROM plan_meta WHERE booking_id=?').get(b.id) || {}).coordinator_id;
      h.waTask({ lead, booking: b, templateId: 'feedback_request', title: `Ask ${b.customer.name.split(/\s+/)[0]} for feedback`, dueAt: now, assigneeId: coord || (lead && lead.ownerId) });
      h.mark(key, 'Feedback request', b.id, `${b.customer.name} · ${P.describe(b).whenShort}`); h.note('Feedback request', b.id);
    });
    // Anniversary: one year after a wedding's first day.
    if (h.settings.anniversary) all.filter(b => kindOf(b) === 'event').forEach(b => {
      const ann = String(+b.startDate.slice(0, 4) + 1) + b.startDate.slice(4);
      if (ann > today || P.addDays(ann, 7) < today) return;
      const lead = leadOf(b); if (lead && lead.eventType && !/wedding/i.test(lead.eventType)) return;
      const key = 'anniv:' + b.id + ':' + ann; if (h.done(key)) return;
      if (h.emailOn() && h.hasEmail(b.customer.email)) h.autoEmail('anniversary', { lead, booking: b, to: b.customer.email });
      h.waTask({ lead, booking: b, templateId: 'anniversary', title: `Wish ${b.customer.name.split(/\s+/)[0]} a happy anniversary`, dueAt: now, assigneeId: lead && lead.ownerId });
      h.mark(key, 'Anniversary', b.id, b.customer.name); h.note('Anniversary', b.id);
    });
  });

  return {
    SECTIONS, VENDOR_CATS, template, setTemplate, createPlan, list, getPlan, setMeta, addItem, updateItem, deleteItem,
    saveRun, deleteRun, saveRoom, deleteRoom, vendors, saveVendor, allFeedback, feedbackFor: id => feedbackRow(feedbackFor(id)), publicFeedback, submitFeedback, onPayment, canPlan
  };
}

module.exports = { createEvents, DEFAULT_TEMPLATE };
