'use strict';
/* =========================================================================
   Kankana CRM — phase 2: message templates and automations.
   Templates are plain text with {placeholders}; the team sends them by
   WhatsApp (tap-to-send) or email. Automations run every few minutes and
   either email the client (when email is configured) or put a ready-to-send
   WhatsApp follow-up on the right person's list. Every automatic action is
   recorded once in auto_log, so nothing is ever sent twice.
   ========================================================================= */
const P = require('../../assets/kankana-pricing.js');

const DEFAULT_TEMPLATES = [
  { id: 'first_reply', name: 'First reply to an enquiry', subject: 'Thank you for your enquiry — Kankana',
    body: 'Hello {first_name},\n\nThank you for reaching out to {company} about your {event}. We would love to host you.\n\nWhen would be a good time for a short call? You are also welcome to visit the estate — we will show you the venues and stays in person.\n\nWarm regards,\n{my_name}\n{company} · {company_phone}' },
  { id: 'no_response', name: 'Follow-up — no reply yet', subject: 'Following up on your {event} at Kankana',
    body: 'Hello {first_name},\n\nJust checking in on your {event} plans. Are your dates confirmed yet? We would be happy to share options, prices and availability whenever you are ready.\n\nWarm regards,\n{my_name}, {company}' },
  { id: 'visit_confirm', name: 'Site visit confirmation', subject: 'Your visit to Kankana — {visit_time}',
    body: 'Hello {first_name},\n\nThank you for scheduling a visit. We look forward to welcoming you on {visit_time}.\n\nAddress: {company_address}\n\nPlease call {company_phone} if anything changes.\n\nWarm regards,\n{my_name}, {company}' },
  { id: 'visit_reminder', name: 'Site visit reminder (day before)', subject: 'See you tomorrow at Kankana',
    body: 'Hello {first_name},\n\nA quick reminder that we are expecting you on {visit_time}. We will have the venues and stays ready to show you.\n\nAddress: {company_address}\n\nSee you soon,\n{my_name}, {company}' },
  { id: 'quote_followup', name: 'Quotation follow-up', subject: 'Your Kankana quotation {quote_no}',
    body: 'Hello {first_name},\n\nI hope you had a chance to look at quotation {quote_no} for {venue} ({when}). The total is {total}, and an advance of {advance} confirms your booking.\n\nYou can review and pay securely here: {pay_link}\n\nHappy to adjust anything — just reply to this message.\n\nWarm regards,\n{my_name}, {company}' },
  { id: 'hold_expiring', name: 'Dates on hold — expiring soon', subject: 'Your dates at Kankana are held until {hold_until}',
    body: 'Hello {first_name},\n\nWe are holding {venue} for you ({when}) until {hold_until}. After that the dates are released for other families.\n\nTo confirm, pay the advance of {advance} here: {pay_link}\n\nWarm regards,\n{company}' },
  { id: 'balance_reminder', name: 'Balance payment reminder', subject: 'Balance due for your booking {booking_id}',
    body: 'Hello {first_name},\n\nA gentle reminder that the balance of {balance} for your booking {booking_id} ({venue}, {when}) is due by {due_date}.\n\nYou can pay securely here: {pay_link}\n\nThank you,\n{company}' },
  { id: 'thanks', name: 'Thank you after the event', subject: 'Thank you for celebrating with us',
    body: 'Hello {first_name},\n\nThank you for celebrating with us at {company}. It was an honour to be part of your family’s day.\n\nIf you have a moment, we would love to hear how everything felt — your words help other families find us.\n\nWith warm wishes,\n{my_name}, {company}' },
  { id: 'keep_in_touch', name: 'Keep in touch (lost lead)', subject: 'Thank you for considering Kankana',
    body: 'Hello {first_name},\n\nThank you for considering {company}. If your plans change, or you are planning another celebration, we would be glad to help.\n\nWarm regards,\n{my_name}, {company}' }
];

const PLACEHOLDERS = [
  ['first_name', 'Client’s first name'], ['name', 'Client’s full name'], ['event', 'Event type, e.g. wedding'], ['event_date', 'Dates they mentioned'], ['guests', 'Guest count'],
  ['my_name', 'Your name'], ['company', 'Kankana — Weddings & Resorts'], ['company_phone', 'Company phone'], ['company_address', 'Company address'],
  ['booking_id', 'Booking ID'], ['quote_no', 'Quotation number'], ['venue', 'What’s booked'], ['when', 'Dates of the booking'], ['total', 'Quotation total'],
  ['advance', 'Advance to confirm'], ['balance', 'Balance due'], ['due_date', 'Balance due date'], ['hold_until', 'Hold expiry'], ['pay_link', 'Client’s pay / track link'], ['visit_time', 'Next site visit time']
];

