/* my-booking.html — lookup, status, payments, documents */
(() => {
  'use strict';
  const K = Kankana, U = K.util, $ = id => document.getElementById(id);

  async function lookup(id, email) {
    $('lErr').textContent = ''; $('lBtn').disabled = true;
    try { show((await K.api('POST', '/api/bookings/lookup', { id, email })).booking); }
    catch (e) { $('lErr').textContent = e.message; }
    finally { $('lBtn').disabled = false; }
  }
  $('lf').onsubmit = e => { e.preventDefault(); lookup($('lId').value.trim(), $('lEmail').value.trim()); };

  function show(b) {
    $('lookup').style.display = 'none';
    const st = K.STATUSES[b.status];
    const paid = K.paidAmount(b), due = K.balanceDue(b);
    const flow = ['quoted', 'confirmed', 'planning', 'paid', 'completed'];
    const idx = b.status === 'enquiry' ? -1 : flow.indexOf(b.status);
    const kind = U.kindOf(b), ds = U.describe(b), fullPay = b.quote.advance >= b.quote.total;
    const stepLabels = kind === 'event' ? ['Quotation', 'Advance paid', 'Planning', 'Fully paid', 'Celebrated'] : kind === 'stay' ? ['Quotation', 'Advance paid', 'Confirmed', 'Fully paid', 'Stayed'] : ['Reserved', 'Paid', 'Confirmed', 'Confirmed', 'Visited'];
    const needsAdvance = b.due && b.due.type === 'advance';
    const holdExpired = b.status === 'quoted' && b.holdUntil && b.holdUntil < Date.now();

    $('bk').style.display = 'block';
    $('bk').innerHTML = `
      <div class="bk-top">
        <div>
          <div class="eyebrow">Booking ${U.esc(b.id)}</div>
          <h2>${U.esc(b.customer.name)}</h2>
          <div class="muted" style="margin-top:6px">${U.esc(b.venueName)} · ${U.esc(ds.when)}</div>
        </div>
        <span class="pill ${st.tone}">${st.label}</span>
      </div>
      ${b.status === 'cancelled' ? '' : `<div class="card" style="margin-bottom:24px"><div class="k-steps">${stepLabels.map((l, i) => `<div class="${i <= idx ? 'done' : ''}">${l}</div>`).join('')}</div></div>`}
      <div class="bk-grid">
        <div>
          <div class="card">
            <h3>${ds.label} details</h3>
            <dl class="kv">
              <dt>${ds.resourceLabel}</dt><dd>${U.esc(b.venueName)}</dd>
              <dt>When</dt><dd>${U.esc(ds.when)}</dd>
              <dt>Guests</dt><dd>${U.esc(ds.people)}</dd>
              ${kind === 'event' ? `<dt>Package</dt><dd>${U.esc(b.packageName || '—')}</dd>
              <dt>Stay on the estate</dt><dd>${U.esc(ds.extras.filter(x => / per night$/.test(x)).join(', ') || '—')}</dd>` : ''}
              ${b.notes ? `<dt>Notes</dt><dd>${U.esc(b.notes)}</dd>` : ''}
            </dl>
          </div>
          <div class="card">
            <h3>Quotation ${U.esc(b.quoteNo)}</h3>
            <table class="q-table" style="margin-top:12px">
              <thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Amount</th></tr></thead>
              <tbody>${b.quote.lines.map(l => `<tr><td>${U.esc(l.desc)}</td><td class="r">${l.qty.toLocaleString('en-IN')}</td><td class="r">${U.inr(l.amount)}</td></tr>`).join('')}</tbody>
            </table>
            <div class="q-totals">
              ${b.quote.discount ? `<div><span>Discount</span><span>− ${U.inr(b.quote.discount)}</span></div>` : ''}
              <div><span>Subtotal</span><span>${U.inr(b.quote.subtotal)}</span></div>
              ${(b.quote.gstBreakdown && b.quote.gstBreakdown.length ? b.quote.gstBreakdown : [{ pct: b.quote.gstPct, gst: b.quote.gst }]).map(g => `<div><span>GST (${g.pct}%)</span><span>${U.inr(g.gst)}</span></div>`).join('')}
              <div class="grand"><span>Total</span><span>${U.inr(b.quote.total)}</span></div>
            </div>
          </div>
          <div class="card">
            <h3>History</h3>
            <ul class="k-timeline" style="margin-top:16px">
              ${b.history.slice().reverse().map(h => `<li><div class="t">${U.fmtDateTime(h.at)}</div><div class="n">${U.esc(h.note)}</div></li>`).join('')}
            </ul>
          </div>
        </div>
        <div>
          <div class="card">
            <h3>Payments</h3>
            <div class="money" style="margin-top:10px">
              <div><span>Total</span><span>${U.inr(b.quote.total)}</span></div>
              <div><span>Paid</span><span>${U.inr(paid)}</span></div>
              <div class="due"><span>${needsAdvance ? (fullPay ? 'Amount due' : `Advance due (${b.quote.advancePct}%)`) : 'Balance due'}</span><span>${U.inr(b.due ? b.due.amount : due)}</span></div>
            </div>
            ${b.status === 'quoted' ? `<div class="hold-note">${holdExpired ? `Your hold has expired. You can still pay if the ${kind === 'slot' ? 'time is' : 'dates are'} free — we will check availability first.` : `${kind === 'slot' ? 'Reservation' : 'Dates'} held until ${U.fmtDateTime(b.holdUntil)}.`}</div>` : ''}
            <div class="actions">
              ${b.due ? `<button class="btn solid" id="payNow">Pay ${U.inr(b.due.amount)} ${b.due.type === 'advance' ? (fullPay ? '& confirm' : 'advance') : 'balance'}</button>` : ''}
            </div>
            <p class="muted" style="font-size:12px;margin-top:12px;line-height:1.6">Secure payments by Razorpay — UPI, cards and netbanking.</p>
          </div>
          <div class="card docs">
            <h3 style="margin-bottom:8px">Documents</h3>
            <a href="${K.docUrl('quotation', b)}" target="_blank" rel="noopener"><span>Quotation ${U.esc(b.quoteNo)}</span><span>PDF ↗</span></a>
            ${b.invoiceNo ? `<a href="${K.docUrl('invoice', b)}" target="_blank" rel="noopener"><span>Tax invoice ${U.esc(b.invoiceNo)}</span><span>PDF ↗</span></a>` : ''}
            ${b.payments.map(pm => `<a href="${K.docUrl('receipt', b, pm.id)}" target="_blank" rel="noopener"><span>Receipt ${U.esc(pm.receiptNo)} · ${U.inr(pm.amount)}</span><span>PDF ↗</span></a>`).join('')}
          </div>
          <p class="muted" style="font-size:13px;margin-top:16px;line-height:1.6">Questions? Write to <span id="coEmail">us</span> quoting ${U.esc(b.id)}.</p>
        </div>
      </div>`;

    K.api('GET', '/api/catalog').then(r => { const e = $('coEmail'); if (e) e.textContent = r.settings.company.email; }).catch(() => {});
    const btn = $('payNow');
    if (btn) btn.onclick = async () => {
      btn.disabled = true;
      try {
        const nb = await K.pay(b);
        K.toast(b.due.type === 'advance' ? 'Advance received — your booking is confirmed.' : 'Payment received — thank you!');
        show(Object.assign(nb, { key: b.key }));
      } catch (e) {
        btn.disabled = false;
        K.toast(e.message === 'dismissed' ? 'Payment cancelled.' : e.message, 6000);
      }
    };
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const qs = new URLSearchParams(location.search);
  if (qs.get('id')) $('lId').value = qs.get('id');
  if (qs.get('email')) $('lEmail').value = qs.get('email');
  if (qs.get('id') && qs.get('email')) lookup(qs.get('id'), qs.get('email'));
})();
