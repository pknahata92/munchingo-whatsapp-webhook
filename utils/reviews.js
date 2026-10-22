'use strict';
/**
 * Review requests (spec: docs/superpowers/specs/2026-10-23-review-requests-design.md).
 *   A buyer gets a link about 4 days after delivery, rates each flavour they received, and may leave one comment.
 *   The link carries a signed token (the order id plus an HMAC), so the page needs no login and one link can only
 *   review its own order, once. Nothing here ever returns a phone number, address or email to the page.
 */
const crypto = require('crypto');
const { boxesBySlug } = require('./inventory');

// Fixed display order and names (matches the website's range order).
const FLAVOURS = [
  ['atta-original', 'Atta Original'],
  ['atta-kesari', 'Atta Kesari'],
  ['atta-lite-sugar', 'Atta Sugar-Lite'],
  ['atta-ajwain', 'Atta Ajwain'],
];
const MAX_COMMENT = 500;

function secret() {
  const s = process.env.REVIEW_LINK_SECRET;
  if (!s) throw new Error('REVIEW_LINK_SECRET is not set');
  return s;
}
const mac16 = (orderId) => crypto.createHmac('sha256', secret()).update(String(orderId)).digest().subarray(0, 16);

/** The review link token: base64url of "<order id>.<first 16 bytes of the HMAC>". */
function signToken(orderId) {
  return Buffer.concat([Buffer.from(String(orderId)), Buffer.from('.'), mac16(orderId)]).toString('base64url');
}

/** The order id inside a token, or null if the token was changed in any way. */
function readToken(token) {
  if (!token || typeof token !== 'string') return null;
  let buf;
  try { buf = Buffer.from(token, 'base64url'); } catch (e) { return null; }
  if (buf.length < 18 || buf[buf.length - 17] !== 0x2e) return null;   // at least one character of order id, '.', 16 bytes
  const orderId = buf.subarray(0, buf.length - 17).toString();
  const given = buf.subarray(buf.length - 16);
  let expected;
  try { expected = mac16(orderId); } catch (e) { return null; }
  return crypto.timingSafeEqual(given, expected) ? orderId : null;
}

/** One row per flavour the buyer received; gift sets are opened up into their flavours. */
function flavoursFor(order) {
  const boxes = boxesBySlug((order && order.items) || []);
  return FLAVOURS.filter(([slug]) => boxes[slug] > 0).map(([slug, name]) => ({ slug, name }));
}

function firstName(order) {
  const w = String((order && order.customer_name) || '').trim().split(/\s+/)[0] || '';
  return w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : '';
}

/** City from the stored address: the city field if there is one, else the part before "State - PIN". */
function cityOf(order) {
  const a = (order && order.delivery_address) || {};
  if (a.city) return String(a.city).trim();
  const parts = String(a.raw || '').split(',').map((p) => p.trim()).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2].replace(/\d+/g, '').trim() : '';
}

const fail = (error) => ({ ok: false, status: 400, error });

/** Check what the page sent. Returns the row to store (the caller adds network, founding_taster and status). */
function validateSubmission(order, body) {
  const b = body || {};
  const wanted = flavoursFor(order).map((f) => f.slug);
  const given = b.ratings && typeof b.ratings === 'object' ? b.ratings : {};
  if (Object.keys(given).some((k) => !wanted.includes(k))) return fail('That flavor is not in this order.');
  if (wanted.some((k) => !(k in given))) return fail('Please rate every flavor.');
  for (const k of wanted) {
    const v = given[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 5) return fail('Ratings are 1 to 5 stars.');
  }
  const comment = String(b.comment == null ? '' : b.comment).trim();
  if (comment.length > MAX_COMMENT) return fail(`Please keep the comment under ${MAX_COMMENT} characters.`);
  const anonymous = b.showAs === 'anonymous';
  const ratings = {};
  wanted.forEach((k) => { ratings[k] = given[k]; });
  return {
    ok: true,
    row: {
      order_id: order.order_id,
      customer_phone: String(order.customer_phone || '').replace(/\D/g, ''),
      ratings,
      comment: comment || null,
      display_name: anonymous ? 'Anonymous buyer' : firstName(order),
      city: anonymous ? '' : cityOf(order),
      consent_publish: b.consent === true,
    },
  };
}

module.exports = { signToken, readToken, flavoursFor, firstName, cityOf, validateSubmission, FLAVOURS, MAX_COMMENT };
