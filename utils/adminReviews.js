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

// The two disclosure labels follow the owner's CURRENT settings, not a snapshot taken when the review came in:
// "known to us" may be ticked after a review lands, and the tasters list may change. The website display uses this too.
function labelsFor(review, order, activeTasterPhones) {
  const src = order && order.delivery_address && order.delivery_address.source;
  return {
    network: order ? (require('./orderSource').isNetwork(src) || order.known_to_us === true) : !!review.network,
    founding_taster: activeTasterPhones.has(normPhone(review.customer_phone)),
  };
}

async function list() {
  const stored = await db.listReviews({ limit: 200 });
  const ordersById = Object.fromEntries((await db.listRecentOrders(600)).map((o) => [o.order_id, o]));
  const active = new Set((await db.listFoundingTasters()).filter((t) => !t.removed).map((t) => normPhone(t.phone)));
  const reviews = stored.map((r) => ({ ...r, ...labelsFor(r, ordersById[r.order_id], active) }));
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
  current.forEach((t) => { byPhone[normPhone(t.phone)] = { phone: normPhone(t.phone), name: t.name || '', first_order_id: t.first_order_id || '', note: t.note || '', ticked: !t.removed }; });
  const firstTime = current.length === 0;   // before the first save every 11-17 Oct buyer is ticked; after it, newcomers are unticked
  const orders = (await db.listRecentOrders(600)).filter((o) => o.status === 'paid' && o.created_at >= TASTER_FROM && o.created_at < TASTER_TO && !/^MNG-TEST/i.test(o.order_id));
  orders.sort((a, b) => (a.created_at < b.created_at ? -1 : 1)).forEach((o) => {
    const ph = normPhone(o.customer_phone);
    if (ph && !byPhone[ph]) byPhone[ph] = { phone: ph, name: o.customer_name || '', first_order_id: o.order_id, note: '', ticked: firstTime };
  });
  return Object.values(byPhone);
}

/** Saves every row shown, ticked or not: an unticked buyer is kept with removed=true so a later open does not re-add them.
 *  Rows without `ticked` count as ticked. A save with no rows at all keeps the 11-17 Oct buyers as removed. */
async function saveTasters(rows, actor) {
  const given = (Array.isArray(rows) ? rows : []).filter((r) => r && normPhone(r.phone).length >= 12);
  const shown = await tasterCandidates();
  const byPhone = {};
  shown.forEach((r) => { byPhone[r.phone] = { ...r, removed: true }; });
  given.forEach((r) => { const ph = normPhone(r.phone); byPhone[ph] = { ...(byPhone[ph] || {}), ...r, phone: ph, removed: r.ticked === false }; });
  const clean = Object.values(byPhone).map((r) => ({ phone: r.phone, name: String(r.name || '').slice(0, 80), first_order_id: String(r.first_order_id || '').slice(0, 40), note: String(r.note || `confirmed by ${who(actor)}`).slice(0, 200), removed: !!r.removed }));
  await db.setFoundingTasters(clean);
  return { saved: clean.filter((r) => !r.removed).length };
}

async function setKnown(orderId, known) {
  await db.setKnownToUs(String(orderId), !!known);
  return {};
}

module.exports = { labelsFor, list, publish, hide, tasterCandidates, saveTasters, setKnown, HIDE_REASONS, ReviewError };
