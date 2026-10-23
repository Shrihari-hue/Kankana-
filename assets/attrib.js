/* attrib.js — remembers how a visitor reached the site (a tagged link or QR code like
   /go/instagram, ?src=instagram, utm_source=…, or the site they came from) so their
   enquiry or booking lands in the CRM with the right source. Kept for 30 days in this browser. */
(() => {
  'use strict';
  const KEY = 'kk_attr', DAYS = 30;
  const read = () => { try { const a = JSON.parse(localStorage.getItem(KEY) || 'null'); return a && a.at > Date.now() - DAYS * 864e5 ? a : null; } catch (e) { return null; } };
  const write = a => { try { localStorage.setItem(KEY, JSON.stringify(a)); } catch (e) { /* private mode — fine */ } };
  try {
    const u = new URL(location.href), q = u.searchParams;
    const tagged = { ref: q.get('ref'), src: q.get('src'), utm_source: q.get('utm_source'), utm_campaign: q.get('utm_campaign') };
    const ext = document.referrer && (() => { try { const r = new URL(document.referrer); return r.host !== location.host ? r.host : ''; } catch (e) { return ''; } })();
    if (Object.values(tagged).some(Boolean)) {
      // A tagged link always wins: it's the most recent thing they clicked or scanned.
      write(Object.assign({ at: Date.now(), referrer: ext || '' }, Object.fromEntries(Object.entries(tagged).filter(([, v]) => v).map(([k, v]) => [k, String(v).slice(0, 60)]))));
      ['ref', 'src', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'igshid'].forEach(k => q.delete(k));
      history.replaceState(null, '', u.pathname + (q.toString() ? '?' + q : '') + u.hash);
    } else if (ext && !read()) {
      write({ at: Date.now(), referrer: ext });
    }
  } catch (e) { /* never block the page */ }
  window.kkAttribution = () => { const a = read(); if (!a) return null; const { at, ...rest } = a; void at; return rest; };
})();
