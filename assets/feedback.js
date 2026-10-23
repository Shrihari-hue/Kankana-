/* feedback.js — the public "How was it?" page reached from the post-event email (feedback.html?t=TOKEN). */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const token = new URLSearchParams(location.search).get('t') || '';
  const box = $('fbBox');
  const WORDS = ['', 'Not what we hoped', 'Could have been better', 'Good', 'Wonderful', 'Unforgettable'];
  let rating = 0, recommend = null;

  async function api(method, body) {
    const r = await fetch('/api/feedback/' + encodeURIComponent(token), { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Something went wrong. Please try again.');
    return j;
  }
  const thanks = (h, p) => { box.innerHTML = `<div class="done"><h2>${esc(h)}</h2><p>${p}</p><p><a class="btn" href="index.html" style="margin-top:10px">Back to Kankana</a></p></div>`; };

  function refRow() {
    const d = document.createElement('div'); d.className = 'ref';
    d.innerHTML = '<input class="k-input" data-r="name" placeholder="Their name" aria-label="Their name"><input class="k-input" data-r="phone" placeholder="Phone" inputmode="tel" aria-label="Phone"><input class="k-input" data-r="email" placeholder="Email (optional)" type="email" aria-label="Email">';
    $('refList').appendChild(d);
  }

  function form(info) {
    $('fbH').textContent = `How was it, ${info.name}?`;
    $('fbP').textContent = `Your ${info.venue ? 'time at ' + info.venue : 'celebration'}${info.when ? ', ' + info.when : ''}. A few words from you help our team — and help other families decide.`;
    box.innerHTML = `<form id="ff" novalidate>
      <div><span class="q-l">Overall</span><div class="rate" id="rate">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-n="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}</div><div class="rate-t" id="rateT"></div></div>
      <label><span class="q-l">What did you love?</span><textarea id="loved" rows="4" maxlength="3000" placeholder="The décor, the food, a moment you’ll remember…"></textarea></label>
      <label><span class="q-l">What could we do better?</span><textarea id="improve" rows="3" maxlength="3000" placeholder="Only our team sees this."></textarea></label>
      <div><span class="q-l">How likely are you to recommend Kankana to a friend?</span><div class="nps" id="nps">${Array.from({ length: 11 }, (_, n) => `<button type="button" data-n="${n}">${n}</button>`).join('')}</div><div class="nps-l"><span>Not likely</span><span>Very likely</span></div></div>
      <label class="consent"><input type="checkbox" id="consent"><span>You may share my words (with my first name) on the Kankana website.</span></label>
      <div class="refs"><h3>Know a family planning a celebration?</h3><p>Pass on their details and we’ll reach out personally — with a thank-you to you if they book.</p><div id="refList"></div><button type="button" class="addref" id="addRef">+ Add another</button></div>
      <div class="err" id="err"></div>
      <button class="btn solid" type="submit" id="send">Send my feedback</button></form>`;
    refRow();
    const paint = () => { $('rate').querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.n <= rating)); $('rateT').textContent = WORDS[rating]; };
    $('rate').onclick = e => { const b = e.target.closest('button'); if (b) { rating = +b.dataset.n; paint(); } };
    $('nps').onclick = e => { const b = e.target.closest('button'); if (!b) return; recommend = +b.dataset.n; $('nps').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); };
    $('addRef').onclick = () => { if ($('refList').children.length < 5) refRow(); if ($('refList').children.length >= 5) $('addRef').style.display = 'none'; };
    $('ff').onsubmit = async e => {
      e.preventDefault(); $('err').textContent = '';
      if (!rating) { $('err').textContent = 'Please choose a star rating.'; return; }
      const referrals = [...$('refList').children].map(r => { const g = k => r.querySelector(`[data-r="${k}"]`).value.trim(); return { name: g('name'), phone: g('phone'), email: g('email') }; }).filter(r => r.name && (r.phone || r.email));
      $('send').disabled = true; $('send').textContent = 'Sending…';
      try {
        const r = await api('POST', { rating, loved: $('loved').value, improve: $('improve').value, recommend, consent: $('consent').checked, referrals });
        thanks('Thank you', `Your words mean a great deal to all of us at ${esc(info.company || 'Kankana')}.${r.referrals ? ` We’ll be in touch with the ${r.referrals === 1 ? 'family' : r.referrals + ' families'} you passed on — warmly, and without any pressure.` : ''}`);
        window.scrollTo(0, 0);
      } catch (err) { $('err').textContent = err.message; $('send').disabled = false; $('send').textContent = 'Send my feedback'; }
    };
  }

  if (!token) { thanks('Link incomplete', 'Please open the feedback link from your email again.'); return; }
  api('GET').then(info => info.submitted ? thanks('Thank you', 'We already have your feedback — thank you for taking the time.') : form(info))
    .catch(e => thanks('Hmm', esc(e.message)));
})();
