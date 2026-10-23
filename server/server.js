'use strict';
/* =========================================================================
   Kankana website server — zero dependencies (Node.js 22.13+).
   Serves the site's HTML/assets and the booking, payment and admin APIs.
   Run:  node server/server.js      (reads server/.env if present)
   ========================================================================= */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

loadEnv(path.join(__dirname, '.env'));
process.removeAllListeners('warning');
process.on('warning', w => { if (w.name !== 'ExperimentalWarning') console.warn(w); });

const P = require('../assets/kankana-pricing.js');
const DB = require('./lib/db');
const rzp = require('./lib/razorpay');
const mailer = require('./lib/mailer');
const { createService, HttpError } = require('./lib/service');
const { createCrm } = require('./lib/crm');
const { createMessaging } = require('./lib/messages');
const { createReports } = require('./lib/reports');
const { createEvents } = require('./lib/events');

const PORT = +(process.env.PORT || 3000);
const PROD = process.env.NODE_ENV === 'production';
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const SESSION_TTL = 12 * 3600 * 1000;
const scrypt = promisify(crypto.scrypt);

const store = DB.open(DATA_DIR);
const hooks = {};
const svc = createService(store, { defaultUrl: `http://localhost:${PORT}`, hooks });
const crm = createCrm(store);
const adminByActor = a => (a && typeof a === 'object') ? a : (a ? store.adminByEmail(a) : null);
hooks.onPayment = (b, pay, actor) => crm.onPayment(b, pay, adminByActor(actor));
hooks.onStatus = (b, status, actor) => crm.onStatus(b, status, adminByActor(actor));
const msg = createMessaging({ store, crm, svc, mailer });
const reports = createReports({ store, crm });
const events = createEvents({ store, crm, svc, msg });
hooks.onPayment = (b, pay, actor) => { crm.onPayment(b, pay, adminByActor(actor)); events.onPayment(b); };
// Automations: shortly after start, then every 5 minutes.
setTimeout(() => msg.run(), 20000).unref();
setInterval(() => msg.run(), 5 * 60000).unref();

/* ---------------- env loader ---------------- */
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith('#')) return;
    let v = m[2]; if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  });
}

/* ---------------- passwords ---------------- */
async function hashPw(pw) { const salt = crypto.randomBytes(16); const k = await scrypt(pw, salt, 64); return `scrypt$${salt.toString('hex')}$${k.toString('hex')}`; }
async function checkPw(pw, stored) {
  const [alg, salt, hex] = String(stored).split('$'); if (alg !== 'scrypt') return false;
  const k = await scrypt(String(pw), Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(k, Buffer.from(hex, 'hex'));
}

/* first admin */
(async () => {
  if (store.adminCount() > 0) return;
  let email = process.env.ADMIN_EMAIL, pw = process.env.ADMIN_PASSWORD;
  if (!email) email = 'admin@kankana.local';
  let generated = false;
  if (!pw) { pw = crypto.randomBytes(9).toString('base64url'); generated = true; }
  store.createAdmin(email, 'Admin', await hashPw(pw)); // first login is an owner (role defaults to owner)
  console.log(`\n  Admin account created: ${email}${generated ? `\n  Temporary password:     ${pw}\n  (change it in Admin → Settings)` : ''}\n`);
})();

/* ---------------- rate limiting ---------------- */
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(); let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++; return b.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60000).unref();

/* ---------------- helpers ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://checkout.razorpay.com https://*.razorpay.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: https:",
  "media-src 'self' https:",
  "connect-src 'self' https://*.razorpay.com",
  "frame-src https://*.razorpay.com",
  "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'"
].join('; ');

function secHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self "https://checkout.razorpay.com" "https://api.razorpay.com")');
  res.setHeader('Content-Security-Policy', CSP);
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function clientIp(req) {
  if (process.env.TRUST_PROXY === '1') { const f = req.headers['x-forwarded-for']; if (f) return String(f).split(',')[0].trim(); }
  return req.socket.remoteAddress || '?';
}
function readBody(req, limit = 200 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const ct = String(req.headers['content-type'] || '');
  if (!ct.includes('application/json')) throw new HttpError(415, 'Expected JSON');
  const raw = await readBody(req);
  try { return raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch (e) { throw new HttpError(400, 'Invalid JSON'); }
}
function cookies(req) {
  const out = {}; String(req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
const COOKIE = PROD ? '__Host-kk_admin' : 'kk_admin';
function setSessionCookie(res, token, maxAgeMs) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token ? encodeURIComponent(token) : ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${PROD ? '; Secure' : ''}`);
}
function adminFrom(req) { return store.sessionAdmin(cookies(req)[COOKIE]); }

/* ---------------- public shapes ---------------- */
function publicSettings() {
  const s = store.settings();
  return { advancePct: s.advancePct, gstPct: s.gstPct, holdHours: s.holdHours, roomRate: s.roomRate, maxDays: s.maxDays, balanceDueDaysBefore: s.balanceDueDaysBefore,
    stayAdvancePct: s.stayAdvancePct, stayHoldHours: s.stayHoldHours, maxNights: s.maxNights, slotAdvancePct: s.slotAdvancePct, slotHoldMinutes: s.slotHoldMinutes,
    company: s.company, terms: s.terms, stayTerms: s.stayTerms, slotTerms: s.slotTerms, payments: rzp.mode(), razorpayKeyId: rzp.keys() ? rzp.keys().id : null };
}
function customerView(b) {
  const { accessKey, source, ...rest } = b;
  return Object.assign(rest, { key: accessKey, due: svc.paymentKind(b) });
}
function publicOccupancy(venueId) {
  const occ = store.occupancy(venueId), out = {};
  Object.entries(occ).forEach(([d, v]) => { out[d] = v.state; });
  return out;
}
function customerBooking(id, key) {
  const row = store.bookingRow(id);
  if (!row || !key || row.access_key.length !== String(key).length || !crypto.timingSafeEqual(Buffer.from(row.access_key), Buffer.from(String(key)))) return null;
  return store.getBooking(id, { withKey: true });
}

