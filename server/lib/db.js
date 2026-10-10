'use strict';
/* SQLite storage using Node's built-in node:sqlite (Node 22.13+). */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const P = require('../../assets/kankana-pricing.js');

/* Starting catalogue — names, capacities and prices are placeholders the team edits in Admin → Venues & Pricing.
   ids must be unique across venues, stays and slots (they key availability). */
const DEFAULT_CATALOG = {
  venues: [
    { id: 'colonnade', name: 'The Colonnade', region: 'Event venue', capacity: 500, perDay: 380000, blurb: 'Pheras beneath carved arches, with the fields beyond.', active: true },
    { id: 'garden-pavilions', name: 'The Garden Pavilions', region: 'Event venue', capacity: 250, perDay: 220000, blurb: 'Shaded lawns for mehndi, haldi and long lunches.', active: true },
    { id: 'sunset-terrace', name: 'The Sunset Terrace', region: 'Event venue', capacity: 150, perDay: 180000, blurb: 'West-facing terrace for sundowners and intimate dinners.', active: true },
    { id: 'reception-hall', name: 'Reception Hall', region: 'Hall', capacity: 800, perDay: 350000, blurb: 'The largest indoor space — receptions, sangeet stages and banquets.', active: true },
    { id: 'dining-hall', name: 'Dining Hall', region: 'Hall', capacity: 300, perDay: 150000, blurb: 'Seated dinners and buffets for the whole family.', active: true },
    { id: 'amphitheatre', name: 'Amphitheatre', region: 'Open-air', capacity: 600, perDay: 250000, blurb: 'Tiered open-air seating for performances, sangeet and screenings.', active: true }
  ],
  stays: [
    { id: 'villa', name: 'Private Villa', unitWord: 'villa', units: 6, sleeps: 4, perNight: 22000, gstPct: 18, sac: '996311', blurb: 'Six private villas — space for a family of four.', active: true },
    { id: 'room', name: 'Guest Room', unitWord: 'room', units: 20, sleeps: 2, perNight: 7500, gstPct: 5, sac: '996311', blurb: 'Twenty rooms for guests and family.', active: true }
  ],
  slots: [
    { id: 'turf', name: 'Turf', per: 'hour', units: 1, rate: 1800, open: 6, close: 23, maxHours: 3, maxGuests: 22, gstPct: 18, sac: '999652', blurb: 'Floodlit turf for football and cricket — booked by the hour.', active: true },
    { id: 'pickleball', name: 'Pickleball Court', per: 'hour', units: 1, rate: 900, open: 6, close: 22, maxHours: 2, maxGuests: 4, gstPct: 18, sac: '999652', blurb: 'One court, paddles available on request — booked by the hour.', active: true },
    { id: 'cafe', name: 'The Café', per: 'guest', units: 40, rate: 300, open: 8, close: 22, sitting: 2, maxGuests: 12, gstPct: 5, sac: '996331', blurb: 'Reserve a table for breakfast, lunch or evening coffee.', active: true }
  ],
  packages: [
    { id: 'essential', name: 'Essential', perGuest: 2600, desc: 'Plated vegetarian menu, standard florals, venue lighting', active: true },
    { id: 'signature', name: 'Signature', perGuest: 4200, desc: 'Multi-cuisine buffet, curated florals, live counters, bar service', active: true },
    { id: 'royal', name: 'Royal', perGuest: 6800, desc: 'Chef-led tasting menus, luxury florals, full bar, guest concierge', active: true }
  ],
  addons: [
    { id: 'mehndi', name: 'Mehndi & Sangeet Night', price: 350000, unit: 'flat', active: true },
    { id: 'mandap', name: 'Mandap & Ceremony Décor', price: 450000, unit: 'flat', active: true },
    { id: 'photo', name: 'Photography & Film', price: 280000, unit: 'flat', active: true },
    { id: 'baraat', name: 'Baraat Procession', price: 150000, unit: 'flat', active: true },
    { id: 'kits', name: 'Guest Welcome Kits', price: 1800, unit: 'perGuest', active: true },
    { id: 'transfers', name: 'Airport Transfers', price: 1200, unit: 'perGuest', active: true }
  ]
};
const LEGACY_VENUES = ['uluwatu', 'ubud', 'inle', 'bagan'];

