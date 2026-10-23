'use strict';
/* =========================================================================
   Kankana CRM — automatic lead capture.
   1. Tagged links & QR codes: /go/<key> counts the scan and opens the
      enquiry form (or booking page) with the source remembered, so the lead
      lands in the CRM marked "Instagram", "Walk-in · QR at reception"…
   2. The email reader: lead emails from WedMeGood, WeddingWire, JustDial…
      read from a Gmail label every 5 minutes (IMAP, app password), or pasted
      by the team, become leads.
   3. A webhook for other apps (Pabbly, Make, Zapier, inbound-email services).
   ========================================================================= */
const crypto = require('node:crypto');
const LM = require('./leadmail');
const imap = require('./imap');

const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
class CapError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = m => new CapError(400, m);

const DEFAULT_LINKS = [
  { key: 'instagram', label: 'Instagram bio', source: 'Instagram', target: 'enquire' },
  { key: 'facebook', label: 'Facebook page', source: 'Facebook', target: 'enquire' },
  { key: 'whatsapp', label: 'WhatsApp status & catalogue', source: 'WhatsApp', target: 'enquire' },
  { key: 'google', label: 'Google Business profile', source: 'Google', target: 'enquire' },
  { key: 'reception', label: 'QR at reception', source: 'Walk-in', target: 'enquire' }
];
const TARGETS = { enquire: '/#enquire', book: '/book.html' };
// ?src= / utm_source= words → CRM sources
const SRC_WORDS = [
  [/^(ig|insta|instagram)/i, 'Instagram'], [/^(fb|facebook|meta)/i, 'Facebook'], [/^(google|gads|adwords|gbp|gmb)/i, 'Google'],
  [/^(wa|whatsapp)/i, 'WhatsApp'], [/^(wmg|wedmegood)/i, 'WedMeGood'], [/^(qr|walk-?in|reception)/i, 'Walk-in'],
  [/^(planner|wedding-?planner)/i, 'Wedding planner'], [/^(ref|referral|friend)/i, 'Referral']
];
const REFERRERS = [
  [/(^|\.)instagram\.com$/i, 'Instagram'], [/(^|\.)(facebook|fb)\.com$|^l\.facebook\.com$|^m\.facebook\.com$/i, 'Facebook'],
  [/(^|\.)google\.[a-z.]+$/i, 'Google'], [/(^|\.)wedmegood\.com$/i, 'WedMeGood'], [/(^|\.)whatsapp\.com$|^wa\.me$/i, 'WhatsApp']
];

