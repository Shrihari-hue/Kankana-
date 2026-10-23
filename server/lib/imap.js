'use strict';
/* =========================================================================
   Minimal IMAP client (zero dependencies) — just enough to read new emails
   from one Gmail label: LOGIN, SELECT, UID SEARCH, UID FETCH BODY.PEEK[], LOGOUT.
   Messages are never marked read, moved or deleted.
   ========================================================================= */
const tls = require('node:tls');

class ImapError extends Error { constructor(msg, code) { super(msg); this.code = code; } }

const q = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const imapDate = d => `${d.getUTCDate()}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()}`;

/** Splits the incoming byte stream into complete IMAP responses, honouring {n} literals. */
function takeResponses(buf) {
  const items = []; let pos = 0;
  for (;;) {
    const start = pos, parts = [], lits = []; let done = false;
    for (;;) {
      const idx = buf.indexOf('\r\n', pos);
      if (idx < 0) break;
      const line = buf.toString('latin1', pos, idx);
      const m = line.match(/\{(\d+)\}$/);
      if (m) {
        const n = +m[1];
        if (idx + 2 + n > buf.length) break;
        parts.push(line); lits.push(buf.subarray(idx + 2, idx + 2 + n)); pos = idx + 2 + n; continue;
      }
      parts.push(line); pos = idx + 2; done = true; break;
    }
    if (!done) return { items, rest: buf.subarray(start) };
    items.push({ text: parts.join(' '), lits });
  }
}

function connect({ host, port = 993, timeout = 25000 }) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, servername: host });
    let buf = Buffer.alloc(0), waiter = null, pending = [], closed = null;
    const t = setTimeout(() => { sock.destroy(new ImapError('The mail server took too long to answer.', 'timeout')); }, timeout);
    const flush = () => {
      const { items, rest } = takeResponses(buf); buf = Buffer.from(rest);
      pending.push(...items);
      if (waiter) waiter();
    };
    sock.on('data', d => { buf = Buffer.concat([buf, d]); flush(); });
    sock.on('error', e => { closed = e; if (waiter) waiter(); });
    sock.on('close', () => { clearTimeout(t); closed = closed || new ImapError('The mail server closed the connection.', 'closed'); if (waiter) waiter(); });
    let n = 0;
    const next = () => new Promise((res, rej) => {
      const go = () => { if (pending.length) { waiter = null; return res(pending.shift()); } if (closed) { waiter = null; return rej(closed); } waiter = go; };
      go();
    });
    async function cmd(text) {
      const tag = 'K' + (++n);
      sock.write(`${tag} ${text}\r\n`);
      const untagged = [];
      for (;;) {
        const r = await next();
        if (r.text.startsWith(tag + ' ')) {
          const ok = /^\S+ OK/i.test(r.text);
          if (!ok) throw new ImapError(r.text.slice(tag.length + 1), /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|authentication failed/i.test(r.text) ? 'auth' : /NONEXISTENT|Unknown Mailbox|doesn't exist|not exist/i.test(r.text) ? 'folder' : 'no');
          return { untagged, status: r.text };
        }
        untagged.push(r);
      }
    }
    sock.once('secureConnect', async () => {
      try {
        const g = await next();
        if (!/^\* (OK|PREAUTH)/i.test(g.text)) throw new ImapError('Unexpected greeting from the mail server.', 'greeting');
        resolve({ cmd, close: () => { try { sock.write('Z LOGOUT\r\n'); } catch (e) { /* ignore */ } setTimeout(() => sock.destroy(), 300); clearTimeout(t); } });
      } catch (e) { reject(e); }
    });
    sock.once('error', reject);
  });
}

/**
 * Fetches messages newer than `afterUid` from `folder` (or, on first run / when the
 * folder was rebuilt, those received in the last `sinceDays` days).
 * @returns {{uidValidity:number, lastUid:number, messages:{uid:number, raw:Buffer}[]}}
 */
async function fetchNew({ host = 'imap.gmail.com', port = 993, user, pass, folder = 'INBOX', afterUid = 0, uidValidity = 0, sinceDays = 7, max = 25, now = new Date() }) {
  const c = await connect({ host, port });
  try {
    await c.cmd(`LOGIN ${q(user)} ${q(pass)}`);
    const sel = await c.cmd(`EXAMINE ${q(folder)}`);   // read-only: nothing is marked as read
    let uv = 0;
    sel.untagged.concat([{ text: sel.status }]).forEach(r => { const m = r.text.match(/UIDVALIDITY (\d+)/i); if (m) uv = +m[1]; });
    const fresh = !afterUid || (uidValidity && uv && uv !== uidValidity);
    const since = new Date(now.getTime() - sinceDays * 864e5);
    const s = await c.cmd(fresh ? `UID SEARCH SINCE ${imapDate(since)}` : `UID SEARCH UID ${afterUid + 1}:*`);
    let uids = [];
    s.untagged.forEach(r => { const m = r.text.match(/^\* SEARCH\s*(.*)$/i); if (m) uids.push(...m[1].trim().split(/\s+/).filter(Boolean).map(Number)); });
    uids = [...new Set(uids)].filter(u => u > 0 && (fresh || u > afterUid)).sort((a, b) => a - b);
    // First run: the most recent `max`. Afterwards: oldest first, so a backlog is worked through over a few checks.
    const take = fresh ? uids.slice(-max) : uids.slice(0, max);
    const messages = [];
    if (take.length) {
      const f = await c.cmd(`UID FETCH ${take.join(',')} (UID BODY.PEEK[])`);
      f.untagged.forEach(r => {
        const m = r.text.match(/UID (\d+)/i);
        if (m && r.lits.length) messages.push({ uid: +m[1], raw: Buffer.from(r.lits[r.lits.length - 1]) });
      });
    }
    const lastUid = fresh ? Math.max(0, ...uids) : Math.max(afterUid, ...take);
    return { uidValidity: uv, lastUid, messages: messages.sort((a, b) => a.uid - b.uid) };
  } finally { c.close(); }
}

module.exports = { fetchNew, ImapError, takeResponses };