const DEFAULT_SETTINGS = {
  advancePct: 30,
  gstPct: 18,
  holdHours: 72,
  roomRate: 0,
  maxDays: 5,
  stayAdvancePct: 50,
  stayHoldHours: 24,
  maxNights: 14,
  slotAdvancePct: 100,
  slotHoldMinutes: 30,
  balanceDueDaysBefore: 30,
  company: {
    name: 'Kankana — Weddings & Resorts',
    legalName: 'Kankana Weddings',
    address: 'Bengaluru, Karnataka, India',
    email: 'hello@kankana.in',
    phone: '+91 90000 00000',
    gstin: '',
    state: 'Karnataka',
    sac: '998596'
  },
  stayTerms: [
    'Your stay is confirmed on receipt of the advance.',
    'The balance is payable at check-in.',
    'Please carry a government photo ID for each adult guest.'
  ],
  slotTerms: [
    'Reservations are confirmed on receipt of payment.',
    'Your slot ends at the booked time — please arrive a few minutes early.',
    'To reschedule, contact us at least 24 hours before your slot.'
  ],
  terms: [
    'Dates are confirmed only on receipt of the advance.',
    'Balance is payable 30 days before the first event date.',
    'Guest count may be revised up to 21 days prior; per-guest items are re-billed accordingly.',
    'Cancellation more than 90 days prior: advance refunded less 10%. Within 90 days the advance is non-refundable.'
  ]
};

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'kankana.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      venue_id TEXT NOT NULL,
      start_date TEXT NOT NULL,
      days INTEGER NOT NULL,
      email TEXT NOT NULL,
      hold_until INTEGER,
      access_key TEXT NOT NULL,
      quote_no TEXT NOT NULL,
      invoice_no TEXT,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_book_venue ON bookings(venue_id, start_date);
    CREATE INDEX IF NOT EXISTS ix_book_email ON bookings(email);
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL REFERENCES bookings(id),
      at INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      method TEXT NOT NULL,
      ref TEXT,
      type TEXT NOT NULL,
      receipt_no TEXT NOT NULL,
      gateway_payment_id TEXT UNIQUE,
      gateway_order_id TEXT,
      recorded_by TEXT
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL REFERENCES bookings(id),
      created_at INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id TEXT NOT NULL REFERENCES bookings(id),
      at INTEGER NOT NULL,
      status TEXT NOT NULL,
      note TEXT NOT NULL,
      actor TEXT
    );
    CREATE TABLE IF NOT EXISTS blocked (
      venue_id TEXT NOT NULL, date TEXT NOT NULL, reason TEXT,
      PRIMARY KEY (venue_id, date)
    );
    CREATE TABLE IF NOT EXISTS emails (
      id TEXT PRIMARY KEY, at INTEGER NOT NULL, to_addr TEXT NOT NULL, booking_id TEXT,
      subject TEXT NOT NULL, body TEXT NOT NULL, attachments TEXT, status TEXT NOT NULL, error TEXT
    );
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, name TEXT, pw_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE, expires INTEGER NOT NULL
    );
  `);
  return new Store(db);
}

class Store {
  constructor(db) {
    this.db = db;
    if (this.getKV('catalog') == null) this.setKV('catalog', DEFAULT_CATALOG);
    if (this.getKV('settings') == null) this.setKV('settings', DEFAULT_SETTINGS);
    this.migrate();
  }

  /** One-time upgrade of older databases: add stays & slots; swap the sample Bali/Myanmar venues for the estate's. */
  migrate() {
    const cat = this.getKV('catalog');
    if (cat && !Array.isArray(cat.stays)) {
      const sample = (cat.venues || []).length && cat.venues.every(v => LEGACY_VENUES.includes(v.id));
      this.setKV('catalog', Object.assign({}, cat, {
        venues: sample ? DEFAULT_CATALOG.venues : cat.venues,
        stays: DEFAULT_CATALOG.stays, slots: DEFAULT_CATALOG.slots
      }));
      const st = this.getKV('settings');
      if (st && st.roomRate === 18000) this.setKV('settings', Object.assign({}, st, { roomRate: 0 }));
    }
    // There is no Water Court at the estate: drop it (or hide it if bookings already use it).
    const cat2 = this.getKV('catalog');
    if (cat2 && (cat2.venues || []).some(v => v.id === 'water-court')) {
      const used = this.db.prepare("SELECT 1 FROM bookings WHERE venue_id='water-court' LIMIT 1").get();
      cat2.venues = used ? cat2.venues.map(v => v.id === 'water-court' ? Object.assign({}, v, { active: false }) : v)
                         : cat2.venues.filter(v => v.id !== 'water-court');
      this.setKV('catalog', cat2);
    }
    // Brand renamed from "Weddings & Beyond" to "Weddings & Resorts".
    const st2 = this.getKV('settings');
    if (st2 && st2.company && /Weddings & Beyond/.test(st2.company.name || '')) {
      st2.company.name = st2.company.name.replace('Weddings & Beyond', 'Weddings & Resorts');
      this.setKV('settings', st2);
    }
  }

  /* ---------- generic ---------- */
  getKV(key) { const r = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key); return r ? JSON.parse(r.value) : null; }
  setKV(key, v) { this.db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(v)); }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch (_) {} throw e; }
  }
  next(name, start) {
    const row = this.db.prepare('SELECT value FROM counters WHERE name=?').get(name);
    const v = (row ? row.value : start) + 1;
    this.db.prepare('INSERT INTO counters(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run(name, v);
    return v;
  }
  docNo(kind, prefix) {
    const fy = financialYear();
    const n = this.next(`${kind}:${fy}`, 0);
    return `${prefix}/${fy}/${String(n).padStart(4, '0')}`;
  }

  /* ---------- settings & catalog ---------- */
  settings() { return Object.assign({}, DEFAULT_SETTINGS, this.getKV('settings'), { company: Object.assign({}, DEFAULT_SETTINGS.company, (this.getKV('settings') || {}).company) }); }
  catalog() { return this.getKV('catalog') || DEFAULT_CATALOG; }
  activeCatalog() {
    const c = this.catalog();
    const on = l => (l || []).filter(x => x.active !== false);
    return { venues: on(c.venues), stays: on(c.stays), slots: on(c.slots), packages: on(c.packages), addons: on(c.addons) };
  }

  /* ---------- bookings ---------- */
  rowToBooking(r, opts = {}) {
    if (!r) return null;
    const d = JSON.parse(r.data);
    const b = Object.assign(d, {
      id: r.id, createdAt: r.created_at, updatedAt: r.updated_at, source: r.source, status: r.status,
      venueId: r.venue_id, startDate: r.start_date, days: r.days, holdUntil: r.hold_until,
      quoteNo: r.quote_no, invoiceNo: r.invoice_no
    });
    if (opts.withKey) b.accessKey = r.access_key;
    b.payments = this.db.prepare('SELECT * FROM payments WHERE booking_id=? ORDER BY at').all(r.id).map(p => ({
      id: p.id, at: p.at, amount: p.amount, method: p.method, ref: p.ref, type: p.type, receiptNo: p.receipt_no,
      gatewayPaymentId: p.gateway_payment_id
    }));
    b.history = this.db.prepare('SELECT at,status,note FROM history WHERE booking_id=? ORDER BY at, id').all(r.id).map(h => Object.assign({}, h));
    return b;
  }
  getBooking(id, opts) { return this.rowToBooking(this.db.prepare('SELECT * FROM bookings WHERE id=?').get(String(id || '').toUpperCase()), opts); }
  bookingRow(id) { return this.db.prepare('SELECT * FROM bookings WHERE id=?').get(String(id || '').toUpperCase()); }
  allBookings() { return this.db.prepare('SELECT * FROM bookings ORDER BY created_at DESC').all().map(r => this.rowToBooking(r, { withKey: true })); }

  /** Occupancy map for a venue: date -> 'booked' | 'hold' | 'blocked' (+ bookingId for admin). */
  occupancy(venueId, ignoreId) {
    const map = {};
    const now = Date.now();
    const rows = this.db.prepare('SELECT id,status,start_date,days,hold_until FROM bookings WHERE venue_id=?').all(venueId);
    rows.forEach(r => {
      if (r.id === ignoreId) return;
      const st = P.STATUSES[r.status] && P.STATUSES[r.status].blocks;
      if (!st) return;
      if (st === 'hold' && r.hold_until && r.hold_until < now) return;
      P.eventDates(r.start_date, r.days).forEach(d => {
        if (!map[d] || map[d].state === 'hold') map[d] = { state: st, bookingId: r.id };
      });
    });
    this.db.prepare('SELECT date,reason FROM blocked WHERE venue_id=?').all(venueId).forEach(x => {
      if (!map[x.date]) map[x.date] = { state: 'blocked', reason: x.reason || 'Unavailable' };
    });
    return map;
  }
  /** Bookings that currently take capacity (live holds + confirmed), with their JSON data parsed. */
  liveRows(ignoreId) {
    const now = Date.now();
    return this.db.prepare(`SELECT id,status,venue_id,start_date,days,hold_until,data FROM bookings WHERE status IN ('quoted','confirmed','planning','paid','completed')`).all()
      .filter(r => r.id !== ignoreId && !(r.status === 'quoted' && r.hold_until && r.hold_until < now))
      .map(r => Object.assign({}, r, { d: JSON.parse(r.data) }));
  }
  blockedDates(id) { const m = {}; this.db.prepare('SELECT date,reason FROM blocked WHERE venue_id=?').all(id).forEach(x => { m[x.date] = x.reason || 'Unavailable'; }); return m; }

  /** Villas/rooms: date -> units taken that night (stay bookings + accommodation inside celebrations). */
  stayNights(stayId, ignoreId) {
    const used = {};
    this.liveRows(ignoreId).forEach(r => {
      let n = 0;
      if (r.venue_id === stayId && r.d.kind === 'stay') n = +r.d.units || 1;
      else if ((r.d.kind || 'event') === 'event') { const a = (r.d.accommodation || []).find(x => x.id === stayId); n = a ? +a.units || 0 : 0; }
      if (n) P.eventDates(r.start_date, r.days).forEach(d => { used[d] = (used[d] || 0) + n; });
    });
    return used;
  }
  /** Turf/court/café on one date: hour -> units (courts) or seats (café) taken. */
  slotHours(slotId, date, ignoreId) {
    const used = {};
    this.liveRows(ignoreId).forEach(r => {
      if (r.venue_id !== slotId || r.start_date !== date || r.d.kind !== 'slot') return;
      for (let h = r.d.startHour; h < r.d.startHour + (r.d.hours || 1); h++) used[h] = (used[h] || 0) + (+r.d.usage || 1);
    });
    return used;
  }

  /** '' if the selection fits, otherwise a customer-facing reason. */
  checkFree(sel, ignoreId) {
    const cat = this.catalog();
    const kind = P.kindOf(sel);
    if (!P.isISODate(sel.startDate) || sel.startDate < P.todayIST()) return 'Please choose a future date.';
    if (kind === 'event') {
      const occ = this.occupancy(sel.venueId, ignoreId);
      if (!P.eventDates(sel.startDate, sel.days).every(d => !occ[d])) return 'Sorry — those dates are no longer available at this venue. Please choose other dates.';
      for (const a of (sel.accommodation || [])) {
        if (!a.units) continue;
        const s = (cat.stays || []).find(x => x.id === a.id); if (!s) return 'Please choose valid accommodation.';
        const used = this.stayNights(s.id, ignoreId), bl = this.blockedDates(s.id);
        const night = P.eventDates(sel.startDate, sel.days).find(d => bl[d] || (used[d] || 0) + a.units > s.units);
        if (night) return `Only ${Math.max(0, bl[night] ? 0 : s.units - (used[night] || 0))} ${s.unitWord || 'unit'}(s) are free on ${P.fmtDate(night)}. Please reduce the number or change dates.`;
      }
      return '';
    }
    if (kind === 'stay') {
      const s = (cat.stays || []).find(x => x.id === sel.venueId); if (!s) return 'Please choose a stay.';
      const used = this.stayNights(s.id, ignoreId), bl = this.blockedDates(s.id);
      const night = P.eventDates(sel.startDate, sel.days).find(d => bl[d] || (used[d] || 0) + (+sel.units || 1) > s.units);
      return night ? `Sorry — not enough ${s.unitWord || 'unit'}s are free on the night of ${P.fmtDate(night)}. Please change your dates or the number of ${s.unitWord || 'unit'}s.` : '';
    }
    const s = (cat.slots || []).find(x => x.id === sel.venueId); if (!s) return 'Please choose what to book.';
    if (this.blockedDates(s.id)[sel.startDate]) return `${s.name} is closed on that day. Please choose another date.`;
    const h0 = Math.round(+sel.startHour), hrs = P.slotHours(s, sel), need = P.slotUsage(s, sel);
    if (!(h0 >= s.open && h0 + hrs <= s.close)) return `${s.name} is open ${P.fmtHour(s.open)} – ${P.fmtHour(s.close)}.`;
    if (sel.startDate === P.todayIST() && h0 <= P.hourIST()) return 'Please choose a later time today.';
    const used = this.slotHours(s.id, sel.startDate, ignoreId);
    for (let h = h0; h < h0 + hrs; h++) if ((used[h] || 0) + need > s.units) return `Sorry — ${P.fmtHour(h)} is already taken. Please choose another time.`;
    return '';
  }

  isRangeFree(venueId, start, days, ignoreId) {
    if (!P.isISODate(start) || start < P.todayIST()) return false;
    const occ = this.occupancy(venueId, ignoreId);
    return P.eventDates(start, days).every(d => !occ[d]);
  }

  insertBooking(b, accessKey) {
    const now = Date.now();
    const { id, createdAt, source, status, venueId, startDate, days, holdUntil, quoteNo, invoiceNo, payments, history, accessKey: _k, ...rest } = b;
    this.db.prepare(`INSERT INTO bookings(id,created_at,updated_at,source,status,venue_id,start_date,days,email,hold_until,access_key,quote_no,invoice_no,data)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, createdAt || now, now, source, status, venueId, startDate, days, rest.customer.email.toLowerCase(), holdUntil || null, accessKey, quoteNo, invoiceNo || null, JSON.stringify(rest));
  }
  saveBooking(b) {
    const { id, createdAt, updatedAt, source, status, venueId, startDate, days, holdUntil, quoteNo, invoiceNo, payments, history, accessKey, ...rest } = b;
    this.db.prepare(`UPDATE bookings SET updated_at=?,status=?,venue_id=?,start_date=?,days=?,email=?,hold_until=?,quote_no=?,invoice_no=?,data=? WHERE id=?`)
      .run(Date.now(), status, venueId, startDate, days, rest.customer.email.toLowerCase(), holdUntil || null, quoteNo, invoiceNo || null, JSON.stringify(rest), id);
  }
  addHistory(bookingId, status, note, actor) {
    this.db.prepare('INSERT INTO history(booking_id,at,status,note,actor) VALUES(?,?,?,?,?)').run(bookingId, Date.now(), status, note, actor || null);
  }

  /* ---------- payments ---------- */
  paymentByGatewayId(pid) { return this.db.prepare('SELECT * FROM payments WHERE gateway_payment_id=?').get(pid); }
  insertPayment(p) {
    this.db.prepare(`INSERT INTO payments(id,booking_id,at,amount,method,ref,type,receipt_no,gateway_payment_id,gateway_order_id,recorded_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(p.id, p.bookingId, p.at, p.amount, p.method, p.ref || null, p.type, p.receiptNo, p.gatewayPaymentId || null, p.gatewayOrderId || null, p.recordedBy || null);
  }
  insertOrder(o) { this.db.prepare('INSERT INTO orders(id,booking_id,created_at,amount,type,status) VALUES(?,?,?,?,?,?)').run(o.id, o.bookingId, Date.now(), o.amount, o.type, 'created'); }
  getOrder(id) { return this.db.prepare('SELECT * FROM orders WHERE id=?').get(id); }
  setOrderStatus(id, s) { this.db.prepare('UPDATE orders SET status=? WHERE id=?').run(s, id); }

  /* ---------- blocked dates ---------- */
  blockedAll() { return this.db.prepare('SELECT venue_id AS venueId, date, reason FROM blocked ORDER BY date').all().map(x => Object.assign({}, x)); }
  toggleBlock(venueId, date, reason) {
    const ex = this.db.prepare('SELECT 1 FROM blocked WHERE venue_id=? AND date=?').get(venueId, date);
    if (ex) { this.db.prepare('DELETE FROM blocked WHERE venue_id=? AND date=?').run(venueId, date); return false; }
    this.db.prepare('INSERT INTO blocked(venue_id,date,reason) VALUES(?,?,?)').run(venueId, date, reason || 'Unavailable');
    return true;
  }

  /* ---------- emails ---------- */
  logEmail(e) {
    this.db.prepare('INSERT INTO emails(id,at,to_addr,booking_id,subject,body,attachments,status,error) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(e.id, Date.now(), e.to, e.bookingId || null, e.subject, e.body, JSON.stringify(e.attachments || []), e.status, e.error || null);
  }
  setEmailStatus(id, status, error) { this.db.prepare('UPDATE emails SET status=?, error=? WHERE id=?').run(status, error || null, id); }
  recentEmails(n) {
    return this.db.prepare('SELECT * FROM emails ORDER BY at DESC LIMIT ?').all(n || 200).map(e => ({
      id: e.id, at: e.at, to: e.to_addr, bookingId: e.booking_id, subject: e.subject, body: e.body,
      attachments: JSON.parse(e.attachments || '[]'), status: e.status, error: e.error
    }));
  }

  /* ---------- admins & sessions ---------- */
  adminCount() { return this.db.prepare('SELECT COUNT(*) AS n FROM admins').get().n; }
  adminByEmail(email) { return this.db.prepare('SELECT * FROM admins WHERE email=?').get(String(email || '').toLowerCase()); }
  adminById(id) { return this.db.prepare('SELECT * FROM admins WHERE id=?').get(id); }
  createAdmin(email, name, hash) { this.db.prepare('INSERT INTO admins(email,name,pw_hash,created_at) VALUES(?,?,?,?)').run(email.toLowerCase(), name || '', hash, Date.now()); }
  setAdminPassword(id, hash) { this.db.prepare('UPDATE admins SET pw_hash=? WHERE id=?').run(hash, id); this.db.prepare('DELETE FROM sessions WHERE admin_id=?').run(id); }
  createSession(adminId, ttlMs) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO sessions(token_hash,admin_id,expires) VALUES(?,?,?)').run(sha256(token), adminId, Date.now() + ttlMs);
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    return token;
  }
  sessionAdmin(token) {
    if (!token) return null;
    const s = this.db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires > ?').get(sha256(token), Date.now());
    return s ? this.adminById(s.admin_id) : null;
  }
  deleteSession(token) { if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(token)); }
}

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
/** Indian financial year label, e.g. 26-27 for Apr 2026 – Mar 2027. */
function financialYear() {
  const t = P.todayIST(); const y = +t.slice(0, 4), m = +t.slice(5, 7);
  const s = m >= 4 ? y : y - 1;
  return `${String(s).slice(2)}-${String(s + 1).slice(2)}`;
}

module.exports = { open, DEFAULT_CATALOG, DEFAULT_SETTINGS, financialYear };
