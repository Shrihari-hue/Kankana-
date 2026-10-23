'use strict';
/* =========================================================================
   Kankana CRM — leads, pipeline, activities (client timeline), follow-up
   tasks and team roles. Shares the bookings database (node:sqlite).
   ========================================================================= */

const STAGES = [
  { id: 'new', label: 'New enquiry' },
  { id: 'contacted', label: 'Contacted' },
  { id: 'visit_booked', label: 'Site visit booked' },
  { id: 'visited', label: 'Visited' },
  { id: 'quoted', label: 'Quotation sent' },
  { id: 'negotiating', label: 'Negotiating' },
  { id: 'won', label: 'Won' },
  { id: 'lost', label: 'Lost' }
];
const STAGE_IDS = STAGES.map(s => s.id);
const rank = id => STAGE_IDS.indexOf(id);
const OPEN = id => id !== 'won' && id !== 'lost';

const ROLES = {
  owner: { label: 'Owner', desc: 'Everything, including prices, settings and team logins' },
  sales: { label: 'Sales', desc: 'Leads, follow-ups, quotations and site visits' },
  accounts: { label: 'Accounts', desc: 'Payments, invoices and receipts' },
  events: { label: 'Events', desc: 'Confirmed bookings and the calendar' }
};

const DEFAULT_CRM = {
  sources: ['Website', 'Booking page', 'Instagram', 'Facebook', 'Google', 'WhatsApp', 'Phone call', 'Walk-in', 'Wedding planner', 'Referral', 'WedMeGood', 'Other'],
  eventTypes: ['Wedding', 'Reception', 'Engagement', 'Mehndi / Sangeet', 'Corporate', 'Birthday / Party', 'Stay', 'Other'],
  lostReasons: ['Price too high', 'Dates not available', 'Chose another venue', 'Budget changed', 'No response', 'Event cancelled', 'Other']
};

const ACT_KINDS = ['created', 'enquiry', 'note', 'call', 'whatsapp', 'email', 'visit', 'stage', 'owner', 'task', 'booking', 'payment', 'edit'];
const TASK_KINDS = ['call', 'visit', 'follow_up', 'other'];

const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
const phoneKey = p => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 8 ? d.slice(-10) : ''; };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

class CrmError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = m => new CrmError(400, m);

