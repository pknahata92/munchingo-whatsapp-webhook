'use strict';

/**
 * Pre-order window. Orders are accepted from ORDERS_OPEN_AT (default: 11 Oct 2026, IST midnight) and every order
 * placed before DISPATCH_FROM (default: 16 Oct 2026) is a PRE-ORDER: it ships on or after that date, not "within
 * 48 hours of payment". After DISPATCH_FROM the normal 48-hour promise applies again. Enforced on the server so
 * the website cannot be bypassed. Override either moment on Render with an ISO timestamp that has an offset.
 * Set ORDERS_OPEN_AT far in the future to close the shop again; the owner can still place test orders by opening
 * checkout.html?preview=<ORDER_PREVIEW_KEY> (set ORDER_PREVIEW_KEY on Render; never commit it).
 */
const crypto = require('crypto');

const openAt = () => Date.parse(process.env.ORDERS_OPEN_AT || '2026-10-11T00:00:00+05:30');
const dispatchFrom = () => Date.parse(process.env.DISPATCH_FROM || '2026-10-16T00:00:00+05:30');

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function ordersOpen(previewKey) {
  if (Date.now() >= openAt()) return true;
  const key = process.env.ORDER_PREVIEW_KEY;
  return !!(key && previewKey && safeEqual(previewKey, key));
}

// True while an order placed right now would wait for the dispatch date.
const isPreorder = () => Date.now() < dispatchFrom();
const dispatchLabel = () => new Date(dispatchFrom()).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long' });

const CLOSED_MESSAGE = 'Orders are not open just yet. You can browse the range now, and we will be ready for you soon.';

module.exports = { ordersOpen, openAt, dispatchFrom, isPreorder, dispatchLabel, CLOSED_MESSAGE };
