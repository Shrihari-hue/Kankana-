'use strict';
/* Dependency-free PDF generator for Kankana quotations, tax invoices and receipts.
   Uses the PDF standard fonts (Helvetica / Times) with WinAnsi encoding. */
const fs = require('node:fs');
const path = require('node:path');
const P = require('../../assets/kankana-pricing.js');

const AFM = JSON.parse(fs.readFileSync(path.join(__dirname, 'afm.json'), 'utf8'));
const FONTS = { R: 'Helvetica', B: 'Helvetica-Bold', S: 'Times-Roman', I: 'Times-Italic' };
const LOGO = (() => { try { return fs.readFileSync(path.join(__dirname, 'logo-doc.jpg')); } catch (e) { return null; } })();

const INK = [0.149, 0.031, 0.055], GOLD = [0.722, 0.537, 0.290], MUTED = [0.42, 0.33, 0.35], LINE = [0.86, 0.82, 0.76], GREEN = [0.18, 0.42, 0.27];

/* ---------------- text encoding ---------------- */
const MAP = { '–': 0x96, '—': 0x97, '·': 0xb7, '×': 0xd7, '’': 0x92, '‘': 0x91, '“': 0x93, '”': 0x94, '•': 0x95, '©': 0xa9, ' ': 0x20 };
function enc(str) {
  const out = [];
  for (const ch of String(str).replace(/₹\s?/g, 'Rs. ')) {
    const c = ch.codePointAt(0);
    if (MAP[ch] != null) out.push(MAP[ch]);
    else if (c >= 32 && c < 127) out.push(c);
    else if (c >= 0xa0 && c <= 0xff) out.push(c);
    else out.push(63);
  }
  return out;
}
function pdfStr(bytes) {
  let s = '(';
  for (const b of bytes) {
    if (b === 40 || b === 41 || b === 92) s += '\\' + String.fromCharCode(b);
    else if (b < 32 || b > 126) s += '\\' + b.toString(8).padStart(3, '0');
    else s += String.fromCharCode(b);
  }
  return s + ')';
}
function width(str, font, size) {
  const w = AFM[FONTS[font]];
  return enc(str).reduce((s, b) => s + (w[b] || 500), 0) * size / 1000;
}
const rs = n => 'Rs. ' + Math.round(n || 0).toLocaleString('en-IN');

/* ---------------- document builder ---------------- */
class Doc {
  constructor() { this.pages = []; this.W = 595.28; this.H = 841.89; this.addPage(); }
  addPage() { this.cur = []; this.pages.push(this.cur); this.y = 60; }
  op(s) { this.cur.push(s); }
  color(c) { this.op(`${c[0]} ${c[1]} ${c[2]} rg ${c[0]} ${c[1]} ${c[2]} RG`); }
  text(str, x, y, { font = 'R', size = 10, color = INK, align = 'left', spacing = 0 } = {}) {
    let w = width(str, font, size) + spacing * Math.max(0, [...String(str)].length - 1);
    if (align === 'right') x -= w; else if (align === 'center') x -= w / 2;
    this.color(color);
    this.op(`BT /${font} ${size} Tf ${spacing ? spacing + ' Tc ' : ''}${x.toFixed(2)} ${(this.H - y).toFixed(2)} Td ${pdfStr(enc(str))} Tj ${spacing ? '0 Tc ' : ''}ET`);
    return w;
  }
  wrap(str, maxW, font, size) {
    const words = String(str).split(/\s+/); const lines = []; let line = '';
    words.forEach(wd => {
      const t = line ? line + ' ' + wd : wd;
      if (width(t, font, size) > maxW && line) { lines.push(line); line = wd; } else line = t;
    });
    if (line) lines.push(line);
    return lines;
  }
  line(x1, y1, x2, y2, c = LINE, w = 0.6) { this.color(c); this.op(`${w} w ${x1} ${this.H - y1} m ${x2} ${this.H - y2} l S`); }
  rect(x, y, w, h, fill, stroke) {
    if (fill) { this.color(fill); this.op(`${x} ${this.H - y - h} ${w} ${h} re f`); }
    if (stroke) { this.color(stroke); this.op(`0.8 w ${x} ${this.H - y - h} ${w} ${h} re S`); }
  }
  image(x, y, w, h) { if (LOGO) this.op(`q ${w} 0 0 ${h} ${x} ${this.H - y - h} cm /Logo Do Q`); }
  ensure(space, onNew) { if (this.y + space > this.H - 70) { this.addPage(); if (onNew) onNew(); } }