function createCrm(store) {
  const db = store.db;

  /* ---------------- schema ---------------- */
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      phone_key TEXT,
      email TEXT,
      city TEXT,
      event_type TEXT,
      event_date TEXT,
      guests INTEGER,
      budget INTEGER,
      source TEXT,
      stage TEXT NOT NULL,
      owner_id INTEGER,
      lost_reason TEXT,
      data TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS ix_leads_phone ON leads(phone_key);
    CREATE INDEX IF NOT EXISTS ix_leads_email ON leads(email);
    CREATE TABLE IF NOT EXISTS lead_activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      at INTEGER NOT NULL,
      actor_id INTEGER,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      data TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_act_lead ON lead_activities(lead_id, at);
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id TEXT REFERENCES leads(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      due_at INTEGER NOT NULL,
      assignee_id INTEGER,
      done_at INTEGER,
      done_by INTEGER,
      created_by INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_tasks_due ON tasks(done_at, due_at);
    CREATE TABLE IF NOT EXISTS lead_bookings (
      lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      booking_id TEXT NOT NULL,
      PRIMARY KEY (lead_id, booking_id)
    );
  `);
  // Team roles on the existing admins table (older databases: everyone becomes an owner).
  const cols = db.prepare('PRAGMA table_info(admins)').all().map(c => c.name);
  if (!cols.includes('role')) db.exec(`ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'owner'`);
  if (!cols.includes('active')) db.exec(`ALTER TABLE admins ADD COLUMN active INTEGER NOT NULL DEFAULT 1`);

  /* ---------------- settings ---------------- */
  function lists() {
    const s = store.getKV('crm') || {};
    return {
      sources: Array.isArray(s.sources) && s.sources.length ? s.sources : DEFAULT_CRM.sources,
      eventTypes: Array.isArray(s.eventTypes) && s.eventTypes.length ? s.eventTypes : DEFAULT_CRM.eventTypes,
      lostReasons: Array.isArray(s.lostReasons) && s.lostReasons.length ? s.lostReasons : DEFAULT_CRM.lostReasons
    };
  }
  function setLists(b) {
    const cur = lists();
    const norm = (a, d) => Array.isArray(a) ? [...new Set(a.map(x => clean(x, 40)).filter(Boolean))].slice(0, 40) : d;
    const next = { sources: norm(b.sources, cur.sources), eventTypes: norm(b.eventTypes, cur.eventTypes), lostReasons: norm(b.lostReasons, cur.lostReasons) };
    ['sources', 'eventTypes', 'lostReasons'].forEach(k => { if (!next[k].length) next[k] = DEFAULT_CRM[k]; });
    store.setKV('crm', next);
    return next;
  }

  /* ---------------- team ---------------- */
  const teamRow = a => a && { id: a.id, name: a.name || '', email: a.email, role: ROLES[a.role] ? a.role : 'owner', active: a.active !== 0, createdAt: a.created_at };
  const team = () => db.prepare('SELECT * FROM admins ORDER BY created_at').all().map(teamRow);
  const activeOwners = () => db.prepare("SELECT COUNT(*) AS n FROM admins WHERE role='owner' AND active=1").get().n;
  function addMember({ name, email, role }, hash) {
    email = clean(email, 200).toLowerCase(); name = clean(name, 80);
    if (!EMAIL_RE.test(email)) throw bad('Enter a valid email address.');
    if (!name) throw bad('Enter their name.');
    if (!ROLES[role]) throw bad('Choose a role.');
    if (store.adminByEmail(email)) throw bad('Someone with that email already has a login.');
    db.prepare('INSERT INTO admins(email,name,pw_hash,created_at,role,active) VALUES(?,?,?,?,?,1)').run(email, name, hash, Date.now(), role);
    return teamRow(store.adminByEmail(email));
  }
  function updateMember(id, { name, role, active }, actor) {
    const a = store.adminById(+id); if (!a) throw new CrmError(404, 'Team member not found');
    const next = { name: name !== undefined ? clean(name, 80) || a.name : a.name, role: role !== undefined ? role : a.role, active: active !== undefined ? (active ? 1 : 0) : a.active };
    if (!ROLES[next.role]) throw bad('Choose a role.');
    const losingOwner = a.role === 'owner' && a.active && (next.role !== 'owner' || !next.active);
    if (losingOwner && activeOwners() <= 1) throw bad('Keep at least one active owner.');
    if (a.id === actor.id && (!next.active || next.role !== a.role)) throw bad('You can’t change your own role or turn off your own login.');
    db.prepare('UPDATE admins SET name=?, role=?, active=? WHERE id=?').run(next.name, next.role, next.active, a.id);
    if (!next.active || next.role !== a.role) db.prepare('DELETE FROM sessions WHERE admin_id=?').run(a.id);
    if (!next.active) db.prepare('UPDATE leads SET owner_id=NULL WHERE owner_id=? AND stage NOT IN (\'won\',\'lost\')').run(a.id);
    return teamRow(store.adminById(a.id));
  }
  const nameOf = id => { if (!id) return null; const a = store.adminById(id); return a ? (a.name || a.email) : null; };

  /* ---------------- permissions ---------------- */
  const roleOf = a => (a && ROLES[a.role]) ? a.role : 'owner';
  const canSell = a => ['owner', 'sales'].includes(roleOf(a));
  function canEditLead(a, lead) {
    const r = roleOf(a);
    if (r === 'owner') return true;
    if (r === 'sales') return !lead.ownerId || lead.ownerId === a.id;
    return false;
  }
  function assertEdit(a, lead) {
    if (!canEditLead(a, lead)) throw new CrmError(403, roleOf(a) === 'sales' ? `This lead belongs to ${nameOf(lead.ownerId) || 'someone else'}. Ask them or an owner to reassign it.` : 'Your role can view leads but not change them.');
  }

  /* ---------------- leads ---------------- */
  function rowToLead(r) {
    if (!r) return null;
    const d = JSON.parse(r.data || '{}');
    return {
      id: r.id, createdAt: r.created_at, updatedAt: r.updated_at, name: r.name, phone: r.phone || '', email: r.email || '', city: r.city || '',
      eventType: r.event_type || '', eventDate: r.event_date || '', guests: r.guests || null, budget: r.budget || null, source: r.source || '',
      stage: r.stage, ownerId: r.owner_id || null, lostReason: r.lost_reason || '', message: d.message || '', interests: d.interests || [], tags: d.tags || []
    };
  }
  const getRow = id => db.prepare('SELECT * FROM leads WHERE id=?').get(String(id || '').toUpperCase());
  function leadSummaries() {
    const leads = db.prepare('SELECT * FROM leads ORDER BY updated_at DESC').all().map(rowToLead);
    const nextDue = {}; db.prepare('SELECT lead_id, MIN(due_at) AS due FROM tasks WHERE done_at IS NULL AND lead_id IS NOT NULL GROUP BY lead_id').all().forEach(r => { nextDue[r.lead_id] = r.due; });
    const lastAct = {}; db.prepare('SELECT lead_id, MAX(at) AS at FROM lead_activities GROUP BY lead_id').all().forEach(r => { lastAct[r.lead_id] = r.at; });
    const books = {}; db.prepare('SELECT * FROM lead_bookings').all().forEach(r => { (books[r.lead_id] = books[r.lead_id] || []).push(r.booking_id); });
    return leads.map(l => Object.assign(l, { nextTaskAt: nextDue[l.id] || null, lastActivityAt: lastAct[l.id] || l.createdAt, bookingIds: books[l.id] || [] }));
  }
  function getLead(id) {
    const l = rowToLead(getRow(id)); if (!l) return null;
    l.activities = db.prepare('SELECT * FROM lead_activities WHERE lead_id=? ORDER BY at DESC, id DESC LIMIT 300').all(l.id)
      .map(a => ({ id: a.id, at: a.at, kind: a.kind, body: a.body, actorId: a.actor_id, actor: nameOf(a.actor_id), data: a.data ? JSON.parse(a.data) : null }));
    l.tasks = db.prepare('SELECT * FROM tasks WHERE lead_id=? ORDER BY done_at IS NOT NULL, due_at').all(l.id).map(taskRow);
    l.bookingIds = db.prepare('SELECT booking_id FROM lead_bookings WHERE lead_id=?').all(l.id).map(r => r.booking_id);
    return l;
  }
  function findMatch({ phone, email }, { openOnly = true } = {}) {
    const pk = phoneKey(phone), em = clean(email, 200).toLowerCase();
    if (!pk && !em) return null;
    const rows = db.prepare(`SELECT * FROM leads WHERE (${pk ? 'phone_key=?' : '0'} OR ${em ? 'email=?' : '0'}) ORDER BY updated_at DESC`).all(...[pk, em].filter(Boolean));
    const r = openOnly ? rows.find(x => OPEN(x.stage)) : rows[0];
    return r ? rowToLead(r) : null;
  }

  function sanitize(input, base = {}) {
    const lst = lists();
    const out = {};
    const has = k => input[k] !== undefined;
    if (has('name')) out.name = clean(input.name, 120);
    if (has('phone')) out.phone = clean(input.phone, 30);
    if (has('email')) { out.email = clean(input.email, 200).toLowerCase(); if (out.email && !EMAIL_RE.test(out.email)) throw bad('That email address doesn’t look right.'); }
    if (has('city')) out.city = clean(input.city, 80);
    if (has('eventType')) out.eventType = clean(input.eventType, 40);
    if (has('eventDate')) out.eventDate = clean(input.eventDate, 40);
    if (has('guests')) { const g = Math.round(+input.guests); out.guests = g > 0 ? Math.min(g, 20000) : null; }
    if (has('budget')) { const b = Math.round(+String(input.budget).replace(/[^\d.]/g, '')); out.budget = b > 0 ? Math.min(b, 1e10) : null; }
    if (has('source')) out.source = clean(input.source, 40);
    if (has('message')) out.message = clean(input.message, 2000);
    if (has('stage')) { if (!STAGE_IDS.includes(input.stage)) throw bad('Unknown stage.'); out.stage = input.stage; }
    if (has('lostReason')) out.lostReason = clean(input.lostReason, 120);
    if (has('ownerId')) { const o = input.ownerId ? +input.ownerId : null; if (o) { const a = store.adminById(o); if (!a || !a.active) throw bad('Choose an active team member.'); } out.ownerId = o; }
    if (has('tags')) out.tags = (Array.isArray(input.tags) ? input.tags : []).map(t => clean(t, 30)).filter(Boolean).slice(0, 12);
    void lst; void base;
    return out;
  }

  function insertLead(f, actorId) {
    const id = 'L-' + store.next('lead', 1000);
    const now = Date.now();
    db.prepare(`INSERT INTO leads(id,created_at,updated_at,name,phone,phone_key,email,city,event_type,event_date,guests,budget,source,stage,owner_id,lost_reason,data)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, now, now, f.name, f.phone || '', phoneKey(f.phone), f.email || '', f.city || '', f.eventType || '', f.eventDate || '',
      f.guests || null, f.budget || null, f.source || 'Other', f.stage || 'new', f.ownerId || null, '', JSON.stringify({ message: f.message || '', tags: f.tags || [] }));
    return id;
  }
  function writeLead(id, l) {
    db.prepare(`UPDATE leads SET updated_at=?,name=?,phone=?,phone_key=?,email=?,city=?,event_type=?,event_date=?,guests=?,budget=?,source=?,stage=?,owner_id=?,lost_reason=?,data=? WHERE id=?`)
      .run(Date.now(), l.name, l.phone, phoneKey(l.phone), l.email, l.city, l.eventType, l.eventDate, l.guests || null, l.budget || null, l.source, l.stage, l.ownerId || null, l.lostReason || '',
        JSON.stringify({ message: l.message || '', tags: l.tags || [] }), id);
  }
  function act(leadId, kind, body, actorId, data) {
    db.prepare('INSERT INTO lead_activities(lead_id,at,actor_id,kind,body,data) VALUES(?,?,?,?,?,?)').run(leadId, Date.now(), actorId || null, kind, clean(body, 4000), data ? JSON.stringify(data) : null);
    db.prepare('UPDATE leads SET updated_at=? WHERE id=?').run(Date.now(), leadId);
  }
  function moveStage(lead, to, actorId, why) {
    if (!to || to === lead.stage) return false;
    const from = lead.stage; lead.stage = to;
    if (to !== 'lost') lead.lostReason = '';
    writeLead(lead.id, lead);
    act(lead.id, 'stage', `${label(from)} → ${label(to)}${why ? ' · ' + why : ''}`, actorId, { from, to });
    return true;
  }
  /** Moves forward only (automatic moves never pull a lead backwards or out of Won/Lost). */
  function advance(lead, to, actorId, why) { if (OPEN(lead.stage) && rank(to) > rank(lead.stage)) moveStage(lead, to, actorId, why); }
  const label = id => (STAGES.find(s => s.id === id) || { label: id }).label;

  /**
   * New enquiry from any channel. An open lead with the same phone or email is reused (merged),
   * so the same family enquiring twice doesn't appear twice.
   */
  function createLead(input, { actor = null, source = null, channelNote = '' } = {}) {
    const f = sanitize(input);
    if (!f.name) throw bad('Please enter a name.');
    if (!f.phone && !f.email) throw bad('Add a phone number or an email address.');
    if (f.phone && !phoneKey(f.phone)) throw bad('That phone number doesn’t look right.');
    if (source) f.source = source;
    if (!f.source) f.source = 'Other';
    const actorId = actor ? actor.id : null;
    return store.tx(() => {
      const ex = findMatch(f);
      if (ex) {
        const merged = Object.assign({}, ex);
        ['phone', 'email', 'city', 'eventType', 'eventDate', 'guests', 'budget'].forEach(k => { if (!merged[k] && f[k]) merged[k] = f[k]; });
        if (f.message) merged.message = [ex.message, f.message].filter(Boolean).join('\n\n— ').slice(0, 4000);
        writeLead(ex.id, merged);
        act(ex.id, 'enquiry', `Enquired again via ${f.source}${f.message ? ': “' + f.message.slice(0, 300) + '”' : ''}${channelNote ? ' · ' + channelNote : ''}`, actorId);
        return { lead: getLead(ex.id), merged: true };
      }
      if (actor && roleOf(actor) === 'sales' && f.ownerId === undefined) f.ownerId = actor.id;
      const id = insertLead(f, actorId);
      act(id, 'created', `Lead created from ${f.source}${actor ? ' by ' + (actor.name || actor.email) : ''}${f.message ? ': “' + f.message.slice(0, 300) + '”' : ''}${channelNote ? ' · ' + channelNote : ''}`, actorId);
      if (f.ownerId) act(id, 'owner', `Assigned to ${nameOf(f.ownerId)}`, actorId);
      return { lead: getLead(id), merged: false };
    });
  }

  function updateLead(id, input, actor) {
    const lead = rowToLead(getRow(id)); if (!lead) throw new CrmError(404, 'Lead not found');
    assertEdit(actor, lead);
    const f = sanitize(input);
    if (f.ownerId !== undefined && roleOf(actor) === 'sales' && f.ownerId && f.ownerId !== actor.id) throw new CrmError(403, 'Only an owner can assign leads to someone else.');
    if (f.stage === 'lost' && !(f.lostReason || lead.lostReason)) throw bad('Choose why the lead was lost.');
    return store.tx(() => {
      const before = Object.assign({}, lead);
      const fields = { name: 'Name', phone: 'Phone', email: 'Email', city: 'City', eventType: 'Event', eventDate: 'Event date', guests: 'Guests', budget: 'Budget', source: 'Source', tags: 'Tags' };
      const changed = [];
      Object.keys(fields).forEach(k => { if (f[k] !== undefined && JSON.stringify(f[k] || '') !== JSON.stringify(lead[k] || '')) { lead[k] = f[k]; changed.push(fields[k]); } });
      if (f.message !== undefined) lead.message = f.message;
      if (!lead.name) throw bad('Name can’t be empty.');
      if (f.lostReason !== undefined) lead.lostReason = f.lostReason;
      writeLead(lead.id, lead);
      if (changed.length) act(lead.id, 'edit', `Updated ${changed.join(', ').toLowerCase()}`, actor.id);
      if (f.ownerId !== undefined && (f.ownerId || null) !== (before.ownerId || null)) {
        lead.ownerId = f.ownerId; writeLead(lead.id, lead);
        act(lead.id, 'owner', f.ownerId ? `Assigned to ${nameOf(f.ownerId)}` : 'Unassigned', actor.id);
      }
      if (f.stage && f.stage !== before.stage) moveStage(lead, f.stage, actor.id, f.stage === 'lost' ? lead.lostReason : '');
      else if (f.lostReason !== undefined && lead.stage === 'lost' && f.lostReason !== before.lostReason) act(lead.id, 'edit', `Lost reason: ${lead.lostReason}`, actor.id);
      return getLead(lead.id);
    });
  }

  function deleteLead(id, actor) {
    if (roleOf(actor) !== 'owner') throw new CrmError(403, 'Only an owner can delete leads.');
    const r = getRow(id); if (!r) throw new CrmError(404, 'Lead not found');
    db.prepare('DELETE FROM leads WHERE id=?').run(r.id);
    return true;
  }

  const LOG_KINDS = { note: 'Note', call: 'Call', whatsapp: 'WhatsApp', email: 'Email', visit: 'Site visit' };
  function logActivity(id, { kind, body }, actor) {
    const lead = rowToLead(getRow(id)); if (!lead) throw new CrmError(404, 'Lead not found');
    if (!LOG_KINDS[kind]) throw bad('Unknown activity type.');
    const text = clean(body, 4000);
    if (!text) throw bad('Write what happened.');
    // Anyone on the team can add notes; contact logs need edit rights on the lead.
    if (kind !== 'note') assertEdit(actor, lead);
    return store.tx(() => {
      act(lead.id, kind, text, actor.id);
      if (['call', 'whatsapp', 'email'].includes(kind)) advance(lead, 'contacted', actor.id);
      if (kind === 'visit') advance(lead, 'visited', actor.id);
      return getLead(lead.id);
    });
  }

  /* ---------------- tasks ---------------- */
  function taskRow(t) {
    return { id: t.id, leadId: t.lead_id, title: t.title, kind: t.kind, dueAt: t.due_at, assigneeId: t.assignee_id, assignee: nameOf(t.assignee_id), doneAt: t.done_at, doneBy: nameOf(t.done_by), createdAt: t.created_at };
  }
  function listTasks() {
    const since = Date.now() - 14 * 864e5;
    return db.prepare('SELECT * FROM tasks WHERE done_at IS NULL OR done_at > ? ORDER BY due_at').all(since).map(taskRow);
  }
  function createTask(input, actor) {
    const title = clean(input.title, 200);
    const kind = TASK_KINDS.includes(input.kind) ? input.kind : 'follow_up';
    const due = Math.round(+input.dueAt);
    if (!title) throw bad('What needs doing?');
    if (!(due > 0)) throw bad('Choose when it’s due.');
    let assignee = input.assigneeId ? +input.assigneeId : actor.id;
    const a = store.adminById(assignee); if (!a || !a.active) throw bad('Choose an active team member.');
    let lead = null;
    if (input.leadId) { lead = rowToLead(getRow(input.leadId)); if (!lead) throw new CrmError(404, 'Lead not found'); assertEdit(actor, lead); }
    if (roleOf(actor) === 'sales' && assignee !== actor.id && !lead) assignee = actor.id;
    return store.tx(() => {
      const r = db.prepare('INSERT INTO tasks(lead_id,title,kind,due_at,assignee_id,created_by,created_at) VALUES(?,?,?,?,?,?,?)').run(lead ? lead.id : null, title, kind, due, assignee, actor.id, Date.now());
      if (lead) {
        act(lead.id, 'task', `${kind === 'visit' ? 'Site visit scheduled' : 'Follow-up set'}: ${title} · ${fmtWhen(due)}${assignee !== actor.id ? ' · for ' + nameOf(assignee) : ''}`, actor.id);
        if (kind === 'visit') advance(lead, 'visit_booked', actor.id);
      }
      return taskRow(db.prepare('SELECT * FROM tasks WHERE id=?').get(r.lastInsertRowid));
    });
  }
  function updateTask(id, input, actor) {
    const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(+id); if (!t) throw new CrmError(404, 'Task not found');
    const lead = t.lead_id ? rowToLead(getRow(t.lead_id)) : null;
    const mine = t.assignee_id === actor.id || t.created_by === actor.id;
    if (!mine && roleOf(actor) !== 'owner' && !(lead && canEditLead(actor, lead))) throw new CrmError(403, 'This follow-up belongs to someone else.');
    return store.tx(() => {
      if (input.done !== undefined) {
        const done = !!input.done;
        db.prepare('UPDATE tasks SET done_at=?, done_by=? WHERE id=?').run(done ? Date.now() : null, done ? actor.id : null, t.id);
        if (lead && done) {
          const outcome = clean(input.outcome, 2000);
          act(lead.id, t.kind === 'visit' ? 'visit' : 'task', `${t.kind === 'visit' ? 'Site visit done' : 'Done'}: ${t.title}${outcome ? ' — ' + outcome : ''}`, actor.id);
          if (t.kind === 'visit') advance(lead, 'visited', actor.id);
          if (t.kind === 'call') advance(lead, 'contacted', actor.id);
        }
      }
      if (input.dueAt !== undefined) {
        const due = Math.round(+input.dueAt); if (!(due > 0)) throw bad('Choose when it’s due.');
        db.prepare('UPDATE tasks SET due_at=? WHERE id=?').run(due, t.id);
        if (lead) act(lead.id, 'task', `Moved “${t.title}” to ${fmtWhen(due)}`, actor.id);
      }
      if (input.title !== undefined) { const title = clean(input.title, 200); if (title) db.prepare('UPDATE tasks SET title=? WHERE id=?').run(title, t.id); }
      if (input.assigneeId !== undefined) {
        const a = store.adminById(+input.assigneeId); if (!a || !a.active) throw bad('Choose an active team member.');
        db.prepare('UPDATE tasks SET assignee_id=? WHERE id=?').run(a.id, t.id);
      }
      return taskRow(db.prepare('SELECT * FROM tasks WHERE id=?').get(t.id));
    });
  }
  function deleteTask(id, actor) {
    const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(+id); if (!t) throw new CrmError(404, 'Task not found');
    if (t.created_by !== actor.id && roleOf(actor) !== 'owner') throw new CrmError(403, 'Only the person who set it, or an owner, can delete it.');
    db.prepare('DELETE FROM tasks WHERE id=?').run(t.id);
    return true;
  }
  function fmtWhen(ms) { return new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); }

  /* ---------------- booking & payment hooks ---------------- */
  const kindOf = b => (b.kind === 'stay' || b.kind === 'slot') ? b.kind : 'event';
  function linkBooking(leadId, b, actorId) {
    db.prepare('INSERT OR IGNORE INTO lead_bookings(lead_id,booking_id) VALUES(?,?)').run(leadId, b.id);
  }
  /** Called after any booking is created. Celebrations and stays join the pipeline; turf/court/café reservations don't. */
  function onBookingCreated(b, { leadId = null, actor = null } = {}) {
    try {
      const k = kindOf(b);
      if (k === 'slot' && !leadId) return null;
      const actorId = actor ? actor.id : null;
      let lead = leadId ? rowToLead(getRow(leadId)) : findMatch({ phone: b.customer.phone, email: b.customer.email });
      const what = `${b.venueName}${b.startDate ? ' · ' + b.startDate : ''}`;
      if (!lead) {
        const id = insertLead({ name: b.customer.name, phone: b.customer.phone, email: b.customer.email, city: b.customer.city, eventType: k === 'stay' ? 'Stay' : 'Wedding',
          eventDate: b.startDate, guests: b.guests, source: b.source === 'website' ? 'Booking page' : 'Other', stage: 'new', ownerId: actor && roleOf(actor) === 'sales' ? actor.id : null }, actorId);
        act(id, 'created', b.source === 'website' ? `Requested a quotation online for ${what}` : `Lead created from booking ${b.id}`, actorId);
        lead = rowToLead(getRow(id));
      }
      linkBooking(lead.id, b, actorId);
      act(lead.id, 'booking', `${b.status === 'enquiry' ? 'Enquiry' : 'Quotation'} ${b.quoteNo} · ${what} · ₹${(b.quote.total || 0).toLocaleString('en-IN')}`, actorId, { bookingId: b.id });
      if (b.status !== 'enquiry') advance(lead, 'quoted', actorId);
      return lead.id;
    } catch (e) { console.error('[crm] booking hook failed:', e.message); return null; }
  }
  function leadsForBooking(bookingId) { return db.prepare('SELECT lead_id FROM lead_bookings WHERE booking_id=?').all(bookingId).map(r => r.lead_id); }
  function onPayment(b, p, actor) {
    try {
      leadsForBooking(b.id).forEach(id => {
        const lead = rowToLead(getRow(id)); if (!lead) return;
        act(id, 'payment', `Paid ₹${p.amount.toLocaleString('en-IN')} (${p.type}) on ${b.id} · ${p.method}`, actor ? actor.id : null, { bookingId: b.id });
        if (OPEN(lead.stage)) moveStage(lead, 'won', actor ? actor.id : null, `advance received on ${b.id}`);
      });
    } catch (e) { console.error('[crm] payment hook failed:', e.message); }
  }
  function onStatus(b, status, actor) {
    try {
      if (!['cancelled', 'completed'].includes(status)) return;
      leadsForBooking(b.id).forEach(id => act(id, 'booking', `Booking ${b.id} ${status === 'cancelled' ? 'cancelled' : 'completed'}`, actor ? actor.id : null, { bookingId: b.id }));
    } catch (e) { console.error('[crm] status hook failed:', e.message); }
  }
  /** One-time: put existing website bookings into the pipeline so the CRM doesn't start empty. */
  function backfill() {
    if (store.getKV('crm:backfilled')) return;
    const all = store.allBookings().slice().reverse();
    all.forEach(b => {
      if (leadsForBooking(b.id).length) return;
      const id = onBookingCreated(b, {});
      if (!id) return;
      if (b.payments.length) { const lead = rowToLead(getRow(id)); if (lead && OPEN(lead.stage)) moveStage(lead, 'won', null, `advance received on ${b.id}`); }
      if (b.status === 'cancelled') { const lead = rowToLead(getRow(id)); if (lead && OPEN(lead.stage)) { lead.lostReason = 'Event cancelled'; moveStage(lead, 'lost', null, 'Event cancelled'); } }
    });
    store.setKV('crm:backfilled', true);
  }
  backfill();

  return {
    STAGES, ROLES, TASK_KINDS, CrmError, roleOf, canSell, canEditLead,
    lists, setLists, team, addMember, updateMember,
    leadSummaries, getLead, createLead, updateLead, deleteLead, logActivity,
    listTasks, createTask, updateTask, deleteTask,
    onBookingCreated, onPayment, onStatus, leadsForBooking, linkBooking: (leadId, b) => linkBooking(leadId, b)
  };
}

module.exports = { createCrm, STAGES, ROLES, CrmError };
