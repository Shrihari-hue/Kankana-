/* admin-reports.js — CRM phase 3: the Reports tab.
   One period filter scopes every number. Charts are plain HTML/SVG (no libraries):
   single-series bars in the gold accent, two-series columns gold + wine (validated
   for colour-blind separation on the paper surface), hover tooltips, and a table
   view behind every chart. */
(() => {
  'use strict';
  const KA = window.KA, K = KA.K, U = KA.U, $ = KA.$, esc = U.esc;
  const DAY = 864e5;
  let period = '3m', data = null, occ = 'next90', tables = {}, seq = 0;
  try { period = localStorage.getItem('kk_rperiod') || '3m'; } catch (e) { /* storage unavailable */ }

  /* ------------------------------------------------ formatting */
  const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  function inrShort(n) {
    n = Math.round(n || 0); const a = Math.abs(n);
    if (a >= 1e7) return '₹' + (n / 1e7).toFixed(a >= 1e8 ? 0 : 1).replace(/\.0$/, '') + ' Cr';
    if (a >= 1e5) return '₹' + (n / 1e5).toFixed(a >= 1e6 ? 0 : 1).replace(/\.0$/, '') + ' L';
    if (a >= 1e3) return '₹' + (n / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
    return '₹' + n;
  }
  const pct = x => x == null ? '—' : x > 0 && x < 0.005 ? '<1%' : Math.round(x * 100) + '%';
  const mins = m => m == null ? '—' : m < 60 ? `${m} min` : m < 1440 ? `${(m / 60).toFixed(m < 600 ? 1 : 0).replace(/\.0$/, '')} h` : `${Math.round(m / 1440)} days`;
  const monthName = ym => new Date(ym + '-01T00:00:00Z').toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' });
  const monthLong = ym => new Date(ym + '-01T00:00:00Z').toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const fmtD = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

  function range() {
    const t = todayIST();
    if (period === 'month') return [t.slice(0, 8) + '01', t];
    if (period === '12m') return [addDays(t, -364), t];
    if (period === 'fy') { const y = +t.slice(0, 4), m = +t.slice(5, 7); return [`${m >= 4 ? y : y - 1}-04-01`, t]; }
    if (period === 'custom') { const f = $('rFrom').value || addDays(t, -89), to = $('rTo').value || t; return f <= to ? [f, to] : [to, f]; }
    return [addDays(t, -89), t];
  }

  /* ------------------------------------------------ tooltip (values lead, labels follow; built with textContent) */
  const tips = [];
  const tip = (title, rows) => { tips.push({ title, rows }); return tips.length - 1; };
  const tipEl = document.createElement('div'); tipEl.id = 'rTip'; tipEl.setAttribute('role', 'tooltip'); document.body.appendChild(tipEl);
  function showTip(i, x, y) {
    const t = tips[i]; if (!t) return;
    tipEl.replaceChildren();
    const h = document.createElement('div'); h.style.cssText = 'font-size:11px;letter-spacing:.06em;opacity:.75;margin-bottom:2px'; h.textContent = t.title; tipEl.appendChild(h);
    t.rows.forEach(([label, value]) => { const r = document.createElement('div'); const b = document.createElement('b'); b.textContent = value; const s = document.createElement('span'); s.style.opacity = '.75'; s.textContent = label; r.append(b, s); tipEl.appendChild(r); });
    tipEl.style.display = 'block';
    const w = tipEl.offsetWidth, hh = tipEl.offsetHeight;
    tipEl.style.left = Math.min(window.innerWidth - w - 8, x + 14) + 'px';
    tipEl.style.top = Math.max(8, y - hh - 10) + 'px';
  }
  const hideTip = () => { tipEl.style.display = 'none'; };
  $('rBody').addEventListener('pointermove', e => { const el = e.target.closest('[data-tip]'); if (el) showTip(+el.dataset.tip, e.clientX, e.clientY); else hideTip(); });
  $('rBody').addEventListener('pointerleave', hideTip);
  $('rBody').addEventListener('focusin', e => { const el = e.target.closest('[data-tip]'); if (el) { const r = el.getBoundingClientRect(); showTip(+el.dataset.tip, r.right, r.top + 8); } });
  $('rBody').addEventListener('focusout', hideTip);

  /* ------------------------------------------------ chart pieces */
  /** Horizontal bars. rows: [{ name, value, label, small, tip, max?, track?, group? }] */
  function hbars(rows, { max, series = 's1', track = false } = {}) {
    const top = max || Math.max(1, ...rows.map(r => r.value));
    let g = null;
    return `<div class="hb">${rows.map(r => {
      const head = r.group && r.group !== g ? `<div class="grp">${esc(r.group)}</div>` : ''; g = r.group || g;
      const w = Math.max(0, Math.min(100, r.value / top * 100));
      return `${head}<div class="nm" title="${esc(r.name)}">${esc(r.name)}</div>
        <div class="tr" data-tip="${r.tip}" tabindex="0" aria-label="${esc(r.name)}: ${esc(r.label)}">${track ? '<div class="bar track"></div>' : ''}<div class="bar ${series === 's2' ? 's2' : ''}" style="width:${w}%;${r.value ? '' : 'min-width:0'}"></div></div>
        <div class="val">${esc(r.label)}${r.small ? `<small>${esc(r.small)}</small>` : ''}</div>`;
    }).join('')}</div>`;
  }
  /** Clean axis: a step of 1, 2 or 5 × 10^k, about four steps tall. */
  function niceAxis(v) {
    if (v <= 0) return { top: 1, step: 1 };
    const raw = v / 4, p = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map(m => m * p).find(x => x >= raw);
    return { top: Math.ceil(v / step) * step, step };
  }
  /** Grouped columns over months: series [{ key, name, cls }] */
  function columns(months, series) {
    const small = window.innerWidth < 760;
    if (small) months = months.slice(-6);             // phones: six readable months instead of twelve tiny ones
    const W = small ? 360 : 900, H = small ? 220 : 250, L = small ? 46 : 56, R = 8, T = 12, B = 30, iw = W - L - R, ih = H - T - B;
    const ax = niceAxis(Math.max(0, ...months.flatMap(m => series.map(s => m[s.key])))), top = ax.top;
    const ticks = []; for (let v = 0; v <= top + 1e-9; v += ax.step) ticks.push(v);
    const slot = iw / months.length, bw = Math.min(24, (slot - 10) / series.length - 2);
    const y = v => T + ih - v / top * ih;
    const bar = (x, v, cls) => { const h = Math.max(0, v / top * ih); if (!h) return ''; const r = Math.min(4, h, bw / 2), yy = T + ih - h;
      return `<path class="${cls}" d="M${x} ${T + ih}V${yy + r}Q${x} ${yy} ${x + r} ${yy}H${x + bw - r}Q${x + bw} ${yy} ${x + bw} ${yy + r}V${T + ih}Z"/>`; };
    return `<svg class="cols" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map(s => s.name).join(' and '))} by month">
      ${ticks.map(t => `<line class="gl" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${t ? inrShort(t) : '0'}</text>`).join('')}
      ${months.map((m, i) => {
        const x0 = L + i * slot + (slot - (bw + 2) * series.length + 2) / 2;
        const t = tip(monthLong(m.month), series.map(s => [s.name, U.inr(m[s.key])]).concat([['enquiries', String(m.enquiries)]]));
        return `<g data-tip="${t}" tabindex="0" aria-label="${esc(monthLong(m.month))}"><rect x="${L + i * slot}" y="${T}" width="${slot}" height="${ih}" fill="transparent"/>
          ${series.map((s, k) => bar(x0 + k * (bw + 2), m[s.key], s.cls)).join('')}
          <text x="${L + i * slot + slot / 2}" y="${H - 10}" text-anchor="middle">${esc(monthName(m.month))}</text></g>`;
      }).join('')}
    </svg>`;
  }
  const table = (head, rows, alignRight = []) => `<table class="r-tbl"><thead><tr>${head.map((h, i) => `<th class="${alignRight.includes(i) ? 'r' : ''}">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td class="${alignRight.includes(i) ? 'r' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${head.length}" class="muted">Nothing in this period.</td></tr>`}</tbody></table>`;
  const card = (id, title, sub, chart, tbl, extra = '') => `<div class="r-card" id="rc-${id}"><div class="hd"><h3>${esc(title)}</h3><span style="display:flex;gap:10px;align-items:center">${extra}<button class="tg" data-tbl="${id}" type="button">${tables[id] ? 'Show chart' : 'Show table'}</button></span></div>
    <div class="sub">${sub}</div>${tables[id] ? tbl : chart}</div>`;
  const empty = t => `<div class="muted" style="font-size:13px;padding:18px 0">${esc(t)}</div>`;

  /* ------------------------------------------------ render */
  function draw() {
    const d = data; tips.length = 0;
    const k = d.kpis;
    const kpi = (l, v, s) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
    const tiles = `<div class="r-kpis">
      ${kpi('Enquiries', k.enquiries, `${k.openLeads} leads open right now`)}
      ${kpi('Conversion', pct(k.conversion), k.won + k.lost ? `${k.won} won · ${k.lost} lost` : 'no leads closed yet')}
      ${kpi('Collected', inrShort(k.collected), 'payments received')}
      ${kpi('Booked', inrShort(k.booked), `${k.bookings} booking${k.bookings === 1 ? '' : 's'} confirmed`)}
      ${kpi('First reply', mins(k.medianResponseMin), k.respondedWithinHour == null ? 'median time to first contact' : `${pct(k.respondedWithinHour)} answered within an hour`)}
      ${kpi('Open pipeline', inrShort(k.openPipeline), 'quotations not yet paid')}</div>`;

    const src = d.sources.map(s => ({ name: s.source, value: s.leads, label: `${s.leads}`, small: s.won ? `${s.won} won · ${pct(s.conversion)}` : s.lost ? `${s.lost} lost` : '',
      tip: tip(s.source, [['enquiries', String(s.leads)], ['won', String(s.won)], ['lost', String(s.lost)], ['conversion of closed', pct(s.conversion)], ['booked value', U.inr(s.value)]]) }));
    const sourcesCard = card('sources', 'Where enquiries come from', 'Enquiries received in this period, and how many of them became bookings.',
      src.length ? hbars(src) : empty('No enquiries in this period.'),
      table(['Source', 'Enquiries', 'Won', 'Lost', 'Conversion', 'Booked value'], d.sources.map(s => [s.source, s.leads, s.won, s.lost, pct(s.conversion), U.inr(s.value)]), [1, 2, 3, 4, 5]));

    const f0 = d.funnel[0] ? d.funnel[0].count : 0;
    const fun = d.funnel.map((f, i) => ({ name: f.label, value: f.count, label: `${f.count}`, small: i && f0 ? `${pct(f.count / f0)} of enquiries` : '',
      tip: tip(f.label, [['leads reached this stage', String(f.count)], ['of all enquiries', f0 ? pct(f.count / f0) : '—']].concat(i && d.funnel[i - 1].count ? [['carried on from the stage before', pct(f.count / d.funnel[i - 1].count)]] : [])) }));
    const funnelCard = card('funnel', 'How far leads get', 'Of the enquiries in this period, how many reached each stage (a lead that was won counts at every stage).',
      f0 ? hbars(fun, { max: f0 }) : empty('No enquiries in this period.'),
      table(['Stage', 'Leads', 'Of enquiries'], d.funnel.map(f => [f.label, f.count, f0 ? pct(f.count / f0) : '—']), [1, 2]));

    const any = d.monthly.some(m => m.collected || m.booked);
    const revCard = card('revenue', 'Revenue by month', `Collected = payments received that month. Booked = value of bookings confirmed (first payment) that month. ${window.innerWidth < 760 ? 'Six' : 'Twelve'} months to ${esc(monthLong(d.monthly.at(-1).month))}.`,
      any ? `<div class="legend"><span><i style="background:var(--s1)"></i>Collected</span><span><i style="background:var(--s2)"></i>Booked</span></div>${columns(d.monthly, [{ key: 'collected', name: 'collected', cls: 's1' }, { key: 'booked', name: 'booked', cls: 's2' }])}` : empty('No payments in these twelve months yet.'),
      table(['Month', 'Collected', 'Booked', 'Enquiries'], d.monthly.slice().reverse().map(m => [monthLong(m.month), U.inr(m.collected), U.inr(m.booked), m.enquiries]), [1, 2, 3]));

    const ow = d.occupancyWindow;
    const oc = d.occupancy.map(o => ({ name: o.name, group: o.group, value: o.pct, label: pct(o.pct), small: `${o.used.toLocaleString('en-IN')} of ${o.capacity.toLocaleString('en-IN')} ${o.unit}`,
      tip: tip(o.name, [['booked', pct(o.pct)], [o.unit + ' used', `${o.used.toLocaleString('en-IN')} of ${o.capacity.toLocaleString('en-IN')}`]]) }));
    const occSeg = `<span class="seg" id="rOcc"><button data-o="next90" class="${occ === 'next90' ? 'on' : ''}" type="button">Next 90 days</button><button data-o="range" class="${occ === 'range' ? 'on' : ''}" type="button">This period</button></span>`;
    const occCard = card('occ', 'How full each space is', `Confirmed bookings only, ${esc(fmtD(ow.from))} – ${esc(fmtD(ow.to))} (${ow.days} days). Villas and rooms count celebrations’ guest stays too.`,
      oc.length ? hbars(oc, { max: 1, track: true }) : empty('No spaces in the catalogue.'),
      table(['Space', 'Booked', 'Used', 'Capacity'], d.occupancy.map(o => [o.name, pct(o.pct), `${o.used} ${o.unit}`, o.capacity]), [1, 2, 3]), occSeg);

    const lost = d.lostReasons.map(r => ({ name: r.reason, value: r.count, label: String(r.count), tip: tip(r.reason, [['leads lost', String(r.count)], ['of lost leads', pct(r.count / d.kpis.lost)]]) }));
    const lostCard = card('lost', 'Why leads are lost', 'Reasons chosen when a lead was marked lost in this period.',
      lost.length ? hbars(lost, { series: 's2' }) : empty('No leads lost in this period.'),
      table(['Reason', 'Leads'], d.lostReasons.map(r => [r.reason, r.count]), [1]));

    let teamCard = '';
    if (d.team) teamCard = `<div class="r-card" style="margin-bottom:20px"><div class="hd"><h3>Team</h3></div><div class="sub">Leads each person owns that arrived in this period, how fast they replied, and what they closed.</div>
      <div class="tbl-wrap" style="border:none">${table(['Person', 'New leads', 'Open now', 'Replied within 1 h', 'Median first reply', 'Follow-ups done', 'Overdue now', 'Won', 'Won value'],
        d.team.map(t => [t.name + (t.role ? ' · ' + (S().crm.roles[t.role] || { label: t.role }).label : ''), t.leads, t.openLeads, pct(t.withinHour), mins(t.medianResponseMin), t.followupsDone, t.overdue, t.won, U.inr(t.wonValue)]), [1, 2, 3, 4, 5, 6, 7, 8])}</div></div>`;

    $('rBody').innerHTML = tiles + `<div class="r-grid">${sourcesCard}${funnelCard}</div><div style="margin-bottom:20px">${revCard}</div><div class="r-grid">${occCard}${lostCard}</div>` + teamCard;
    $('rRange').textContent = `${fmtD(d.range.from)} – ${fmtD(d.range.to)}`;
    $('rBody').querySelectorAll('[data-tbl]').forEach(b => b.onclick = () => { tables[b.dataset.tbl] = !tables[b.dataset.tbl]; draw(); });
    const o = $('rOcc'); if (o) o.onclick = e => { const b = e.target.closest('[data-o]'); if (b && b.dataset.o !== occ) { occ = b.dataset.o; load(); } };
  }
  const S = () => KA.S;

  async function load() {
    const [from, to] = range(), my = ++seq;
    $('rBody').classList.add('busy');
    try {
      const r = await K.api('GET', `/api/admin/reports?from=${from}&to=${to}&occ=${occ}`);
      if (my !== seq) return;
      data = r; draw();
    } catch (e) { if (e.status === 401) return KA.showLogin(); $('rBody').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    finally { if (my === seq) $('rBody').classList.remove('busy'); }
  }
  function rReports() {
    document.querySelectorAll('#rPeriod button').forEach(b => b.classList.toggle('on', b.dataset.p === period));
    $('rCustom').style.display = period === 'custom' ? 'inline-flex' : 'none';
    load();
  }
  $('rPeriod').onclick = e => {
    const b = e.target.closest('button'); if (!b) return; period = b.dataset.p;
    try { localStorage.setItem('kk_rperiod', period); } catch (_) {}
    if (period === 'custom' && !$('rFrom').value) { const [f, t] = [addDays(todayIST(), -89), todayIST()]; $('rFrom').value = f; $('rTo').value = t; }
    rReports();
  };
  ['rFrom', 'rTo'].forEach(id => $(id).addEventListener('change', () => { if (period === 'custom') load(); }));
  KA.addTab('reports', rReports);
})();
