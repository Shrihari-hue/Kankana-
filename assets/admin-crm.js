/* admin-crm.js — Kankana CRM screens inside the studio dashboard:
   Leads (pipeline board + list), lead drawer (client timeline), Follow-ups, Team logins, CRM lists.
   Talks to /api/admin/leads, /tasks, /team. Loaded after admin.js (uses window.KA). */
(() => {
  'use strict';
  const KA = window.KA, K = KA.K, U = KA.U, $ = KA.$, esc = U.esc, toast = KA.toast;
  const S = () => KA.S;

  /* ------------------------------------------------ helpers */
  const STAGE_TONE = { new: 'amber', contacted: 'blue', visit_booked: 'blue', visited: 'blue', quoted: 'amber', negotiating: 'amber', won: 'green', lost: 'red' };
  const stages = () => S().crm.stages;
  const stageLabel = id => (stages().find(s => s.id === id) || { label: id }).label;
  const stagePill = id => `<span class="pill ${STAGE_TONE[id] || 'neutral'}">${esc(stageLabel(id))}</span>`;
  const me = () => S().me;
  const role = () => me().role;
  const isOwner = () => role() === 'owner';
  const canSell = () => ['owner', 'sales'].includes(role());
  const canEdit = l => isOwner() || (role() === 'sales' && (!l.ownerId || l.ownerId === me().id));
  const member = id => (S().team || []).find(t => t.id === id);
  const memberName = id => { const m = member(id); return m ? (m.name || m.email || 'Team member') : ''; };
  const initials = id => { const n = memberName(id); return n ? n.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() : ''; };
  const avatar = id => id ? `<span class="av" title="${esc(memberName(id))}">${esc(initials(id))}</span>` : '<span class="av none" title="Unassigned">?</span>';
  const activeTeam = () => (S().team || []).filter(t => t.active);
  const DAY = 864e5;
  const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const timeStr = t => new Date(t).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  function whenStr(t) {
    const d0 = startOfDay(Date.now()), d = startOfDay(t), diff = Math.round((d - d0) / DAY);
    if (diff === 0) return `Today ${timeStr(t)}`;
    if (diff === 1) return `Tomorrow ${timeStr(t)}`;
    if (diff === -1) return `Yesterday ${timeStr(t)}`;
    return new Date(t).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  }
  const isLate = t => t < Date.now();
  function ago(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now'; if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60); if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24); return d === 1 ? 'yesterday' : `${d} days ago`;
  }
  const inr = n => n ? U.inr(n) : '—';
  const opts = (list, cur, blank) => (blank != null ? `<option value="">${esc(blank)}</option>` : '') + list.map(v => `<option ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join('');
  const withCur = (list, cur) => cur && !list.includes(cur) ? list.concat(cur) : list;
  const localInput = t => { const d = new Date(t - new Date(t).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
  const tomorrowAt = h => { const d = new Date(Date.now() + DAY); d.setHours(h, 0, 0, 0); return d.getTime(); };
  const waNumber = p => { let d = String(p || '').replace(/\D/g, ''); if (d.length === 10) d = '91' + d; return d; };
  const firstName = n => String(n || '').trim().split(/\s+/)[0] || '';
  async function call(fn, okMsg) {
    try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
    catch (e) { if (e.status === 401) KA.showLogin(); toast(e.message, 5000); throw e; }
  }
  const refresh = async () => { await KA.reload(); KA.render(); };

  /* ------------------------------------------------ roles: what each person sees */
  const HIDE = { owner: [], sales: ['catalog', 'payments', 'reports'], accounts: ['quote', 'catalog'], events: ['quote', 'catalog', 'payments', 'reports'] };
  KA.onBoot.push(() => {
    const r = role();
    document.querySelectorAll('#tabs button').forEach(b => { b.hidden = (HIDE[r] || []).includes(b.dataset.tab); });
    document.querySelectorAll('.owner-only').forEach(el => { el.hidden = r !== 'owner'; });
    const exp = $('expCsv'); if (exp) exp.hidden = !['owner', 'accounts'].includes(r);
    document.querySelectorAll('[data-go="quote"]').forEach(b => { b.hidden = !canSell(); });
    $('lNew').hidden = !canSell();
    $('whoami').textContent = `${me().name || me().email} · ${S().crm.roles[r].label}`;
    fillFilters();
  });

  /* ------------------------------------------------ badges + overview cards */
  KA.afterRender(t => {
    const s = S(); if (!s || !s.leads) return;
    $('lCount').textContent = s.leads.filter(l => l.stage === 'new').length || '';
    const end = startOfDay(Date.now()) + DAY;
    $('tCount').textContent = s.tasks.filter(x => !x.doneAt && x.assigneeId === me().id && x.dueAt < end).length || '';
    if (t === 'overview') overviewCards();
    if (t === 'settings') { teamCard(); listsCard(); }
  });
  function overviewCards() {
    const end = startOfDay(Date.now()) + DAY;
    const mine = S().tasks.filter(x => !x.doneAt && x.assigneeId === me().id && x.dueAt < end + 6 * DAY).sort((a, b) => a.dueAt - b.dueAt).slice(0, 6);
    $('ovTasks').innerHTML = mine.length ? mine.map(taskRow).join('') : '<div class="empty" style="padding:24px">Nothing due this week. Set follow-ups from any lead.</div>';
    const fresh = S().leads.filter(l => l.stage === 'new').sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);
    $('ovLeads').innerHTML = fresh.length ? `<table class="t"><tbody>${fresh.map(l => `<tr class="click" data-lead="${esc(l.id)}"><td><b style="font-weight:500">${esc(l.name)}</b><div class="sub">${esc([l.eventType, l.eventDate, l.guests ? l.guests + ' guests' : ''].filter(Boolean).join(' · ') || l.phone)}</div></td><td class="sub" style="white-space:nowrap">${esc(l.source)}<br>${ago(l.createdAt)}</td><td class="r">${avatar(l.ownerId)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty" style="padding:24px">No new enquiries waiting. Every new lead has been contacted.</div>';
  }

  /* ------------------------------------------------ Leads tab */
  let view = 'board';
  try { view = localStorage.getItem('kk_lview') || 'board'; } catch (e) { /* storage unavailable */ }
  function fillFilters() {
    const keep = $('lOwner').value;
    $('lOwner').innerHTML = `<option value="">Everyone’s leads</option><option value="me">My leads</option><option value="none">Unassigned</option>` +
      activeTeam().filter(t => t.id !== me().id).map(t => `<option value="${t.id}">${esc(t.name || t.email)}</option>`).join('');
    if (keep) $('lOwner').value = keep;
    const ks = $('lSource').value;
    $('lSource').innerHTML = '<option value="">All sources</option>' + S().crm.sources.map(v => `<option>${esc(v)}</option>`).join('');
    if (ks) $('lSource').value = ks;
  }
  ['lSearch', 'lOwner', 'lSource', 'lClosed'].forEach(id => $(id).addEventListener('input', () => rLeads()));
  $('lView').onclick = e => { const b = e.target.closest('button'); if (!b) return; view = b.dataset.v; try { localStorage.setItem('kk_lview', view); } catch (_) {} rLeads(); };
  $('lNew').onclick = () => newLeadDrawer();

  function filtered() {
    const q = $('lSearch').value.trim().toLowerCase(), ow = $('lOwner').value, src = $('lSource').value, closedDays = +$('lClosed').value;
    const cutoff = Date.now() - closedDays * DAY;
    return S().leads.filter(l =>
      (!q || [l.id, l.name, l.phone, l.email, l.city].join(' ').toLowerCase().includes(q)) &&
      (!ow || (ow === 'me' ? l.ownerId === me().id : ow === 'none' ? !l.ownerId : l.ownerId === +ow)) &&
      (!src || l.source === src) &&
      (['won', 'lost'].includes(l.stage) ? closedDays > 0 && l.updatedAt >= cutoff : true));
  }
  function rLeads() {
    fillFilters();
    document.querySelectorAll('#lView button').forEach(b => b.classList.toggle('on', b.dataset.v === view));
    const all = S().leads, open = all.filter(l => !['won', 'lost'].includes(l.stage));
    const wk = Date.now() - 7 * DAY, mon = startOfDay(Date.now()) - (new Date().getDate() - 1) * DAY;
    const won = all.filter(l => l.stage === 'won' && l.updatedAt >= mon);
    const quoteVal = l => (l.bookingIds || []).map(id => S().bookings.find(b => b.id === id)).filter(Boolean).reduce((s, b) => s + (b.status !== 'cancelled' ? b.quote.total : 0), 0);
    const closedMonth = all.filter(l => ['won', 'lost'].includes(l.stage) && l.updatedAt >= mon);
    const noFollow = open.filter(l => !l.nextTaskAt).length;
    $('lKpis').innerHTML = [
      ['Open leads', open.length, `${all.filter(l => l.createdAt >= wk).length} new this week`],
      ['Quoted value', U.inr(open.reduce((s, l) => s + quoteVal(l), 0)), 'quotations still open'],
      ['Won this month', won.length, closedMonth.length ? `${Math.round(won.length / closedMonth.length * 100)}% of leads closed this month` : 'none closed yet'],
      ['No follow-up set', noFollow, noFollow ? 'open leads nobody is chasing' : 'every open lead has a next step']
    ].map(k => `<div class="kpi"><div class="l">${k[0]}</div><div class="v">${k[1]}</div><div class="s">${k[2]}</div></div>`).join('');
    const rows = filtered();
    $('lBoard').style.display = view === 'board' ? '' : 'none';
    $('lList').style.display = view === 'list' ? '' : 'none';
    if (view === 'board') drawBoard(rows); else drawList(rows);
  }
  function card(l) {
    const due = l.nextTaskAt ? `<span class="due ${isLate(l.nextTaskAt) ? 'late' : ''}">${isLate(l.nextTaskAt) ? 'Overdue · ' : ''}${esc(whenStr(l.nextTaskAt))}</span>` : (['won', 'lost'].includes(l.stage) ? `<span>${ago(l.updatedAt)}</span>` : '<span style="color:var(--red)">No follow-up</span>');
    const meta = [l.eventType, l.eventDate, l.guests ? l.guests + ' guests' : ''].filter(Boolean).join(' · ');
    return `<div class="lc" draggable="${canEdit(l)}" data-lead="${esc(l.id)}">
      <div class="nm"><span>${esc(l.name)}</span>${avatar(l.ownerId)}</div>
      <div class="meta">${esc(meta || l.phone || l.email)}</div>
      ${l.stage === 'lost' && l.lostReason ? `<div class="meta" style="color:var(--red)">${esc(l.lostReason)}</div>` : ''}
      <div class="foot"><span class="src">${esc(l.source)}</span>${due}</div></div>`;
  }
  function drawBoard(rows) {
    const closedDays = +$('lClosed').value;
    $('lBoard').innerHTML = stages().filter(s => closedDays > 0 || !['won', 'lost'].includes(s.id)).map(s => {
      const list = rows.filter(l => l.stage === s.id).sort((a, b) => (a.nextTaskAt || 9e15) - (b.nextTaskAt || 9e15) || b.updatedAt - a.updatedAt);
      return `<div class="col ${s.id}" data-stage="${s.id}"><div class="col-h"><b>${esc(s.label)}</b><span>${list.length}</span></div><div class="col-b">${list.map(card).join('') || ''}</div></div>`;
    }).join('');
  }
  function drawList(rows) {
    rows = rows.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    $('lTable').innerHTML = `<thead><tr><th>Lead</th><th>Contact</th><th>Event</th><th>Source</th><th>Stage</th><th>Next follow-up</th><th>Owner</th></tr></thead><tbody>${rows.map(l => `
      <tr class="click" data-lead="${esc(l.id)}"><td><b style="font-weight:500">${esc(l.name)}</b><div class="sub" style="font-family:Cinzel,serif;letter-spacing:.06em">${esc(l.id)}</div></td>
      <td>${esc(l.phone)}<div class="sub">${esc(l.email)}</div></td>
      <td>${esc(l.eventType || '—')}<div class="sub">${esc([l.eventDate, l.guests ? l.guests + ' guests' : ''].filter(Boolean).join(' · '))}</div></td>
      <td class="sub">${esc(l.source)}</td><td>${stagePill(l.stage)}</td>
      <td class="sub" style="white-space:nowrap;${l.nextTaskAt && isLate(l.nextTaskAt) ? 'color:var(--red)' : ''}">${l.nextTaskAt ? esc(whenStr(l.nextTaskAt)) : '—'}</td>
      <td>${l.ownerId ? esc(memberName(l.ownerId)) : '<span class="muted">Unassigned</span>'}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No leads match.</td></tr>'}</tbody>`;
  }
  KA.addTab('leads', rLeads);

  /* drag a card to another column to move its stage */
  let dragId = null;
  $('lBoard').addEventListener('dragstart', e => { const c = e.target.closest('.lc'); if (!c) return; dragId = c.dataset.lead; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', dragId); } catch (_) {} });
  $('lBoard').addEventListener('dragend', e => { const c = e.target.closest('.lc'); if (c) c.classList.remove('dragging'); document.querySelectorAll('.col.drop').forEach(x => x.classList.remove('drop')); });
  $('lBoard').addEventListener('dragover', e => { const col = e.target.closest('.col'); if (!col || !dragId) return; e.preventDefault(); document.querySelectorAll('.col.drop').forEach(x => x !== col && x.classList.remove('drop')); col.classList.add('drop'); });
  $('lBoard').addEventListener('drop', async e => {
    const col = e.target.closest('.col'); if (!col || !dragId) return; e.preventDefault();
    const id = dragId; dragId = null; col.classList.remove('drop');
    const to = col.dataset.stage, l = S().leads.find(x => x.id === id);
    if (!l || l.stage === to) return;
    if (to === 'lost') return openLead(id, { askLost: true });
    try { await call(() => K.api('PUT', `/api/admin/leads/${encodeURIComponent(id)}`, { stage: to }), `${l.name} → ${stageLabel(to)}`); await refresh(); } catch (_) {}
  });

  /* any [data-lead] anywhere opens the lead */
  document.addEventListener('click', e => {
    const a = e.target.closest('[data-lead]'); if (!a || e.target.closest('input,button:not([data-lead]),select,textarea')) return;
    e.preventDefault(); openLead(a.dataset.lead);
  });

  /* ------------------------------------------------ lead drawer */
  const ICON = { created: '✦', enquiry: '✉', note: '✎', call: '☎', whatsapp: '◉', email: '@', visit: '⌂', stage: '→', owner: '◎', task: '✓', booking: '₹', payment: '₹', edit: '✎' };
  const KIND_WORD = { call: 'Call', whatsapp: 'WhatsApp', email: 'Email', visit: 'Site visit', note: 'Note' };
  let cur = null;
  function show(html) { $('drawer').innerHTML = html; $('drawer').classList.add('open'); $('drawerBg').classList.add('open'); $('drawer').scrollTop = 0; }
  async function openLead(id, o = {}) {
    let r;
    try { r = await K.api('GET', `/api/admin/leads/${encodeURIComponent(id)}`); } catch (e) { if (e.status === 401) return KA.showLogin(); return toast(e.message, 5000); }
    cur = r.lead; drawLead(cur, r.canEdit, o);
  }
  KA.showDrawer = show; KA.newLeadDrawer = pre => newLeadDrawer(pre); KA.openLead = id => openLead(id);
  KA.reopenLead = id => { if ($('drawer').classList.contains('open') && cur && cur.id === id) openLead(id); };
  function drawLead(l, editable, o = {}) {
    const lists = S().crm;
    const books = (l.bookingIds || []).map(id => S().bookings.find(b => b.id === id)).filter(Boolean);
    const openTasks = l.tasks.filter(t => !t.doneAt);
    const tel = l.phone ? `tel:${esc(l.phone.replace(/[^\d+]/g, ''))}` : '';
    const ownerCtl = isOwner()
      ? `<select id="ldOwner" class="k-input" style="width:auto;padding:7px 10px;font-size:13px"><option value="">Unassigned</option>${activeTeam().map(t => `<option value="${t.id}" ${t.id === l.ownerId ? 'selected' : ''}>${esc(t.name || t.email)}</option>`).join('')}</select>`
      : (l.ownerId ? esc(memberName(l.ownerId)) : (role() === 'sales' ? '<button class="btn sm" id="ldClaim" type="button">Assign to me</button>' : 'Unassigned'));
    show(`
      <div class="dr-h"><div style="min-width:0"><div class="eyebrow">${esc(l.id)} · ${esc(l.source)}${l.campaign ? ' · ' + esc(l.campaign) : ''} · ${new Date(l.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
        <h2>${esc(l.name)}</h2><div style="margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">${stagePill(l.stage)}<span class="muted" style="font-size:13px">Owner:</span> ${ownerCtl}</div></div>
        <button class="dr-x" id="drX" aria-label="Close">×</button></div>
      <div class="dr-b">
        <div class="dr-sec"><div class="quick">
          ${tel ? `<a href="${tel}" id="qCall">☎ Call ${esc(l.phone)}</a>` : ''}
          ${l.phone ? '<button type="button" class="wa" id="qWa">◉ WhatsApp</button>' : ''}
          ${l.email ? `<a href="mailto:${esc(l.email)}">@ Email</a>` : ''}
          ${canSell() && l.stage !== 'lost' ? '<button type="button" id="qQuote">₹ Create quotation</button>' : ''}
        </div></div>

        <div class="dr-sec" id="ldMsg"></div>

        <div class="dr-sec"><h4>Stage</h4>
          <div class="stages">${stages().map(s => `<button type="button" data-st="${s.id}" class="${s.id} ${s.id === l.stage ? 'on' : ''}" ${editable ? '' : 'disabled'}>${esc(s.label)}</button>`).join('')}</div>
          <div id="lostBox" style="display:${o.askLost ? 'block' : 'none'};margin-top:12px"><div class="row">
            <label class="field" style="flex:2"><span>Why was it lost?</span><select id="ldLost">${opts(withCur(lists.lostReasons, l.lostReason), l.lostReason, 'Choose a reason')}</select></label>
            <button class="btn sm solid" id="ldLostGo" type="button">Mark as lost</button></div></div>
          ${l.stage === 'lost' && l.lostReason ? `<div class="muted" style="font-size:13px;margin-top:8px">Lost: ${esc(l.lostReason)}</div>` : ''}
          ${editable ? '' : `<div class="muted" style="font-size:12px;margin-top:8px">${role() === 'sales' ? `Owned by ${esc(memberName(l.ownerId))} — you can add notes.` : 'Your role can add notes but not change leads.'}</div>`}
        </div>

        <div class="dr-sec"><h4>Next follow-up</h4>
          ${openTasks.length ? openTasks.map(taskRow).join('') : '<div class="muted" style="font-size:13px;padding:4px 0 8px">Nothing scheduled — set the next step so this lead doesn’t go cold.</div>'}
          ${editable ? `<div class="row" style="margin-top:10px">
            <label class="field" style="flex:.8"><span>Type</span><select id="tkKind"><option value="call">Call</option><option value="follow_up">Follow-up</option><option value="visit">Site visit</option><option value="other">Other</option></select></label>
            <label class="field" style="flex:1.6"><span>What</span><input id="tkTitle" placeholder="Call back about dates"></label>
            <label class="field" style="flex:1.2"><span>When</span><input id="tkDue" type="datetime-local" value="${localInput(tomorrowAt(11))}"></label>
            ${isOwner() || role() === 'sales' ? `<label class="field" style="flex:1"><span>Who</span><select id="tkWho">${activeTeam().map(t => `<option value="${t.id}" ${t.id === (l.ownerId || me().id) ? 'selected' : ''}>${esc(t.name || t.email)}</option>`).join('')}</select></label>` : ''}
            <button class="btn sm solid" id="tkAdd" type="button">Set</button></div>` : ''}
        </div>

        <div class="dr-sec log-box"><h4>Log what happened</h4>
          <textarea id="lgText" placeholder="e.g. Spoke to the bride’s father — wants a visit on Sunday, budget around 25 lakh"></textarea>
          <div class="quick" style="margin-top:8px">
            <button type="button" data-log="note">Add note</button>
            ${editable ? '<button type="button" data-log="call">Log call</button><button type="button" data-log="whatsapp">Log WhatsApp</button><button type="button" data-log="email">Log email</button><button type="button" data-log="visit">Log site visit</button>' : ''}
          </div>
        </div>

        ${books.length ? `<div class="dr-sec"><h4>Quotations &amp; bookings</h4><div class="pay-list">${books.map(b => `<div data-open-bk="${esc(b.id)}" style="cursor:pointer"><span><b style="font-weight:500">${esc(b.id)}</b> · ${esc(U.describe(b).name)} · ${esc(U.describe(b).whenShort)}</span><span>${U.inr(b.quote.total)} ${KA.pill(b.status)}</span></div>`).join('')}</div></div>` : ''}

        <div class="dr-sec"><h4>Details</h4>
          <div class="grid2">
            <label class="field"><span>Name</span><input id="ld_name" value="${esc(l.name)}" ${editable ? '' : 'disabled'}></label>
            <label class="field"><span>Phone</span><input id="ld_phone" value="${esc(l.phone)}" ${editable ? '' : 'disabled'}></label>
            <label class="field"><span>Email</span><input id="ld_email" type="email" value="${esc(l.email)}" ${editable ? '' : 'disabled'}></label>
            <label class="field"><span>City</span><input id="ld_city" value="${esc(l.city)}" ${editable ? '' : 'disabled'}></label>
            <label class="field"><span>Event</span><select id="ld_type" ${editable ? '' : 'disabled'}>${opts(withCur(lists.eventTypes, l.eventType), l.eventType, '—')}</select></label>
            <label class="field"><span>Event date</span><input id="ld_date" value="${esc(l.eventDate)}" placeholder="2027-02-14 or “Feb 2027”" ${editable ? '' : 'disabled'}></label>
            <label class="field"><span>Guests</span><input id="ld_guests" type="number" min="0" value="${l.guests || ''}" ${editable ? '' : 'disabled'}></label>
            <label class="field"><span>Budget (₹)</span><input id="ld_budget" type="number" min="0" step="10000" value="${l.budget || ''}" ${editable ? '' : 'disabled'}></label>
            <label class="field"><span>Source</span><select id="ld_source" ${editable ? '' : 'disabled'}>${opts(withCur(lists.sources, l.source), l.source)}</select></label>
          </div>
          ${l.message ? `<div class="field" style="margin-top:12px"><span>Their message</span><div style="white-space:pre-wrap;font-size:14px;line-height:1.6;background:#fffdf8;border:1px solid var(--line-soft);padding:10px 12px">${esc(l.message)}</div></div>` : ''}
          ${editable ? '<button class="btn sm" id="ldSave" type="button" style="margin-top:12px">Save details</button>' : ''}
        </div>

        <div class="dr-sec"><h4>Timeline</h4><ul class="acts">${l.activities.map(a => `<li><span class="ic ${esc(a.kind)}">${ICON[a.kind] || '·'}</span><div>${KIND_WORD[a.kind] ? `<b style="font-weight:500">${KIND_WORD[a.kind]}</b> — ` : ''}${esc(a.body)}<div class="t">${esc(whenStr(a.at))}${a.actor ? ' · ' + esc(a.actor) : ''}</div></div></li>`).join('')}</ul></div>
        ${isOwner() ? '<div class="dr-sec"><button class="btn sm danger" id="ldDel" type="button">Delete lead</button></div>' : ''}
      </div>`);
    wireLead(l, editable);
    if (o.askLost) $('ldLost').focus();
  }
  const put = (l, body, msg) => call(() => K.api('PUT', `/api/admin/leads/${encodeURIComponent(l.id)}`, body), msg).then(async () => { await refresh(); await openLead(l.id); }).catch(() => {});
  function wireLead(l, editable) {
    $('drX').onclick = KA.closeDrawer;
    const q = $('qQuote'); if (q) q.onclick = () => { KA.closeDrawer(); KA.quoteForLead(l); };
    const wa = $('qWa'); if (wa) wa.onclick = () => { const box = $('ldMsg'); box.scrollIntoView({ behavior: 'smooth', block: 'start' }); $('mgText').focus(); };
    const pick = l.stage === 'new' ? 'first_reply' : l.stage === 'visit_booked' ? 'visit_confirm' : l.stage === 'quoted' || l.stage === 'negotiating' ? 'quote_followup' : l.stage === 'won' ? 'thanks' : l.stage === 'lost' ? 'keep_in_touch' : 'no_response';
    if (KA.msgPanel) KA.msgPanel($('ldMsg'), { lead: l }, pick);
    const ow = $('ldOwner'); if (ow) ow.onchange = () => put(l, { ownerId: ow.value ? +ow.value : null }, ow.value ? `Assigned to ${memberName(+ow.value)}` : 'Unassigned');
    const cl = $('ldClaim'); if (cl) cl.onclick = () => put(l, { ownerId: me().id }, 'Assigned to you');
    document.querySelectorAll('.stages [data-st]').forEach(b => b.onclick = () => {
      const to = b.dataset.st; if (to === l.stage) return;
      if (to === 'lost') { $('lostBox').style.display = 'block'; $('ldLost').focus(); return; }
      put(l, { stage: to }, `Moved to ${stageLabel(to)}`);
    });
    const lg = $('ldLostGo'); if (lg) lg.onclick = () => { const r = $('ldLost').value; if (!r) return toast('Choose why it was lost'); put(l, { stage: 'lost', lostReason: r }, 'Marked as lost'); };
    const ta = $('tkAdd'); if (ta) ta.onclick = () => {
      const kind = $('tkKind').value, title = $('tkTitle').value.trim() || { call: 'Call back', follow_up: 'Follow up', visit: 'Site visit', other: 'Follow up' }[kind];
      const due = new Date($('tkDue').value).getTime();
      if (!due) return toast('Choose when');
      call(() => K.api('POST', '/api/admin/tasks', { leadId: l.id, kind, title, dueAt: due, assigneeId: $('tkWho') ? +$('tkWho').value : undefined }), kind === 'visit' ? 'Site visit scheduled' : 'Follow-up set')
        .then(async () => { await refresh(); await openLead(l.id); }).catch(() => {});
    };
    document.querySelectorAll('[data-log]').forEach(b => b.onclick = () => {
      const body = $('lgText').value.trim(); if (!body) { $('lgText').focus(); return toast('Write what happened first'); }
      call(() => K.api('POST', `/api/admin/leads/${encodeURIComponent(l.id)}/activity`, { kind: b.dataset.log, body }), 'Added to the timeline')
        .then(async () => { await refresh(); await openLead(l.id); }).catch(() => {});
    });
    const sv = $('ldSave'); if (sv) sv.onclick = () => put(l, {
      name: $('ld_name').value, phone: $('ld_phone').value, email: $('ld_email').value, city: $('ld_city').value, eventType: $('ld_type').value,
      eventDate: $('ld_date').value, guests: $('ld_guests').value, budget: $('ld_budget').value, source: $('ld_source').value
    }, 'Details saved');
    document.querySelectorAll('[data-open-bk]').forEach(x => x.onclick = () => KA.openDrawer(x.dataset.openBk));
    const del = $('ldDel'); if (del) del.onclick = () => {
      if (!del.dataset.sure) { del.dataset.sure = '1'; del.textContent = 'Click again to delete for good'; return; }
      call(() => K.api('DELETE', `/api/admin/leads/${encodeURIComponent(l.id)}`), 'Lead deleted').then(async () => { KA.closeDrawer(); await refresh(); }).catch(() => {});
    };
    wireTasks($('drawer'), () => openLead(l.id));
  }

  /* new lead */
  function newLeadDrawer(pre) {
    const lists = S().crm;
    show(`<div class="dr-h"><div><div class="eyebrow">${pre ? 'From an email' : 'Phone call, walk-in, Instagram…'}</div><h2>New lead</h2></div><button class="dr-x" id="drX" aria-label="Close">×</button></div>
      <div class="dr-b">
        ${pre && pre._note ? `<div class="card" style="background:${pre._warn ? 'var(--amber-bg)' : 'var(--green-bg)'};border:none;padding:12px 16px;margin-bottom:14px;font-size:13px;line-height:1.55;color:${pre._warn ? 'var(--amber)' : 'var(--green)'}">${pre._note}</div>` : ''}
        <div class="grid2">
          <label class="field"><span>Name *</span><input id="nl_name" placeholder="Ananya Rao"></label>
          <label class="field"><span>Phone *</span><input id="nl_phone" placeholder="+91 98450 00000"></label>
          <label class="field"><span>Email</span><input id="nl_email" type="email"></label>
          <label class="field"><span>City</span><input id="nl_city"></label>
          <label class="field"><span>Event</span><select id="nl_type">${opts(lists.eventTypes, 'Wedding')}</select></label>
          <label class="field"><span>Event date</span><input id="nl_date" placeholder="2027-02-14 or “Feb 2027”"></label>
          <label class="field"><span>Guests</span><input id="nl_guests" type="number" min="0"></label>
          <label class="field"><span>Budget (₹)</span><input id="nl_budget" type="number" min="0" step="10000"></label>
          <label class="field"><span>Source *</span><select id="nl_source">${opts(lists.sources.filter(s => s !== 'Website' && s !== 'Booking page'), 'Phone call')}</select></label>
          ${isOwner() ? `<label class="field"><span>Owner</span><select id="nl_owner"><option value="">Unassigned</option>${activeTeam().map(t => `<option value="${t.id}">${esc(t.name || t.email)}</option>`).join('')}</select></label>` : ''}
        </div>
        <label class="field" style="margin-top:12px"><span>What they asked for</span><textarea id="nl_msg" rows="3" placeholder="3-day wedding, needs 10 rooms, vegetarian menu…"></textarea></label>
        <div class="row" style="margin-top:12px">
          <label class="field"><span>First follow-up</span><input id="nl_due" type="datetime-local" value="${localInput(tomorrowAt(11))}"></label>
          <label class="field" style="flex:1.6"><span>What</span><input id="nl_task" value="Call back"></label>
        </div>
        <div class="err" id="nl_err" style="color:var(--red);font-size:13px;margin-top:10px;min-height:1em"></div>
        <button class="btn solid" id="nl_go" type="button" style="margin-top:6px">Save lead</button>
      </div>`);
    $('drX').onclick = KA.closeDrawer; $('nl_name').focus();
    if (pre) {
      const put = (id, v) => { const el = $(id); if (!el || v === undefined || v === null || v === '') return; if (el.tagName === 'SELECT' && ![...el.options].some(o => o.value === String(v))) el.add(new Option(v, v)); el.value = v; };
      put('nl_name', pre.name); put('nl_phone', pre.phone); put('nl_email', pre.email); put('nl_city', pre.city); put('nl_type', pre.eventType); put('nl_date', pre.eventDate);
      put('nl_guests', pre.guests); put('nl_budget', pre.budget); put('nl_source', pre.source); put('nl_msg', pre.message);
      (pre._missing || []).forEach(id => { const el = $(id); if (el) el.style.borderColor = 'var(--amber)'; });
    }
    $('nl_go').onclick = async () => {
      $('nl_err').textContent = '';
      const body = { name: $('nl_name').value, phone: $('nl_phone').value, email: $('nl_email').value, city: $('nl_city').value, eventType: $('nl_type').value,
        eventDate: $('nl_date').value, guests: $('nl_guests').value, budget: $('nl_budget').value, source: $('nl_source').value, message: $('nl_msg').value };
      if ($('nl_owner')) body.ownerId = $('nl_owner').value ? +$('nl_owner').value : null;
      $('nl_go').disabled = true;
      try {
        const r = await K.api('POST', '/api/admin/leads', body);
        const due = new Date($('nl_due').value).getTime();
        if (due && $('nl_task').value.trim()) await K.api('POST', '/api/admin/tasks', { leadId: r.lead.id, kind: 'call', title: $('nl_task').value.trim(), dueAt: due, assigneeId: r.lead.ownerId || me().id }).catch(() => {});
        toast(r.merged ? `Already in the CRM — added to ${r.lead.id} (${r.lead.name})` : `${r.lead.id} saved`);
        await refresh(); await openLead(r.lead.id);
      } catch (e) { if (e.status === 401) return KA.showLogin(); $('nl_err').textContent = e.message; $('nl_go').disabled = false; }
    };
  }

  /* ------------------------------------------------ follow-ups */
  const KIND_TAG = { call: 'Call', visit: 'Site visit', follow_up: 'Follow-up', whatsapp: 'WhatsApp', other: 'To-do' };
  function taskRow(t) {
    const l = t.leadId ? S().leads.find(x => x.id === t.leadId) : null;
    return `<div class="task ${t.doneAt ? 'done' : ''}" data-task="${t.id}">
      <input type="checkbox" data-done="${t.id}" ${t.doneAt ? 'checked' : ''} aria-label="Mark done">
      <div><div class="tt">${esc(t.title)} <span class="src" style="margin-left:4px">${KIND_TAG[t.kind] || ''}</span>${t.auto ? '<span class="auto">automatic</span>' : ''}</div>
        ${l ? `<a href="#" data-lead="${esc(l.id)}" class="w" style="color:var(--gold-deep)">${esc(l.name)}${l.phone ? ' · ' + esc(l.phone) : ''}</a>` : ''}
        ${t.kind === 'whatsapp' && t.message && !t.doneAt ? `<div class="peek">${esc(t.message.replace(/\s+/g, ' '))}</div><button type="button" class="wa-btn" data-wa="${t.id}">◉ Send on WhatsApp</button>` : ''}</div>
      <div style="text-align:right"><div class="w ${!t.doneAt && isLate(t.dueAt) ? 'late' : ''}">${t.doneAt ? 'Done ' + esc(whenStr(t.doneAt)) : esc(whenStr(t.dueAt))}</div>
        <div class="w">${esc(t.assignee || '')}${!t.doneAt ? ` · <a href="#" data-snooze="${t.id}" style="color:inherit">+1 day</a>` : ''}</div></div></div>`;
  }
  function wireTasks(root, after) {
    root.querySelectorAll('[data-wa]').forEach(btn => btn.onclick = () => {
      const t = S().tasks.find(x => x.id === +btn.dataset.wa); if (!t) return;
      window.open(KA.waLink(t.phone, t.message), '_blank', 'noopener');
      call(() => K.api('PUT', `/api/admin/tasks/${t.id}`, { done: true, sent: true }), 'Marked as sent').then(async () => { await refresh(); if (after) await after(); }).catch(() => {});
    });
    root.querySelectorAll('[data-done]').forEach(c => c.onchange = () => {
      call(() => K.api('PUT', `/api/admin/tasks/${c.dataset.done}`, { done: c.checked }), c.checked ? 'Done ✓' : 'Reopened').then(async () => { await refresh(); if (after) await after(); }).catch(() => { c.checked = !c.checked; });
    });
    root.querySelectorAll('[data-snooze]').forEach(a => a.onclick = e => {
      e.preventDefault(); const t = S().tasks.find(x => x.id === +a.dataset.snooze); if (!t) return;
      call(() => K.api('PUT', `/api/admin/tasks/${t.id}`, { dueAt: Math.max(t.dueAt, Date.now()) + DAY }), 'Moved to tomorrow').then(async () => { await refresh(); if (after) await after(); }).catch(() => {});
    });
  }
  let who = 'me';
  $('tWho').onclick = e => { const b = e.target.closest('button'); if (!b) return; who = b.dataset.v; rTasks(); };
  $('tNew').onclick = () => {
    const box = $('tAdd'); box.style.display = box.style.display === 'none' ? 'block' : 'none';
    const open = S().leads.filter(l => !['won', 'lost'].includes(l.stage)).sort((a, b) => a.name.localeCompare(b.name));
    box.innerHTML = `<div class="row">
      <label class="field" style="flex:1.6"><span>What</span><input id="nt_title" placeholder="Send menu options"></label>
      <label class="field" style="flex:.8"><span>Type</span><select id="nt_kind"><option value="follow_up">Follow-up</option><option value="call">Call</option><option value="visit">Site visit</option><option value="other">To-do</option></select></label>
      <label class="field" style="flex:1.2"><span>When</span><input id="nt_due" type="datetime-local" value="${localInput(tomorrowAt(11))}"></label>
      <label class="field" style="flex:1.2"><span>Lead (optional)</span><select id="nt_lead"><option value="">—</option>${open.map(l => `<option value="${esc(l.id)}">${esc(l.name)} · ${esc(l.id)}</option>`).join('')}</select></label>
      ${isOwner() ? `<label class="field"><span>Who</span><select id="nt_who">${activeTeam().map(t => `<option value="${t.id}" ${t.id === me().id ? 'selected' : ''}>${esc(t.name || t.email)}</option>`).join('')}</select></label>` : ''}
      <button class="btn sm solid" id="nt_go" type="button">Add</button></div>`;
    $('nt_title').focus();
    $('nt_go').onclick = () => {
      const due = new Date($('nt_due').value).getTime(); const title = $('nt_title').value.trim();
      if (!title) return toast('What needs doing?');
      call(() => K.api('POST', '/api/admin/tasks', { title, kind: $('nt_kind').value, dueAt: due, leadId: $('nt_lead').value || undefined, assigneeId: $('nt_who') ? +$('nt_who').value : undefined }), 'Follow-up added')
        .then(async () => { box.style.display = 'none'; await refresh(); }).catch(() => {});
    };
  };
  function rTasks() {
    document.querySelectorAll('#tWho button').forEach(b => b.classList.toggle('on', b.dataset.v === who));
    const list = S().tasks.filter(t => who === 'all' || t.assigneeId === me().id);
    const d0 = startOfDay(Date.now()), d1 = d0 + DAY, d2 = d1 + DAY, d7 = d0 + 7 * DAY;
    const open = list.filter(t => !t.doneAt).sort((a, b) => a.dueAt - b.dueAt);
    const groups = [
      ['Overdue', open.filter(t => t.dueAt < Date.now()), 'late'],
      ['Later today', open.filter(t => t.dueAt >= Date.now() && t.dueAt < d1)],
      ['Tomorrow', open.filter(t => t.dueAt >= d1 && t.dueAt < d2)],
      ['This week', open.filter(t => t.dueAt >= d2 && t.dueAt < d7)],
      ['Later', open.filter(t => t.dueAt >= d7)],
      ['Done recently', list.filter(t => t.doneAt).sort((a, b) => b.doneAt - a.doneAt).slice(0, 15)]
    ];
    $('tGroups').innerHTML = groups.filter(g => g[1].length).map(g => `<div class="tgrp ${g[2] || ''}"><h4>${g[0]} · ${g[1].length}</h4><div class="card">${g[1].map(taskRow).join('')}</div></div>`).join('')
      || `<div class="card empty">${who === 'me' ? 'You have no follow-ups. Set one from any lead, or add one above.' : 'No follow-ups yet.'}</div>`;
    wireTasks($('tGroups'));
  }
  KA.addTab('tasks', rTasks);
  KA.afterRender(t => { if (t === 'overview') wireTasks($('ovTasks')); });

  /* ------------------------------------------------ settings: team + lists */
  function teamCard() {
    if (!isOwner()) return;
    const roles = S().crm.roles;
    $('tm_role').innerHTML = Object.entries(roles).map(([k, r]) => `<option value="${k}" ${k === 'sales' ? 'selected' : ''}>${esc(r.label)}</option>`).join('');
    $('roleHelp').innerHTML = Object.values(roles).map(r => `<b style="font-weight:500">${esc(r.label)}</b> — ${esc(r.desc)}`).join('<br>');
    $('teamTable').innerHTML = `<thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Login</th><th></th></tr></thead><tbody>${S().team.map(t => `
      <tr data-tm="${t.id}"><td>${esc(t.name || '—')}${t.id === me().id ? ' <span class="muted">(you)</span>' : ''}</td><td>${esc(t.email)}</td>
      <td><select data-tm-role="${t.id}" ${t.id === me().id ? 'disabled' : ''} style="font:inherit;font-size:13px;padding:6px 8px;border:1px solid var(--line-soft);background:#fffdf8">${Object.entries(roles).map(([k, r]) => `<option value="${k}" ${k === t.role ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select></td>
      <td>${t.active ? '<span class="pill green">Active</span>' : '<span class="pill neutral">Turned off</span>'}</td>
      <td class="r">${t.id === me().id ? '' : `<button class="btn sm ghost" data-tm-reset="${t.id}" type="button">New password</button> <button class="btn sm ${t.active ? 'danger' : ''}" data-tm-toggle="${t.id}" type="button">${t.active ? 'Turn off' : 'Turn on'}</button>`}</td></tr>`).join('')}</tbody>`;
    const pwBox = (who, pw) => {
      const b = $('tm_pw'); b.style.display = 'block';
      b.innerHTML = `<div class="card" style="background:var(--amber-bg);border:none;padding:16px 18px;font-size:14px;line-height:1.6">Temporary password for <b style="font-weight:500">${esc(who)}</b>: <code class="code" style="display:inline-block;padding:4px 8px;margin:0 6px;user-select:all">${esc(pw)}</code><button class="btn sm" id="tm_copy" type="button">Copy</button><br><span class="muted" style="font-size:12px">Shown once. Send it to them privately (WhatsApp or in person). They sign in at <b style="font-weight:500">${esc(location.origin)}/admin</b> and should change it under Settings → Your account.</span></div>`;
      $('tm_copy').onclick = async () => { try { await navigator.clipboard.writeText(pw); toast('Copied'); } catch (e) { toast('Select the password and copy it'); } };
    };
    $('tm_add').onclick = () => call(() => K.api('POST', '/api/admin/team', { name: $('tm_name').value, email: $('tm_email').value, role: $('tm_role').value }))
      .then(async r => { $('tm_name').value = $('tm_email').value = ''; await KA.reload(); teamCard(); pwBox(r.member.name || r.member.email, r.tempPassword); toast(`${r.member.name} can now sign in`); }).catch(() => {});
    document.querySelectorAll('[data-tm-role]').forEach(s => s.onchange = () => call(() => K.api('PUT', `/api/admin/team/${s.dataset.tmRole}`, { role: s.value }), 'Role updated — they’ll need to sign in again').then(async () => { await KA.reload(); teamCard(); }).catch(async () => { await KA.reload(); teamCard(); }));
    document.querySelectorAll('[data-tm-toggle]').forEach(b => b.onclick = () => { const t = S().team.find(x => x.id === +b.dataset.tmToggle); call(() => K.api('PUT', `/api/admin/team/${t.id}`, { active: !t.active }), t.active ? `${t.name}’s login turned off` : `${t.name} can sign in again`).then(async () => { await KA.reload(); teamCard(); }).catch(() => {}); });
    document.querySelectorAll('[data-tm-reset]').forEach(b => b.onclick = () => { const t = S().team.find(x => x.id === +b.dataset.tmReset); call(() => K.api('POST', `/api/admin/team/${t.id}/reset`, {})).then(r => pwBox(t.name || t.email, r.tempPassword)).catch(() => {}); });
  }
  function listsCard() {
    if (!isOwner()) return;
    const c = S().crm;
    $('cl_sources').value = c.sources.join('\n'); $('cl_types').value = c.eventTypes.join('\n'); $('cl_lost').value = c.lostReasons.join('\n');
    $('cl_save').onclick = () => {
      const lines = id => $(id).value.split('\n').map(x => x.trim()).filter(Boolean);
      call(() => K.api('PUT', '/api/admin/crm-lists', { sources: lines('cl_sources'), eventTypes: lines('cl_types'), lostReasons: lines('cl_lost') }), 'Lists saved').then(async () => { await KA.reload(); listsCard(); fillFilters(); }).catch(() => {});
    };
  }
})();
