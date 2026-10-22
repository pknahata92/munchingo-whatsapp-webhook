'use strict';
/**
 * Owner screens for reviews (spec section 7) and the founding tasters list (spec section 14).
 * Publishing rules: a review is shown only with the buyer's consent, and hidden only for one of four fixed reasons.
 * A low rating is never a reason to hide.
 */
const db = require('./database');
const { normPhone } = require('./reviews');

const HIDE_REASONS = ['abusive', 'personal_data', 'off_topic', 'no_consent'];
// The first buyers: orders placed 11 to 17 Oct 2026 (India time).
const TASTER_FROM = '2026-10-10T18:30:00.000Z';
const TASTER_TO = '2026-10-17T18:30:00.000Z';

class ReviewError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const who = (actor) => (actor && (actor.name || actor.email)) || 'Owner';

async function list() {
  const reviews = await db.listReviews({ limit: 200 });
  const delivered = await db.listDeliveredOrders({ since: new Date(Date.now() - 120 * 86400000).toISOString() });
  const asked = delivered.length ? new Set((await db.listOrderEventsByName('review_requested', delivered.map((o) => o.order_id))).map((e) => e.order_id)).size : 0;
  const received = reviews.length;
  return { reviews, totals: { asked, received, rate: asked ? Math.round((received / asked) * 100) : 0 } };
}

async function find(id) {
  const r = (await db.listReviews({ limit: 1000 })).find((x) => String(x.id) === String(id));
  if (!r) throw new ReviewError('No such review.', 404);
  return r;
}

async function publish(id, actor) {
  const r = await find(id);
  if (!r.consent_publish) throw new ReviewError('No consent to publish: the buyer did not tick "You can show my review".', 409);
  await db.updateReview(r.id, { status: 'published', hidden_reason: null, moderated_by: who(actor), moderated_at: new Date().toISOString() });
  return {};
}

async function hide(id, reason, actor) {
  if (!HIDE_REASONS.includes(reason)) throw new ReviewError('Hide only for: abusive, personal data, off topic or no consent. A low rating is not a reason.');
  const r = await find(id);
  await db.updateReview(r.id, { status: 'hidden', hidden_reason: reason, moderated_by: who(actor), moderated_at: new Date().toISOString() });
  return {};
}

/** Buyers who ordered 11 to 17 Oct, plus anyone already on the list; all ticked by default. */
async function tasterCandidates() {
  const current = await db.listFoundingTasters();
  const byPhone = {};
  current.forEach((t) => { byPhone[normPhone(t.phone)] = { phone: normPhone(t.phone), name: t.name || '', first_order_id: t.first_order_id || '', note: t.note || '', ticked: true }; });
  const orders = (await db.listRecentOrders(600)).filter((o) => o.status === 'paid' && o.created_at >= TASTER_FROM && o.created_at < TASTER_TO && !/^MNG-TEST/i.test(o.order_id));
  orders.sort((a, b) => (a.created_at < b.created_at ? -1 : 1)).forEach((o) => {
    const ph = normPhone(o.customer_phone);
    if (ph && !byPhone[ph]) byPhone[ph] = { phone: ph, name: o.customer_name || '', first_order_id: o.order_id, note: '', ticked: true };
  });
  return Object.values(byPhone);
}

async function saveTasters(rows, actor) {
  const clean = (Array.isArray(rows) ? rows : []).filter((r) => r && normPhone(r.phone).length >= 12)
    .map((r) => ({ phone: normPhone(r.phone), name: String(r.name || '').slice(0, 80), first_order_id: String(r.first_order_id || '').slice(0, 40), note: String(r.note || `confirmed by ${who(actor)}`).slice(0, 200) }));
  await db.setFoundingTasters(clean);
  return { saved: clean.length };
}

async function setKnown(orderId, known) {
  await db.setKnownToUs(String(orderId), !!known);
  return {};
}

module.exports = { list, publish, hide, tasterCandidates, saveTasters, setKnown, HIDE_REASONS, ReviewError };
