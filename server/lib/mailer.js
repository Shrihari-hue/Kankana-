'use strict';
/* Email delivery without dependencies.
   Supports: SMTP (implicit TLS on 465 or STARTTLS on 587) and the Resend HTTP API.
   Configure via environment variables — see .env.example. */
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const os = require('node:os');

function config() {
  const e = process.env;
  if (e.RESEND_API_KEY) return { kind: 'resend', key: e.RESEND_API_KEY, from: e.MAIL_FROM };
  if (e.SMTP_HOST) return {
    kind: 'smtp', host: e.SMTP_HOST, port: +(e.SMTP_PORT || 465), secure: String(e.SMTP_SECURE || (+(e.SMTP_PORT || 465) === 465)) === 'true',
    user: e.SMTP_USER, pass: e.SMTP_PASS, from: e.MAIL_FROM || e.SMTP_USER
  };
  return null;
}
const configured = () => !!config();

async function send(msg) {
  const c = config();
  if (!c) throw new Error('Email is not configured (set SMTP_* or RESEND_API_KEY)');
  if (!c.from) throw new Error('MAIL_FROM is not set');
  return c.kind === 'resend' ? sendResend(c, msg) : sendSMTP(c, msg);
}

async function sendResend(c, m) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: c.from, to: [m.to], bcc: m.bcc ? [m.bcc] : undefined, reply_to: m.replyTo || undefined,
      subject: m.subject, html: m.html, text: m.text,
      attachments: (m.attachments || []).map(a => ({ filename: a.filename, content: a.content.toString('base64') }))
    })
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return true;
}

/* ---------------- SMTP ---------------- */
function encHeader(s) { return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`; }
function addr(s) { const m = String(s).match(/<([^>]+)>/); return (m ? m[1] : s).trim(); }
function fmtFrom(s) {
  const m = String(s).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? `${encHeader(m[1])} <${m[2]}>` : s;
}
function b64lines(buf) { return buf.toString('base64').replace(/.{1,76}/g, '$&\r\n'); }

function buildMime(c, m) {
  const mixed = 'mix_' + crypto.randomBytes(12).toString('hex');
  const alt = 'alt_' + crypto.randomBytes(12).toString('hex');
  const domain = addr(c.from).split('@')[1] || 'localhost';
  const h = [
    `From: ${fmtFrom(c.from)}`, `To: ${m.to}`, m.replyTo ? `Reply-To: ${m.replyTo}` : null,
    `Subject: ${encHeader(m.subject)}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`, 'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixed}"`
  ].filter(Boolean);
  let body = `--${mixed}\r\nContent-Type: multipart/alternative; boundary="${alt}"\r\n\r\n` +
    `--${alt}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64lines(Buffer.from(m.text || ''))}` +
    `--${alt}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64lines(Buffer.from(m.html || ''))}` +
    `--${alt}--\r\n`;
  (m.attachments || []).forEach(a => {
    body += `--${mixed}\r\nContent-Type: ${a.type || 'application/pdf'}; name="${a.filename}"\r\nContent-Disposition: attachment; filename="${a.filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64lines(a.content)}`;
  });
  body += `--${mixed}--\r\n`;
  return h.join('\r\n') + '\r\n\r\n' + body;
}

function sendSMTP(c, m) {
  return new Promise((resolve, reject) => {
    let sock, buf = '', waiter = null, done = false;
    const timer = setTimeout(() => fail(new Error('SMTP timeout')), 30000);
    const fail = e => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch (_) {} reject(e); };
    const onData = d => {
      buf += d.toString('utf8');
      const lines = buf.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const resp = lines.slice(0, i + 1).join('\n'); buf = lines.slice(i + 1).join('\r\n');
          const w = waiter; waiter = null; if (w) w(resp); return;
        }
      }
    };
    const read = () => new Promise(r => { waiter = r; if (buf) onData(Buffer.alloc(0)); });
    const cmd = async (line, expect) => {
      if (line != null) sock.write(line + '\r\n');
      const r = await read();
      const code = +r.slice(0, 3);
      if (expect && !expect.includes(code)) throw new Error(`SMTP ${line ? line.split(' ')[0] : 'greeting'} failed: ${r.slice(0, 200)}`);
      return r;
    };
    const attach = s => { sock = s; sock.on('data', onData); sock.on('error', fail); };
    const run = async () => {
      const host = os.hostname() || 'kankana';
      await cmd(null, [220]);
      let ehlo = await cmd(`EHLO ${host}`, [250]);
      if (!c.secure) {
        if (!/STARTTLS/i.test(ehlo)) throw new Error('SMTP server does not offer STARTTLS');
        await cmd('STARTTLS', [220]);
        sock.removeListener('data', onData);
        await new Promise((res, rej) => { const t = tls.connect({ socket: sock, servername: c.host }, res); t.on('error', rej); attach(t); });
        ehlo = await cmd(`EHLO ${host}`, [250]);
      }
      if (c.user) {
        if (/AUTH[^\n]*PLAIN/i.test(ehlo)) await cmd('AUTH PLAIN ' + Buffer.from(`\0${c.user}\0${c.pass}`).toString('base64'), [235]);
        else { await cmd('AUTH LOGIN', [334]); await cmd(Buffer.from(c.user).toString('base64'), [334]); await cmd(Buffer.from(c.pass || '').toString('base64'), [235]); }
      }
      await cmd(`MAIL FROM:<${addr(c.from)}>`, [250]);
      await cmd(`RCPT TO:<${addr(m.to)}>`, [250, 251]);
      if (m.bcc) await cmd(`RCPT TO:<${addr(m.bcc)}>`, [250, 251]);
      await cmd('DATA', [354]);
      const data = buildMime(c, m).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
      await cmd(data + '\r\n.', [250]);
      try { sock.write('QUIT\r\n'); } catch (_) {}
      done = true; clearTimeout(timer); sock.end(); resolve(true);
    };
    const onConnect = () => run().catch(fail);
    if (c.secure) attach(tls.connect({ host: c.host, port: c.port, servername: c.host }, onConnect));
    else attach(net.connect({ host: c.host, port: c.port }, onConnect));
  });
}

module.exports = { send, configured, buildMime };