function createCapture({ store, crm, mailer }) {
  const db = store.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS lead_links (
      key TEXT PRIMARY KEY, label TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL DEFAULT 'enquire',
      created_at INTEGER NOT NULL, scans INTEGER NOT NULL DEFAULT 0, last_scan INTEGER
    );
    CREATE TABLE IF NOT EXISTS inbound_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, via TEXT NOT NULL, msg_id TEXT, from_addr TEXT, subject TEXT,
      platform TEXT, status TEXT NOT NULL, lead_id TEXT, note TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS inbound_emails_msg ON inbound_emails(msg_id) WHERE msg_id IS NOT NULL AND msg_id <> '';
  `);
  if (!store.getKV('capture:seeded')) {
    const ins = db.prepare('INSERT OR IGNORE INTO lead_links(key,label,source,target,created_at) VALUES(?,?,?,?,?)');
    DEFAULT_LINKS.forEach(l => ins.run(l.key, l.label, l.source, l.target, Date.now()));
    store.setKV('capture:seeded', true);
  }
  const siteUrl = () => String(process.env.SITE_URL || process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '')).replace(/\/$/, '');

  /* ---------------- tagged links ---------------- */
  const linkRow = r => r && ({ key: r.key, label: r.label, source: r.source, target: r.target, createdAt: r.created_at, scans: r.scans, lastScan: r.last_scan });
  function links() {
    const counts = {};
    db.prepare("SELECT json_extract(data,'$.link') AS k, COUNT(*) AS n FROM leads WHERE json_extract(data,'$.link') <> '' GROUP BY k").all().forEach(r => { counts[r.k] = r.n; });
    return db.prepare('SELECT * FROM lead_links ORDER BY created_at, key').all().map(r => Object.assign(linkRow(r), { leads: counts[r.key] || 0 }));
  }
  const slug = s => clean(s, 60).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  function saveLink(input, key = null) {
    const label = clean(input.label, 60), source = clean(input.source, 40);
    const target = TARGETS[input.target] ? input.target : 'enquire';
    if (key) {
      const cur = db.prepare('SELECT * FROM lead_links WHERE key=?').get(key); if (!cur) throw new CapError(404, 'Link not found');
      db.prepare('UPDATE lead_links SET label=?, source=?, target=? WHERE key=?').run(label || cur.label, source || cur.source, input.target ? target : cur.target, key);
      return linkRow(db.prepare('SELECT * FROM lead_links WHERE key=?').get(key));
    }
    if (!label) throw bad('Give the link a name, e.g. “Wedding expo, Jan 2027”.');
    if (!source) throw bad('Choose which source its leads should count as.');
    let k = slug(input.key || label) || 'link'; const base = k; let i = 2;
    while (db.prepare('SELECT 1 FROM lead_links WHERE key=?').get(k)) k = `${base}-${i++}`;
    db.prepare('INSERT INTO lead_links(key,label,source,target,created_at) VALUES(?,?,?,?,?)').run(k, label, source, target, Date.now());
    crm.ensureSource(source);
    return linkRow(db.prepare('SELECT * FROM lead_links WHERE key=?').get(k));
  }
  function deleteLink(key) { db.prepare('DELETE FROM lead_links WHERE key=?').run(key); return true; }
  /** /go/<key> → where to send the visitor (and count the scan). */
  function redirectFor(key) {
    const k = clean(key, 40).toLowerCase();
    const r = db.prepare('SELECT * FROM lead_links WHERE key=?').get(k);
    if (!r) return '/';
    db.prepare('UPDATE lead_links SET scans=scans+1, last_scan=? WHERE key=?').run(Date.now(), k);
    const t = TARGETS[r.target] || TARGETS.enquire, hash = t.indexOf('#');
    return hash >= 0 ? `${t.slice(0, hash)}?ref=${encodeURIComponent(k)}${t.slice(hash)}` : `${t}?ref=${encodeURIComponent(k)}`;
  }
  /** What the website remembered about how the visitor arrived → { source, campaign, link } or null. */
  function resolve(a) {
    if (!a || typeof a !== 'object') return null;
    const ref = clean(a.ref, 40).toLowerCase();
    if (ref) { const r = db.prepare('SELECT * FROM lead_links WHERE key=?').get(ref); if (r) return { source: r.source, campaign: r.label, link: r.key }; }
    const src = clean(a.src || a.utm_source, 40);
    const camp = clean(a.utm_campaign || a.campaign, 60);
    if (src) { const hit = SRC_WORDS.find(([re]) => re.test(src)); return { source: hit ? hit[1] : clean(src.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), 40), campaign: camp, link: '' }; }
    const host = clean(a.referrer, 200).replace(/^https?:\/\//i, '').split(/[/?#]/)[0].toLowerCase();
    if (host) { const hit = REFERRERS.find(([re]) => re.test(host)); if (hit) return { source: hit[1], campaign: camp, link: '' }; }
    return null;
  }

  /* ---------------- the email reader ---------------- */
  const ownEmails = () => {
    const s = store.settings();
    return [process.env.IMAP_USER, process.env.ADMIN_EMAIL, process.env.MAIL_FROM, s.company && s.company.email, ...crm.team().map(t => t.email)].filter(Boolean).map(e => String(e).toLowerCase().replace(/^.*</, '').replace(/>.*$/, ''));
  };
  const parse = mail => LM.parseLeadEmail(mail, { ownEmails: ownEmails(), eventTypes: crm.lists().eventTypes });
  function preview(text) {
    const t = String(text || '').slice(0, 200000);
    if (t.trim().length < 10) throw bad('Paste the whole email, including the name and phone number.');
    const looksRaw = /^(?:[\w-]+:.*\r?\n)+\r?\n/.test(t) && /^(?:from|subject|content-type):/im.test(t.slice(0, 3000));
    const mail = looksRaw ? LM.parseMime(t) : { text: t, subject: (t.match(/^subject:\s*(.+)$/im) || [])[1] || '', from: (t.match(/^from:\s*(.+)$/im) || [])[1] || '' };
    return parse(mail);
  }
  const log = (row) => db.prepare('INSERT OR IGNORE INTO inbound_emails(at,via,msg_id,from_addr,subject,platform,status,lead_id,note) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(Date.now(), row.via, row.msgId || null, clean(row.from, 200), clean(row.subject, 300), row.platform || '', row.status, row.leadId || null, clean(row.note, 500));
  /** One email → a lead (or a logged reason why not). */
  function importMail(mail, via) {
    const msgId = clean(mail.messageId, 300);
    if (msgId && db.prepare('SELECT 1 FROM inbound_emails WHERE msg_id=?').get(msgId)) return { status: 'duplicate' };
    const p = parse(mail);
    const base = { via, msgId, from: mail.from, subject: mail.subject, platform: p.platform };
    if (p.status === 'not_lead') { log(Object.assign(base, { status: 'skipped', note: 'No name, phone or email in it — probably a newsletter or notice.' })); return { status: 'skipped', parsed: p }; }
    if (p.status === 'hidden') {
      const note = `${p.platform || 'The site'} hid the contact details${p.fields.name ? ' of ' + p.fields.name : ''} — open the lead in ${p.platform || 'their'} app.`;
      log(Object.assign(base, { status: 'hidden', note }));
      crm.systemTask({ title: `${p.platform || 'Email'} lead${p.fields.name ? ' from ' + p.fields.name : ''}: number hidden — open it in the ${p.platform || 'listing'} app`, kind: 'follow_up', dueAt: Date.now() + 15 * 60000 });
      return { status: 'hidden', parsed: p };
    }
    try {
      crm.ensureSource(p.source);
      const { lead, merged } = crm.createLead(p.fields, { source: p.source, channelNote: via === 'imap' ? 'read from the leads mailbox' : via === 'webhook' ? 'sent by a connected app' : '', channel: 'Website' });
      log(Object.assign(base, { status: merged ? 'merged' : 'created', leadId: lead.id, note: `${lead.name} · ${p.found.length} details found` }));
      return { status: merged ? 'merged' : 'created', lead, parsed: p };
    } catch (e) {
      log(Object.assign(base, { status: 'failed', note: e.message }));
      return { status: 'failed', error: e.message, parsed: p };
    }
  }
  const recent = (n = 30) => db.prepare('SELECT * FROM inbound_emails ORDER BY id DESC LIMIT ?').all(n)
    .map(r => ({ id: r.id, at: r.at, via: r.via, from: r.from_addr, subject: r.subject, platform: r.platform, status: r.status, leadId: r.lead_id, note: r.note }));

  /* ---------------- the Gmail label, every 5 minutes ---------------- */
  const imapCfg = () => ({ host: process.env.IMAP_HOST || 'imap.gmail.com', port: +(process.env.IMAP_PORT || 993), user: process.env.IMAP_USER || '', pass: (process.env.IMAP_PASSWORD || '').replace(/\s+/g, ''), folder: process.env.IMAP_LABEL || 'Kankana leads' });
  const imapOn = () => { const c = imapCfg(); return !!(c.user && c.pass); };
  let polling = false;
  const FRIENDLY = {
    auth: 'Gmail refused the login. Check IMAP_USER and that IMAP_PASSWORD is a 16-letter app password (not your normal password).',
    folder: label => `There’s no Gmail label called “${label}”. Create it (or set IMAP_LABEL to the label’s exact name).`,
    timeout: 'Gmail didn’t answer in time. It will try again in 5 minutes.'
  };
  async function poll() {
    if (!imapOn() || polling) return mailboxStatus();
    polling = true;
    const c = imapCfg(), st = store.getKV('capture:imap') || {};
    const sameBox = st.user === c.user && st.folder === c.folder;
    try {
      const r = await imap.fetchNew({ host: c.host, port: c.port, user: c.user, pass: c.pass, folder: c.folder, afterUid: sameBox ? st.lastUid || 0 : 0, uidValidity: sameBox ? st.uidValidity || 0 : 0 });
      const results = r.messages.map(m => { try { const mail = LM.parseMime(m.raw); return importMail(mail, 'imap').status; } catch (e) { console.error('[leads mailbox] message', m.uid, e.message); return 'failed'; } });
      const made = results.filter(x => x === 'created' || x === 'merged').length;
      store.setKV('capture:imap', { user: c.user, folder: c.folder, uidValidity: r.uidValidity, lastUid: r.lastUid, lastRunAt: Date.now(), lastOkAt: Date.now(), lastError: '', lastCount: made, total: (sameBox ? st.total || 0 : 0) + made });
    } catch (e) {
      const msg = e.code === 'folder' ? FRIENDLY.folder(c.folder) : FRIENDLY[e.code] || `Couldn’t read the mailbox: ${e.message}`;
      store.setKV('capture:imap', Object.assign({}, st, { lastRunAt: Date.now(), lastError: msg }));
      console.error('[leads mailbox]', e.message);
    } finally { polling = false; }
    return mailboxStatus();
  }
  function mailboxStatus() {
    const c = imapCfg(), st = store.getKV('capture:imap') || {};
    return { configured: imapOn(), user: c.user, label: c.folder, lastRunAt: st.user === c.user ? st.lastRunAt || null : null, lastOkAt: st.user === c.user ? st.lastOkAt || null : null, lastError: st.user === c.user ? st.lastError || '' : '', total: st.user === c.user ? st.total || 0 : 0 };
  }

  /* ---------------- webhook for other apps ---------------- */
  function hookKey(regenerate = false) {
    let k = store.getKV('capture:hookKey');
    if (!k || regenerate) { k = crypto.randomBytes(18).toString('base64url'); store.setKV('capture:hookKey', k); }
    return k;
  }
  const keyOk = k => { const a = Buffer.from(String(k || '')), b = Buffer.from(hookKey()); return a.length === b.length && crypto.timingSafeEqual(a, b); };
  /** Accepts a ready lead ({name, phone, …}), a raw email ({raw}) or a parsed email ({subject, from, text|plain, html}, Cloudmailin-style headers too). */
  function webhook(body) {
    const b = body && typeof body === 'object' ? body : {};
    if (b.raw) return importMail(LM.parseMime(String(b.raw)), 'webhook');
    const h = b.headers && typeof b.headers === 'object' ? b.headers : {};
    const subject = b.subject || h.subject || h.Subject, text = b.text || b.plain || b['body-plain'], html = b.html || b['body-html'];
    if (text || html) return importMail({ from: b.from || h.from || h.From || (b.envelope && b.envelope.from) || '', subject: subject || '', text: text || '', html: html || '', messageId: b.messageId || h['message_id'] || h['Message-ID'] || h['message-id'] || '' }, 'webhook');
    if (!b.name) throw bad('Send name and phone (or email), or an email’s subject and text.');
    const attr = resolve({ src: b.source, ref: b.ref, utm_campaign: b.campaign });
    const source = (attr && attr.source) || clean(b.source, 40) || 'Other';
    crm.ensureSource(source);
    const { lead, merged } = crm.createLead({ name: b.name, phone: b.phone, email: b.email, city: b.city, eventType: b.eventType, eventDate: b.eventDate, guests: b.guests, budget: b.budget, message: b.message },
      { source, campaign: clean(b.campaign, 60) || (attr && attr.campaign) || '', link: attr && attr.link || '', channelNote: 'sent by a connected app', channel: 'Website' });
    return { status: merged ? 'merged' : 'created', lead: { id: lead.id, name: lead.name } };
  }

  function overview() {
    return { links: links(), targets: Object.keys(TARGETS), siteUrl: siteUrl(), mailbox: mailboxStatus(), emails: recent(40), hookKey: hookKey(), emailOn: mailer.configured() };
  }
  return { links, saveLink, deleteLink, redirectFor, resolve, preview, importMail, recent, poll, mailboxStatus, hookKey, keyOk, webhook, overview, imapOn, CapError };
}

module.exports = { createCapture, CapError };
