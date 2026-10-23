/* book.html — availability, live quotation, booking & payment for every part of the estate:
   celebrations (venues & halls by the day), villas & rooms (by the night),
   turf & pickleball (by the hour) and café tables. */
(async () => {
  'use strict';
  const K = Kankana, U = K.util, P = window.KankanaPricing, $ = id => document.getElementById(id);
  let CAT, SET, TODAY;

  try {
    const r = await K.api('GET', '/api/catalog');
    CAT = r.catalog; SET = r.settings; TODAY = r.today;
  } catch (e) {
    $('loading').innerHTML = `<h3 class="serif" style="font-size:26px">We couldn't load availability</h3><p class="muted" style="margin-top:8px">${U.esc(e.message)}</p><button class="btn" style="margin-top:18px" onclick="location.reload()">Try again</button>`;
    return;
  }
  CAT.stays = CAT.stays || []; CAT.slots = CAT.slots || [];

  /* ------------------------------------------------------------ tabs */
  const LISTS = {
    event: CAT.venues,
    stay: CAT.stays,
    play: CAT.slots.filter(s => s.per !== 'guest'),
    cafe: CAT.slots.filter(s => s.per === 'guest')
  };
  const KIND = { event: 'event', stay: 'stay', play: 'slot', cafe: 'slot' };
  const COPY = {
    event: { eyebrow: 'Plan Your Celebration', title: 'Check availability & reserve your dates', what: 'Choose a venue', when: 'Pick your dates', start: 'Start date', days: 'Celebration length',
      lead: () => `Choose a venue and date, shape your celebration, and receive an instant quotation. A ${SET.advancePct}% advance confirms your booking.` },
    stay: { eyebrow: 'Stay at Kankana', title: 'Villas & rooms', what: 'Choose your stay', when: 'Choose your nights', start: 'Check-in', days: 'Nights',
      lead: () => `See which nights are free and reserve instantly. A ${SET.stayAdvancePct || 50}% advance confirms your stay; the balance is paid at check-in.` },
    play: { eyebrow: 'Play at Kankana', title: 'Turf & pickleball', what: 'Choose a court', when: 'Pick a day & time', start: 'Date', days: '',
      lead: () => 'Book by the hour. Pay online to confirm your slot instantly.' },
    cafe: { eyebrow: 'The Café', title: 'Reserve a table', what: 'The café', when: 'Pick a day & time', start: 'Date', days: '',
      lead: () => 'Choose a day, a time and how many of you are coming. Pay online to confirm your table.' }
  };
  document.querySelectorAll('#kinds [data-kind]').forEach(b => { if (!LISTS[b.dataset.kind].length) b.style.display = 'none'; });

  const qs = new URLSearchParams(location.search);
  let tab = ({ event: 'event', events: 'event', stay: 'stay', stays: 'stay', play: 'play', turf: 'play', pickleball: 'play', cafe: 'cafe' })[qs.get('type')] || null;
  const want = qs.get('venue') || qs.get('item');
  if (!tab && want) tab = Object.keys(LISTS).find(t => LISTS[t].some(x => x.id === want)) || null;
  if (!tab || !LISTS[tab].length) tab = Object.keys(LISTS).find(t => LISTS[t].length);

  const state = {
    itemId: '', startDate: '', days: 1, units: 1, guests: 150, guests2: 2, hours: 1, startHour: null,
    packageId: (CAT.packages.find(p => p.id === 'signature') || CAT.packages[0] || {}).id,
    addons: [], acc: {}, month: U.parseISO(TODAY)
  };
  if (qs.get('email')) $('cEmail').value = qs.get('email');
  $('startDate').min = TODAY;

  /* ------------------------------------------------------------ availability caches */
  const cache = { event: {}, stay: {}, closed: {}, day: {} };
  async function loadAvail(force) {
    const id = state.itemId, k = KIND[tab];
    if (k === 'event' && (force || !cache.event[id])) cache.event[id] = (await K.api('GET', `/api/availability?venue=${encodeURIComponent(id)}`)).dates;
    if (k === 'stay' && (force || !cache.stay[id])) cache.stay[id] = (await K.api('GET', `/api/availability?stay=${encodeURIComponent(id)}`)).free;
    if (k === 'event') await Promise.all(CAT.stays.map(async s => { if (force || !cache.stay[s.id]) cache.stay[s.id] = (await K.api('GET', `/api/availability?stay=${encodeURIComponent(s.id)}`)).free; }));
    if (k === 'slot') {
      if (force || !cache.closed[id]) cache.closed[id] = (await K.api('GET', `/api/availability?slot=${encodeURIComponent(id)}`)).closed;
      if (state.startDate) await loadDay(force);
    }
  }
  async function loadDay(force) {
    const key = state.itemId + '|' + state.startDate;
    if (force || !cache.day[key]) cache.day[key] = await K.api('GET', `/api/availability?slot=${encodeURIComponent(state.itemId)}&date=${state.startDate}`);
    return cache.day[key];
  }
  const item = () => LISTS[tab].find(x => x.id === state.itemId);
  const stayFree = (s, d) => { const f = (cache.stay[s.id] || {})[d]; return f == null ? s.units : f; };
  const minStayFree = (s, start, nights) => start ? Math.min(...U.eventDates(start, nights).map(d => stayFree(s, d))) : s.units;

  /* ------------------------------------------------------------ tab switching */
  function setTab(t, keepItem) {
    tab = t;
    const c = COPY[t], k = KIND[t];
    document.querySelectorAll('#kinds [data-kind]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.kind === t)));
    $('headEyebrow').textContent = c.eyebrow; $('headTitle').textContent = c.title; $('headLead').textContent = c.lead();
    $('whatTitle').textContent = c.what; $('whenTitle').textContent = c.when; $('startLbl').textContent = c.start;
    $('stepShape').style.display = k === 'event' ? '' : 'none';
    $('daysField').style.display = k === 'slot' ? 'none' : ''; $('daysLbl').textContent = c.days;
    $('unitsField').style.display = k === 'stay' ? '' : 'none';
    $('guestsField2').style.display = k === 'event' ? 'none' : '';
    $('hoursField').style.display = t === 'play' ? '' : 'none';
    $('timeWrap').style.display = k === 'slot' ? '' : 'none';
    $('detailsNo').textContent = k === 'event' ? '04' : '03';
    $('holdBtn').style.display = k === 'slot' ? 'none' : '';
    $('legend').innerHTML = k === 'event'
      ? '<span><i class="free"></i>Available</span><span><i class="sel"></i>Your dates</span><span><i class="hold"></i>On hold</span><span><i class="booked"></i>Booked</span><span><i class="blocked"></i>Unavailable</span>'
      : k === 'stay' ? '<span><i class="free"></i>Available</span><span><i class="sel"></i>Your nights</span><span><i class="booked"></i>Full</span><span><i class="blocked"></i>Closed</span>'
        : '<span><i class="free"></i>Open</span><span><i class="sel"></i>Your day</span><span><i class="blocked"></i>Closed</span>';
    $('days').innerHTML = k === 'stay'
      ? Array.from({ length: SET.maxNights || 14 }, (_, i) => `<option value="${i + 1}">${i + 1} night${i ? 's' : ''}</option>`).join('')
      : Array.from({ length: SET.maxDays || 5 }, (_, i) => `<option value="${i + 1}">${i + 1} day${i ? 's' : ''}</option>`).join('');
    if (!keepItem || !LISTS[t].some(x => x.id === state.itemId)) state.itemId = (LISTS[t].find(x => x.id === want) || LISTS[t][0]).id;
    state.startDate = ''; state.days = 1; state.units = 1; state.hours = 1; state.startHour = null;
    state.guests2 = t === 'play' ? 4 : 2;
    $('startDate').value = ''; $('days').value = '1'; $('guests2').value = state.guests2;
    const u = new URL(location.href); u.searchParams.set('type', t); u.searchParams.delete('venue'); u.searchParams.delete('item'); history.replaceState(null, '', u);
    selectItem(state.itemId);
  }
  $('kinds').onclick = e => { const b = e.target.closest('[data-kind]'); if (b && b.dataset.kind !== tab) setTab(b.dataset.kind); };

  /* ------------------------------------------------------------ items */
  function drawItems() {
    const t = tab;
    $('items').innerHTML = LISTS[t].map(v => {
      let eyebrow, meta;
      if (t === 'event') { eyebrow = v.region || 'Venue'; meta = `<span>Up to ${v.capacity} guests</span><span>${U.inr(v.perDay)} / day</span>`; }
      else if (t === 'stay') { eyebrow = `${v.units} ${v.unitWord || 'unit'}${v.units > 1 ? 's' : ''}`; meta = `<span>Sleeps ${v.sleeps}</span><span>${U.inr(v.perNight)} / night</span>`; }
      else if (t === 'play') { eyebrow = `${U.fmtHour(v.open)} – ${U.fmtHour(v.close)}`; meta = `<span>Up to ${v.maxGuests} players</span><span>${U.inr(v.rate)} / hour</span>`; }
      else { eyebrow = `${U.fmtHour(v.open)} – ${U.fmtHour(v.close)}`; meta = `<span>Tables up to ${v.maxGuests}</span><span>${U.inr(v.rate)} / guest</span>`; }
      return `<button type="button" class="venue-opt ${v.id === state.itemId ? 'on' : ''}" data-id="${U.esc(v.id)}" aria-pressed="${v.id === state.itemId}">
        <div class="eyebrow">${U.esc(eyebrow)}</div><h3>${U.esc(v.name)}</h3><p>${U.esc(v.blurb || '')}</p><div class="meta">${meta}</div></button>`;
    }).join('');
    $('items').querySelectorAll('.venue-opt').forEach(b => b.onclick = () => { if (b.dataset.id !== state.itemId) selectItem(b.dataset.id); });
  }
  async function selectItem(id) {
    state.itemId = id; state.startHour = null;
    const it = item();
    if (tab === 'stay') $('units').innerHTML = Array.from({ length: it.units }, (_, i) => `<option value="${i + 1}">${i + 1} ${it.unitWord || 'unit'}${i ? 's' : ''}</option>`).join('');
    if (tab === 'stay') { $('unitsLbl').textContent = (it.unitWord || 'unit').replace(/^./, c => c.toUpperCase()) + 's'; state.units = Math.min(state.units, it.units); $('units').value = String(state.units); }
    if (tab === 'play') $('hours').innerHTML = Array.from({ length: it.maxHours || 2 }, (_, i) => `<option value="${i + 1}">${i + 1} hour${i ? 's' : ''}</option>`).join('');
    if (tab === 'play') { state.hours = Math.min(state.hours, it.maxHours || 2); $('hours').value = String(state.hours); }
    if (KIND[tab] !== 'event') {
      $('guests2Lbl').textContent = tab === 'stay' ? 'Guests' : tab === 'play' ? 'Players' : 'Party size';
      $('guests2').max = tab === 'stay' ? state.units * it.sleeps : it.maxGuests;
    }
    $('stepWhat').style.display = LISTS[tab].length > 1 ? '' : 'none';
    $('whenNo').textContent = LISTS[tab].length > 1 ? '02' : '01';
    drawItems();
    try { await loadAvail(); } catch (e) { K.toast(e.message); }
    drawAll();
  }

  /* ------------------------------------------------------------ calendar & times */
  function drawCal() {
    const k = KIND[tab], it = item(); const occ = {}, badges = {};
    if (k === 'event') Object.assign(occ, cache.event[it.id] || {});
    else if (k === 'stay') {
      Object.entries(cache.stay[it.id] || {}).forEach(([d, f]) => { if (f < state.units) occ[d] = f === 0 ? 'booked' : 'booked'; if (f < it.units) badges[d] = f ? `${f} left` : 'full'; });
    } else Object.keys(cache.closed[it.id] || {}).forEach(d => { occ[d] = 'blocked'; });
    K.renderCalendar($('cal'), {
      occ, badges, today: TODAY, month: state.month, selStart: state.startDate, selDays: k === 'slot' ? 1 : state.days, mode: 'customer',
      onMonth: m => state.month = m,
      onPick: d => setDate(d)
    });
  }
  async function setDate(d) {
    state.startDate = d; $('startDate').value = d;
    if (d) state.month = U.parseISO(d);
    state.startHour = null;
    if (KIND[tab] === 'slot' && d) { try { await loadDay(); } catch (e) { K.toast(e.message); } }
    drawAll();
  }
  function drawTimes() {
    if (KIND[tab] !== 'slot') return;
    const it = item();
    if (!state.startDate) { $('times').innerHTML = '<p class="muted" style="font-size:14px;grid-column:1/-1">Choose a day to see open times.</p>'; return; }
    const day = cache.day[it.id + '|' + state.startDate];
    if (!day) { $('times').innerHTML = '<p class="muted" style="font-size:14px;grid-column:1/-1">Loading…</p>'; return; }
    const hrs = U.slotHours(it, { hours: state.hours }), need = U.slotUsage(it, { guests: state.guests2, units: 1 });
    const today = state.startDate === TODAY;
    let html = '';
    for (let h = it.open; h + hrs <= it.close; h++) {
      let ok = !(today && h <= day.hourNow), minFree = Infinity;
      for (let x = h; x < h + hrs; x++) { const f = day.free[x] == null ? it.units : day.free[x]; minFree = Math.min(minFree, f); if (f < need) ok = false; }
      const sub = it.per === 'guest' ? (ok ? `${minFree} seats` : 'full') : (ok ? 'free' : 'taken');
      if (!ok && state.startHour === h) state.startHour = null;
      html += `<button type="button" data-h="${h}" class="${state.startHour === h ? 'on' : ''}" ${ok ? '' : 'disabled'}>${U.fmtHour(h)}<small>${today && h <= day.hourNow ? 'past' : sub}</small></button>`;
    }
    $('times').innerHTML = html || '<p class="muted" style="font-size:14px;grid-column:1/-1">No times available.</p>';
    $('timeLbl').textContent = it.per === 'guest' ? `Arrival time · tables are held for ${hrs} hours` : 'Start time';
    $('times').querySelectorAll('[data-h]').forEach(b => b.onclick = () => { state.startHour = +b.dataset.h; drawTimes(); validateWhen(); update(); });
  }

  /** Shows whether the current selection fits; returns true if it does. */
  function validateWhen() {
    const msg = $('dateMsg'), k = KIND[tab], it = item();
    const show = (ok, t) => { msg.className = 'date-msg ' + (ok ? 'ok' : 'bad'); msg.textContent = t; return ok; };
    msg.className = 'date-msg';
    if (!state.startDate) return false;
    if (state.startDate < TODAY) return show(false, 'Please choose a future date.');
    if (k === 'event') {
      const ok = K.rangeFree(cache.event[it.id] || {}, state.startDate, state.days, TODAY);
      const end = U.addDays(state.startDate, state.days - 1);
      const range = state.days > 1 ? `${U.fmtDate(state.startDate)} – ${U.fmtDate(end)}` : U.fmtDate(state.startDate);
      return show(ok, ok ? `✓ ${range} is available at ${it.name}.` : `${range} overlaps a date that's already booked or unavailable. Please choose another start date or a shorter celebration.`);
    }
    if (k === 'stay') {
      const free = minStayFree(it, state.startDate, state.days), out = U.addDays(state.startDate, state.days);
      const range = `${U.fmtDate(state.startDate)} – ${U.fmtDate(out)}`;
      if (free >= state.units) return show(true, `✓ ${state.units} ${it.unitWord}${state.units > 1 ? 's' : ''} available, ${range} (${state.days} night${state.days > 1 ? 's' : ''}).`);
      return show(false, free ? `Only ${free} ${it.unitWord}${free > 1 ? 's are' : ' is'} free for every night of ${range}. Reduce the number or change your dates.` : `No ${it.unitWord}s are free for all of ${range}. Please try other dates.`);
    }
    if (state.startHour == null) { msg.className = 'date-msg'; return false; }
    const hrs = U.slotHours(it, { hours: state.hours });
    return show(true, `✓ ${it.name} · ${U.fmtDate(state.startDate)} · ${U.fmtHour(state.startHour)} – ${U.fmtHour(state.startHour + hrs)}`);
  }

  $('startDate').onchange = e => setDate(e.target.value);
  $('days').onchange = e => { state.days = +e.target.value; drawAll(); };
  $('units').onchange = e => { state.units = +e.target.value; $('guests2').max = state.units * item().sleeps; drawAll(); };
  $('hours').onchange = e => { state.hours = +e.target.value; drawAll(); };
  $('guests2').oninput = e => { state.guests2 = Math.max(1, +e.target.value || 0); if (KIND[tab] === 'slot') drawTimes(); validateWhen(); update(); };

  /* ------------------------------------------------------------ celebration extras */
  function drawPackages() {
    $('packages').innerHTML = CAT.packages.map(p => `
      <button type="button" class="pkg-opt ${p.id === state.packageId ? 'on' : ''}" data-id="${U.esc(p.id)}" aria-pressed="${p.id === state.packageId}">
        <h4>${U.esc(p.name)}</h4><div class="price">${U.inr(p.perGuest)} per guest / day</div><p>${U.esc(p.desc)}</p></button>`).join('');
    $('packages').querySelectorAll('.pkg-opt').forEach(b => b.onclick = () => { state.packageId = b.dataset.id; drawPackages(); update(); });
  }
  function drawAddons() {
    $('addons').innerHTML = CAT.addons.map(a => `
      <label class="addon"><input type="checkbox" value="${U.esc(a.id)}" ${state.addons.includes(a.id) ? 'checked' : ''}>
        <span>${U.esc(a.name)}<small>${U.inr(a.price)}${a.unit === 'perGuest' ? ' per guest' : ''}</small></span></label>`).join('');
    $('addons').querySelectorAll('input').forEach(i => i.onchange = () => {
      state.addons = [...$('addons').querySelectorAll('input:checked')].map(x => x.value); update();
    });
  }
  function drawAcc() {
    if (!CAT.stays.length) { $('accWrap').style.display = 'none'; return; }
    $('acc').innerHTML = CAT.stays.map(s => {
      const free = minStayFree(s, state.startDate, state.days);
      const cur = Math.min(state.acc[s.id] || 0, free); state.acc[s.id] = cur;
      return `<div class="acc-row"><div>${U.esc(s.name)}s<small>${U.inr(s.perNight)} / night · sleeps ${s.sleeps}${state.startDate ? ` · ${free} free for your dates` : ''}</small></div>
        <select data-acc="${U.esc(s.id)}" aria-label="${U.esc(s.name)}s per night">${Array.from({ length: free + 1 }, (_, i) => `<option value="${i}" ${i === cur ? 'selected' : ''}>${i}</option>`).join('')}</select></div>`;
    }).join('');
    $('acc').querySelectorAll('[data-acc]').forEach(sel => sel.onchange = () => { state.acc[sel.dataset.acc] = +sel.value; update(); });
  }
  $('guests').oninput = e => { state.guests = Math.max(1, +e.target.value || 0); update(); };

  /* ------------------------------------------------------------ summary */
  function selection() {
    const k = KIND[tab], it = item();
    const base = { kind: k, venueId: it.id, startDate: state.startDate };
    if (k === 'event') return Object.assign(base, { days: state.days, guests: state.guests, packageId: state.packageId, addons: state.addons.slice(),
      accommodation: CAT.stays.map(s => ({ id: s.id, units: state.acc[s.id] || 0 })).filter(a => a.units) });
    if (k === 'stay') return Object.assign(base, { days: state.days, units: state.units, guests: state.guests2 });
    return Object.assign(base, { days: 1, guests: state.guests2, startHour: state.startHour, hours: U.slotHours(it, { hours: state.hours }), units: 1 });
  }
  function update() {
    const k = KIND[tab], it = item(), sel = selection();
    const q = K.buildQuote(sel, CAT, SET);
    const pseudo = Object.assign({}, sel, { venueName: it.name, unitWord: it.unitWord, per: it.per, packageName: (CAT.packages.find(p => p.id === state.packageId) || {}).name,
      accommodation: (sel.accommodation || []).map(a => Object.assign({ name: (CAT.stays.find(s => s.id === a.id) || {}).name }, a)) });
    const ds = U.describe(Object.assign({}, pseudo, { startDate: state.startDate || TODAY, startHour: state.startHour == null ? it.open : state.startHour }));
    const when = !state.startDate ? '<span class="muted">Choose a date</span>' : (k === 'slot' && state.startHour == null) ? `${U.fmtDate(state.startDate)} · <span class="muted">choose a time</span>` : U.esc(ds.when);
    let warn = '';
    if (k === 'event' && state.guests > it.capacity) warn = ` <span style="color:var(--red)">(${U.esc(it.name)} hosts up to ${it.capacity})</span>`;
    if (k === 'stay' && state.guests2 > state.units * it.sleeps) warn = ` <span style="color:var(--red)">(${state.units} ${it.unitWord}${state.units > 1 ? 's sleep' : ' sleeps'} up to ${state.units * it.sleeps})</span>`;
    if (k === 'slot' && state.guests2 > it.maxGuests) warn = ` <span style="color:var(--red)">(up to ${it.maxGuests})</span>`;
    $('sumEvent').innerHTML = `<b style="font-weight:500">${U.esc(it.name)}</b><br>${when}<br>${U.esc([ds.people].concat(ds.extras).join(' · '))}${warn}`;
    $('sumLines').innerHTML = q.lines.map(l => `<div><span>${U.esc(l.desc.replace(/ \(.*\)$/, ''))}${l.qty > 1 ? ` <span class="muted">× ${l.qty.toLocaleString('en-IN')}</span>` : ''}</span><span>${U.inr(l.amount)}</span></div>`).join('');
    const gst = (q.gstBreakdown && q.gstBreakdown.length ? q.gstBreakdown : [{ pct: q.gstPct, gst: q.gst }])
      .map(g => `<div><span>GST (${g.pct}%)</span><span>${U.inr(g.gst)}</span></div>`).join('');
    const full = q.advance >= q.total;
    $('sumTotals').innerHTML = `
      <div><span>Subtotal</span><span>${U.inr(q.subtotal)}</span></div>${gst}
      <div class="grand"><span>Total</span><span>${U.inr(q.total)}</span></div>
      ${full ? '' : `<div class="adv"><span>Advance due now (${q.advancePct}%)</span><span>${U.inr(q.advance)}</span></div>`}`;
    $('payBtn').textContent = full ? `Pay ${U.inr(q.total)} & confirm` : `Pay ${U.inr(q.advance)} advance & confirm`;
    $('payBtn').style.display = SET.payments === 'off' ? 'none' : '';
    $('sumNote').innerHTML = k === 'event'
      ? `Dates are held for ${SET.holdHours} hours on a saved quotation. Payments are processed securely by Razorpay (UPI, cards, netbanking). Balance is due ${SET.balanceDueDaysBefore} days before your celebration.`
      : k === 'stay' ? `Nights are held for ${SET.stayHoldHours || 24} hours on a saved quotation. Payments are processed securely by Razorpay. The balance is paid at check-in.`
        : `Payments are processed securely by Razorpay (UPI, cards, netbanking). Your ${tab === 'cafe' ? 'table' : 'slot'} is confirmed as soon as you pay.`;
  }

  function drawAll() { drawCal(); drawTimes(); if (KIND[tab] === 'event') drawAcc(); validateWhen(); update(); }

  /* ------------------------------------------------------------ submit */
  function collect() {
    const problems = [], k = KIND[tab], it = item();
    if (!state.startDate) problems.push('choose your date');
    else if (k === 'slot' && state.startHour == null) problems.push('choose a time');
    else if (!validateWhen()) problems.push(k === 'slot' ? 'pick an available time' : 'pick available dates');
    if (k === 'event' && state.guests > it.capacity) problems.push(`keep guests within ${it.capacity} for this venue`);
    if (k === 'stay' && state.guests2 > state.units * it.sleeps) problems.push(`add more ${it.unitWord}s or reduce guests`);
    if (k === 'slot' && state.guests2 > it.maxGuests) problems.push(`keep to ${it.maxGuests} ${tab === 'cafe' ? 'guests' : 'players'}`);
    const name = $('cName').value.trim(), email = $('cEmail').value.trim(), phone = $('cPhone').value.trim();
    if (!name) problems.push('add your name');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) problems.push('add a valid email');
    if (!/^[+0-9 ()-]{8,20}$/.test(phone)) problems.push('add a phone number');
    $('missing').textContent = problems.length ? 'Please ' + problems.join(', ') + '.' : '';
    if (problems.length) return null;
    return Object.assign(selection(), {
      notes: $('cNotes').value.trim(), website: $('website').value,
      customer: { name, email, phone, city: $('cCity').value.trim(), state: $('cState').value.trim(), gstin: $('cGstin').value.trim() }
    });
  }

  function showDone(b, paid) {
    const k = U.kindOf(b), ds = U.describe(b);
    $('flow').style.display = 'none'; $('kinds').style.display = 'none';
    $('done').style.display = 'block';
    document.querySelector('.k-head p').style.display = 'none';
    document.querySelector('.k-head h1').textContent = paid ? (k === 'event' ? 'Thank you — see you at the mandap' : k === 'stay' ? 'Thank you — we look forward to hosting you' : 'Thank you — you’re booked') : 'Your quotation is ready';
    $('doneEyebrow').textContent = paid ? 'Booking Confirmed' : 'Quotation Saved';
    $('doneTitle').textContent = paid ? (k === 'event' ? 'Your dates are reserved' : k === 'stay' ? 'Your stay is confirmed' : `${b.venueName} · ${ds.when}`) : (k === 'slot' ? `Held for ${SET.slotHoldMinutes || 30} minutes` : `Held for ${k === 'stay' ? (SET.stayHoldHours || 24) : SET.holdHours} hours`);
    $('doneText').textContent = paid
      ? `We've received ${U.inr(K.paidAmount(b))}. Your receipt and GST invoice have been emailed to ${b.customer.email}.${k === 'event' ? ' Our planning team will call you within 24 hours.' : ''}`
      : `We've emailed quotation ${b.quoteNo} to ${b.customer.email}. Pay the ${U.inr(b.quote.advance)} ${b.quote.advance >= b.quote.total ? 'amount' : 'advance'} any time from "My Booking" to confirm.`;
    $('doneId').textContent = b.id;
    const pay = b.payments[b.payments.length - 1];
    $('doneDocs').innerHTML = `
      <a class="btn sm" href="${K.docUrl('quotation', b)}" target="_blank" rel="noopener">Quotation (PDF)</a>
      ${paid ? `<a class="btn sm" href="${K.docUrl('invoice', b)}" target="_blank" rel="noopener">Tax invoice</a>
      <a class="btn sm" href="${K.docUrl('receipt', b, pay.id)}" target="_blank" rel="noopener">Payment receipt</a>` : ''}
      <a class="btn sm solid" href="my-booking.html?id=${encodeURIComponent(b.id)}&email=${encodeURIComponent(b.customer.email)}">Track booking</a>`;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  let busy = false;
  async function submit(withPayment) {
    if (busy) return;
    const data = collect(); if (!data) return;
    if (window.kkAttribution) data.attribution = window.kkAttribution();
    busy = true; $('payBtn').disabled = $('holdBtn').disabled = true;
    let b;
    try {
      b = (await K.api('POST', '/api/bookings', data)).booking;
    } catch (e) {
      $('missing').textContent = e.message;
      if (e.status === 409) { try { await loadAvail(true); } catch (_) {} drawAll(); }
      busy = false; $('payBtn').disabled = $('holdBtn').disabled = false; return;
    }
    if (!withPayment) return showDone(b, false);
    try {
      const paidB = await K.pay(b);
      showDone(Object.assign(paidB, { key: b.key }), true);
    } catch (e) {
      K.toast(e.message === 'dismissed' ? (KIND[tab] === 'slot' ? 'Payment cancelled — your slot is held for a few minutes. Pay from "My Booking" to confirm it.' : 'Payment cancelled — your quotation is saved and your dates are on hold.') : e.message, 7000);
      showDone(b, false);
    }
  }
  $('holdBtn').onclick = () => submit(false);
  $('payBtn').onclick = () => submit(true);

  drawPackages(); drawAddons();
  $('loading').style.display = 'none'; $('flow').style.display = '';
  setTab(tab, true);
})();
