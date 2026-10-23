'use strict';
/* =========================================================================
   Lead emails → CRM fields.
   Wedding listing sites (WedMeGood, WeddingWire, JustDial…) don't offer an
   API, but they email every new enquiry. This reads those emails — raw MIME
   from the mailbox, or text pasted by the team — and pulls out the name,
   phone, email, date, guests, budget, city, event type and message.
   Pure functions, no I/O: parseMime(raw), parseLeadEmail({from,subject,text,html}).
   ========================================================================= */

const PLATFORMS = [
  { name: 'WedMeGood', re: /wedmegood/i, wedding: true },
  { name: 'WeddingWire', re: /weddingwire/i, wedding: true },
  { name: 'Weddingz', re: /weddingz/i, wedding: true },
  { name: 'WeddingBazaar', re: /weddingbazaar/i, wedding: true },
  { name: 'ShaadiSaga', re: /shaadisaga/i, wedding: true },
  { name: 'VenueLook', re: /venuelook/i, wedding: true },
  { name: 'VenueMonk', re: /venuemonk/i, wedding: true },
  { name: 'JustDial', re: /justdial/i },
  { name: 'Sulekha', re: /sulekha/i },
  { name: 'IndiaMART', re: /indiamart/i }
];

/* ---------------------------------------------------------------- MIME */
function decodeQP(str) {
  const s = str.replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) { out.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
    else out.push(s.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}
function decodeCharset(buf, charset) {
  const cs = String(charset || 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  try { return new TextDecoder(cs === 'us-ascii' ? 'utf-8' : cs).decode(buf); } catch (e) { return buf.toString('utf8'); }
}
/** RFC 2047 encoded words in headers: =?UTF-8?B?…?= / =?utf-8?Q?…?= */
function decodeWords(v) {
  return String(v || '').replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, cs, enc, txt) => {
      try {
        const buf = enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64') : decodeQP(txt.replace(/_/g, ' '));
        return decodeCharset(buf, cs);
      } catch (e) { return m; }
    });
}
function splitHead(str) {
  const m = str.match(/\r?\n\r?\n/);
  if (!m) return { head: str, body: '' };
  return { head: str.slice(0, m.index), body: str.slice(m.index + m[0].length) };
}
function headers(head) {
  const h = {};
  head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).forEach(line => {
    const i = line.indexOf(':'); if (i <= 0) return;
    const k = line.slice(0, i).trim().toLowerCase();
    if (h[k] === undefined) h[k] = line.slice(i + 1).trim();
  });
  return h;
}
function param(v, name) {
  const m = String(v || '').match(new RegExp(`(?:^|;)\\s*${name}\\*?=\\s*(?:"([^"]*)"|([^;\\s]*))`, 'i'));
  return m ? (m[1] !== undefined ? m[1] : m[2]) : '';
}
/** One MIME entity (as a latin1 "binary" string) → { text, html } found inside it. */
function walk(entity, out, depth = 0) {
  if (depth > 8) return;
  const { head, body } = splitHead(entity);
  const h = headers(head);
  const ct = (h['content-type'] || 'text/plain').toLowerCase();
  const disp = (h['content-disposition'] || '').toLowerCase();
  if (ct.startsWith('multipart/')) {
    const b = param(h['content-type'], 'boundary'); if (!b) return;
    const parts = body.split(new RegExp(`\\r?\\n?--${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*(?:\\r?\\n|$)`));
    parts.slice(1).forEach(p => { if (p.trim()) walk(p, out, depth + 1); });
    return;
  }
  if (ct.startsWith('message/rfc822')) { walk(body, out, depth + 1); return; }
  if (disp.startsWith('attachment')) return;
  const te = (h['content-transfer-encoding'] || '').toLowerCase();
  let buf;
  if (te === 'base64') buf = Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  else if (te === 'quoted-printable') buf = decodeQP(body);
  else buf = Buffer.from(body, 'latin1');
  const txt = decodeCharset(buf, param(h['content-type'], 'charset') || 'utf-8');
  if (ct.startsWith('text/html') && !out.html) out.html = txt;
  else if (ct.startsWith('text/plain') && !out.text) out.text = txt;
}
/** Raw RFC 822 message (Buffer or string) → { from, to, subject, date, messageId, text, html }. */
function parseMime(raw) {
  const str = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw || '');
  const { head } = splitHead(str);
  const h = headers(head);
  const out = { text: '', html: '' };
  walk(str, out);
  // Headers are normally 7-bit with encoded words; some senders put raw UTF-8 bytes in them.
  const hv = v => decodeWords(/[\x80-\xff]/.test(v || '') ? Buffer.from(v, 'latin1').toString('utf8') : (v || ''));
  return {
    from: hv(h.from), to: hv(h.to), subject: hv(h.subject), date: h.date || '',
    messageId: (h['message-id'] || '').replace(/[<>\s]/g, '').slice(0, 300), text: out.text, html: out.html
  };
}