/* ---------------- routes ---------------- */
const routes = [];
const route = (method, pattern, handler, o = {}) => {
  const keys = []; const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, o });
};

route('GET', '/api/health', () => ({ ok: true, payments: rzp.mode(), email: mailer.configured() }));

route('GET', '/api/catalog', () => ({ catalog: store.activeCatalog(), settings: publicSettings(), today: P.todayIST() }));

route('GET', '/api/availability', (req, url) => {
  const cat = store.catalog(), today = P.todayIST();
  const v = url.searchParams.get('venue'), st = url.searchParams.get('stay'), sl = url.searchParams.get('slot');
  if (v) {
    if (!cat.venues.some(x => x.id === v)) throw new HttpError(400, 'Unknown venue');
    return { venue: v, dates: publicOccupancy(v), today };
  }
  if (st) {
    const item = (cat.stays || []).find(x => x.id === st); if (!item) throw new HttpError(400, 'Unknown stay');
    const used = store.stayNights(st), bl = store.blockedDates(st), free = {};
    Object.keys(used).forEach(d => { free[d] = Math.max(0, item.units - used[d]); });
    Object.keys(bl).forEach(d => { free[d] = 0; });
    return { stay: st, units: item.units, free, today };
  }
  if (sl) {
    const item = (cat.slots || []).find(x => x.id === sl); if (!item) throw new HttpError(400, 'Unknown reservation');
    const date = url.searchParams.get('date');
    const closed = {}; Object.keys(store.blockedDates(sl)).forEach(d => { closed[d] = true; });
    if (!date) return { slot: sl, closed, today, hourNow: P.hourIST() };
    if (!P.isISODate(date)) throw new HttpError(400, 'Invalid date');
    const used = store.slotHours(sl, date), free = {};
    for (let h = item.open; h < item.close; h++) free[h] = closed[date] ? 0 : Math.max(0, item.units - (used[h] || 0));
    return { slot: sl, date, units: item.units, free, closed, today, hourNow: P.hourIST() };
  }
  throw new HttpError(400, 'Choose what to check');
});

route('POST', '/api/bookings', async (req, url, ctx) => {
  if (limited('book:' + ctx.ip, 15, 3600000)) throw new HttpError(429, 'Too many requests. Please try again later.');
  const body = await readJson(req);
  if (body.website) throw new HttpError(400, 'Rejected'); // honeypot
  const b = svc.createBooking(body, { source: 'website', status: 'quoted' });
  crm.onBookingCreated(b, {});
  return { booking: customerView(b) };
});

route('POST', '/api/bookings/lookup', async (req, url, ctx) => {
  if (limited('lookup:' + ctx.ip, 20, 900000)) throw new HttpError(429, 'Too many attempts. Please wait a few minutes.');
  const { id, email } = await readJson(req);
  const b = store.getBooking(String(id || '').trim(), { withKey: true });
  if (!b || b.customer.email !== String(email || '').trim().toLowerCase()) throw new HttpError(404, "We couldn't find a booking with that ID and email.");
  return { booking: customerView(b) };
});

route('GET', '/api/bookings/:id', (req, url, ctx, p) => {
  const admin = adminFrom(req);
  const b = admin ? store.getBooking(p.id, { withKey: true }) : customerBooking(p.id, url.searchParams.get('key'));
  if (!b) throw new HttpError(404, 'Booking not found');
  return { booking: customerView(b), settings: publicSettings() };
});

