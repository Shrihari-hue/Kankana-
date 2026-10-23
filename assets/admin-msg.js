/* admin-msg.js — CRM phase 2: message templates, WhatsApp / email sending, automations.
   Adds a "Send a message" panel to lead and booking drawers and two cards to Settings. */
(() => {
  'use strict';
  const KA = window.KA, K = KA.K, U = KA.U, $ = KA.$, esc = U.esc, toast = KA.toast;
  const S = () => KA.S;
  const M = () => S().messaging;
  const waNumber = p => { let d = String(p || '').replace(/\D/g, ''); if (d.length === 10) d = '91' + d; return d; };
  const waLink = (phone, text) => `https://wa.me/${waNumber(phone)}?text=${encodeURIComponent(text || '')}`;
  KA.waLink = waLink;
  async function call(fn, okMsg) { try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { if (e.status === 401) KA.showLogin(); toast(e.message, 5000); throw e; } }

  /* ------------------------------------------------ send-a-message panel */
  /**
   * el: container · refs: { lead } or { booking } · pick: default template id
   * WhatsApp opens the chat with the message typed (one tap to send) and logs it.
   * Email sends a branded email from the server (or opens the email app when email isn't set up).
   */
  function msgPanel(el, refs, pick) {
    if (!el) return;
    const lead = refs.lead || null, b = refs.booking || null;
    const phone = lead ? lead.phone : b ? b.customer.phone : '';
    const email = lead ? lead.email : b ? b.customer.email : '';
    const tpls = M().templates;
    const def = pick && tpls.some(t => t.id === pick) ? pick : tpls[0].id;
    el.innerHTML = `<h4>Send a message</h4><div class="msg-box">
      <div class="row"><label class="field" style="flex:2"><span>Template</span><select id="mgTpl" class="k-input">${tpls.map(t => `<option value="${esc(t.id)}" ${t.id === def ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label></div>
      <div id="mgWarn" class="avail bad" style="display:none"></div>
      <label class="field" style="margin-top:10px"><span>Email subject</span><input id="mgSubj" class="k-input"></label>
      <label class="field" style="margin-top:10px"><span>Message — edit before sending</span><textarea id="mgText"></textarea></label>
      <div class="quick" style="margin-top:10px">
        ${phone ? '<button type="button" id="mgWa" class="wa">◉ Open in WhatsApp</button>' : ''}
        ${email ? `<button type="button" id="mgEm">@ ${M().emailOn ? 'Send email' : 'Open in my email app'}</button>` : ''}
      </div>
      <div class="msg-note">${!phone && !email ? 'Add a phone number or email to this client to message them. ' : ''}${email && !M().emailOn ? 'Email isn’t set up on the server yet, so emails open in your own email app. ' : ''}WhatsApp opens the chat with the message typed — tap send in WhatsApp.</div></div>`;
    const load = async () => {
      try {
        const r = await K.api('POST', '/api/admin/messages/preview', { templateId: $('mgTpl').value, leadId: lead ? lead.id : undefined, bookingId: b ? b.id : undefined });
        $('mgSubj').value = r.subject; $('mgText').value = r.text;
        const w = $('mgWarn');
        w.style.display = r.missing && r.missing.length ? 'block' : 'none';
        w.textContent = r.missing && r.missing.length ? `Some details are blank: ${r.missing.map(k => '{' + k + '}').join(', ')}. ${r.missing.some(k => ['quote_no', 'total', 'advance', 'balance', 'booking_id', 'pay_link', 'hold_until', 'venue', 'when'].includes(k)) && lead ? 'This client has no quotation yet — create one first, or edit the message.' : 'Fill them in before sending.'}` : '';
      } catch (e) { toast(e.message, 5000); }
    };
    $('mgTpl').onchange = load; load();
    const after = async () => { await KA.reload(); KA.render(); if (lead && KA.reopenLead) KA.reopenLead(lead.id); };
    const wa = $('mgWa'); if (wa) wa.onclick = () => {
      const text = $('mgText').value.trim(); if (!text) return toast('The message is empty');
      window.open(waLink(phone, text), '_blank', 'noopener');
      call(() => K.api('POST', '/api/admin/messages/send', { channel: 'whatsapp', leadId: lead ? lead.id : undefined, bookingId: b ? b.id : undefined, templateId: $('mgTpl').value }), 'Logged as sent on WhatsApp').then(after).catch(() => {});
    };
    const em = $('mgEm'); if (em) em.onclick = () => {
      const subject = $('mgSubj').value.trim(), text = $('mgText').value.trim(); if (!text) return toast('The message is empty');
      if (!M().emailOn) window.location.href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
      em.disabled = true;
      call(() => K.api('POST', '/api/admin/messages/send', { channel: 'email', to: email, subject, text, leadId: lead ? lead.id : undefined, bookingId: b ? b.id : undefined, templateId: $('mgTpl').value }), M().emailOn ? `Email sent to ${email}` : 'Logged — finish sending in your email app')
        .then(after).catch(() => { em.disabled = false; });
    };
  }
  KA.msgPanel = msgPanel;

  /* booking drawer: reminders that fit the booking's state */
  KA.onBookingDrawer.push(b => {
    const paid = (b.payments || []).reduce((s, p) => s + p.amount, 0);
    const pick = b.status === 'quoted' ? (b.holdUntil && b.holdUntil - Date.now() < 864e5 ? 'hold_expiring' : 'quote_followup')
      : ['confirmed', 'planning'].includes(b.status) && paid < b.quote.total ? 'balance_reminder' : b.status === 'completed' ? 'thanks' : 'quote_followup';
    msgPanel($('dMsg'), { booking: b }, pick);
  });

  /* ------------------------------------------------ settings: automations */
  KA.afterRender(t => { if (t === 'settings' && S().me.role === 'owner') { autoCard(); tplCard(); } });
  const RULES = [
    ['firstReplyEmail', 'Email a first reply to new website enquiries', 'Sends the “First reply to an enquiry” template the moment someone enquires (if they left an email).', 'email'],
    ['firstReplyTask', 'Put a WhatsApp reply on someone’s list', 'A ready-to-send WhatsApp follow-up for each new website enquiry or online quotation, due within <input type="number" id="au_frm" min="5" max="1440"> minutes.'],
    ['autoAssign', 'Share new leads among Sales, in turn', 'New website leads go to each active Sales login one after another. Off: they stay unassigned and the follow-up goes to the default person below.'],
    ['_quote', 'Follow up unpaid quotations', 'After <input type="number" id="au_qfd" min="0" max="30"> days without payment (0 = off): a WhatsApp follow-up for the lead’s owner, and an email to the client.', 'email'],
    ['holdExpiryEmail', 'Warn when held dates are about to be released', 'Emails the client when their hold ends within 24 hours.', 'email'],
    ['balanceEmail', 'Balance reminders for confirmed celebrations', 'Emails the client <input type="text" id="au_bal" style="width:80px"> days before the balance due date (comma-separated). On the due date, Accounts gets a follow-up to collect it.', 'email'],
    ['visitReminder', 'Remind clients the day before a site visit', 'Emails the client and puts a WhatsApp reminder on the host’s list.'],
    ['feedbackRequest', 'Ask for feedback after each event', 'The day after a celebration or stay ends, emails the family a feedback and referral link, and puts a WhatsApp version on the coordinator’s list.'],
    ['anniversary', 'Wish couples on their first anniversary', 'One year after a wedding at Kankana, emails the couple and reminds the coordinator to send a WhatsApp.'],
    ['_stale', 'Flag leads that have gone quiet', 'Open leads with no activity for <input type="number" id="au_stale" min="0" max="60"> days and nothing scheduled get a check-in follow-up (0 = off).']
  ];
  function autoCard() {
    const a = M().auto, el = $('autoCard'); if (!el || !a) return;
    const team = (S().team || []).filter(t => t.active);
    const lr = M().lastRun;
    el.innerHTML = `<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline"><h3>Automations</h3>
      <span class="muted" style="font-size:12px">Checked every 5 minutes. Each one happens once per client — nothing is sent twice.${lr ? ' Last check: ' + esc(U.fmtDateTime(lr.at)) + '.' : ''}</span></div>
      ${M().emailOn ? '' : '<div class="card" style="background:var(--amber-bg);border:none;padding:12px 16px;margin-top:12px;font-size:13px;color:var(--amber)">Email isn’t set up on the server yet, so the email parts below are paused. The WhatsApp follow-ups still work. Add SMTP or Resend settings on Railway to turn email on.</div>'}
      <div class="auto-grid">${RULES.map(([k, title, desc, needsEmail]) => `<label class="auto-row"><input type="checkbox" data-au="${k}" ${k === '_stale' ? (a.staleDays > 0 ? 'checked' : '') : k === '_quote' ? (a.quoteFollowupDays > 0 ? 'checked' : '') : a[k] ? 'checked' : ''}>
        <div><div>${title}${needsEmail && !M().emailOn ? ' <span class="pill neutral" style="font-size:9px;padding:2px 6px">needs email</span>' : ''}</div><div class="d">${desc}</div></div></label>`).join('')}</div>
      <div class="row" style="margin-top:14px">
        <label class="field" style="max-width:320px"><span>Default person for unassigned follow-ups</span><select id="au_def"><option value="">First owner</option>${team.map(t => `<option value="${t.id}" ${t.id === a.defaultAssigneeId ? 'selected' : ''}>${esc(t.name || t.email)}</option>`).join('')}</select></label>
        <button class="btn sm solid" id="au_save" type="button">Save automations</button>
        <button class="btn sm" id="au_run" type="button">Check now</button>
      </div>
      <div style="margin-top:18px"><div class="field"><span>What the automations did recently</span></div>
        <div class="auto-log">${(M().log || []).map(x => `<div><span><b style="font-weight:500">${esc(x.rule)}</b> · ${esc(x.note || '')}</span><span class="muted" style="white-space:nowrap">${esc(U.fmtDateTime(x.at))}</span></div>`).join('') || '<div class="muted">Nothing yet.</div>'}</div></div>`;
    $('au_frm').value = a.firstReplyMinutes; $('au_qfd').value = a.quoteFollowupDays; $('au_bal').value = (a.balanceReminderDays || []).join(', '); $('au_stale').value = a.staleDays;
    $('au_save').onclick = () => {
      const c = k => el.querySelector(`[data-au="${k}"]`).checked;
      const qfd = Math.max(0, +$('au_qfd').value || 0), stale = Math.max(0, +$('au_stale').value || 0);
      const body = {
        firstReplyEmail: c('firstReplyEmail'), firstReplyTask: c('firstReplyTask'), firstReplyMinutes: +$('au_frm').value || 60, autoAssign: c('autoAssign'),
        quoteFollowupEmail: true, quoteFollowupDays: c('_quote') ? (qfd || 3) : 0, holdExpiryEmail: c('holdExpiryEmail'), balanceEmail: c('balanceEmail'),
        balanceReminderDays: $('au_bal').value.split(/[,\s]+/).map(Number).filter(n => n > 0), visitReminder: c('visitReminder'), feedbackRequest: c('feedbackRequest'), anniversary: c('anniversary'),
        staleDays: c('_stale') ? (stale || 7) : 0, defaultAssigneeId: $('au_def').value ? +$('au_def').value : null
      };
      call(() => K.api('PUT', '/api/admin/automations', body), 'Automations saved').then(async () => { await KA.reload(); autoCard(); }).catch(() => {});
    };
    $('au_run').onclick = () => call(() => K.api('POST', '/api/admin/automations/run', {})).then(async r => { toast(r.actions && r.actions.length ? `${r.actions.length} automatic action${r.actions.length > 1 ? 's' : ''} taken` : 'Nothing needed right now'); await KA.reload(); KA.render(); }).catch(() => {});
  }

  /* ------------------------------------------------ settings: templates */
  const REQUIRED = ['first_reply', 'no_response', 'visit_confirm', 'visit_reminder', 'quote_followup', 'hold_expiring', 'balance_reminder', 'thanks', 'keep_in_touch', 'feedback_request', 'anniversary'];
  let draft = null, focusBody = null;
  function tplCard() {
    const el = $('tplCard'); if (!el) return;
    if (!draft) draft = JSON.parse(JSON.stringify(M().templates));
    el.innerHTML = `<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline"><h3>Message templates</h3>
      <span class="muted" style="font-size:12px">Used for WhatsApp and email. Words in {curly brackets} are filled in for each client.</span></div>
      <div class="ph">${M().placeholders.map(([k, d]) => `<button type="button" data-ph="${esc(k)}" title="${esc(d)}">{${esc(k)}}</button>`).join('')}</div>
      <div id="tplList">${draft.map((t, i) => `<div class="tpl" data-i="${i}">
        <div class="row"><label class="field" style="flex:1.2"><span>Name</span><input data-f="name" value="${esc(t.name)}"></label>
          <label class="field" style="flex:2"><span>Email subject</span><input data-f="subject" value="${esc(t.subject)}"></label>
          ${REQUIRED.includes(t.id) ? '<span class="muted" style="font-size:11px;padding-bottom:12px">used by automations</span>' : `<button class="btn sm danger" type="button" data-del="${i}">Remove</button>`}</div>
        <textarea data-f="body">${esc(t.body)}</textarea></div>`).join('')}</div>
      <div class="row" style="margin-top:14px"><button class="btn sm" id="tp_add" type="button">+ New template</button><button class="btn sm solid" id="tp_save" type="button">Save templates</button><button class="btn sm ghost" id="tp_reset" type="button">Discard changes</button></div>`;
    el.querySelectorAll('.tpl').forEach(row => {
      const i = +row.dataset.i;
      row.querySelectorAll('[data-f]').forEach(inp => { inp.addEventListener('input', () => { draft[i][inp.dataset.f] = inp.value; }); inp.addEventListener('focus', () => { focusBody = inp; }); });
    });
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { draft.splice(+b.dataset.del, 1); tplCard(); });
    el.querySelectorAll('[data-ph]').forEach(b => b.onmousedown = e => {
      e.preventDefault(); const f = focusBody; if (!f || !document.body.contains(f)) return toast('Click into a template first');
      const tok = `{${b.dataset.ph}}`, s0 = f.selectionStart, s1 = f.selectionEnd;
      f.value = f.value.slice(0, s0) + tok + f.value.slice(s1); f.selectionStart = f.selectionEnd = s0 + tok.length; f.dispatchEvent(new Event('input'));
    });
    $('tp_add').onclick = () => { draft.push({ id: '', name: 'New template', subject: '', body: 'Hello {first_name},\n\n\n\nWarm regards,\n{my_name}, {company}' }); tplCard(); const ta = el.querySelectorAll('.tpl textarea'); ta[ta.length - 1].focus(); };
    $('tp_reset').onclick = () => { draft = null; tplCard(); };
    $('tp_save').onclick = () => call(() => K.api('PUT', '/api/admin/templates', { templates: draft }), 'Templates saved').then(async () => { draft = null; await KA.reload(); tplCard(); }).catch(() => {});
  }
})();