/* ---------------------------------------------------------------- HTML → lines */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', bull: '•', middot: '·', rupee: '₹' };
function entities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1); try { return String.fromCodePoint(n); } catch (x) { return ' '; } }
    return ENT[e.toLowerCase()] !== undefined ? ENT[e.toLowerCase()] : m;
  });
}
function htmlToText(html) {
  return entities(String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section|article|header|footer|blockquote)>/gi, '\n')
    .replace(/<(p|div|tr|li|h[1-6]|table)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[  ​‌‍﻿]+/g, ' ');
}

/* ---------------------------------------------------------------- field labels */
const PREFIX = /^(?:approx\.?|approximately|approximate|expected|estimated|preferred|tentative|total|your|the|client'?s?|customer'?s?)\s+/i;
const LABELS = [
  ['name', /^(?:(?:customer|client|lead|contact|guest|bride|groom|full|first|couple'?s?|person)\s*)?name(?:\s+of\s+(?:the\s+)?(?:client|customer|person|couple))?$|^contact\s*person$|^(?:enquired|inquired|requested|sent)\s+by$|^lead\s+from$|^enquiry\s+from$/i],
  ['phone', /^(?:(?:customer|client|contact|guest|alternate|alt\.?|primary)\s*)?(?:phone|mobile|cell|whatsapp|contact|tel(?:ephone)?)(?:\s*(?:no\.?|number|num|#|details))?$|^(?:mobile|phone)\s*\/\s*whatsapp$/i],
  ['email', /^(?:customer\s*|client\s*|contact\s*)?(?:e-?mail|mail)(?:\s*(?:id|address))?$/i],
  ['eventDate', /^(?:(?:event|wedding|function|marriage|party|booking|occasion)\s*)?dates?(?:\s+of\s+(?:the\s+)?(?:event|wedding|function|marriage))?$|^when$|^(?:event|wedding)\s+on$/i],
  ['guests', /^(?:(?:no\.?|number|count)\s*(?:of\s*)?)?(?:guests?|pax|people|persons|attendees|gatherings?)(?:\s*count)?$|^(?:guest|head)\s*count$|^headcount$/i],
  ['budget', /^budget(?:\s*(?:range|\(.*\)|per\s*(?:plate|head|person)|in\s*(?:rs|inr|₹)\.?))?$|^price\s*range$/i],
  ['city', /^(?:city|location|event\s*(?:city|location)|venue\s*(?:city|location)|area|locality|place)$/i],
  ['eventType', /^(?:(?:event|function|occasion)\s*type|type\s*of\s*(?:event|function|occasion)|event|function|occasion|category|service(?:\s*required)?)$/i],
  ['message', /^(?:message|requirements?|details|comments?|notes?|query|queries|enquiry|inquiry|additional\s*(?:info|information|details|requirements|comments)|description|special\s*requests?|remarks)$/i]
];
const labelOf = raw => {
  const l = raw.replace(/[*•▪►\-–:：|]+$/g, '').replace(/^[*•▪►\-–|]+/, '').trim().replace(PREFIX, '').replace(PREFIX, '').trim();
  if (!l || l.length > 36 || /\d/.test(l)) return null;
  const hit = LABELS.find(([, re]) => re.test(l));
  return hit ? hit[0] : null;
};
const FOOTER = /unsubscribe|^reply to .{1,60}\b(?:from|on|via|in) (?:your|the) .{0,40}(?:account|app|dashboard)|^(?:log ?in|sign ?in) to (?:your|the|view|see|reply)|^(?:click|tap) here|^view (?:the )?(?:full |complete )?(?:lead|enquiry|inquiry|details|contact)|^respond (?:now|quickly|to)|download (?:the|our) app|privacy policy|terms (?:of use|and conditions|&)|©|copyright|all rights reserved|this email was sent|you(?:'| a)re receiving this|manage (?:your )?(?:email )?preferences|follow us on|^regards\b|^thanks?(?: you)?,?$|^team\s+\w+$/i;
const HELPLINE = /helpline|customer care|support|toll[- ]free|call us|reach us|our team|contact us|for any (?:help|queries)|vendor (?:manager|team)|account manager/i;

/* ---------------------------------------------------------------- value parsers */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const pad = n => String(n).padStart(2, '0');
const monIdx = s => MONTHS.indexOf(s.slice(0, 3).toLowerCase());
function validDay(y, m, d) { const dt = new Date(Date.UTC(y, m, d)); return dt.getUTCFullYear() === y && dt.getUTCMonth() === m && dt.getUTCDate() === d; }
function fullYear(y) { y = +y; return y < 100 ? 2000 + y : y; }
/** "14th Feb 2027", "14/02/2027", "Feb 14", "2027-02-14", "February 2027" → "2027-02-14" / "Feb 2027". */
function parseDate(v, now = new Date()) {
  const s = String(v || '').trim(); if (!s) return '';
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const iso = (y, m, d) => validDay(y, m, d) ? `${y}-${pad(m + 1)}-${pad(d)}` : '';
  const future = (m, d) => { let y = today.getUTCFullYear(); if (Date.UTC(y, m, d) < today.getTime()) y++; return iso(y, m, d); };
  let m;
  if ((m = s.match(/\b(20\d\d)-(\d{1,2})-(\d{1,2})\b/))) return iso(+m[1], +m[2] - 1, +m[3]) || s;
  if ((m = s.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b/))) return iso(fullYear(m[3]), +m[2] - 1, +m[1]) || s;
  const ord = '(?:st|nd|rd|th)?';
  if ((m = s.match(new RegExp(`\\b(\\d{1,2})${ord}(?:\\s*(?:-|–|to|&|and)\\s*\\d{1,2}${ord})?\\s*(?:of\\s+)?${MON_RE}\\.?,?\\s*(\\d{4}|'\\d\\d)?`, 'i')))) {
    const mi = monIdx(m[2]); return m[3] ? iso(fullYear(m[3].replace("'", '')), mi, +m[1]) || s : future(mi, +m[1]) || s;
  }
  if ((m = s.match(new RegExp(`\\b${MON_RE}\\.?\\s+(\\d{1,2})${ord}(?:\\s*(?:-|–|to|&)\\s*\\d{1,2}${ord})?,?\\s*(\\d{4})?\\b`, 'i')))) {
    const mi = monIdx(m[1]); return m[3] ? iso(+m[3], mi, +m[2]) || s : future(mi, +m[2]) || s;
  }
  if ((m = s.match(new RegExp(`\\b${MON_RE}\\.?,?\\s*(\\d{4})\\b`, 'i')))) return `${MONTHS[monIdx(m[1])][0].toUpperCase()}${MONTHS[monIdx(m[1])].slice(1)} ${m[2]}`;
  return s.slice(0, 40);
}
function parseGuests(v) {
  const nums = (String(v || '').replace(/,/g, '').match(/\d+/g) || []).map(Number).filter(n => n > 0 && n <= 20000);
  return nums.length ? Math.max(...nums) : null;
}
/** "₹10–15 lakh", "Rs 8,00,000", "1.5 Cr", "25k" → rupees (upper end of a range). Per-plate prices aren't a budget. */
function parseBudget(v) {
  const s = String(v || '');
  if (/per\s*(?:plate|head|person|pax)|\/\s*(?:plate|head|pax)|\bpp\b/i.test(s)) return { amount: null, perPlate: true };
  const re = /(\d+(?:,\d+)*(?:\.\d+)?)\s*(lakhs?|lacs?|lac|l\b|crores?|cr\b|k\b|thousand)?/gi;
  const found = []; let m;
  while ((m = re.exec(s))) found.push({ n: parseFloat(m[1].replace(/,/g, '')), u: (m[2] || '').toLowerCase() });
  if (!found.length) return { amount: null };
  const lastU = [...found].reverse().find(f => f.u);
  const mult = u => /^l/.test(u) ? 1e5 : /^c/.test(u) ? 1e7 : /^(k|t)/.test(u) ? 1e3 : 1;
  const vals = found.map(f => f.n * mult(f.u || (lastU && f.n < 1000 ? lastU.u : '')));
  const amt = Math.round(Math.max(...vals));
  return { amount: amt >= 1000 ? amt : null };
}
const MASK = /\d[\dxX*•\s-]{4,}[xX*•]{2,}|[xX*•]{3,}\d{2,}/;
function parsePhone(v) {
  const s = String(v || '');
  if (MASK.test(s) && !/[6-9]\d{9}/.test(s.replace(/\D/g, ''))) return { masked: true };
  const m = s.match(/(\+?\d[\d\s().-]{7,18}\d)/); if (!m) return {};
  let d = m[1].replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10 && /^[6-9]/.test(d)) return { phone: `+91 ${d.slice(0, 5)} ${d.slice(5)}` };
  if (d.length >= 8 && d.length <= 15) return { phone: (m[1].trim().startsWith('+') ? '+' : '') + d };
  return {};
}
const EMAIL_G = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
function eventTypeOf(v, types) {
  const s = String(v || '').toLowerCase(); if (!s) return '';
  const want = [
    [/reception/, 'Reception'], [/wedding|marriage|shaadi|vivah|pheras?|nikah/, 'Wedding'], [/engage|ring ceremony|roka|sagai|tilak/, 'Engagement'],
    [/mehe?ndi|sangeet|haldi|cocktail/, 'Mehndi / Sangeet'], [/birthday|anniversary|party|get[- ]together|kitty/, 'Birthday / Party'],
    [/corporate|conference|off-?site|meeting|seminar|launch/, 'Corporate'], [/stay|room|villa|night/, 'Stay']
  ].find(([re]) => re.test(s));
  if (!want) return '';
  const hit = (types || []).find(t => t.toLowerCase() === want[1].toLowerCase());
  return hit || want[1];
}
const cleanName = n => {
  const s = String(n || '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().replace(/[,.;:|-]+$/, '').trim();
  if (!s || s.length < 2 || s.length > 60 || /@|\d{3,}|https?:/i.test(s)) return '';
  if (/^(?:kankana|team|customer|client|user|guest|vendor|admin|sir|madam|there|hi|hello|dear)\b/i.test(s)) return '';
  if (PLATFORMS.some(p => p.re.test(s))) return '';
  return s;
};

/* ---------------------------------------------------------------- the reader */
/**
 * @param {{from?:string, subject?:string, text?:string, html?:string}} mail
 * @param {{ownEmails?:string[], eventTypes?:string[], now?:Date}} opt
 * @returns {{status:'ok'|'hidden'|'not_lead', platform:string, source:string, fields:object, found:string[], notes:string[]}}
 */
function parseLeadEmail(mail, opt = {}) {
  const from = String(mail.from || ''), subject = String(mail.subject || '').trim();
  const text = (mail.text && mail.text.trim()) ? String(mail.text) : htmlToText(mail.html || '');
  const bodyForHtml = mail.html ? htmlToText(mail.html) : '';
  // Prefer whichever version has more labelled lines (some senders put a stub in text/plain).
  const pick = [text, bodyForHtml].filter(Boolean).map(t => ({ t, n: t.split(/\r?\n/).filter(l => /[:\t]/.test(l) && labelOf(l.split(/[:\t]/)[0])).length }))
    .sort((a, b) => b.n - a.n)[0];
  const body = pick ? pick.t : '';
  const platform = PLATFORMS.find(p => p.re.test(from)) || PLATFORMS.find(p => p.re.test(subject)) || PLATFORMS.find(p => p.re.test(body.slice(0, 4000)));
  const own = (opt.ownEmails || []).map(e => String(e).toLowerCase());

  // Lines, cut at the footer.
  let lines = body.split(/\r?\n/).map(l => l.replace(/[ \u00a0\f\v]+/g, ' ').replace(/\s*\t[\s\t]*/g, '\t').replace(/^[\s>]+/, '').replace(/\t+$/, '').trim());
  // Drop the header block of a hand-forwarded email ("From: … Date: … Subject: … To: …").
  lines = lines.filter((l, i) => !(/^(?:from|to|cc|bcc|subject|sent|date|reply-to):\s/i.test(l) && lines.slice(Math.max(0, i - 6), i).some(x => /forwarded message|original message|^from:\s/i.test(x))));
  const fi = lines.findIndex((l, i) => i > 3 && FOOTER.test(l));
  if (fi > 0) lines = lines.slice(0, fi);
  lines = lines.filter(Boolean);

  const f = {}, notes = [];
  const set = (k, v) => { if (v !== undefined && v !== null && v !== '' && (f[k] === undefined || f[k] === '')) f[k] = v; };
  let masked = false;

  const apply = (key, val, idx, label = '') => {
    if (!val) return;
    if (key === 'eventDate' && /\d{1,2}:\d{2}/.test(val)) return;   // an email timestamp, not the event
    if (key === 'name') set('name', cleanName(val));
    else if (key === 'phone') { const p = parsePhone(val); if (p.masked) masked = true; set('phone', p.phone); }
    else if (key === 'email') { const e = (val.match(EMAIL_G) || [])[0]; if (e && !own.includes(e.toLowerCase())) set('email', e.toLowerCase()); }
    else if (key === 'eventDate') set('eventDate', parseDate(val, opt.now));
    else if (key === 'guests') set('guests', parseGuests(val));
    else if (key === 'budget') { const b = parseBudget(/per\s*(?:plate|head|person)/i.test(label) ? val + ' per plate' : val); if (b.amount) set('budget', b.amount); else if (b.perPlate) notes.push(`Budget: ${val}${/plate|head|person/i.test(val) ? '' : ' per plate'}`); }
    else if (key === 'city') set('city', val.slice(0, 80));
    else if (key === 'eventType') set('eventType', eventTypeOf(val, opt.eventTypes) || val.slice(0, 40));
    else if (key === 'message') {
      const more = [];
      for (let j = idx + 1; j < lines.length && more.length < 6; j++) { const l = lines[j]; const lab = l.match(/^([^:\t]{1,40})[:\t]/); if (lab && labelOf(lab[1])) break; more.push(l); }
      set('message', [val, ...more].join('\n').slice(0, 1500));
    }
  };

  lines.forEach((l, i) => {
    // "Label: value" / "Label - value" / "Label<TAB>value" / "Label | value"
    const m = l.match(/^([^:\t|]{1,40}?)\s*(?::|：|\t|\s\|\s|\s[-–]\s)\s*(.*)$/);
    if (m) {
      const key = labelOf(m[1]);
      if (key) { const val = m[2].replace(/^\s*[:|\t-]\s*/, '').replace(/\t/g, ' ').trim(); if (val) return apply(key, val, i, m[1]); const nx = lines[i + 1]; if (nx && !labelOf(nx.replace(/[:：]$/, ''))) return apply(key, nx, i + 1, m[1]); return; }
    }
    // "Label" alone on a line, value on the next one.
    const key = labelOf(l);
    if (key && lines[i + 1] && !labelOf(lines[i + 1].replace(/[:：]$/, ''))) apply(key, lines[i + 1], i + 1, l);
  });

  // Fallbacks when the email isn't laid out as labels.
  const hay = lines.join('\n');
  if (!f.name) {
    const pats = [
      /(?:enquiry|inquiry|lead|request|message|query|response)\b[^\n]{0,40}?\s(?:from|by)\s+([A-Za-z][\w.'’-]*(?:\s+[A-Za-z][\w.'’-]*){0,3}?)(?=\s+(?:for|on|at|regarding|about|via|has|is|wants|-|–|\||,)|[!.,|:]|$)/im,
      /^([A-Z][\w.'’-]*(?:\s+[A-Z][\w.'’-]*){0,3})\s+(?:has\s+)?(?:sent|shared|submitted|enquired|inquired|is\s+interested|showed\s+interest|wants|requested|contacted|viewed\s+your\s+(?:number|contact))/m
    ];
    for (const re of pats) { const mm = subject.match(re) || hay.match(re); if (mm && cleanName(mm[1])) { f.name = cleanName(mm[1]); break; } }
  }
  if (!f.phone && !masked) {
    for (const l of lines) { if (HELPLINE.test(l)) continue; const p = parsePhone((l.match(/(?:\+?91[\s-]?|0)?[6-9]\d{2}[\s-]?\d{3}[\s-]?\d{4}\b|(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}\b/) || [])[0]); if (p.phone) { f.phone = p.phone; break; } }
    if (!f.phone && MASK.test(hay)) masked = true;
  }
  if (!f.email) {
    const plat = platform ? platform.name.toLowerCase() : '##';
    const all = (hay.match(EMAIL_G) || []).map(e => e.toLowerCase())
      .filter(e => !own.includes(e) && !e.includes(plat) && !/no-?reply|donotreply|notifications?@|alerts?@|mailer|bounce|support@|help@|info@|hello@kankana/i.test(e));
    if (all[0]) f.email = all[0];
  }
  if (!f.eventType) {
    const t = eventTypeOf((subject + ' ' + (f.message || '') + ' ' + hay.slice(0, 1500)).replace(/kankana\s*[-—–·]?\s*(?:weddings?\s*(?:&|and)\s*resorts?)?/gi, ' '), opt.eventTypes) || (platform && platform.wedding ? eventTypeOf('wedding', opt.eventTypes) : '');
    if (t) f.eventType = t;
  }
  if (!f.eventDate) { const mm = (subject + '\n' + hay).match(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MON_RE}\\.?,?\\s*\\d{4}\\b|\\b${MON_RE}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s*\\d{4}\\b`, 'i')); if (mm) f.eventDate = parseDate(mm[0], opt.now); }

  const extra = [...notes];
  if (platform || subject) extra.push(`From ${platform ? 'a ' + platform.name + ' email' : 'an email'}${subject ? ': “' + subject.slice(0, 140) + '”' : ''}`);
  f.message = [f.message, extra.join('\n')].filter(Boolean).join('\n\n').slice(0, 2000);

  const found = ['name', 'phone', 'email', 'eventDate', 'guests', 'budget', 'city', 'eventType'].filter(k => f[k]);
  const status = (f.phone || f.email) ? 'ok' : (masked && f.name ? 'hidden' : (masked ? 'hidden' : 'not_lead'));
  return { status, platform: platform ? platform.name : '', source: platform ? platform.name : 'Email', fields: f, found, masked };
}

module.exports = { parseMime, parseLeadEmail, htmlToText, parseDate, parseBudget, parseGuests, parsePhone, PLATFORMS };
