/* book.html — availability, live quotation, booking & advance payment */
(async () => {
  'use strict';
  const K = Kankana, U = K.util, $ = id => document.getElementById(id);
  let CAT, SET, TODAY;
  const occCache = {};

  try {
    const r = await K.api('GET', '/api/catalog');
    CAT = r.catalog; SET = r.settings; TODAY = r.today;
  } catch (e) {
    $('loading').innerHTML = `<h3 class="serif" style="font-size:26px">We couldn't load availability</h3><p class="muted" style="margin-top:8px">${U.esc(e.message)}</p><button class="btn" style="margin-top:18px" onclick="location.reload()">Try again</button>`;
    return;
  }

  const qs = new URLSearchParams(location.search);
  const state = {
    venueId: CAT.venues.some(v => v.id === qs.get('venue')) ? qs.get('venue') : CAT.venues[0].id,
    startDate: '', days: 1, guests: 150, rooms: 0,
    packageId: (CAT.packages.find(p => p.id === 'signature') || CAT.packages[0]).id,
    addons: [], month: U.parseISO(TODAY)
  };
  if (qs.get('email')) $('cEmail').value = qs.get('email');
  $('advPctTxt').textContent = SET.advancePct;
  $('holdH').textContent = SET.holdHours;
  $('balDays').textContent = SET.balanceDueDaysBefore;
  $('days').innerHTML = Array.from({ length: SET.maxDays || 5 }, (_, i) => `<option value="${i + 1}">${i + 1} day${i ? 's' : ''}</option>`).join('');
  $('startDate').min = TODAY;

  async function occ(venueId, force) {
    if (!occCache[venueId] || force) occCache[venueId] = (await K.api('GET', `/api/availability?venue=${encodeURIComponent(venueId)}`)).dates;
    return occCache[venueId];
  }

  /* venues */
  function drawVenues() {
    $('venues').innerHTML = CAT.venues.map(v => `
      <button type="button" class="venue-opt ${v.id === state.venueId ? 'on' : ''}" data-id="${U.esc(v.id)}" aria-pressed="${v.id === state.venueId}">
        <div class="eyebrow">${U.esc(v.region)}</div><h3>${U.esc(v.name)}</h3><p>${U.esc(v.blurb)}</p>
        <div class="meta"><span>Up to ${v.capacity} guests</span><span>${U.inr(v.perDay)} / day</span></div>
      </button>`).join('');
    $('venues').querySelectorAll('.venue-opt').forEach(b => b.onclick = async () => {
      state.venueId = b.dataset.id; drawVenues(); await occ(state.venueId); drawCal(); validateDates(); update();
    });
  }

  /* calendar */
  function drawCal() {
    K.renderCalendar($('cal'), {
      occ: occCache[state.venueId] || {}, today: TODAY, month: state.month, selStart: state.startDate, selDays: state.days, mode: 'customer',
      onMonth: m => state.month = m,
      onPick: d => { state.startDate = d; $('startDate').value = d; drawCal(); validateDates(); update(); }
    });
  }
  function validateDates() {
    const msg = $('dateMsg');
    if (!state.startDate) { msg.className = 'date-msg'; return false; }
    const ok = K.rangeFree(occCache[state.venueId] || {}, state.startDate, state.days, TODAY);
    const end = U.addDays(state.startDate, state.days - 1);
    const range = state.days > 1 ? `${U.fmtDate(state.startDate)} – ${U.fmtDate(end)}` : U.fmtDate(state.startDate);
    const v = CAT.venues.find(x => x.id === state.venueId);
    msg.className = 'date-msg ' + (ok ? 'ok' : 'bad');
    msg.textContent = ok ? `✓ ${range} is available at ${v.name}.` : `${range} overlaps a date that's already booked or unavailable. Please choose another start date or a shorter celebration.`;
    return ok;
  }
  $('startDate').onchange = e => {
    state.startDate = e.target.value;
    if (state.startDate) state.month = U.parseISO(state.startDate);
    drawCal(); validateDates(); update();
  };
  $('days').onchange = e => { state.days = +e.target.value; drawCal(); validateDates(); update(); };

  /* packages & addons */
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
  $('guests').oninput = e => { state.guests = Math.max(1, +e.target.value || 0); update(); };
  $('rooms').oninput = e => { state.rooms = Math.max(0, +e.target.value || 0); update(); };

  /* summary */
  function update() {
    const v = CAT.venues.find(x => x.id === state.venueId);
    const q = K.buildQuote(state, CAT, SET);
    const end = state.startDate ? U.addDays(state.startDate, state.days - 1) : '';
    $('sumEvent').innerHTML = `<b style="font-weight:500">${U.esc(v.name)}</b><br>
      ${state.startDate ? (state.days > 1 ? `${U.fmtDate(state.startDate)} – ${U.fmtDate(end)}` : U.fmtDate(state.startDate)) : '<span class="muted">Select dates</span>'}
      · ${state.guests} guests${state.guests > v.capacity ? ` <span style="color:var(--red)">(venue capacity ${v.capacity})</span>` : ''}`;
    $('sumLines').innerHTML = q.lines.map(l => `<div><span>${U.esc(l.desc.replace(/ \(.*\)$/, ''))}${l.qty > 1 ? ` <span class="muted">× ${l.qty.toLocaleString('en-IN')}</span>` : ''}</span><span>${U.inr(l.amount)}</span></div>`).join('');
    $('sumTotals').innerHTML = `
      <div><span>Subtotal</span><span>${U.inr(q.subtotal)}</span></div>
      <div><span>GST (${q.gstPct}%)</span><span>${U.inr(q.gst)}</span></div>
      <div class="grand"><span>Total</span><span>${U.inr(q.total)}</span></div>
      <div class="adv"><span>Advance due now (${q.advancePct}%)</span><span>${U.inr(q.advance)}</span></div>`;
    $('payBtn').textContent = `Pay ${U.inr(q.advance)} advance & confirm`;
    $('payBtn').style.display = SET.payments === 'off' ? 'none' : '';
  }

  function collect() {
    const problems = [];
    if (!state.startDate) problems.push('choose your dates');
    else if (!validateDates()) problems.push('pick available dates');
    const v = CAT.venues.find(x => x.id === state.venueId);
    if (state.guests > v.capacity) problems.push(`keep guests within ${v.capacity} for this venue`);
    const name = $('cName').value.trim(), email = $('cEmail').value.trim(), phone = $('cPhone').value.trim();
    if (!name) problems.push('add your name');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) problems.push('add a valid email');
    if (!/^[+0-9 ()-]{8,20}$/.test(phone)) problems.push('add a phone number');
    $('missing').textContent = problems.length ? 'Please ' + problems.join(', ') + '.' : '';
    if (problems.length) return null;
    return {
      venueId: state.venueId, startDate: state.startDate, days: state.days, guests: state.guests, rooms: state.rooms,
      packageId: state.packageId, addons: state.addons.slice(), notes: $('cNotes').value.trim(), website: $('website').value,
      customer: { name, email, phone, city: $('cCity').value.trim(), state: $('cState').value.trim(), gstin: $('cGstin').value.trim() }
    };
  }

  function showDone(b, paid) {
    $('flow').style.display = 'none';
    $('done').style.display = 'block';
    document.querySelector('.k-head p').style.display = 'none';
    document.querySelector('.k-head h1').textContent = paid ? 'Thank you — see you at the mandap' : 'Your quotation is ready';
    $('doneEyebrow').textContent = paid ? 'Booking Confirmed' : 'Quotation Saved';
    $('doneTitle').textContent = paid ? 'Your dates are reserved' : `Dates held for ${SET.holdHours} hours`;
    $('doneText').textContent = paid
      ? `We've received your advance of ${U.inr(K.paidAmount(b))}. Your receipt and GST invoice have been emailed to ${b.customer.email}. Our planning team will call you within 24 hours.`
      : `We've emailed quotation ${b.quoteNo} to ${b.customer.email}. Pay the ${U.inr(b.quote.advance)} advance any time from "My Booking" to confirm your dates.`;
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
    busy = true; $('payBtn').disabled = $('holdBtn').disabled = true;
    let b;
    try {
      b = (await K.api('POST', '/api/bookings', data)).booking;
    } catch (e) {
      $('missing').textContent = e.message;
      if (e.status === 409) { await occ(state.venueId, true); drawCal(); validateDates(); }
      busy = false; $('payBtn').disabled = $('holdBtn').disabled = false; return;
    }
    if (!withPayment) return showDone(b, false);
    try {
      const paidB = await K.pay(b);
      showDone(Object.assign(paidB, { key: b.key }), true);
    } catch (e) {
      K.toast(e.message === 'dismissed' ? 'Payment cancelled — your quotation is saved and your dates are on hold.' : e.message, 6000);
      showDone(b, false);
    }
  }
  $('holdBtn').onclick = () => submit(false);
  $('payBtn').onclick = () => submit(true);

  await occ(state.venueId);
  drawVenues(); drawCal(); drawPackages(); drawAddons(); update();
  $('loading').style.display = 'none'; $('flow').style.display = '';
})();