route('POST', '/api/bookings/:id/order', async (req, url, ctx, p) => {
  if (limited('order:' + ctx.ip, 30, 3600000)) throw new HttpError(429, 'Too many requests.');
  const { key } = await readJson(req);
  const b = customerBooking(p.id, key);
  if (!b) throw new HttpError(404, 'Booking not found');
  const o = await svc.createOrder(b);
  return Object.assign(o, { prefill: { name: b.customer.name, email: b.customer.email, contact: b.customer.phone }, bookingId: b.id, company: store.settings().company.name });
});

route('POST', '/api/payments/verify', async (req) => {
  const { orderId, paymentId, signature } = await readJson(req);
  if (!orderId || !paymentId || !signature) throw new HttpError(400, 'Missing payment details');
  const b = await svc.completeOnlinePayment(String(orderId), String(paymentId), String(signature));
  return { booking: customerView(b) };
});

/* dev-only: simulate a successful checkout (PAYMENTS_MODE=mock, never in production) */
route('POST', '/api/payments/mock-complete', async (req) => {
  if (rzp.mode() !== 'mock') throw new HttpError(404, 'Not found');
  const { orderId } = await readJson(req);
  const paymentId = 'pay_mock_' + crypto.randomBytes(7).toString('hex');
  return { orderId, paymentId, signature: rzp.mockSignature(orderId, paymentId) };
});

route('POST', '/api/razorpay/webhook', async (req) => {
  const raw = await readBody(req, 1024 * 1024);
  if (!rzp.verifyWebhook(raw, req.headers['x-razorpay-signature'])) throw new HttpError(400, 'Invalid signature');
  return svc.handleWebhook(JSON.parse(raw.toString('utf8')));
});

route('GET', '/api/docs/:id/:type', (req, url, ctx, p) => {
  const admin = adminFrom(req);
  const b = admin ? store.getBooking(p.id, { withKey: true }) : customerBooking(p.id, url.searchParams.get('key'));
  if (!b) throw new HttpError(404, 'Document not found');
  const type = p.type.replace(/\.pdf$/, '');
  const d = svc.renderPdf(b, type, url.searchParams.get('pay'));
  return { __raw: true, type: 'application/pdf', body: d.buf, headers: { 'Content-Disposition': `${url.searchParams.get('download') ? 'attachment' : 'inline'}; filename="${d.name}"` } };
});

/* ---------- admin ---------- */
route('POST', '/api/admin/login', async (req, url, ctx) => {
  if (limited('login:' + ctx.ip, 8, 900000)) throw new HttpError(429, 'Too many login attempts. Try again in 15 minutes.');
  const { email, password } = await readJson(req);
  const a = store.adminByEmail(email);
  const ok = a ? await checkPw(password || '', a.pw_hash) : (await hashPw('x'), false);
  if (!ok) throw new HttpError(401, 'Incorrect email or password.');
  if (a.active === 0) throw new HttpError(403, 'This login has been turned off. Ask an owner to turn it back on.');
  ctx.res.__cookie = store.createSession(a.id, SESSION_TTL);
  return { ok: true, admin: { email: a.email, name: a.name, role: crm.roleOf(a) } };
});
route('POST', '/api/admin/logout', (req, url, ctx) => { store.deleteSession(cookies(req)[COOKIE]); ctx.res.__cookie = ''; return { ok: true }; });
route('GET', '/api/admin/me', (req, url, ctx) => ({ admin: { id: ctx.admin.id, email: ctx.admin.email, name: ctx.admin.name, role: crm.roleOf(ctx.admin) } }), { admin: true });

route('GET', '/api/admin/state', (req, url, ctx) => ({
  bookings: store.allBookings(), blocked: store.blockedAll(), catalog: store.catalog(), settings: store.settings(),
  emails: store.recentEmails(200), today: P.todayIST(),
  me: { id: ctx.admin.id, email: ctx.admin.email, name: ctx.admin.name || '', role: crm.roleOf(ctx.admin) },
  team: crm.team().map(t => crm.roleOf(ctx.admin) === 'owner' ? t : { id: t.id, name: t.name, role: t.role, active: t.active }),
  leads: crm.leadSummaries(), tasks: crm.listTasks(), crm: Object.assign({ stages: crm.STAGES, roles: crm.ROLES }, crm.lists()),
  messaging: Object.assign({ templates: msg.templates(), placeholders: msg.PLACEHOLDERS, emailOn: msg.emailOn() },
    crm.roleOf(ctx.admin) === 'owner' ? { auto: msg.autoSettings(), log: msg.recentLog(40), lastRun: msg.lastRun() } : {}),
  system: { payments: rzp.mode(), email: mailer.configured(), webhook: !!process.env.RAZORPAY_WEBHOOK_SECRET, siteUrl: process.env.SITE_URL || null, admin: ctx.admin.email }
}), { admin: true });