  build() {
    const objs = [];
    const add = s => { objs.push(s); return objs.length; };
    const catalogId = add(null), pagesId = add(null);
    const fontIds = {};
    Object.entries(FONTS).forEach(([k, name]) => { fontIds[k] = add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`); });
    let logoId = null;
    if (LOGO) {
      const { w, h } = jpegSize(LOGO);
      logoId = add({ dict: `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${LOGO.length} >>`, stream: LOGO });
    }
    const fontRes = Object.entries(fontIds).map(([k, id]) => `/${k} ${id} 0 R`).join(' ');
    const res = `<< /Font << ${fontRes} >>${logoId ? ` /XObject << /Logo ${logoId} 0 R >>` : ''} >>`;
    const pageIds = [];
    this.pages.forEach((ops, i) => {
      const content = Buffer.from(ops.join('\n') + (this.footer ? '\n' + this.footer(i + 1, this.pages.length) : ''), 'latin1');
      const cId = add({ dict: `<< /Length ${content.length} >>`, stream: content });
      pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.W} ${this.H}] /Resources ${res} /Contents ${cId} 0 R >>`));
    });
    objs[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objs[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map(i => i + ' 0 R').join(' ')}] /Count ${pageIds.length} >>`;
    const infoId = add(`<< /Producer (Kankana) /Title ${pdfStr(enc(this.title || 'Kankana'))} >>`);

    const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let offset = chunks[0].length; const xref = [];
    objs.forEach((o, i) => {
      xref.push(offset);
      let buf;
      if (typeof o === 'string') buf = Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
      else buf = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${o.dict}\nstream\n`, 'latin1'), o.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
      chunks.push(buf); offset += buf.length;
    });
    let x = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    xref.forEach(o => { x += String(o).padStart(10, '0') + ' 00000 n \n'; });
    x += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${offset}\n%%EOF`;
    chunks.push(Buffer.from(x, 'latin1'));
    return Buffer.concat(chunks);
  }
}

function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xc3) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return { w: 100, h: 100 };
}

/* ---------------- layouts ---------------- */
const L = 48, R = 547;
const fmtDate = s => s ? P.parseISO(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const fmtTs = t => fmtDate(tsISO(t));
const tsISO = t => { const d = new Date(t + (5.5 * 60) * 60000); return d.toISOString().slice(0, 10); };

function header(d, s, title, metaLines) {
  const C = s.company;
  d.rect(22, 22, 551.28, 797.89, null, [0.85, 0.74, 0.55]);
  d.image(L, 40, 50, 62);
  d.text('KANKANA', L + 64, 68, { font: 'S', size: 22, spacing: 5 });
  d.text('WEDDINGS & RESORTS', L + 65, 84, { font: 'R', size: 7, color: GOLD, spacing: 2.2 });
  let y = 52;
  [C.legalName || C.name, C.address, `${C.email} · ${C.phone}`, C.gstin ? `GSTIN ${C.gstin}` : ''].filter(Boolean).forEach(t => { d.text(t, R, y, { size: 8.5, color: MUTED, align: 'right' }); y += 12; });
  d.line(L, 112, R, 112, GOLD, 0.8);
  d.text(title, L, 148, { font: 'S', size: 20, spacing: 3.5 });
  y = 130; metaLines.forEach((t, i) => { d.text(t, R, y, { font: i === 0 ? 'B' : 'R', size: 9, align: 'right' }); y += 12.5; });
  d.y = Math.max(170, y + 8);
  d.footer = (n, total) => {
    const ops = [];
    const t = `Computer-generated document · ${C.name}${total > 1 ? ` · Page ${n} of ${total}` : ''}`;
    const w = width(t, 'R', 7.5);
    ops.push(`${MUTED.join(' ')} rg BT /R 7.5 Tf ${((595.28 - w) / 2).toFixed(2)} 36 Td ${pdfStr(enc(t))} Tj ET`);
    return ops.join('\n');
  };
}

function parties(d, b, venue, pkg) {
  const c = b.customer, y0 = d.y, ds = P.describe(b);
  d.text('BILLED TO', L, y0, { size: 7.5, color: GOLD, spacing: 1.6 });
  d.text(ds.label.toUpperCase(), 310, y0, { size: 7.5, color: GOLD, spacing: 1.6 });
  const left = [[c.name, 'B'], [c.email], [c.phone], [c.city], [c.gstin ? 'GSTIN ' + c.gstin : '']].filter(x => x[0]);
  const title = venue ? (ds.kind === 'event' && venue.region ? `${venue.name} · ${venue.region}` : venue.name) : (b.venueName || b.venueId);
  const right = [[title, 'B'], [ds.when], [[ds.people].concat(ds.extras).join(' · ')], [`Booking ref ${b.id}`]];
  let y = y0 + 16; left.forEach(([t, f]) => { d.text(t, L, y, { font: f || 'R', size: 9.5 }); y += 13; });
  let y2 = y0 + 16; right.forEach(([t, f]) => d.wrap(t, R - 310, f === 'B' ? 'B' : 'R', 9.5).forEach(line => { d.text(line, 310, y2, { font: f || 'R', size: 9.5 }); y2 += 13; }));
  d.y = Math.max(y, y2) + 14;
}

function itemsTable(d, q) {
  const cols = { n: L + 4, desc: L + 24, qty: 390, rate: 462, amt: R - 4 };
  const head = () => {
    d.rect(L, d.y - 11, R - L, 18, [0.975, 0.95, 0.9]);
    [['#', cols.n, 'left'], ['DESCRIPTION', cols.desc, 'left'], ['QTY', cols.qty, 'right'], ['RATE', cols.rate, 'right'], ['AMOUNT', cols.amt, 'right']]
      .forEach(([t, x, a]) => d.text(t, x, d.y + 1, { size: 7, color: MUTED, align: a, spacing: 1.2 }));
    d.y += 18;
  };
  head();
  q.lines.forEach((l, i) => {
    const lines = d.wrap(l.desc, cols.qty - cols.desc - 60, 'R', 9);
    const h = lines.length * 12 + 8;
    d.ensure(h, head);
    lines.forEach((t, j) => d.text(t, cols.desc, d.y + 4 + j * 12, { size: 9 }));
    d.text(String(i + 1), cols.n, d.y + 4, { size: 9, color: MUTED });
    d.text(`${l.qty.toLocaleString('en-IN')} ${l.unit}`, cols.qty, d.y + 4, { size: 8.5, align: 'right', color: MUTED });
    d.text(rs(l.rate), cols.rate, d.y + 4, { size: 9, align: 'right' });
    d.text(rs(l.amount), cols.amt, d.y + 4, { size: 9, align: 'right' });
    d.y += h;
    d.line(L, d.y - 4, R, d.y - 4);
  });
  d.y += 8;
}

function totals(d, rows) {
  const x1 = 330, x2 = R - 4;
  d.ensure(rows.length * 18 + 20);
  rows.forEach(r => {
    if (r.rule) { d.line(x1 - 6, d.y - 3, R, d.y - 3, INK, 0.8); d.y += 16; }
    if (r.band) {
      d.rect(x1 - 6, d.y - 12, R - x1 + 6, 22, INK);
      d.text(r.label, x1, d.y + 3, { size: 10, color: [0.96, 0.93, 0.85] });
      d.text(r.value, x2, d.y + 3, { size: 10, font: 'B', color: [0.96, 0.93, 0.85], align: 'right' });
      d.y += 26; return;
    }
    d.text(r.label, x1, d.y, { size: r.big ? 11.5 : 9.5, font: r.big ? 'B' : 'R' });
    d.text(r.value, x2, d.y, { size: r.big ? 11.5 : 9.5, font: r.big ? 'B' : 'R', align: 'right' });
    d.y += r.big ? 20 : 16;
  });
  d.y += 6;
}

/** GST rows: one line per rate; split into CGST + SGST unless the client is in another state. */
function gstRows(q, interState, split) {
  const groups = q.gstBreakdown && q.gstBreakdown.length ? q.gstBreakdown : [{ pct: q.gstPct, taxable: q.subtotal, gst: q.gst }];
  const many = groups.length > 1, rows = [];
  groups.forEach(g => {
    const on = many ? ` on ${rs(g.taxable)}` : '';
    if (!split) rows.push({ label: `GST @ ${g.pct}%${on}`, value: rs(g.gst) });
    else if (interState) rows.push({ label: `IGST @ ${g.pct}%${on}`, value: rs(g.gst) });
    else rows.push({ label: `CGST @ ${g.pct / 2}%${on}`, value: rs(g.gst / 2) }, { label: `SGST @ ${g.pct / 2}%${on}`, value: rs(g.gst - Math.round(g.gst / 2)) });
  });
  return rows;
}
const balanceText = (b, s) => P.kindOf(b) === 'stay' ? `Due at check-in on ${fmtDate(b.startDate)}.` : P.kindOf(b) === 'slot' ? 'Due before your reservation.' : `Due by ${fmtDate(P.addDays(b.startDate, -(s.balanceDueDaysBefore || 30)))}.`;

function section(d, title, lines, x, w) {
  d.text(title.toUpperCase(), x, d.y, { size: 7.5, color: GOLD, spacing: 1.6 });
  let y = d.y + 14;
  lines.forEach(t => d.wrap(t, w, 'R', 8.5).forEach(s => { d.text(s, x, y, { size: 8.5, color: MUTED }); y += 11.5; }));
  return y;
}

function signature(d, s) {
  d.ensure(60);
  d.y = Math.max(d.y + 20, d.y);
  d.text(s.company.legalName || 'Kankana', R, d.y + 10, { font: 'I', size: 15, color: GOLD, align: 'right' });
  d.text('Authorised signatory', R, d.y + 24, { size: 8, align: 'right', color: MUTED });
  d.y += 36;
}

function stamp(d, text, x, y) {
  const w = width(text, 'B', 11) + text.length * 2 + 20;
  d.rect(x, y - 14, w, 22, null, GREEN);
  d.text(text, x + 10, y + 1, { font: 'B', size: 11, color: GREEN, spacing: 2 });
}

function quotation(b, ctx) {
  const d = new Doc(); const s = ctx.settings; const q = b.quote;
  d.title = `Quotation ${b.quoteNo}`;
  header(d, s, 'QUOTATION', [b.quoteNo, `Date ${fmtTs(b.createdAt)}`, `Valid until ${fmtTs(b.createdAt + 7 * 86400000)}`]);
  parties(d, b, ctx.venue, ctx.pkg);
  itemsTable(d, q);
  const rows = [];
  if (q.discount) rows.push({ label: 'Gross', value: rs(q.gross) }, { label: 'Discount', value: '- ' + rs(q.discount) });
  rows.push({ label: 'Taxable value', value: rs(q.subtotal) }, ...gstRows(q, false, false),
    { rule: true, label: 'Total', value: rs(q.total), big: true }, { band: true, label: q.advance >= q.total ? 'Payable to confirm' : `Advance to confirm (${q.advancePct}%)`, value: rs(q.advance) });
  totals(d, rows);
  d.ensure(120);
  const terms = P.kindOf(b) === 'stay' ? s.stayTerms : P.kindOf(b) === 'slot' ? s.slotTerms : s.terms;
  const y1 = section(d, 'Terms', (terms || []).map((t, i) => `${i + 1}. ${t}`), L, 270);
  const y2 = section(d, 'How to pay', [`Pay securely online (UPI, cards, netbanking) at ${ctx.siteUrl}/my-booking.html using booking ID ${b.id}.`].concat(b.notes ? ['', 'Notes: ' + b.notes] : []), 340, R - 340);
  d.y = Math.max(y1, y2) + 6;
  signature(d, s);
  return d.build();
}

function invoice(b, ctx) {
  const d = new Doc(); const s = ctx.settings; const q = b.quote;
  const paid = b.payments.reduce((t, p) => t + p.amount, 0), due = Math.max(0, q.total - paid);
  const first = b.payments[0];
  d.title = `Tax Invoice ${b.invoiceNo}`;
  header(d, s, 'TAX INVOICE', [b.invoiceNo, `Date ${fmtTs(first ? first.at : Date.now())}`, `Against quotation ${b.quoteNo}`, `SAC ${(ctx.venue && ctx.venue.sac) || s.company.sac || '998596'} · Place of supply: ${b.customer.state || s.company.state || 'Karnataka'}`]);
  parties(d, b, ctx.venue, ctx.pkg);
  itemsTable(d, q);
  const interState = b.customer.state && s.company.state && b.customer.state.toLowerCase() !== s.company.state.toLowerCase();
  const rows = [];
  if (q.discount) rows.push({ label: 'Gross', value: rs(q.gross) }, { label: 'Discount', value: '- ' + rs(q.discount) });
  rows.push({ label: 'Taxable value', value: rs(q.subtotal) });
  rows.push(...gstRows(q, interState, true));
  rows.push({ rule: true, label: 'Invoice total', value: rs(q.total), big: true }, { label: 'Amount received', value: rs(paid) }, { band: true, label: 'Balance due', value: rs(due) });
  totals(d, rows);
  d.ensure(90);
  const y0 = d.y;
  const y1 = section(d, 'Payments received', b.payments.map(p => `${fmtTs(p.at)} · ${rs(p.amount)} · ${p.method} · ${p.receiptNo}`), L, 270);
  d.y = y0;
  let y2;
  if (due === 0) { stamp(d, 'PAID IN FULL', 360, y0 + 16); y2 = y0 + 30; }
  else y2 = section(d, 'Balance', [`${balanceText(b, s)} Pay online at ${ctx.siteUrl}/my-booking.html.`], 340, R - 340);
  d.y = Math.max(y1, y2) + 6;
  signature(d, s);
  return d.build();
}

function receipt(b, pay, ctx) {
  const d = new Doc(); const s = ctx.settings;
  const paid = b.payments.reduce((t, p) => t + p.amount, 0), due = Math.max(0, b.quote.total - paid);
  d.title = `Receipt ${pay.receiptNo}`;
  header(d, s, 'PAYMENT RECEIPT', [pay.receiptNo, new Date(pay.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })]);
  d.y += 10;
  d.text('AMOUNT RECEIVED', 297.64, d.y, { size: 8, color: GOLD, align: 'center', spacing: 2 });
  d.text(rs(pay.amount), 297.64, d.y + 36, { font: 'S', size: 34, align: 'center' });
  stamp(d, 'RECEIVED', 250, d.y + 70);
  d.y += 110;
  const ds = P.describe(b);
  const rows = [
    ['Received from', b.customer.name],
    ['Towards', `${pay.type === 'balance' ? 'Balance' : pay.amount >= b.quote.total ? 'Full' : 'Advance'} payment for booking ${b.id} — ${b.venueName || (ctx.venue ? ctx.venue.name : '')}, ${ds.when}`],
    ['Method', pay.method], ['Transaction ref', pay.ref || '—'], ['Tax invoice', b.invoiceNo || '—'],
    ['Booking total', rs(b.quote.total)], ['Paid to date', rs(paid)], ['Balance due', rs(due)]
  ];
  d.rect(L, d.y - 14, R - L, rows.length * 22 + 26, null, LINE);
  d.y += 4;
  rows.forEach(([k, v]) => {
    d.text(k.toUpperCase(), L + 18, d.y, { size: 7.5, color: MUTED, spacing: 1 });
    const lines = d.wrap(v, R - 190, 'R', 10);
    lines.forEach((t, i) => d.text(t, 170, d.y + i * 12, { size: 10, font: k === 'Balance due' ? 'B' : 'R' }));
    d.y += 10 + lines.length * 12;
  });
  d.y += 26;
  d.text(`Thank you for choosing Kankana${P.kindOf(b) === 'event' ? ' for your celebration' : ''}. Please keep this receipt for your records.`, L, d.y, { size: 9, color: MUTED });
  d.y += 20;
  signature(d, s);
  return d.build();
}

module.exports = { quotation, invoice, receipt };
