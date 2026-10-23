/* Homepage enquiry form → /api/enquiries → a new lead in the Kankana CRM. */
(() => {
  'use strict';
  const f = document.getElementById('enquire'); if (!f) return;
  const msg = f.querySelector('.enq-msg'), btn = f.querySelector('button[type=submit]');
  const say = (t, cls) => { msg.textContent = t; msg.className = 'enq-msg ' + (cls || ''); };
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f).entries());
    if (window.kkAttribution) d.attribution = window.kkAttribution();
    f.querySelectorAll('.bad').forEach(x => x.classList.remove('bad'));
    const need = [];
    if (!String(d.name || '').trim()) need.push('name');
    const digits = String(d.phone || '').replace(/\D/g, '');
    if (digits.length < 8) need.push('phone');
    if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email)) need.push('email');
    if (need.length) { need.forEach(n => f.elements[n].classList.add('bad')); f.elements[need[0]].focus(); return say(need[0] === 'phone' ? 'Please add a phone number we can reach you on.' : need[0] === 'email' ? 'That email doesn’t look right.' : 'Please tell us your name.', 'err'); }
    btn.disabled = true; say('Sending…');
    try {
      const r = await fetch('/api/enquiries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Something went wrong. Please call or WhatsApp us instead.');
      f.classList.add('sent');
      say(`Thank you, ${String(d.name).trim().split(/\s+/)[0]}. We’ll be in touch within a day.`, 'ok');
    } catch (err) { say(err.message, 'err'); btn.disabled = false; }
  });
})();