route('POST', '/api/admin/bookings', async (req, url, ctx) => {
  const body = await readJson(req);
  const status = body.status === 'enquiry' ? 'enquiry' : 'quoted';
  const b = svc.createBooking(body, { source: 'admin', status, actor: ctx.admin.email, silent: status === 'enquiry' });
  const leadId = crm.onBookingCreated(b, { leadId: body.leadId || null, actor: ctx.admin });
  return { booking: b, leadId };
}, { admin: true, roles: ['owner', 'sales'] });
route('PUT', '/api/admin/bookings/:id', async (req, url, ctx, p) => {
  const body = await readJson(req);
  let b = svc.updateBooking(p.id, body, ctx.admin.email);
  if (['enquiry', 'cancelled'].includes(b.status) && body.sendQuote) b = svc.setStatus(b.id, 'quoted', 'Quotation sent to client', ctx.admin.email, { email: false });
  return { booking: b };
}, { admin: true, roles: ['owner', 'sales'] });
route('POST', '/api/admin/bookings/:id/status', async (req, url, ctx, p) => {
  const { status, note, notify } = await readJson(req);
  return { booking: svc.setStatus(p.id, status, note, ctx.admin.email, { email: notify !== false }) };
}, { admin: true, roles: ['owner', 'sales', 'events'] });
route('POST', '/api/admin/bookings/:id/payments', async (req, url, ctx, p) => {
  const { amount, method, ref } = await readJson(req);
  const b = store.getBooking(p.id); if (!b) throw new HttpError(404, 'Booking not found');
  const due = b.quote.total - b.payments.reduce((s, x) => s + x.amount, 0);
  if (+amount > due) throw new HttpError(400, `Amount is more than the balance due (${P.inr(due)}).`);
  return svc.recordPayment(p.id, { amount, method, ref }, ctx.admin.email);
}, { admin: true, roles: ['owner', 'accounts'] });
route('POST', '/api/admin/bookings/:id/resend', async (req, url, ctx, p) => {
  const { kind } = await readJson(req);
  svc.resendEmail(p.id, kind); return { ok: true };
}, { admin: true, roles: ['owner', 'sales', 'accounts'] });
route('POST', '/api/admin/blocked', async (req) => {
  const { venueId, date, reason } = await readJson(req);
  if (!P.findResource(store.catalog(), venueId) || !P.isISODate(date)) throw new HttpError(400, 'Invalid date or venue');
  return { blocked: store.toggleBlock(venueId, date, String(reason || '').slice(0, 120)) };
}, { admin: true, roles: ['owner', 'sales', 'events'] });
/* Live availability check for the admin quotation builder (same rules as saving). */
route('POST', '/api/admin/check', async (req) => {
  const b = await readJson(req);
  const sel = {
    kind: ['stay', 'slot'].includes(b.kind) ? b.kind : 'event', venueId: String(b.venueId || ''), startDate: String(b.startDate || ''),
    days: Math.max(1, Math.round(+b.days || 1)), units: Math.max(1, Math.round(+b.units || 1)), guests: Math.max(1, Math.round(+b.guests || 1)),
    startHour: Math.round(+b.startHour), hours: Math.max(1, Math.round(+b.hours || 1)),
    accommodation: (Array.isArray(b.accommodation) ? b.accommodation : []).slice(0, 20).map(a => ({ id: String(a.id || ''), units: Math.max(0, Math.round(+a.units || 0)) })).filter(a => a.units)
  };
  if (!P.findResource(store.catalog(), sel.venueId)) return { reason: 'Choose what is being booked.' };
  return { reason: store.checkFree(sel, b.ignoreId ? String(b.ignoreId) : null) };
}, { admin: true, roles: ['owner', 'sales'] });
route('PUT', '/api/admin/settings', async (req) => {
  const b = await readJson(req); const s = store.settings();
  const num = (v, lo, hi, d) => { const n = +v; return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const next = Object.assign(s, {
    advancePct: num(b.advancePct, 1, 100, s.advancePct), gstPct: num(b.gstPct, 0, 28, s.gstPct), holdHours: num(b.holdHours, 1, 720, s.holdHours),
    roomRate: num(b.roomRate, 0, 1e7, s.roomRate), maxDays: num(b.maxDays, 1, 14, s.maxDays), balanceDueDaysBefore: num(b.balanceDueDaysBefore, 0, 365, s.balanceDueDaysBefore),
    stayAdvancePct: num(b.stayAdvancePct, 1, 100, s.stayAdvancePct), stayHoldHours: num(b.stayHoldHours, 1, 720, s.stayHoldHours), maxNights: num(b.maxNights, 1, 60, s.maxNights),
    slotAdvancePct: num(b.slotAdvancePct, 1, 100, s.slotAdvancePct), slotHoldMinutes: num(b.slotHoldMinutes, 5, 1440, s.slotHoldMinutes)
  });
  if (b.company) ['name', 'legalName', 'address', 'email', 'phone', 'gstin', 'state', 'sac'].forEach(k => { if (k in b.company) next.company[k] = String(b.company[k] || '').slice(0, 200); });
  ['terms', 'stayTerms', 'slotTerms'].forEach(k => { if (Array.isArray(b[k])) next[k] = b[k].map(t => String(t).slice(0, 400)).filter(Boolean).slice(0, 12); });
  store.setKV('settings', next);
  return { settings: store.settings() };
}, { admin: true, roles: ['owner'] });
route('PUT', '/api/admin/catalog', async (req) => {
  const b = await readJson(req);
  const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const str = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
  const pos = (n, d = 0) => Math.max(0, Math.round(+n || d));
  const uniq = (list, mk) => { const seen = new Set(); return (list || []).map(mk).filter(x => x.id && x.name && !seen.has(x.id) && seen.add(x.id)); };
  const gst = v => (v === '' || v == null || !Number.isFinite(+v)) ? '' : Math.min(28, Math.max(0, +v));
  const hour = (v, d) => Math.min(24, Math.max(0, Math.round(Number.isFinite(+v) ? +v : d)));
  const cat = {
    venues: uniq(b.venues, v => ({ id: slug(v.id || v.name), name: str(v.name, 120), region: str(v.region, 60), capacity: pos(v.capacity, 100), perDay: pos(v.perDay), blurb: str(v.blurb, 240), active: v.active !== false })),
    stays: uniq(b.stays, v => ({ id: slug(v.id || v.name), name: str(v.name, 120), unitWord: str(v.unitWord, 20).toLowerCase() || 'unit', units: Math.max(1, pos(v.units, 1)), sleeps: Math.max(1, pos(v.sleeps, 2)), perNight: pos(v.perNight), gstPct: gst(v.gstPct), sac: str(v.sac, 10), blurb: str(v.blurb, 240), active: v.active !== false })),
    slots: uniq(b.slots, v => { const open = hour(v.open, 6), close = Math.max(open + 1, hour(v.close, 22));
      return { id: slug(v.id || v.name), name: str(v.name, 120), per: v.per === 'guest' ? 'guest' : 'hour', units: Math.max(1, pos(v.units, 1)), rate: pos(v.rate), open, close,
        maxHours: Math.max(1, Math.min(12, pos(v.maxHours, 2))), sitting: Math.max(1, Math.min(6, pos(v.sitting, 2))), maxGuests: Math.max(1, pos(v.maxGuests, 10)),
        gstPct: gst(v.gstPct), sac: str(v.sac, 10), blurb: str(v.blurb, 240), active: v.active !== false }; }),
    packages: uniq(b.packages, p => ({ id: slug(p.id || p.name), name: str(p.name, 80), perGuest: pos(p.perGuest), desc: str(p.desc, 240), active: p.active !== false })),
    addons: uniq(b.addons, a => ({ id: slug(a.id || a.name), name: str(a.name, 120), price: pos(a.price), unit: a.unit === 'perGuest' ? 'perGuest' : 'flat', active: a.active !== false }))
  };
  if (!cat.venues.length || !cat.packages.length) throw new HttpError(400, 'Keep at least one venue and one package.');
  const ids = [...cat.venues, ...cat.stays, ...cat.slots].map(x => x.id);
  const dup = ids.find((x, i) => ids.indexOf(x) !== i);
  if (dup) throw new HttpError(400, `Two items share the name/id "${dup}". Give each venue, stay and reservation a different name.`);
  store.setKV('catalog', cat);
  return { catalog: cat };
}, { admin: true, roles: ['owner'] });
route('POST', '/api/admin/password', async (req, url, ctx) => {
  const { current, next } = await readJson(req);
  if (!(await checkPw(current || '', ctx.admin.pw_hash))) throw new HttpError(400, 'Current password is incorrect.');
  if (String(next || '').length < 10) throw new HttpError(400, 'Use at least 10 characters.');
  store.setAdminPassword(ctx.admin.id, await hashPw(next));
  ctx.res.__cookie = store.createSession(ctx.admin.id, SESSION_TTL);
  return { ok: true };
}, { admin: true });
route('POST', '/api/admin/test-email', async (req, url, ctx) => {
  const { to } = await readJson(req);
  await mailer.send({ to: to || ctx.admin.email, subject: 'Kankana test email', text: 'Email delivery is working.', html: '<p>Email delivery is working. ✦ Kankana</p>' });
  return { ok: true };
}, { admin: true, roles: ['owner'] });
route('GET', '/api/admin/export.csv', () => {
  const cols = ['Booking ID', 'Created', 'Status', 'Type', 'Client', 'Email', 'Phone', 'City', 'Booked', 'When', 'Start', 'Days/Nights', 'Guests', 'Details', 'Total', 'Paid', 'Balance', 'Quotation', 'Invoice'];
  const rows = store.allBookings().map(b => { const paid = b.payments.reduce((s, p) => s + p.amount, 0), ds = P.describe(b); return [b.id, new Date(b.createdAt).toISOString(), P.STATUSES[b.status].label, ds.label, b.customer.name, b.customer.email, b.customer.phone, b.customer.city, b.venueName, ds.when, b.startDate, b.days, b.guests, [ds.people].concat(ds.extras).join(' · '), b.quote.total, paid, b.quote.total - paid, b.quoteNo, b.invoiceNo || '']; });
  const csv = [cols, ...rows].map(r => r.map(x => { let s = String(x == null ? '' : x); if (/^[=+\-@]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; }).join(',')).join('\r\n');
  return { __raw: true, type: 'text/csv; charset=utf-8', body: '﻿' + csv, headers: { 'Content-Disposition': 'attachment; filename="kankana-bookings.csv"' } };
}, { admin: true, roles: ['owner', 'accounts'] });

route('GET', '/api/admin/backup', () => {
  const tmp = path.join(DATA_DIR, `backup-${Date.now()}.db`);
  store.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  const buf = fs.readFileSync(tmp); fs.unlinkSync(tmp);
  const stamp = P.todayIST();
  return { __raw: true, type: 'application/octet-stream', body: buf, headers: { 'Content-Disposition': `attachment; filename="kankana-backup-${stamp}.db"` } };
}, { admin: true, roles: ['owner'] });

/* ---------------- CRM: website enquiries ---------------- */
route('POST', '/api/enquiries', async (req, url, ctx) => {
  if (limited('enq:' + ctx.ip, 6, 3600000)) throw new HttpError(429, 'Thank you — we already have your enquiry. Our team will be in touch shortly.');
  const b = await readJson(req);
  if (b.website) return { ok: true }; // honeypot: pretend success
  const { lead, merged } = crm.createLead({
    name: b.name, phone: b.phone, email: b.email, city: b.city, eventType: b.eventType, eventDate: b.eventDate, guests: b.guests, message: b.message
  }, { source: 'Website' });
  const s = store.settings();
  const to = (s.company && s.company.email) || process.env.ADMIN_EMAIL;
  if (mailer.configured() && to) {
    const lines = [`Name: ${lead.name}`, `Phone: ${lead.phone}`, `Email: ${lead.email}`, `Event: ${lead.eventType || '—'} · ${lead.eventDate || 'date open'} · ${lead.guests || '?'} guests`, '', lead.message || ''];
    mailer.send({ to, subject: `${merged ? 'Repeat enquiry' : 'New enquiry'} — ${lead.name} (${lead.id})`, text: lines.join('\n'), html: lines.map(l => `<div>${String(l).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</div>`).join('') })
      .catch(e => console.error('[enquiry email]', e.message));
  }
  return { ok: true };
});

/* ---------------- CRM: leads, activities, follow-ups ---------------- */
route('GET', '/api/admin/leads/:id', (req, url, ctx, p) => {
  const l = crm.getLead(p.id); if (!l) throw new HttpError(404, 'Lead not found');
  return { lead: l, canEdit: crm.canEditLead(ctx.admin, l) };
}, { admin: true });
route('POST', '/api/admin/leads', async (req, url, ctx) => {
  const b = await readJson(req);
  return crm.createLead(b, { actor: ctx.admin, source: b.source || 'Other' });
}, { admin: true, roles: ['owner', 'sales'] });
route('PUT', '/api/admin/leads/:id', async (req, url, ctx, p) => ({ lead: crm.updateLead(p.id, await readJson(req), ctx.admin) }), { admin: true, roles: ['owner', 'sales'] });
route('DELETE', '/api/admin/leads/:id', (req, url, ctx, p) => ({ ok: crm.deleteLead(p.id, ctx.admin) }), { admin: true, roles: ['owner'] });
route('POST', '/api/admin/leads/:id/activity', async (req, url, ctx, p) => ({ lead: crm.logActivity(p.id, await readJson(req), ctx.admin) }), { admin: true });
route('POST', '/api/admin/tasks', async (req, url, ctx) => ({ task: crm.createTask(await readJson(req), ctx.admin) }), { admin: true });
route('PUT', '/api/admin/tasks/:id', async (req, url, ctx, p) => ({ task: crm.updateTask(p.id, await readJson(req), ctx.admin) }), { admin: true });
route('DELETE', '/api/admin/tasks/:id', (req, url, ctx, p) => ({ ok: crm.deleteTask(p.id, ctx.admin) }), { admin: true });
route('PUT', '/api/admin/crm-lists', async (req) => ({ lists: crm.setLists(await readJson(req)) }), { admin: true, roles: ['owner'] });

/* ---------------- messages & automations ---------------- */
route('POST', '/api/admin/messages/preview', async (req, url, ctx) => {
  const { templateId, leadId, bookingId } = await readJson(req);
  const lead = leadId ? crm.rawLead(leadId) : null;
  const booking = bookingId ? store.getBooking(bookingId, { withKey: true }) : (lead ? msg.latestBooking(lead.id) : null);
  return msg.render(templateId, { lead, booking, actor: ctx.admin });
}, { admin: true });
route('POST', '/api/admin/messages/send', async (req, url, ctx) => msg.send(await readJson(req), ctx.admin), { admin: true });
route('PUT', '/api/admin/templates', async (req) => ({ templates: msg.setTemplates((await readJson(req)).templates) }), { admin: true, roles: ['owner'] });
route('PUT', '/api/admin/automations', async (req) => ({ auto: msg.setAuto(await readJson(req)) }), { admin: true, roles: ['owner'] });
route('POST', '/api/admin/automations/run', () => msg.run(), { admin: true, roles: ['owner'] });

/* ---------------- events: planner, vendors, feedback ---------------- */
route('GET', '/api/admin/events', () => ({ events: events.list(), vendors: events.vendors(), sections: events.SECTIONS, vendorCategories: events.VENDOR_CATS }), { admin: true });
route('GET', '/api/admin/events/:id', (req, url, ctx, p) => Object.assign(events.getPlan(p.id), { canPlan: events.canPlan(ctx.admin) }), { admin: true });
route('POST', '/api/admin/events/:id/plan', (req, url, ctx, p) => { if (!events.canPlan(ctx.admin)) throw new HttpError(403, 'Only Owner and Events logins can start a plan.'); return events.createPlan(p.id, ctx.admin); }, { admin: true });
route('PUT', '/api/admin/events/:id', async (req, url, ctx, p) => events.setMeta(p.id, await readJson(req), ctx.admin), { admin: true });
route('POST', '/api/admin/events/:id/feedback-link', (req, url, ctx, p) => ({ feedback: events.feedbackFor(p.id) }), { admin: true });
route('POST', '/api/admin/plan-items', async (req, url, ctx) => ({ item: events.addItem(await readJson(req), ctx.admin) }), { admin: true });
route('PUT', '/api/admin/plan-items/:id', async (req, url, ctx, p) => ({ item: events.updateItem(p.id, await readJson(req), ctx.admin) }), { admin: true });
route('DELETE', '/api/admin/plan-items/:id', (req, url, ctx, p) => ({ ok: events.deleteItem(p.id, ctx.admin) }), { admin: true });
route('POST', '/api/admin/runsheet', async (req, url, ctx) => ({ line: events.saveRun(await readJson(req), ctx.admin) }), { admin: true });
route('PUT', '/api/admin/runsheet/:id', async (req, url, ctx, p) => ({ line: events.saveRun(await readJson(req), ctx.admin, p.id) }), { admin: true });
route('DELETE', '/api/admin/runsheet/:id', (req, url, ctx, p) => ({ ok: events.deleteRun(p.id, ctx.admin) }), { admin: true });
route('POST', '/api/admin/rooming', async (req, url, ctx) => ({ room: events.saveRoom(await readJson(req), ctx.admin) }), { admin: true });
route('PUT', '/api/admin/rooming/:id', async (req, url, ctx, p) => ({ room: events.saveRoom(await readJson(req), ctx.admin, p.id) }), { admin: true });
route('DELETE', '/api/admin/rooming/:id', (req, url, ctx, p) => ({ ok: events.deleteRoom(p.id, ctx.admin) }), { admin: true });
route('POST', '/api/admin/vendors', async (req, url, ctx) => ({ vendor: events.saveVendor(await readJson(req), ctx.admin) }), { admin: true });
route('PUT', '/api/admin/vendors/:id', async (req, url, ctx, p) => ({ vendor: events.saveVendor(await readJson(req), ctx.admin, p.id) }), { admin: true });
route('GET', '/api/admin/feedback', () => ({ feedback: events.allFeedback() }), { admin: true });
route('GET', '/api/admin/event-template', () => ({ template: events.template(), sections: events.SECTIONS }), { admin: true });
route('PUT', '/api/admin/event-template', async (req) => ({ template: events.setTemplate(await readJson(req)) }), { admin: true, roles: ['owner'] });
// public feedback page
route('GET', '/api/feedback/:token', (req, url, ctx, p) => events.publicFeedback(p.token));
route('POST', '/api/feedback/:token', async (req, url, ctx, p) => {
  if (limited('fb:' + ctx.ip, 10, 3600000)) throw new HttpError(429, 'Too many attempts. Please try again later.');
  return events.submitFeedback(p.token, await readJson(req));
});

/* ---------------- reports ---------------- */
route('GET', '/api/admin/reports', (req, url, ctx) => reports.build({
  from: url.searchParams.get('from'), to: url.searchParams.get('to'), occ: url.searchParams.get('occ') === 'range' ? 'range' : 'next90',
  withTeam: crm.roleOf(ctx.admin) === 'owner'
}), { admin: true, roles: ['owner', 'accounts'] });
route('GET', '/api/admin/leads.csv', () => ({ __raw: true, type: 'text/csv; charset=utf-8', body: '\ufeff' + reports.leadsCsv(),
  headers: { 'Content-Disposition': `attachment; filename="kankana-leads-${P.todayIST()}.csv"` } }), { admin: true, roles: ['owner'] });

/* ---------------- team logins ---------------- */
const tempPassword = () => crypto.randomBytes(9).toString('base64url');
route('POST', '/api/admin/team', async (req) => {
  const b = await readJson(req); const pw = tempPassword();
  return { member: crm.addMember(b, await hashPw(pw)), tempPassword: pw };
}, { admin: true, roles: ['owner'] });
route('PUT', '/api/admin/team/:id', async (req, url, ctx, p) => ({ member: crm.updateMember(p.id, await readJson(req), ctx.admin) }), { admin: true, roles: ['owner'] });
route('POST', '/api/admin/team/:id/reset', async (req, url, ctx, p) => {
  const a = store.adminById(+p.id); if (!a) throw new HttpError(404, 'Team member not found');
  if (a.id === ctx.admin.id) throw new HttpError(400, 'Change your own password under Your account.');
  const pw = tempPassword(); store.setAdminPassword(a.id, await hashPw(pw));
  return { tempPassword: pw };
}, { admin: true, roles: ['owner'] });

/* ---------------- static files ---------------- */
const STATIC_OK = p => /^\/[\w.-]+\.html$/.test(p) || /^\/assets\/[\w./-]+$/.test(p) || p === '/favicon.ico' || p === '/robots.txt';
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin') pathname = '/admin.html';
  if (!STATIC_OK(pathname) || pathname.includes('..')) return notFound(res);
  const file = path.join(ROOT, pathname);
  if (!file.startsWith(ROOT + path.sep)) return notFound(res);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
    const ext = path.extname(file).toLowerCase();
    const etag = `W/"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`;
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', ETag: etag, 'Last-Modified': st.mtime.toUTCString(),
      'Cache-Control': ext === '.html' ? 'no-cache' : (pathname.startsWith('/assets/') && /\.(png|jpe?g|webp|mp4|woff2)$/.test(ext) ? 'public, max-age=604800' : 'public, max-age=300') };
    if (pathname === '/admin.html') headers['X-Robots-Tag'] = 'noindex';
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}
function notFound(res) {
  const f = path.join(ROOT, '404.html');
  if (fs.existsSync(f)) { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); return fs.createReadStream(f).pipe(res); }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
}

