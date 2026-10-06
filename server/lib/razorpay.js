'use strict';
/* Razorpay: server-side orders + signature verification (no SDK needed).
   Docs: https://razorpay.com/docs/payments/server-integration/nodejs/ */
const crypto = require('node:crypto');

function keys() {
  const id = process.env.RAZORPAY_KEY_ID, secret = process.env.RAZORPAY_KEY_SECRET;
  return id && secret ? { id, secret } : null;
}
const mockAllowed = () => process.env.PAYMENTS_MODE === 'mock' && process.env.NODE_ENV !== 'production';
const enabled = () => !!keys() || mockAllowed();
const mode = () => keys() ? (keys().id.startsWith('rzp_live_') ? 'live' : 'test') : (mockAllowed() ? 'mock' : 'off');

async function createOrder({ amountPaise, receipt, notes }) {
  const k = keys();
  if (!k) {
    if (mockAllowed()) return { id: 'order_mock_' + crypto.randomBytes(8).toString('hex'), amount: amountPaise, currency: 'INR', mock: true };
    throw Object.assign(new Error('Online payments are not configured yet. Please contact us to pay.'), { status: 503 });
  }
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${k.id}:${k.secret}`).toString('base64'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt: String(receipt).slice(0, 40), notes, payment_capture: 1 })
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error('Payment gateway error: ' + ((j.error && j.error.description) || res.status)), { status: 502 });
  return j;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Verifies the checkout handler response: HMAC_SHA256(order_id|payment_id, key_secret). */
function verifyPayment(orderId, paymentId, signature) {
  if (String(orderId).startsWith('order_mock_')) return mockAllowed() && signature === mockSignature(orderId, paymentId);
  const k = keys(); if (!k) return false;
  const expected = crypto.createHmac('sha256', k.secret).update(`${orderId}|${paymentId}`).digest('hex');
  return safeEqual(expected, signature);
}
function mockSignature(orderId, paymentId) { return crypto.createHmac('sha256', 'kankana-mock').update(`${orderId}|${paymentId}`).digest('hex'); }

/** Verifies a webhook: HMAC_SHA256(raw_body, webhook_secret) === X-Razorpay-Signature. */
function verifyWebhook(rawBody, signature) {
  const s = process.env.RAZORPAY_WEBHOOK_SECRET; if (!s || !signature) return false;
  const expected = crypto.createHmac('sha256', s).update(rawBody).digest('hex');
  return safeEqual(expected, signature);
}

async function fetchPayment(paymentId) {
  const k = keys(); if (!k) return null;
  const res = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${k.id}:${k.secret}`).toString('base64') }
  });
  return res.ok ? res.json() : null;
}

module.exports = { keys, enabled, mode, createOrder, verifyPayment, verifyWebhook, mockSignature, fetchPayment };
