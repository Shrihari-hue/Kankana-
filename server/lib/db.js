'use strict';
/* SQLite storage using Node's built-in node:sqlite (Node 22.13+). */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const P = require('../../assets/kankana-pricing.js');

const DEFAULT_CATALOG = {
  venues: [
    { id: 'uluwatu', name: 'Clifftop Pavilion, Uluwatu', region: 'Bali', capacity: 250, perDay: 850000, blurb: 'Open-air mandap above the Indian Ocean, sunset pheras.', active: true },
    { id: 'ubud', name: 'Villa Kancana, Ubud', region: 'Bali', capacity: 120, perDay: 620000, blurb: 'Five jungle pavilions for intimate multi-day celebrations.', active: true },
    { id: 'inle', name: 'Inle Lake Pavilion', region: 'Myanmar', capacity: 300, perDay: 540000, blurb: 'Lantern-lit lakeside receptions on stilted teak decks.', active: true },
    { id: 'bagan', name: 'Bagan Temple Gardens', region: 'Myanmar', capacity: 400, perDay: 710000, blurb: 'Temple-inspired décor among ten thousand spires.', active: true }
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

const DEFAULT_SETTINGS = {
  advancePct: 30,
  gstPct: 18,
  holdHours: 72,
  roomRate: 18000,
  maxDays: 5,
  balanceDueDaysBefore: 30,
  company: {
    name: 'Kankana — Weddings & Beyond',
    legalName: 'Kankana Weddings',
    address: 'Bengaluru, Karnataka, India',
    email: 'hello@kankana.in',
    phone: '+91 90000 00000',
    gstin: '',
    state: 'Karnataka',
    sac: '998596'
  },
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
    return { venues: c.venues.filter(x => x.active !== false), packages: c.packages.filter(x => x.active !== false), addons: c.addons.filter(x => x.active !== false) };
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