const DEFAULT_AUTO = {
  autoAssign: false,          // round-robin new website leads across Sales logins
  firstReplyEmail: true,      // email the first-reply template to website enquiries that left an email
  firstReplyTask: true,       // put a ready WhatsApp reply on the owner's list
  firstReplyMinutes: 60,
  quoteFollowupDays: 3,       // 0 = off
  quoteFollowupEmail: true,
  holdExpiryEmail: true,
  balanceReminderDays: [14, 3],
  balanceEmail: true,
  staleDays: 7,               // 0 = off
  visitReminder: true,
  defaultAssigneeId: null
};

const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, n);
const DAY = 864e5;
const IST = 5.5 * 3600e3;
const istMidnight = t => Math.floor((t + IST) / DAY) * DAY - IST;
const fmtDT = ms => new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function createMessaging({ store, crm, svc, mailer }) {
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS auto_log (key TEXT PRIMARY KEY, at INTEGER NOT NULL, rule TEXT NOT NULL, ref TEXT, note TEXT)`);

  /* ---------------- templates ---------------- */
  function templates() {
    const t = store.getKV('crm:templates');
    return Array.isArray(t) && t.length ? t : DEFAULT_TEMPLATES;
  }
  function setTemplates(list) {
    if (!Array.isArray(list)) throw Object.assign(new Error('Send a list of templates.'), { status: 400 });
    const seen = new Set();
    const out = list.slice(0, 40).map((t, i) => {
      let id = clean(t.id, 40).toLowerCase().replace(/[^a-z0-9_]+/g, '_') || ('custom_' + (i + 1));
      while (seen.has(id)) id += '_2';
      seen.add(id);
      return { id, name: clean(t.name, 80).trim() || 'Untitled', subject: clean(t.subject, 200).trim(), body: clean(t.body, 4000) };
    }).filter(t => t.body.trim());
    // Templates the automations rely on can be edited but never lost.
    DEFAULT_TEMPLATES.forEach(d => { if (!out.some(t => t.id === d.id)) out.push(d); });
    store.setKV('crm:templates', out);
    return out;
  }
  const tpl = id => templates().find(t => t.id === id) || DEFAULT_TEMPLATES.find(t => t.id === id);

  /** Values for every placeholder, from a lead and/or a booking. Unknown values become a sensible phrase, never "{x}". */
  function context({ lead = null, booking = null, actor = null }) {
    const s = store.settings(), C = s.company || {};
    const b = booking, d = b ? P.describe(b) : null;
    const who = (lead && lead.name) || (b && b.customer.name) || '';
    const paid = b ? b.payments.reduce((x, p) => x + p.amount, 0) : 0;
    const visit = lead ? crm.openTasksFor(lead.id).filter(t => t.kind === 'visit').sort((a, c) => a.dueAt - c.dueAt)[0] : null;
    const kind = b ? P.kindOf(b) : null;
    const dueDate = b && kind === 'event' ? P.fmtDate(P.addDays(b.startDate, -(s.balanceDueDaysBefore || 30))) : b ? P.fmtDate(b.startDate) : '';
    const evt = (lead && lead.eventType) || (kind === 'stay' ? 'stay' : kind === 'slot' ? 'reservation' : b ? 'celebration' : '');
    return {
      first_name: who.trim().split(/\s+/)[0] || 'there', name: who || 'there',
      event: evt ? (evt === 'Other' ? 'celebration' : evt.toLowerCase()) : 'celebration',
      event_date: (lead && lead.eventDate) || (b ? d.whenShort : 'your dates'), guests: String((lead && lead.guests) || (b && b.guests) || ''),
      my_name: (actor && (actor.name || '').trim()) || 'The Kankana team', company: C.name || 'Kankana', company_phone: C.phone || '', company_address: C.address || '',
      booking_id: b ? b.id : '', quote_no: b ? b.quoteNo : '', venue: b ? (b.venueName || b.venueId) : '', when: d ? d.when : '',
      total: b ? P.inr(b.quote.total) : '', advance: b ? P.inr(b.quote.advance) : '', balance: b ? P.inr(Math.max(0, b.quote.total - paid)) : '',
      due_date: dueDate, hold_until: b && b.holdUntil ? fmtDT(b.holdUntil) : '', pay_link: b ? svc.trackUrl(b) : svc.siteUrl() + '/book.html',
      visit_time: visit ? fmtDT(visit.dueAt) : 'your visit'
    };
  }
  const fill = (text, ctx) => String(text || '').replace(/\{(\w+)\}/g, (m, k) => (k in ctx ? ctx[k] : m));
  function render(templateId, refs) {
    const t = tpl(templateId); if (!t) throw Object.assign(new Error('Template not found'), { status: 404 });
    const ctx = context(refs);
    const used = [...new Set(((t.subject || '') + ' ' + t.body).match(/\{(\w+)\}/g) || [])].map(x => x.slice(1, -1));
    const missing = used.filter(k => k in ctx && !String(ctx[k]).trim());
    return { templateId: t.id, name: t.name, subject: fill(t.subject, ctx), text: fill(t.body, ctx), missing };
  }
  /** Bookings for a lead, newest first (used to fill booking placeholders on a lead's message). */
  function latestBooking(leadId) {
    const ids = crm.leadsForBooking ? db.prepare('SELECT booking_id FROM lead_bookings WHERE lead_id=?').all(leadId).map(r => r.booking_id) : [];
    return ids.map(id => store.getBooking(id, { withKey: true })).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  }

  /* ---------------- sending (by a team member) ---------------- */
  function send({ channel, to, subject, text, leadId, bookingId, templateId }, actor) {
    const lead = leadId ? crm.rawLead(leadId) : null;
    if (leadId && !lead) throw Object.assign(new Error('Lead not found'), { status: 404 });
    const leadsOfBooking = bookingId ? crm.leadsForBooking(bookingId) : [];
    const targets = lead ? [lead.id] : leadsOfBooking;
    const t = templateId ? tpl(templateId) : null;
    const label = t ? t.name : 'Message';
    if (channel === 'email') {
      const r = svc.sendCustom({ to, subject, text, bookingId: bookingId || null, leadId: lead ? lead.id : (leadsOfBooking[0] || null) });
      targets.forEach(id => crm.logContact(id, 'email', `${label} — “${clean(subject, 140)}”${r.status === 'not_configured' ? ' (saved; email not set up yet)' : ''}`, actor.id));
      return r;
    }
    if (channel === 'whatsapp') {
      targets.forEach(id => crm.logContact(id, 'whatsapp', `${label} sent on WhatsApp`, actor.id));
      return { ok: true };
    }
    throw Object.assign(new Error('Choose WhatsApp or email.'), { status: 400 });
  }

  /* ---------------- automations ---------------- */
  function autoSettings() { return Object.assign({}, DEFAULT_AUTO, store.getKV('crm:auto') || {}); }
  function setAuto(b) {
    const cur = autoSettings(), n = (v, lo, hi, d) => { const x = Math.round(+v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
    const bool = (v, d) => v === undefined ? d : !!v;
    const next = {
      autoAssign: bool(b.autoAssign, cur.autoAssign), firstReplyEmail: bool(b.firstReplyEmail, cur.firstReplyEmail), firstReplyTask: bool(b.firstReplyTask, cur.firstReplyTask),
      firstReplyMinutes: n(b.firstReplyMinutes, 5, 1440, cur.firstReplyMinutes), quoteFollowupDays: n(b.quoteFollowupDays, 0, 30, cur.quoteFollowupDays),
      quoteFollowupEmail: bool(b.quoteFollowupEmail, cur.quoteFollowupEmail), holdExpiryEmail: bool(b.holdExpiryEmail, cur.holdExpiryEmail),
      balanceReminderDays: Array.isArray(b.balanceReminderDays) ? [...new Set(b.balanceReminderDays.map(x => n(x, 1, 120, 0)).filter(Boolean))].sort((a, c) => c - a).slice(0, 4) : cur.balanceReminderDays,
      balanceEmail: bool(b.balanceEmail, cur.balanceEmail), staleDays: n(b.staleDays, 0, 60, cur.staleDays), visitReminder: bool(b.visitReminder, cur.visitReminder),
      defaultAssigneeId: b.defaultAssigneeId !== undefined ? (b.defaultAssigneeId ? +b.defaultAssigneeId : null) : cur.defaultAssigneeId
    };
    if (next.defaultAssigneeId) { const a = store.adminById(next.defaultAssigneeId); if (!a || !a.active) next.defaultAssigneeId = null; }
    store.setKV('crm:auto', next);
    return next;
  }
  const done = key => !!db.prepare('SELECT 1 FROM auto_log WHERE key=?').get(key);
  const mark = (key, rule, ref, note) => db.prepare('INSERT OR IGNORE INTO auto_log(key,at,rule,ref,note) VALUES(?,?,?,?,?)').run(key, Date.now(), rule, ref || null, clean(note, 300));
  function recentLog(n = 40) { return db.prepare('SELECT * FROM auto_log ORDER BY at DESC LIMIT ?').all(n).map(r => ({ at: r.at, rule: r.rule, ref: r.ref, note: r.note })); }
  const emailOn = () => mailer.configured();
  const hasEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || ''));
  function autoEmail(templateId, { lead, booking, to }) {
    const m = render(templateId, { lead, booking, actor: null });
    svc.sendCustom({ to, subject: m.subject, text: m.text, bookingId: booking ? booking.id : null, leadId: lead ? lead.id : null });
    if (lead) crm.logContact(lead.id, 'email', `${m.name} — sent automatically`, null);
    return m;
  }
  function waTask({ lead, booking = null, templateId, title, dueAt, assigneeId }) {
    const m = render(templateId, { lead, booking, actor: assigneeId ? store.adminById(assigneeId) : crm.defaultAssignee() });
    const phone = (lead && lead.phone) || (booking && booking.customer.phone) || '';
    return crm.systemTask({ leadId: lead ? lead.id : null, title, kind: phone ? 'whatsapp' : 'follow_up', dueAt, assigneeId, message: phone ? m.text : null, phone, template: templateId });
  }

  /** A lead that arrived by itself (website form or booking page). */
  function onNewLead(leadId, { via }) {
    const a = autoSettings();
    let lead = crm.rawLead(leadId); if (!lead) return;
    if (a.autoAssign) { crm.autoAssign(lead.id); lead = crm.rawLead(lead.id); }
    if (via === 'Website' && a.firstReplyEmail && emailOn() && hasEmail(lead.email) && !done('first:' + lead.id)) {
      autoEmail('first_reply', { lead, to: lead.email });
      mark('first:' + lead.id, 'First reply email', lead.id, `Emailed ${lead.name}`);
    }
    if (a.firstReplyTask && !done('firsttask:' + lead.id)) {
      waTask({ lead, templateId: 'first_reply', title: via === 'Website' ? 'Reply to new enquiry' : 'Call about their online quotation', dueAt: Date.now() + a.firstReplyMinutes * 60000, assigneeId: lead.ownerId });
      mark('firsttask:' + lead.id, 'First reply follow-up', lead.id, `Follow-up for ${lead.name}`);
    }
  }

  let running = false;
  function run(now = Date.now()) {
    if (running) return { skipped: true };
    running = true;
    const a = autoSettings(), out = [];
    const note = (rule, text) => out.push(`${rule}: ${text}`);
    try {
      const bookings = store.allBookings();
      const leadOf = b => { const ids = crm.leadsForBooking(b.id); return ids.length ? crm.rawLead(ids[0]) : null; };
      const paidOf = b => b.payments.reduce((s, p) => s + p.amount, 0);

      // 1. Quotation not paid after N days → WhatsApp follow-up for the owner (+ email to the client).
      if (a.quoteFollowupDays > 0) bookings.filter(b => b.status === 'quoted' && P.kindOf(b) !== 'slot' && !paidOf(b) && now - b.createdAt >= a.quoteFollowupDays * DAY).forEach(b => {
        const key = 'quote:' + b.id; if (done(key)) return;
        const lead = leadOf(b);
        if (a.quoteFollowupEmail && emailOn() && hasEmail(b.customer.email)) autoEmail('quote_followup', { lead, booking: b, to: b.customer.email });
        waTask({ lead, booking: b, templateId: 'quote_followup', title: `Follow up on quotation ${b.quoteNo}`, dueAt: now, assigneeId: lead && lead.ownerId });
        mark(key, 'Quotation follow-up', b.id, `${b.customer.name} · ${b.quoteNo}`); note('Quotation follow-up', b.id);
      });

      // 2. Hold expiring within 24 hours → email the client once per hold.
      if (a.holdExpiryEmail && emailOn()) bookings.filter(b => b.status === 'quoted' && P.kindOf(b) !== 'slot' && b.holdUntil && b.holdUntil > now && b.holdUntil - now <= DAY && hasEmail(b.customer.email)).forEach(b => {
        const key = `hold:${b.id}:${b.holdUntil}`; if (done(key)) return;
        autoEmail('hold_expiring', { lead: leadOf(b), booking: b, to: b.customer.email });
        mark(key, 'Hold expiring email', b.id, `${b.customer.name} · held until ${fmtDT(b.holdUntil)}`); note('Hold expiring', b.id);
      });

      // 3. Balance reminders for confirmed celebrations: N days before the due date, and on the due date (with a task for accounts).
      const today = P.todayIST();
      bookings.filter(b => ['confirmed', 'planning'].includes(b.status) && P.kindOf(b) === 'event' && b.quote.total - paidOf(b) > 0).forEach(b => {
        const due = P.addDays(b.startDate, -(store.settings().balanceDueDaysBefore || 30));
        const daysLeft = Math.round((P.parseISO(due) - P.parseISO(today)) / DAY);
        const lead = leadOf(b);
        const steps = a.balanceReminderDays.filter(d => daysLeft <= d && daysLeft > 0).slice(-1);
        steps.forEach(d => {
          const key = `bal:${b.id}:${d}`; if (done(key)) return;
          if (a.balanceEmail && emailOn() && hasEmail(b.customer.email)) autoEmail('balance_reminder', { lead, booking: b, to: b.customer.email });
          mark(key, `Balance reminder (${d} days)`, b.id, `${b.customer.name} · due ${due}`); note('Balance reminder', b.id);
        });
        if (daysLeft <= 0 && !done(`bal:${b.id}:due`)) {
          if (a.balanceEmail && emailOn() && hasEmail(b.customer.email)) autoEmail('balance_reminder', { lead, booking: b, to: b.customer.email });
          const acc = crm.accountsPerson();
          waTask({ lead, booking: b, templateId: 'balance_reminder', title: `Collect balance for ${b.id} (${P.inr(b.quote.total - paidOf(b))})`, dueAt: now, assigneeId: acc && acc.id });
          mark(`bal:${b.id}:due`, 'Balance due', b.id, `${b.customer.name} · ${daysLeft < 0 ? 'overdue' : 'due today'}`); note('Balance due', b.id);
        }
      });

      // 4. Open leads with no activity for N days and nothing scheduled → a check-in on the owner's list.
      if (a.staleDays > 0) crm.openLeads().forEach(l => {
        const last = crm.lastActivityAt(l.id) || l.createdAt;
        if (now - last < a.staleDays * DAY || crm.openTasksFor(l.id).length) return;
        const key = `stale:${l.id}:${last}`; if (done(key)) return;
        waTask({ lead: l, templateId: 'no_response', title: `Check in — no activity for ${a.staleDays} days`, dueAt: now, assigneeId: l.ownerId });
        mark(key, 'Gone quiet', l.id, `${l.name} · ${a.staleDays}+ days`); note('Gone quiet', l.id);
      });

      // 5. Site visits tomorrow → reminder email to the client + a WhatsApp reminder for whoever is hosting.
      if (a.visitReminder) {
        const t0 = istMidnight(now) + DAY;
        crm.visitTasksBetween(t0, t0 + DAY).forEach(v => {
          const key = 'visit:' + v.id; if (done(key) || !v.leadId) return;
          const lead = crm.rawLead(v.leadId); if (!lead) return;
          if (emailOn() && hasEmail(lead.email)) autoEmail('visit_reminder', { lead, to: lead.email });
          waTask({ lead, templateId: 'visit_reminder', title: 'Send visit reminder for tomorrow', dueAt: now, assigneeId: v.assigneeId });
          mark(key, 'Visit reminder', lead.id, `${lead.name} · ${fmtDT(v.dueAt)}`); note('Visit reminder', lead.id);
        });
      }
      store.setKV('crm:lastAutoRun', { at: now, actions: out.length });
    } catch (e) { console.error('[automations]', e); }
    finally { running = false; }
    return { at: now, actions: out };
  }

  crm.events.onNewLead = onNewLead;

  return {
    templates, setTemplates, render, latestBooking, send, PLACEHOLDERS,
    autoSettings, setAuto, run, recentLog, lastRun: () => store.getKV('crm:lastAutoRun'), emailOn
  };
}

module.exports = { createMessaging, DEFAULT_TEMPLATES };