/* ---------------- server ---------------- */
const server = http.createServer(async (req, res) => {
  secHeaders(res);
  const url = new URL(req.url, 'http://x');
  const pathname = decodeURIComponent(url.pathname);
  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, pathname);
  }
  const ctx = { ip: clientIp(req), res };
  try {
    const r = routes.find(x => x.method === req.method && x.re.test(pathname));
    if (!r) throw new HttpError(404, 'Not found');
    const params = {}; const m = pathname.match(r.re); r.keys.forEach((k, i) => { params[k] = m[i + 1]; });
    if (r.o.admin || pathname.startsWith('/api/admin/') && pathname !== '/api/admin/login') {
      ctx.admin = adminFrom(req);
      if (!ctx.admin || ctx.admin.active === 0) throw new HttpError(401, 'Please sign in.');
      if (r.o.roles && !r.o.roles.includes(crm.roleOf(ctx.admin))) throw new HttpError(403, `Your role (${crm.ROLES[crm.roleOf(ctx.admin)].label}) can’t do this. Ask an owner.`);
    }
    // CSRF: state-changing admin calls must carry our custom header (blocked cross-site without CORS).
    if (req.method !== 'GET' && pathname.startsWith('/api/admin/') && req.headers['x-kankana'] !== '1') throw new HttpError(403, 'Forbidden');
    const out = await r.handler(req, url, ctx, params);
    if (res.__cookie !== undefined) setSessionCookie(res, res.__cookie, res.__cookie ? SESSION_TTL : 0);
    if (out && out.__raw) { res.writeHead(200, Object.assign({ 'Content-Type': out.type, 'Cache-Control': 'private, no-store' }, out.headers)); return res.end(out.body); }
    json(res, 200, out);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(`[${new Date().toISOString()}] ${req.method} ${pathname}`, e);
    json(res, status, { error: status >= 500 && PROD ? 'Something went wrong. Please try again.' : e.message });
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 20000;

server.listen(PORT, () => {
  console.log(`Kankana running on http://localhost:${PORT}`);
  console.log(`  payments: ${rzp.mode()}   email: ${mailer.configured() ? 'on' : 'off (not configured)'}   data: ${DATA_DIR}`);
  if (PROD && !process.env.SITE_URL) console.warn('  ! SITE_URL is not set — links in emails will point to localhost');
});

function shutdown() { server.close(() => { try { store.db.close(); } catch (_) {} process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
