/* admin-capture.js — automatic lead capture.
   Settings → "Lead capture": tagged links & QR codes, the email reader (Gmail label) and the
   webhook for other apps. Leads → "From an email": paste a WedMeGood/WeddingWire/JustDial email
   and the new-lead form fills itself in. Talks to /api/admin/capture, /lead-links, /lead-mail. */
(() => {
  'use strict';
  const KA = window.KA, K = KA.K, U = KA.U, $ = KA.$, esc = U.esc, toast = KA.toast;
  const S = () => KA.S, role = () => S().me.role;
  const FIELD_IDS = { name: 'nl_name', phone: 'nl_phone' };
  const NAMES = { name: 'name', phone: 'phone', email: 'email', eventDate: 'date', guests: 'guests', budget: 'budget', city: 'city', eventType: 'event' };
  async function call(fn, okMsg) { try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { if (e.status === 401) KA.showLogin(); toast(e.message, 6000); throw e; } }
  const copy = async (text, what) => { try { await navigator.clipboard.writeText(text); toast(`${what} copied`); } catch (e) { window.prompt(`Copy ${what.toLowerCase()}`, text); } };
  const origin = () => location.origin;
  const goUrl = key => `${origin()}/go/${key}`;
  const ago = t => { if (!t) return 'never'; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : U.fmtDateTime(t); };

  /* ------------------------------------------------ Leads → "From an email" */
  KA.onBoot.push(() => {
    const nb = $('lNew'); if (!nb || $('lMail')) return;
    const b = document.createElement('button'); b.className = 'btn sm'; b.id = 'lMail'; b.type = 'button'; b.textContent = 'From an email';
    b.hidden = !['owner', 'sales'].includes(role());
    nb.parentNode.insertBefore(b, nb); b.onclick = mailDrawer;
  });
  function mailDrawer() {
    KA.showDrawer(`<div class="dr-h"><div><div class="eyebrow">WedMeGood, WeddingWire, JustDial…</div><h2>Lead from an email</h2></div><button class="dr-x" id="drX" aria-label="Close">×</button></div>
      <div class="dr-b">
        <p style="font-size:14px;line-height:1.7;margin-bottom:12px">Open the lead email, select all of it (<b style="font-weight:500">Ctrl/⌘ + A</b>), copy, and paste it below. Kankana reads the name, phone, date, guests and budget and fills in a new lead for you to check.</p>
        <textarea id="em_txt" rows="14" style="width:100%;font:inherit;font-size:13.5px;line-height:1.55;padding:12px;border:1px solid var(--line);background:var(--paper)" placeholder="Paste the whole email here"></textarea>
        <div class="err" id="em_err" style="color:var(--red);font-size:13px;margin-top:10px;min-height:1em"></div>
        <button class="btn solid" id="em_go" type="button" style="margin-top:6px">Read the email</button>
        ${role() === 'owner' ? '<p class="muted" style="font-size:12.5px;margin-top:16px;line-height:1.6">Tip: once the leads mailbox is connected (Settings → Lead capture), these emails are read automatically every 5 minutes.</p>' : ''}
      </div>`);
    $('drX').onclick = KA.closeDrawer; $('em_txt').focus();
    $('em_go').onclick = async () => {
      $('em_err').textContent = ''; $('em_go').disabled = true;
      try {
        const { parsed: p } = await K.api('POST', '/api/admin/lead-mail/preview', { text: $('em_txt').value });
        if (p.status === 'not_lead') { $('em_err').textContent = 'Couldn’t find a name, phone number or email address in this. Is it the whole lead email?'; $('em_go').disabled = false; return; }
        const got = p.found.map(k => NAMES[k]).filter(Boolean);
        const missing = ['name', 'phone'].filter(k => !p.fields[k]);
        const note = p.status === 'hidden'
          ? `${esc(p.platform || 'The site')} hid the phone number in this email. Open the lead in the ${esc(p.platform || 'listing')} app, copy the number into Phone, then save.`
          : `Read from ${p.platform ? 'a ' + esc(p.platform) + ' email' : 'the email'} — found the ${esc(got.join(', ') || 'basic details')}.${missing.length ? ` Couldn’t find the ${missing.join(' or ')} — please add ${missing.length > 1 ? 'them' : 'it'}.` : ''} Check everything, then save.`;
        KA.newLeadDrawer(Object.assign({}, p.fields, { source: p.source, _note: note, _warn: p.status === 'hidden' || missing.length > 0, _missing: missing.map(k => FIELD_IDS[k]) }));
      } catch (e) { if (e.status === 401) return KA.showLogin(); $('em_err').textContent = e.message; $('em_go').disabled = false; }
    };
  }

  /* ------------------------------------------------ QR codes */
  function qrModules(text) { const q = window.qrcode(0, 'M'); q.addData(text); q.make(); const n = q.getModuleCount(); return { n, dark: (r, c) => q.isDark(r, c) }; }
  function qrSvg(text, { size = 280, ink = '#26080e', quiet = 4 } = {}) {
    const { n, dark } = qrModules(text), w = n + quiet * 2; let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (dark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${w}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="QR code for ${esc(text)}"><rect width="${w}" height="${w}" fill="#fff"/><path d="${d}" fill="${ink}"/></svg>`;
  }
  function download(name, blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }
  function qrPng(text, px = 1200) {
    const { n, dark } = qrModules(text), quiet = 4, w = n + quiet * 2, cell = Math.floor(px / w), size = cell * w;
    const cv = document.createElement('canvas'); cv.width = cv.height = size; const g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, size, size); g.fillStyle = '#26080e';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (dark(r, c)) g.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
    return new Promise(res => cv.toBlob(res, 'image/png'));
  }
  function qrDrawer(l) {
    const url = goUrl(l.key);
    KA.showDrawer(`<div class="dr-h"><div><div class="eyebrow">QR code · counts as ${esc(l.source)}</div><h2>${esc(l.label)}</h2></div><button class="dr-x" id="drX" aria-label="Close">×</button></div>
      <div class="dr-b" style="text-align:center">
        <div style="display:inline-block;padding:18px;background:#fff;border:1px solid var(--line-soft)">${qrSvg(url, { size: 260 })}</div>
        <div style="margin:14px 0 4px;font-size:14px;word-break:break-all"><a href="${esc(url)}" target="_blank" rel="noopener" style="color:var(--gold-deep)">${esc(url.replace(/^https?:\/\//, ''))}</a></div>
        <div class="muted" style="font-size:12.5px;margin-bottom:16px">Opens the ${l.target === 'book' ? 'booking page' : 'enquiry form'} · scanned ${l.scans} time${l.scans === 1 ? '' : 's'} · ${l.leads} lead${l.leads === 1 ? '' : 's'}</div>
        <div class="quick" style="justify-content:center"><button type="button" id="qrPng">Download PNG</button><button type="button" id="qrSvg">Download SVG</button><button type="button" id="qrPrint">Print a card</button><button type="button" id="qrCopy">Copy link</button></div>
        <p class="muted" style="font-size:12.5px;line-height:1.6;margin-top:18px;text-align:left">Print it at least 3 cm wide. Test it with your phone camera before printing many copies. The code never changes, so cards you print now keep working. You can rename the link or change its source later.</p>
      </div>`);
    $('drX').onclick = KA.closeDrawer;
    const file = `kankana-qr-${l.key}`;
    $('qrPng').onclick = async () => download(file + '.png', await qrPng(url));
    $('qrSvg').onclick = () => download(file + '.svg', new Blob([qrSvg(url, { size: 1024 })], { type: 'image/svg+xml' }));
    $('qrCopy').onclick = () => copy(url, 'Link');
    $('qrPrint').onclick = () => {
      let el = $('printArea'); if (!el) { el = document.createElement('div'); el.id = 'printArea'; document.body.appendChild(el); }
      el.innerHTML = `<div class="qr-card"><div class="qr-brand">KANKANA</div><div class="qr-tag">Weddings &amp; Resorts</div>
        <div class="qr-head">Planning a celebration?</div><div class="qr-sub">Scan to see the estate, check your dates and send us an enquiry.</div>
        <div class="qr-code">${qrSvg(url, { size: 300 })}</div><div class="qr-url">${esc(url.replace(/^https?:\/\//, ''))}</div></div>`;
      document.body.classList.add('printing'); window.print(); setTimeout(() => document.body.classList.remove('printing'), 500);
    };
  }

  /* ------------------------------------------------ Settings → Lead capture (owner) */
  let data = null;
  KA.afterRender(t => { if (t === 'settings' && role() === 'owner') load(); });
  async function load() { try { data = await K.api('GET', '/api/admin/capture'); draw(); } catch (e) { if (e.status === 401) KA.showLogin(); } }
  const STATUS = {
    created: ['green', 'New lead'], merged: ['blue', 'Added to existing lead'], hidden: ['amber', 'Number hidden'], skipped: ['neutral', 'Not a lead'], failed: ['red', 'Couldn’t import']
  };
  const FILTER = 'wedmegood.com OR weddingwire.in OR weddingz.in OR justdial.com OR venuelook.com OR shaadisaga.com OR weddingbazaar.com';
  function draw() {
    const el = $('capCard'); if (!el || !data) return;
    const d = data, mb = d.mailbox, sources = S().crm.sources;
    const srcOpts = cur => [...new Set([...sources, cur].filter(Boolean))].map(s => `<option ${s === cur ? 'selected' : ''}>${esc(s)}</option>`).join('');
    const tgtOpts = cur => [['enquire', 'Enquiry form'], ['book', 'Booking page']].map(([k, l]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${l}</option>`).join('');
    const mbState = !mb.configured ? ['neutral', 'Not connected yet'] : mb.lastError ? ['red', 'Needs attention'] : mb.lastOkAt ? ['green', 'Working'] : ['amber', 'Waiting for the first check'];
    el.innerHTML = `<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline"><h3>Lead capture</h3><span class="muted" style="font-size:12px">Enquiries that arrive by themselves, already marked with where they came from.</span></div>

      <div class="cap-sec"><h4>Tagged links &amp; QR codes</h4>
        <p class="cap-p">Put these links in your Instagram bio, Facebook page, WhatsApp status and Google profile. Print the QR codes for reception, brochures and wedding expos. When someone enquires or books through one, the lead is marked with that source.</p>
        <div class="tbl-wrap"><table class="t cap-t"><thead><tr><th>Name</th><th>Counts as</th><th>Opens</th><th>Link</th><th class="r">Scans</th><th class="r">Leads</th><th></th></tr></thead><tbody>
        ${d.links.map(l => `<tr data-k="${esc(l.key)}"><td><input data-f="label" value="${esc(l.label)}"></td><td><select data-f="source">${srcOpts(l.source)}</select></td><td><select data-f="target">${tgtOpts(l.target)}</select></td>
          <td style="white-space:nowrap"><span class="cap-url">/go/${esc(l.key)}</span></td><td class="r" data-l="Scans">${l.scans}</td><td class="r" data-l="Leads">${l.leads}</td>
          <td class="cap-act"><button class="btn sm" data-copy type="button">Copy</button> <button class="btn sm" data-qr type="button">QR code</button> <button class="x" data-del type="button" aria-label="Delete ${esc(l.label)}">×</button></td></tr>`).join('') || '<tr><td colspan="7" class="empty">No links yet.</td></tr>'}</tbody></table></div>
        <div class="add-row"><label class="field" style="flex:1.6"><span>New link</span><input id="cl_label" placeholder="e.g. Wedding expo, Jan 2027"></label>
          <label class="field"><span>Counts as</span><select id="cl_src">${srcOpts('Walk-in')}</select></label>
          <label class="field"><span>Opens</span><select id="cl_tgt">${tgtOpts('enquire')}</select></label>
          <button class="btn sm solid" id="cl_add" type="button">Add link</button></div>
        <p class="muted" style="font-size:12px;margin-top:10px">Running an ad or a post with its own link? Adding <span class="cap-url">?src=instagram</span> to any Kankana web address works too.</p>
      </div>

      <div class="cap-sec"><h4>Email reader — WedMeGood, WeddingWire, JustDial… <span class="pill ${mbState[0]}" style="margin-left:8px;vertical-align:2px">${mbState[1]}</span></h4>
        ${mb.configured ? `<p class="cap-p">Reading the Gmail label <b style="font-weight:500">${esc(mb.label)}</b> in ${esc(mb.user)} every 5 minutes. Last check: ${esc(ago(mb.lastRunAt))}. ${mb.total} lead${mb.total === 1 ? '' : 's'} imported so far.</p>
          ${mb.lastError ? `<div class="card" style="background:var(--red-bg);border:none;padding:12px 16px;font-size:13px;color:var(--red);margin-bottom:10px">${esc(mb.lastError)}</div>` : ''}` :
          '<p class="cap-p">These sites email you every new enquiry. Connect the Gmail account that receives them, and each one becomes a lead automatically, usually within 5 minutes. They are assigned and answered just like website enquiries. It’s free and takes about 10 minutes:</p>'}
        <details ${mb.configured ? '' : 'open'} class="cap-steps"><summary>${mb.configured ? 'How it’s set up' : 'Set it up'}</summary><ol>
          <li>In that Gmail account, create a label called <b style="font-weight:500">Kankana leads</b>.</li>
          <li>Create a filter (Gmail → Settings → Filters → Create a new filter). In <b style="font-weight:500">From</b>, paste <span class="cap-url">${esc(FILTER)}</span> <button class="btn sm ghost" id="cap_cf" type="button">Copy</button>. Choose “Apply the label: Kankana leads” and tick “Also apply filter to matching conversations”.</li>
          <li>Turn on 2-Step Verification for the Google account. Then go to <b style="font-weight:500">myaccount.google.com/apppasswords</b> and create an app password named “Kankana CRM”.</li>
          <li>In Railway → your Kankana service → Variables, add <span class="cap-url">IMAP_USER</span> = the Gmail address and <span class="cap-url">IMAP_PASSWORD</span> = the 16-letter app password. If your label has a different name, also add <span class="cap-url">IMAP_LABEL</span>. Railway restarts the site by itself.</li>
          <li>Come back here and press <b style="font-weight:500">Check now</b>. Emails from the last 7 days are picked up on the first check. Kankana only reads that one label and never changes or deletes anything in your mailbox.</li></ol></details>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin:12px 0 4px">${mb.configured ? '<button class="btn sm solid" id="cap_chk" type="button">Check now</button>' : ''}<button class="btn sm" id="cap_paste" type="button">Paste one email instead</button></div>
        <div class="field" style="margin-top:14px"><span>Recent lead emails</span></div>
        <div class="auto-log">${d.emails.map(m => `<div><span><span class="pill ${(STATUS[m.status] || STATUS.failed)[0]}" style="font-size:9px;padding:2px 7px;margin-right:6px">${(STATUS[m.status] || STATUS.failed)[1]}</span>${m.leadId ? `<a href="#" data-lead="${esc(m.leadId)}" style="color:var(--gold-deep)">${esc(m.leadId)}</a> · ` : ''}${esc(m.platform || 'Email')} · ${esc(m.subject || '(no subject)')}${m.note && m.status !== 'created' ? `<div class="muted" style="font-size:11.5px">${esc(m.note)}</div>` : ''}</span><span class="muted" style="white-space:nowrap">${esc(U.fmtDateTime(m.at))}</span></div>`).join('') || '<div class="muted">None yet.</div>'}</div>
      </div>

      <div class="cap-sec"><details class="cap-steps"><summary>Connect other apps (for later)</summary>
        <p class="cap-p" style="margin-top:10px">Pabbly Connect, Make or Zapier can forward Instagram and Facebook ad leads, Google Ads lead forms or an inbound-email service to this address. Send JSON with <span class="cap-url">name</span>, <span class="cap-url">phone</span>, <span class="cap-url">email</span>, <span class="cap-url">eventDate</span>, <span class="cap-url">guests</span> and <span class="cap-url">source</span>. You can also send an email’s <span class="cap-url">subject</span> and <span class="cap-url">text</span>. Keep this address private.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><code class="cap-url" style="word-break:break-all">${esc(origin())}/api/hooks/lead/${esc(d.hookKey)}</code><button class="btn sm" id="cap_hc" type="button">Copy</button><button class="btn sm ghost" id="cap_hr" type="button">Make a new address</button></div>
      </details></div>`;

    el.querySelectorAll('tr[data-k]').forEach(row => {
      const key = row.dataset.k, l = d.links.find(x => x.key === key);
      row.querySelectorAll('[data-f]').forEach(inp => inp.onchange = () => call(() => K.api('PUT', `/api/admin/lead-links/${encodeURIComponent(key)}`, { [inp.dataset.f]: inp.value }), 'Link saved').then(load).catch(load));
      row.querySelector('[data-copy]').onclick = () => copy(goUrl(key), 'Link');
      row.querySelector('[data-qr]').onclick = () => qrDrawer(l);
      row.querySelector('[data-del]').onclick = () => { if (!window.confirm(`Delete “${l.label}”? Printed QR codes and posted links for it will stop counting and just open the homepage.`)) return; call(() => K.api('DELETE', `/api/admin/lead-links/${encodeURIComponent(key)}`), 'Link deleted').then(load).catch(() => {}); };
    });
    $('cl_add').onclick = () => call(() => K.api('POST', '/api/admin/lead-links', { label: $('cl_label').value, source: $('cl_src').value, target: $('cl_tgt').value }), 'Link added').then(async r => { await KA.reload(); await load(); qrDrawer(Object.assign({ scans: 0, leads: 0 }, r.link)); }).catch(() => {});
    $('cap_cf').onclick = () => copy(FILTER, 'Filter');
    const chk = $('cap_chk'); if (chk) chk.onclick = () => { chk.disabled = true; chk.textContent = 'Checking…'; call(() => K.api('POST', '/api/admin/lead-mail/check', {})).then(r => { Object.assign(data, { mailbox: r.mailbox, emails: r.emails }); toast(r.mailbox.lastError ? 'The mailbox needs attention' : 'Mailbox checked'); draw(); KA.reload().catch(() => {}); }).catch(() => { chk.disabled = false; chk.textContent = 'Check now'; }); };
    $('cap_paste').onclick = mailDrawer;
    el.querySelectorAll('[data-lead]').forEach(a => a.onclick = e => { e.preventDefault(); KA.openLead(a.dataset.lead); });
    $('cap_hc').onclick = () => copy(`${origin()}/api/hooks/lead/${d.hookKey}`, 'Address');
    $('cap_hr').onclick = () => { if (!window.confirm('Make a new address? Any app using the old one will stop working until you update it.')) return; call(() => K.api('POST', '/api/admin/capture/hook-key', {}), 'New address made').then(load).catch(() => {}); };
  }
})();
