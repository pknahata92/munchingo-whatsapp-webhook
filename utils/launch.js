'use strict';

/**
 * Orders are closed until the launch moment (default: 15 Oct 2026, 1:00 PM IST). Enforced on the
 * server so the website cannot be bypassed. The owner can still place test orders before launch by
 * opening checkout.html?preview=<ORDER_PREVIEW_KEY> (set ORDER_PREVIEW_KEY on Render; never commit it).
 * Override the moment with ORDERS_OPEN_AT (an ISO timestamp with offset) on Render if the launch moves.
 */
const crypto = require('crypto');

const openAt = () => Date.parse(process.env.ORDERS_OPEN_AT || '2026-10-15T13:00:00+05:30');

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function ordersOpen(previewKey) {
  if (Date.now() >= openAt()) return true;
  const key = process.env.ORDER_PREVIEW_KEY;
  return !!(key && previewKey && safeEqual(previewKey, key));
}

const CLOSED_MESSAGE = 'Orders open on 15 October at 1:00 PM IST. You can browse the range now, and we will be ready for you then.';

module.exports = { ordersOpen, openAt, CLOSED_MESSAGE };
