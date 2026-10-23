'use strict';
/* =========================================================================
   Kankana CRM — phase 3: reports. Every number is computed from the same
   database the dashboard runs on (leads, activities, tasks, bookings,
   payments), for a date range in India time.
   ========================================================================= */
const P = require('../../assets/kankana-pricing.js');

const DAY = 864e5, IST = 5.5 * 3600e3;
const BOOKED = ['confirmed', 'planning', 'paid', 'completed'];
/** 'YYYY-MM-DD' (IST) → ms at IST midnight */
const istStart = d => Date.parse(d + 'T00:00:00Z') - IST;
const istDay = ms => new Date(ms + IST).toISOString().slice(0, 10);
const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function createReports({ store, crm }) {
  const db = store.db;
  const RANK = Object.fromEntries(crm.STAGES.map((s, i) => [s.id, i]));

  function build({ from, to, occ = 'next90', withTeam = true }) {
    const today = P.todayIST();
    if (!P.isISODate(from)) from = P.addDays(today, -89);
    if (!P.isISODate(to)) to = today;
    if (from > to) [from, to] = [to, from];
    const t0 = istStart(from), t1 = istStart(P.addDays(to, 1));
    const inRange = t => t >= t0 && t < t1;

    const leads = db.prepare('SELECT * FROM leads').all();
    const acts = db.prepare('SELECT lead_id, at, kind, actor_id, data FROM lead_activities ORDER BY at').all();
    const links = db.prepare('SELECT * FROM lead_bookings').all();
    const bookings = store.allBookings();
    const bById = Object.fromEntries(bookings.map(b => [b.id, b]));
    const byLead = {}; acts.forEach(a => (byLead[a.lead_id] = byLead[a.lead_id] || []).push(a));
    const booksOf = {}; links.forEach(l => { if (bById[l.booking_id]) (booksOf[l.lead_id] = booksOf[l.lead_id] || []).push(bById[l.booking_id]); });
    const paidOf = b => b.payments.reduce((s, p) => s + p.amount, 0);
    const wonValue = id => (booksOf[id] || []).filter(b => BOOKED.includes(b.status) || paidOf(b) > 0).reduce((s, b) => s + b.quote.total, 0);

    /* when each lead was won / lost (last stage move into it) */
    const closedAt = {};
    acts.filter(a => a.kind === 'stage' && a.data).forEach(a => { const d = JSON.parse(a.data); if (d.to === 'won' || d.to === 'lost') closedAt[a.lead_id] = { to: d.to, at: a.at }; });
    const leadsById = Object.fromEntries(leads.map(l => [l.id, l]));
    const wonIn = Object.entries(closedAt).filter(([id, c]) => c.to === 'won' && inRange(c.at) && leadsById[id] && leadsById[id].stage === 'won').map(([id]) => id);
    const lostIn = Object.entries(closedAt).filter(([id, c]) => c.to === 'lost' && inRange(c.at) && leadsById[id] && leadsById[id].stage === 'lost').map(([id]) => id);

    /* first human response (call / WhatsApp / email logged by a person) */
    const firstResponse = l => { const a = (byLead[l.id] || []).find(x => ['call', 'whatsapp', 'email'].includes(x.kind) && x.actor_id); return a ? a.at - l.created_at : null; };

    const created = leads.filter(l => inRange(l.created_at));
    const responses = created.map(firstResponse).filter(x => x != null && x >= 0);
    const payments = bookings.flatMap(b => b.payments.map(p => Object.assign({ booking: b }, p)));
    const collected = payments.filter(p => inRange(p.at)).reduce((s, p) => s + p.amount, 0);
    const firstPayAt = b => b.payments.length ? Math.min(...b.payments.map(p => p.at)) : null;
    const confirmedIn = bookings.filter(b => b.status !== 'cancelled' && firstPayAt(b) != null && inRange(firstPayAt(b)));
    const openQuoted = leads.filter(l => !['won', 'lost'].includes(l.stage)).reduce((s, l) => s + (booksOf[l.id] || []).filter(b => b.status === 'quoted' || b.status === 'enquiry').reduce((x, b) => x + b.quote.total, 0), 0);

    const kpis = {
      enquiries: created.length,
      won: wonIn.length, lost: lostIn.length,
      conversion: wonIn.length + lostIn.length ? wonIn.length / (wonIn.length + lostIn.length) : null,
      collected, booked: confirmedIn.reduce((s, b) => s + b.quote.total, 0), bookings: confirmedIn.length,
      medianResponseMin: responses.length ? Math.round(median(responses) / 60000) : null,
      respondedWithinHour: created.length ? responses.filter(r => r <= 3600e3).length / created.length : null,
      openPipeline: openQuoted, openLeads: leads.filter(l => !['won', 'lost'].includes(l.stage)).length
    };

    /* sources: leads created in range, and how those leads ended up */
    const srcMap = {};
    created.forEach(l => {
      const k = l.source || 'Other', s = srcMap[k] = srcMap[k] || { source: k, leads: 0, won: 0, lost: 0, value: 0 };
      s.leads++; if (l.stage === 'won') { s.won++; s.value += wonValue(l.id); } if (l.stage === 'lost') s.lost++;
    });
    const sources = Object.values(srcMap).map(s => Object.assign(s, { conversion: s.won + s.lost ? s.won / (s.won + s.lost) : null })).sort((a, b) => b.leads - a.leads || b.won - a.won);

    /* funnel: how far each lead created in range got (best stage ever reached; lost leads count up to where they were) */
    const stagesOpen = crm.STAGES.filter(s => s.id !== 'lost');
    const reached = l => {
      let r = l.stage === 'lost' ? -1 : RANK[l.stage];
      (byLead[l.id] || []).filter(a => a.kind === 'stage' && a.data).forEach(a => { const d = JSON.parse(a.data); [d.from, d.to].forEach(x => { if (x && x !== 'lost' && RANK[x] > r) r = RANK[x]; }); });
      return Math.max(r, 0);
    };
    const reachedAll = created.map(reached);
    const funnel = stagesOpen.map(s => ({ stage: s.id, label: s.label, count: reachedAll.filter(r => r >= RANK[s.id]).length }));

    /* revenue by month: the 12 months ending with the range's last month */
    const endMonth = to.slice(0, 7);
    const months = []; { let [y, m] = endMonth.split('-').map(Number); for (let i = 0; i < 12; i++) { months.unshift(`${y}-${String(m).padStart(2, '0')}`); m--; if (!m) { m = 12; y--; } } }
    const monthOf = ms => istDay(ms).slice(0, 7);
    const monthly = months.map(mo => ({
      month: mo,
      collected: payments.filter(p => monthOf(p.at) === mo).reduce((s, p) => s + p.amount, 0),
      booked: bookings.filter(b => b.status !== 'cancelled' && firstPayAt(b) != null && monthOf(firstPayAt(b)) === mo).reduce((s, b) => s + b.quote.total, 0),
      enquiries: leads.filter(l => monthOf(l.created_at) === mo).length
    }));

    /* occupancy of every venue, stay and court/café over a window */
    const [o0, o1] = occ === 'range' ? [from, to] : [today, P.addDays(today, 89)];
    const days = []; for (let d = o0; d <= o1; d = P.addDays(d, 1)) days.push(d);
    const cat = store.catalog();
    const live = bookings.filter(b => BOOKED.includes(b.status));
    const occupancy = [];
    (cat.venues || []).filter(v => v.active !== false).forEach(v => {
      const set = new Set(); live.filter(b => b.venueId === v.id && P.kindOf(b) === 'event').forEach(b => P.eventDates(b.startDate, b.days).forEach(d => { if (d >= o0 && d <= o1) set.add(d); }));
      occupancy.push({ id: v.id, name: v.name, kind: 'event', group: v.region || 'Venue', used: set.size, capacity: days.length, unit: 'days', pct: days.length ? set.size / days.length : 0 });
    });
    (cat.stays || []).filter(s => s.active !== false).forEach(s => {
      let used = 0;
      live.forEach(b => {
        const n = P.kindOf(b) === 'stay' && b.venueId === s.id ? (b.units || 1) : P.kindOf(b) === 'event' ? (b.accommodation || []).filter(a => a.id === s.id).reduce((x, a) => x + (a.units || 0), 0) : 0;
        if (n) P.eventDates(b.startDate, b.days).forEach(d => { if (d >= o0 && d <= o1) used += n; });
      });
      const capacity = s.units * days.length;
      occupancy.push({ id: s.id, name: s.name, kind: 'stay', group: 'Stays', used, capacity, unit: `${s.unitWord || 'unit'}-nights`, pct: capacity ? Math.min(1, used / capacity) : 0 });
    });
    (cat.slots || []).filter(s => s.active !== false).forEach(s => {
      const perDay = (s.close - s.open) * s.units;
      let used = 0;
      live.filter(b => P.kindOf(b) === 'slot' && b.venueId === s.id && b.startDate >= o0 && b.startDate <= o1).forEach(b => { used += P.slotHours(s, b) * P.slotUsage(s, b); });
      const capacity = perDay * days.length;
      occupancy.push({ id: s.id, name: s.name, kind: 'slot', group: 'Turf, courts & café', used, capacity, unit: s.per === 'guest' ? 'seat-hours' : 'court-hours', pct: capacity ? Math.min(1, used / capacity) : 0 });
    });

    /* why leads were lost (in range) */
    const lr = {}; lostIn.forEach(id => { const k = leadsById[id].lost_reason || 'Not given'; lr[k] = (lr[k] || 0) + 1; });
    const lostReasons = Object.entries(lr).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);

    /* team: what each person owns and did in the range */
    let team = null;
    if (withTeam) {
      const tasks = db.prepare('SELECT * FROM tasks').all();
      const now = Date.now();
      const members = crm.team().filter(t => t.active || leads.some(l => l.owner_id === t.id));
      team = members.map(m => {
        const mine = created.filter(l => l.owner_id === m.id);
        const resp = mine.map(firstResponse).filter(x => x != null && x >= 0);
        const won = wonIn.filter(id => leadsById[id].owner_id === m.id);
        return {
          id: m.id, name: m.name || m.email, role: m.role, active: m.active,
          leads: mine.length, openLeads: leads.filter(l => l.owner_id === m.id && !['won', 'lost'].includes(l.stage)).length,
          medianResponseMin: resp.length ? Math.round(median(resp) / 60000) : null,
          withinHour: mine.length ? resp.filter(r => r <= 3600e3).length / mine.length : null,
          followupsDone: tasks.filter(t => t.done_by === m.id && t.done_at && inRange(t.done_at)).length,
          overdue: tasks.filter(t => t.assignee_id === m.id && !t.done_at && t.due_at < now).length,
          won: won.length, wonValue: won.reduce((s, id) => s + wonValue(id), 0),
          logged: acts.filter(a => a.actor_id === m.id && inRange(a.at) && ['call', 'whatsapp', 'email', 'visit', 'note'].includes(a.kind)).length
        };
      }).sort((a, b) => b.won - a.won || b.leads - a.leads);
      const un = created.filter(l => !l.owner_id);
      if (un.length) team.push({ id: null, name: 'Unassigned', role: '', active: true, leads: un.length, openLeads: leads.filter(l => !l.owner_id && !['won', 'lost'].includes(l.stage)).length, medianResponseMin: null, withinHour: null, followupsDone: 0, overdue: 0, won: 0, wonValue: 0, logged: 0 });
    }

    return { range: { from, to }, occupancyWindow: { from: o0, to: o1, days: days.length }, kpis, sources, funnel, monthly, occupancy, lostReasons, team };
  }

  function leadsCsv() {
    const leads = crm.leadSummaries();
    const cols = ['Lead ID', 'Created', 'Name', 'Phone', 'Email', 'City', 'Event', 'Event date', 'Guests', 'Budget', 'Source', 'Stage', 'Lost reason', 'Owner', 'Next follow-up', 'Bookings'];
    const rows = leads.map(l => [l.id, istDay(l.createdAt), l.name, l.phone, l.email, l.city, l.eventType, l.eventDate, l.guests || '', l.budget || '', l.source,
      (crm.STAGES.find(s => s.id === l.stage) || {}).label || l.stage, l.lostReason, crm.nameOf(l.ownerId) || '', l.nextTaskAt ? new Date(l.nextTaskAt + IST).toISOString().slice(0, 16).replace('T', ' ') : '', l.bookingIds.join(' ')]);
    return [cols, ...rows].map(r => r.map(x => { let s = String(x == null ? '' : x); if (/^[=+\-@]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; }).join(',')).join('\r\n');
  }

  return { build, leadsCsv };
}

module.exports = { createReports };
