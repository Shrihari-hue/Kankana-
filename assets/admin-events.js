/* admin-events.js — CRM phase 4: the Events tab.
   Upcoming events with planning progress → a planner per booking (checklist, run-sheet,
   rooming list, notes), the vendor directory, client feedback, and the checklist
   template in Settings. Talks to /api/admin/events, /plan-items, /runsheet, /rooming, /vendors, /feedback. */
(() => {
  'use strict';
  const KA = window.KA, K = KA.K, U = KA.U, $ = KA.$, esc = U.esc, toast = KA.toast;
  const S = () => KA.S;
  let view = 'upcoming', list = null, vendors = [], sections = [], vendorCats = [], open = null, plan = null, sub = 'checklist';
  const me = () => S().me, team = () => (S().team || []).filter(t => t.active);
  const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const fmtD = d => d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : '—';
  const fmtLong = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const daysTo = d => Math.round((Date.parse(d + 'T00:00:00Z') - Date.parse(today() + 'T00:00:00Z')) / 864e5);
  const stars = n => '★'.repeat(n || 0) + '☆'.repeat(5 - (n || 0));
  async function call(fn, okMsg) { try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { if (e.status === 401) KA.showLogin(); toast(e.message, 5000); throw e; } }
  const memberOpts = (cur, blank = 'Unassigned') => `<option value="">${esc(blank)}</option>` + team().map(t => `<option value="${t.id}" ${t.id === cur ? 'selected' : ''}>${esc(t.name || t.email)}</option>`).join('');
  const vendorOpts = cur => '<option value="">No vendor</option>' + vendors.filter(v => v.active || v.id === cur).map(v => `<option value="${v.id}" ${v.id === cur ? 'selected' : ''}>${esc(v.name)} · ${esc(v.category)}</option>`).join('');

  /* ------------------------------------------------ load */
  async function loadList() {
    const r = await K.api('GET', '/api/admin/events');
    list = r.events; vendors = r.vendors; sections = r.sections; vendorCats = r.vendorCategories;
    const due = list.filter(e => e.startDate >= today() && e.overdue > 0).length;
    $('eCount').textContent = due || '';
  }
  async function loadPlan(id) { plan = await K.api('GET', `/api/admin/events/${encodeURIComponent(id)}`); open = id; }
  KA.onBoot.push(() => { loadList().catch(() => {}); });

  async function rEvents() {
    document.querySelectorAll('#evView button').forEach(b => b.classList.toggle('on', b.dataset.v === view && !open));
    try {
      await loadList();
      if (open) { await loadPlan(open); return drawPlan(); }
      ({ upcoming: drawList, past: drawList, vendors: drawVendors, feedback: drawFeedback })[view]();
    } catch (e) { if (e.status === 401) return KA.showLogin(); $('evBody').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
  KA.addTab('events', rEvents);
  $('evView').onclick = e => { const b = e.target.closest('button'); if (!b) return; view = b.dataset.v; open = null; $('evTitle').textContent = 'Events'; rEvents(); };

  /* ------------------------------------------------ list */
  function drawList() {
    const t = today();
    const rows = list.filter(e => view === 'upcoming' ? e.endDate >= t : e.endDate < t);
    if (view === 'past') rows.reverse();
    $('evBody').innerHTML = rows.length ? rows.map(e => {
      const d = new Date(e.startDate + 'T00:00:00Z'), n = daysTo(e.startDate);
      const pctDone = e.total ? Math.round(e.done / e.total * 100) : 0;
      return `<div class="ev-card" data-ev="${esc(e.bookingId)}" tabindex="0">
        <div class="ev-date"><b>${d.getUTCDate()}</b><span>${d.toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' })}</span></div>
        <div><h3>${esc(e.customer)}</h3><div class="meta">${esc(e.venue)} · ${esc(e.when)} · ${esc(e.people)}<br>${esc(e.bookingId)}${e.coordinator ? ' · coordinator ' + esc(e.coordinator) : ''}${e.balance ? ` · <span style="color:var(--amber)">${U.inr(e.balance)} balance due</span>` : ''}</div></div>
        <div class="ev-prog">${e.hasPlan ? `<div class="t">${view === 'upcoming' ? (n > 0 ? `In ${n} day${n === 1 ? '' : 's'}` : n === 0 ? 'Today' : 'Happening now') : (e.feedback ? (e.feedback.submitted ? `Feedback ${stars(e.feedback.rating)}` : 'Feedback asked') : 'No feedback yet')}</div>
          <div class="bar"><i style="width:${pctDone}%"></i></div><div class="t">${e.done} of ${e.total} done${e.overdue ? ` · <span class="late">${e.overdue} overdue</span>` : ''}</div>
          ${e.next && view === 'upcoming' ? `<div class="t" style="margin-top:2px">Next: ${esc(e.next.title)} · ${esc(fmtD(e.next.dueDate))}</div>` : ''}`
          : `<div class="t">No plan yet</div>${['owner', 'events'].includes(me().role) ? `<button class="btn sm" data-start="${esc(e.bookingId)}" type="button" style="margin-top:6px">Start plan</button>` : ''}`}</div></div>`;
    }).join('') : `<div class="card empty">${view === 'upcoming' ? 'No confirmed celebrations or stays coming up. A plan starts automatically when an advance is paid.' : 'No events in the last 60 days.'}</div>`;
    $('evBody').querySelectorAll('[data-start]').forEach(b => b.onclick = ev => { ev.stopPropagation(); call(() => K.api('POST', `/api/admin/events/${encodeURIComponent(b.dataset.start)}/plan`, {}), 'Plan started').then(() => openPlan(b.dataset.start)).catch(() => {}); });
    $('evBody').querySelectorAll('[data-ev]').forEach(c => { c.onclick = () => openPlan(c.dataset.ev); c.onkeydown = k => { if (k.key === 'Enter') openPlan(c.dataset.ev); }; });
  }
  async function openPlan(id) { try { await loadPlan(id); sub = 'checklist'; drawPlan(); window.scrollTo(0, 0); } catch (e) { toast(e.message, 5000); } }
  KA.openEventPlan = id => { KA.go('events'); openPlan(id); };

  /* ------------------------------------------------ planner */
  function drawPlan() {
    const p = plan, s = p.summary, can = p.canPlan;
    document.querySelectorAll('#evView button').forEach(b => b.classList.remove('on'));
    $('evTitle').textContent = 'Event plan';
    const n = daysTo(s.startDate);
    const tabs = [['checklist', `Checklist · ${s.done}/${s.total}`], ['runsheet', 'Run-sheet'], ['rooming', `Rooming list${p.rooming.length ? ' · ' + p.rooming.length : ''}`], ['notes', 'Notes'], ['feedback', 'Feedback']];
    $('evBody').innerHTML = `<div class="ev-head"><div><button class="back" id="evBack" type="button">← All events</button>
        <h2>${esc(s.customer)}</h2><div class="muted" style="font-size:13.5px;margin-top:6px;line-height:1.6">${esc(s.venue)} · ${esc(s.when)} · ${esc(s.people)}<br>${esc(s.bookingId)} · ${n > 0 ? `in ${n} day${n === 1 ? '' : 's'}` : n === 0 ? 'today' : 'done'}${s.balance ? ` · <span style="color:var(--amber)">${U.inr(s.balance)} balance due</span>` : ''}</div></div>
      <div style="display:flex;flex-direction:column;gap:10px;align-items:flex-end">
        <label class="field" style="min-width:220px"><span>Coordinator</span><select id="evCoord" class="k-input" style="padding:8px 10px;font-size:13.5px" ${can ? '' : 'disabled'}>${memberOpts(s.coordinatorId)}</select></label>
        <div class="quick"><button type="button" id="evBk">Open booking</button>${s.phone ? `<a href="tel:${esc(s.phone.replace(/[^\d+]/g, ''))}">☎ Call</a>` : ''}</div></div></div>
      ${!s.hasPlan ? `<div class="card" style="margin-bottom:16px">No plan yet. ${can ? '<button class="btn sm solid" id="evStart" type="button" style="margin-left:10px">Start plan from the checklist template</button>' : 'Ask an Owner or Events login to start it.'}</div>` : ''}
      <div class="ev-tabs">${tabs.map(([k, l]) => `<button data-sub="${k}" class="${k === sub ? 'on' : ''}" type="button">${esc(l)}</button>`).join('')}</div>
      <div id="evSub"></div>`;
    $('evBack').onclick = () => { open = null; plan = null; view = view === 'past' ? 'past' : 'upcoming'; $('evTitle').textContent = 'Events'; rEvents(); };
    $('evBk').onclick = () => KA.openDrawer(s.bookingId);
    const st = $('evStart'); if (st) st.onclick = () => call(() => K.api('POST', `/api/admin/events/${encodeURIComponent(s.bookingId)}/plan`, {}), 'Plan started').then(() => openPlan(s.bookingId)).catch(() => {});
    $('evCoord').onchange = () => saveMeta({ coordinatorId: $('evCoord').value ? +$('evCoord').value : null }, 'Coordinator updated');
    $('evBody').querySelectorAll('[data-sub]').forEach(b => b.onclick = () => { sub = b.dataset.sub; drawPlan(); });
    ({ checklist: drawChecklist, runsheet: drawRunsheet, rooming: drawRooming, notes: drawNotes, feedback: drawPlanFeedback })[sub]();
  }
  const refreshPlan = async () => { await loadPlan(open); drawPlan(); loadList().catch(() => {}); };
  const saveMeta = (body, msg) => call(() => K.api('PUT', `/api/admin/events/${encodeURIComponent(open)}`, body), msg).then(refreshPlan).catch(() => {});

  /* checklist */
  function drawChecklist() {
    const p = plan, can = p.canPlan, t = today();
    const bySec = {}; p.items.forEach(i => (bySec[i.section] = bySec[i.section] || []).push(i));
    const order = sections.filter(x => bySec[x]).concat(Object.keys(bySec).filter(x => !sections.includes(x)));
    const mine = i => i.ownerId === me().id;
    $('evSub').innerHTML = (order.length ? order.map(sec => `<div class="ck-sec"><h4>${esc(sec)} · ${bySec[sec].filter(i => i.doneAt).length}/${bySec[sec].length}</h4>${bySec[sec].map(i => `
      <div class="ck ${i.doneAt ? 'done' : ''}" data-it="${i.id}">
        <input type="checkbox" data-f="done" ${i.doneAt ? 'checked' : ''} ${can || mine(i) ? '' : 'disabled'} aria-label="Done">
        <div class="tt">${esc(i.title)}${i.doneAt ? `<div class="muted" style="font-size:11.5px">Done by ${esc(i.doneBy || '—')}</div>` : ''}</div>
        <div class="c-due">${can ? `<input type="date" data-f="dueDate" value="${esc(i.dueDate || '')}" class="${!i.doneAt && i.dueDate && i.dueDate < t ? 'late' : ''}">` : `<span class="${!i.doneAt && i.dueDate && i.dueDate < t ? 'late' : 'muted'}" style="font-size:12.5px">${esc(fmtD(i.dueDate))}</span>`}</div>
        <div class="c-own">${can ? `<select data-f="ownerId">${memberOpts(i.ownerId)}</select>` : `<span class="muted" style="font-size:12.5px">${esc(i.owner || 'Unassigned')}</span>`}</div>
        <div class="c-ven">${can ? `<select data-f="vendorId">${vendorOpts(i.vendorId)}</select>` : `<span class="muted" style="font-size:12.5px">${esc((vendors.find(v => v.id === i.vendorId) || {}).name || '')}</span>`}</div>
        <div>${can ? `<button class="x" data-del="${i.id}" type="button" aria-label="Remove">×</button>` : ''}</div></div>`).join('')}</div>`).join('') : '<div class="muted">No checklist items yet.</div>')
      + (can ? `<div class="add-row"><label class="field"><span>Section</span><select id="ck_sec">${sections.map(x => `<option>${esc(x)}</option>`).join('')}</select></label>
        <label class="field" style="flex:2.2"><span>New item</span><input id="ck_title" placeholder="e.g. Confirm shehnai players"></label>
        <label class="field"><span>Due</span><input id="ck_due" type="date"></label>
        <label class="field"><span>Who</span><select id="ck_own">${memberOpts(plan.summary.coordinatorId)}</select></label>
        <button class="btn sm solid" id="ck_add" type="button">Add</button></div>` : '');
    $('evSub').querySelectorAll('[data-it]').forEach(row => {
      const id = row.dataset.it;
      row.querySelectorAll('[data-f]').forEach(inp => inp.onchange = () => {
        const f = inp.dataset.f, v = f === 'done' ? inp.checked : (f === 'ownerId' || f === 'vendorId') ? (inp.value ? +inp.value : null) : inp.value;
        call(() => K.api('PUT', `/api/admin/plan-items/${id}`, { [f]: v }), f === 'done' ? (v ? 'Done ✓' : 'Reopened') : 'Saved').then(refreshPlan).catch(refreshPlan);
      });
    });
    $('evSub').querySelectorAll('[data-del]').forEach(b => b.onclick = () => call(() => K.api('DELETE', `/api/admin/plan-items/${b.dataset.del}`), 'Removed').then(refreshPlan).catch(() => {}));
    const add = $('ck_add'); if (add) add.onclick = () => {
      const title = $('ck_title').value.trim(); if (!title) return toast('What needs doing?');
      call(() => K.api('POST', '/api/admin/plan-items', { bookingId: open, section: $('ck_sec').value, title, dueDate: $('ck_due').value || null, ownerId: $('ck_own').value ? +$('ck_own').value : null }), 'Added').then(refreshPlan).catch(() => {});
    };
  }

  /* run-sheet */
  function runsheetText() {
    const p = plan, s = p.summary;
    const days = [...new Set(p.days.concat(p.runsheet.map(r => r.day)))].sort();
    return `${s.customer} — ${s.venue}\n${s.when}\n\n` + days.filter(d => p.runsheet.some(r => r.day === d)).map(d => `*${fmtLong(d)}*\n` + p.runsheet.filter(r => r.day === d).map(r => `${r.time}  ${r.title}${r.place ? ' · ' + r.place : ''}${r.who ? ' · ' + r.who : ''}`).join('\n')).join('\n\n');
  }
  function drawRunsheet() {
    const p = plan, can = p.canPlan;
    const days = [...new Set(p.days.concat(p.runsheet.map(r => r.day)))].sort();
    $('evSub').innerHTML = `<div class="quick" style="margin-bottom:14px"><button type="button" id="rsPrint">Print run-sheet</button><button type="button" class="wa" id="rsWa">◉ Share on WhatsApp</button><button type="button" id="rsCopy">Copy as text</button></div>`
      + days.map(d => `<div class="rs-day"><h4>${esc(fmtLong(d))}</h4>${p.runsheet.filter(r => r.day === d).map(r => `
        <div class="rs" data-rs="${r.id}"><input type="time" data-f="time" value="${esc(r.time)}" ${can ? '' : 'disabled'}><input data-f="title" value="${esc(r.title)}" ${can ? '' : 'disabled'} aria-label="What">
          <input class="c-place" data-f="place" value="${esc(r.place)}" placeholder="Where" ${can ? '' : 'disabled'}><input class="c-who" data-f="who" value="${esc(r.who)}" placeholder="Who" ${can ? '' : 'disabled'}>
          <div>${can ? `<button class="x" data-del="${r.id}" type="button" aria-label="Remove">×</button>` : ''}</div></div>`).join('') || '<div class="muted" style="font-size:13px">Nothing planned for this day yet.</div>'}
        ${can ? `<div class="add-row" data-day="${d}"><label class="field" style="flex:.6;min-width:96px"><span>Time</span><input type="time" data-n="time" value="18:00"></label><label class="field" style="flex:2"><span>What happens</span><input data-n="title" placeholder="e.g. Varmala on the stage"></label><label class="field"><span>Where</span><input data-n="place"></label><label class="field"><span>Who</span><input data-n="who"></label><button class="btn sm" data-addrs="${d}" type="button">Add</button></div>` : ''}</div>`).join('');
    $('evSub').querySelectorAll('[data-rs]').forEach(row => row.querySelectorAll('[data-f]').forEach(inp => inp.onchange = () =>
      call(() => K.api('PUT', `/api/admin/runsheet/${row.dataset.rs}`, { [inp.dataset.f]: inp.value }), 'Saved').then(inp.dataset.f === 'time' ? refreshPlan : () => loadPlan(open)).catch(refreshPlan)));
    $('evSub').querySelectorAll('[data-del]').forEach(b => b.onclick = () => call(() => K.api('DELETE', `/api/admin/runsheet/${b.dataset.del}`), 'Removed').then(refreshPlan).catch(() => {}));
    $('evSub').querySelectorAll('[data-addrs]').forEach(b => b.onclick = () => {
      const box = b.closest('.add-row'), g = k => box.querySelector(`[data-n="${k}"]`).value;
      if (!g('title').trim()) return toast('What happens at this time?');
      call(() => K.api('POST', '/api/admin/runsheet', { bookingId: open, day: b.dataset.addrs, time: g('time'), title: g('title'), place: g('place'), who: g('who') }), 'Added').then(refreshPlan).catch(() => {});
    });
    $('rsCopy').onclick = async () => { try { await navigator.clipboard.writeText(runsheetText()); toast('Run-sheet copied'); } catch (e) { toast('Copy isn’t available here'); } };
    $('rsWa').onclick = () => window.open(`https://wa.me/?text=${encodeURIComponent(runsheetText())}`, '_blank', 'noopener');
    $('rsPrint').onclick = () => printRunsheet();
  }
  function printRunsheet() {
    const p = plan, s = p.summary;
    let el = $('printArea'); if (!el) { el = document.createElement('div'); el.id = 'printArea'; document.body.appendChild(el); }
    const days = [...new Set(p.days.concat(p.runsheet.map(r => r.day)))].sort().filter(d => p.runsheet.some(r => r.day === d));
    el.innerHTML = `<h1>${esc(s.customer)} — run-sheet</h1><div>${esc(s.venue)} · ${esc(s.when)} · ${esc(s.people)} · ${esc(s.bookingId)}</div>`
      + days.map(d => `<h3 style="margin-top:16px">${esc(fmtLong(d))}</h3><table><tr><th style="width:70px">Time</th><th>What</th><th>Where</th><th>Who</th></tr>${p.runsheet.filter(r => r.day === d).map(r => `<tr><td>${esc(r.time)}</td><td>${esc(r.title)}</td><td>${esc(r.place)}</td><td>${esc(r.who)}</td></tr>`).join('')}</table>`).join('')
      + (p.rooming.length ? `<h3 style="margin-top:16px">Rooming list</h3><table><tr><th>Room</th><th>Guests</th><th>Nights</th><th>Notes</th></tr>${p.rooming.map(r => `<tr><td>${esc(r.room)}</td><td>${esc(r.guests)}</td><td>${esc(r.nights)}</td><td>${esc(r.notes)}</td></tr>`).join('')}</table>` : '');
    document.body.classList.add('printing'); window.print(); setTimeout(() => document.body.classList.remove('printing'), 500);
  }

  /* rooming */
  function drawRooming() {
    const p = plan, can = p.canPlan;
    $('evSub').innerHTML = `<div class="muted" style="font-size:12.5px;margin-bottom:10px">Who sleeps where. Rows start from the villas and rooms on the booking — type the guests’ names in.</div>
      <div class="rm" style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--line)"><span>Room</span><span class="c-g">Guests</span><span class="c-n">Nights</span><span class="c-no">Notes</span><span></span></div>
      ${p.rooming.map(r => `<div class="rm" data-rm="${r.id}"><input data-f="room" value="${esc(r.room)}" ${can ? '' : 'disabled'} aria-label="Room"><input class="c-g" data-f="guests" value="${esc(r.guests)}" placeholder="Names" ${can ? '' : 'disabled'}><input class="c-n" data-f="nights" value="${esc(r.nights)}" ${can ? '' : 'disabled'}><input class="c-no" data-f="notes" value="${esc(r.notes)}" placeholder="Diet, accessibility…" ${can ? '' : 'disabled'}><div>${can ? `<button class="x" data-del="${r.id}" type="button" aria-label="Remove">×</button>` : ''}</div></div>`).join('') || '<div class="muted" style="padding:10px 0">No rooms listed yet.</div>'}
      ${can ? `<div class="add-row"><label class="field"><span>Room</span><input id="rm_room" placeholder="Guest Room 4"></label><label class="field" style="flex:2"><span>Guests</span><input id="rm_guests"></label><label class="field"><span>Nights</span><input id="rm_nights" value="${plan.summary.kind === 'stay' ? '' : '1 night'}"></label><button class="btn sm" id="rm_add" type="button">Add room</button></div>` : ''}`;
    $('evSub').querySelectorAll('[data-rm]').forEach(row => row.querySelectorAll('[data-f]').forEach(inp => inp.onchange = () =>
      call(() => K.api('PUT', `/api/admin/rooming/${row.dataset.rm}`, { [inp.dataset.f]: inp.value }), 'Saved').then(() => loadPlan(open)).catch(refreshPlan)));
    $('evSub').querySelectorAll('[data-del]').forEach(b => b.onclick = () => call(() => K.api('DELETE', `/api/admin/rooming/${b.dataset.del}`), 'Removed').then(refreshPlan).catch(() => {}));
    const a = $('rm_add'); if (a) a.onclick = () => call(() => K.api('POST', '/api/admin/rooming', { bookingId: open, room: $('rm_room').value, guests: $('rm_guests').value, nights: $('rm_nights').value }), 'Room added').then(refreshPlan).catch(() => {});
  }

  /* notes */
  function drawNotes() {
    const can = plan.canPlan;
    $('evSub').innerHTML = `<label class="field"><span>Notes for the team</span><textarea id="evNotes" rows="10" style="font:inherit;font-size:14px;line-height:1.6;padding:12px;border:1px solid var(--line);background:var(--paper)" ${can ? '' : 'disabled'} placeholder="Family preferences, dietary needs, who decides what, ritual timings…">${esc(plan.notes)}</textarea></label>
      ${can ? '<button class="btn sm solid" id="evNotesSave" type="button" style="margin-top:10px">Save notes</button>' : ''}`;
    const b = $('evNotesSave'); if (b) b.onclick = () => saveMeta({ notes: $('evNotes').value }, 'Notes saved');
  }

  /* feedback inside a plan */
  function drawPlanFeedback() {
    const f = plan.feedback;
    $('evSub').innerHTML = f && f.submittedAt ? fbCard(f) : `<div class="card"><p style="font-size:14px;line-height:1.7">${f ? 'Feedback has been requested but not answered yet.' : 'The feedback request goes out automatically the day after the event. You can also send it yourself.'}</p>
      <div class="quick" style="margin-top:10px"><button type="button" id="fbLink">Copy feedback link</button><button type="button" id="fbSend">Send request…</button></div></div>`;
    const c = $('fbLink'); if (c) c.onclick = () => call(() => K.api('POST', `/api/admin/events/${encodeURIComponent(open)}/feedback-link`, {})).then(async r => { try { await navigator.clipboard.writeText(r.feedback.link); toast('Link copied'); } catch (e) { prompt('Feedback link', r.feedback.link); } }).catch(() => {});
    const sbtn = $('fbSend'); if (sbtn) sbtn.onclick = () => { const b = S().bookings.find(x => x.id === open); if (b) { KA.openDrawer(b.id); setTimeout(() => { const sel = $('mgTpl'); if (sel) { sel.value = 'feedback_request'; sel.dispatchEvent(new Event('change')); } }, 50); } };
  }
  const fbCard = f => `<div class="fb"><div class="top"><span><b style="font-weight:500;color:var(--ink);font-size:15px">${esc(f.customer)}</b> · ${esc(f.venue)} · ${esc(f.when)}</span><span>${f.submittedAt ? esc(U.fmtDateTime(f.submittedAt)) : 'asked ' + esc(U.fmtDateTime(f.createdAt))}</span></div>
    ${f.submittedAt ? `<div class="stars" style="margin:6px 0">${stars(f.rating)}</div>${f.loved ? `<div><b style="font-weight:500">Loved:</b> ${esc(f.loved)}</div>` : ''}${f.improve ? `<div><b style="font-weight:500">Could be better:</b> ${esc(f.improve)}</div>` : ''}
    <div class="muted" style="font-size:12.5px;margin-top:6px">${f.recommend != null ? `Would recommend: ${f.recommend}/10 · ` : ''}${f.consent ? '<span style="color:var(--green)">OK to share on the website</span>' : 'Private — don’t publish'}${f.referrals ? ` · referred ${f.referrals} ${f.referrals === 1 ? 'family' : 'families'}` : ''}</div>` : '<div class="muted" style="margin-top:6px">Waiting for their reply.</div>'}
    <div style="margin-top:6px"><a href="#" data-plan="${esc(f.bookingId)}" style="color:var(--gold-deep);font-size:12.5px">Open event plan →</a></div></div>`;

  /* ------------------------------------------------ vendors */
  function drawVendors() {
    const canEdit = ['owner', 'events', 'sales'].includes(me().role);
    $('evBody').innerHTML = `<div class="tbl-wrap"><table class="t vt"><thead><tr><th>Vendor</th><th>Category</th><th>Contact</th><th>Phone</th><th>Email</th><th class="r">Events</th><th>Notes</th><th>Active</th></tr></thead><tbody>
      ${vendors.map(v => `<tr data-v="${v.id}">
        <td>${canEdit ? `<input data-f="name" value="${esc(v.name)}">` : esc(v.name)}</td>
        <td>${canEdit ? `<select data-f="category">${vendorCats.map(c => `<option ${c === v.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>` : esc(v.category)}</td>
        <td>${canEdit ? `<input data-f="contact" value="${esc(v.contact)}">` : esc(v.contact)}</td>
        <td><div style="display:flex;gap:8px;align-items:center">${canEdit ? `<input data-f="phone" value="${esc(v.phone)}" style="min-width:120px">` : esc(v.phone)}${v.phone ? `<a href="https://wa.me/${esc(v.phone.replace(/\D/g, '').replace(/^(\d{10})$/, '91$1'))}" target="_blank" rel="noopener" style="color:#2f6b45;font-size:12px;white-space:nowrap">WhatsApp</a>` : ''}</div></td>
        <td>${canEdit ? `<input data-f="email" value="${esc(v.email)}">` : esc(v.email)}</td>
        <td class="r">${v.events}</td>
        <td>${canEdit ? `<input data-f="notes" value="${esc(v.notes)}" style="min-width:180px">` : esc(v.notes)}</td>
        <td style="text-align:center"><input type="checkbox" data-f="active" ${v.active ? 'checked' : ''} ${canEdit ? '' : 'disabled'} style="width:auto;accent-color:var(--ink)"></td></tr>`).join('') || '<tr><td colspan="8" class="empty">No vendors yet. Add the décor, catering, photography and music partners you work with.</td></tr>'}</tbody></table></div>
      ${canEdit ? `<div class="add-row card" style="margin-top:14px;padding:16px 18px"><label class="field" style="flex:1.4"><span>Vendor name</span><input id="vd_name" placeholder="Bloom Florals"></label>
        <label class="field"><span>Category</span><select id="vd_cat">${vendorCats.map(c => `<option>${esc(c)}</option>`).join('')}</select></label>
        <label class="field"><span>Contact person</span><input id="vd_contact"></label><label class="field"><span>Phone</span><input id="vd_phone"></label><label class="field"><span>Email</span><input id="vd_email"></label>
        <button class="btn sm solid" id="vd_add" type="button">Add vendor</button></div>` : ''}`;
    $('evBody').querySelectorAll('tr[data-v]').forEach(row => row.querySelectorAll('[data-f]').forEach(inp => inp.onchange = () =>
      call(() => K.api('PUT', `/api/admin/vendors/${row.dataset.v}`, { [inp.dataset.f]: inp.type === 'checkbox' ? inp.checked : inp.value }), 'Vendor saved').then(loadList).catch(rEvents)));
    const a = $('vd_add'); if (a) a.onclick = () => call(() => K.api('POST', '/api/admin/vendors', { name: $('vd_name').value, category: $('vd_cat').value, contact: $('vd_contact').value, phone: $('vd_phone').value, email: $('vd_email').value }), 'Vendor added').then(rEvents).catch(() => {});
  }

  /* ------------------------------------------------ feedback */
  async function drawFeedback() {
    const r = await K.api('GET', '/api/admin/feedback');
    const done = r.feedback.filter(f => f.submittedAt), avg = done.length ? done.reduce((s, f) => s + f.rating, 0) / done.length : null;
    const recs = done.filter(f => f.recommend != null);
    const promoters = recs.filter(f => f.recommend >= 9).length, detractors = recs.filter(f => f.recommend <= 6).length;
    $('evBody').innerHTML = `<div class="kpis" style="grid-template-columns:repeat(4,minmax(0,1fr))">
        <div class="kpi"><div class="l">Average rating</div><div class="v">${avg ? avg.toFixed(1) : '—'}</div><div class="s">${avg ? `<span class="stars">${stars(Math.round(avg))}</span>` : 'no replies yet'}</div></div>
        <div class="kpi"><div class="l">Replies</div><div class="v">${done.length}</div><div class="s">of ${r.feedback.length} asked</div></div>
        <div class="kpi"><div class="l">Would recommend</div><div class="v">${recs.length ? Math.round((promoters - detractors) / recs.length * 100) : '—'}</div><div class="s">${recs.length ? `${promoters} gave 9–10 · ${detractors} gave 0–6` : 'net score once families reply'}</div></div>
        <div class="kpi"><div class="l">Referrals</div><div class="v">${done.reduce((s, f) => s + (f.referrals || 0), 0)}</div><div class="s">new leads from happy families</div></div></div>
      ${r.feedback.map(fbCard).join('') || '<div class="card empty">No feedback yet. Requests go out automatically the day after each event.</div>'}`;
    $('evBody').querySelectorAll('[data-plan]').forEach(a => a.onclick = e => { e.preventDefault(); openPlan(a.dataset.plan); });
  }
  document.addEventListener('click', e => { const a = e.target.closest('#evSub [data-plan]'); if (a) { e.preventDefault(); openPlan(a.dataset.plan); } });

  /* booking drawer → "Event plan" shortcut */
  KA.onBookingDrawer.push(b => {
    if (!['confirmed', 'planning', 'paid', 'completed'].includes(b.status) || U.kindOf(b) === 'slot') return;
    const box = $('dMsg'); if (!box) return;
    box.insertAdjacentHTML('beforebegin', `<div class="dr-sec"><h4>Event plan</h4><button class="btn sm" id="dPlan" type="button">Open event plan →</button></div>`);
    $('dPlan').onclick = () => { KA.closeDrawer(); KA.openEventPlan(b.id); };
  });

  /* ------------------------------------------------ settings: checklist template (owner) */
  let tpl = null;
  KA.afterRender(t => { if (t === 'settings' && me().role === 'owner') drawTplCard(); });
  async function drawTplCard() {
    const el = $('evTplCard'); if (!el) return;
    if (!tpl) { try { const r = await K.api('GET', '/api/admin/event-template'); tpl = r.template; sections = r.sections; } catch (e) { return; } }
    const FROM = [['start', 'days from the event'], ['confirmed', 'days after the advance'], ['balance', 'days from the balance due date']];
    const ROLES = [['events', 'Events'], ['accounts', 'Accounts'], ['sales', 'Lead owner'], ['owner', 'Owner']];
    const rows = kind => tpl[kind].map((x, i) => `<div class="add-row tpl-row${i ? ' nolab' : ''}" data-k="${kind}" data-i="${i}" style="margin-top:6px">
      <label class="field" style="flex:.9"><span>Section</span><select data-f="section">${sections.map(s => `<option ${s === x.section ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
      <label class="field" style="flex:2.4"><span>Task</span><input data-f="title" value="${esc(x.title)}"></label>
      <label class="field" style="flex:.45;min-width:70px"><span>Days</span><input data-f="offset" type="number" value="${x.offset}"></label>
      <label class="field" style="flex:1.2"><span>Counted</span><select data-f="from">${FROM.map(([k, l]) => `<option value="${k}" ${k === x.from ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field" style="flex:.8"><span>Who</span><select data-f="role">${ROLES.map(([k, l]) => `<option value="${k}" ${k === x.role ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <button class="btn sm danger" data-rm type="button">×</button></div>`).join('');
    el.innerHTML = `<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline"><h3>Event checklist template</h3><span class="muted" style="font-size:12px">Every confirmed celebration or stay gets this checklist. Negative days = before the event (−30 is a month before).</span></div>
      <div class="field" style="margin-top:14px"><span>Celebrations</span></div>${rows('event')}<button class="btn sm ghost" data-addt="event" type="button" style="margin-top:8px">+ Add task</button>
      <div class="field" style="margin-top:18px"><span>Stays</span></div>${rows('stay')}<button class="btn sm ghost" data-addt="stay" type="button" style="margin-top:8px">+ Add task</button>
      <div style="margin-top:14px"><button class="btn sm solid" id="evt_save" type="button">Save checklist template</button> <span class="muted" style="font-size:12px;margin-left:8px">Changes apply to events confirmed from now on.</span></div>`;
    el.querySelectorAll('[data-k]').forEach(row => {
      const x = tpl[row.dataset.k][+row.dataset.i];
      row.querySelectorAll('[data-f]').forEach(inp => inp.oninput = () => { x[inp.dataset.f] = inp.dataset.f === 'offset' ? +inp.value : inp.value; });
      row.querySelector('[data-rm]').onclick = () => { tpl[row.dataset.k].splice(+row.dataset.i, 1); drawTplCard(); };
    });
    el.querySelectorAll('[data-addt]').forEach(b => b.onclick = () => { tpl[b.dataset.addt].push({ section: 'Planning', title: '', offset: -7, from: 'start', role: 'events' }); drawTplCard(); });
    $('evt_save').onclick = () => call(() => K.api('PUT', '/api/admin/event-template', tpl), 'Checklist template saved').then(r => { tpl = r.template; drawTplCard(); }).catch(() => {});
  }
})();
