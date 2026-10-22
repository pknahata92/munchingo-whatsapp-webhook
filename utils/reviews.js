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
  if (buf.toString('base64url') !== token) return null;   // only the exact link: base64 quietly ignores stray trailing characters
  if (buf.length < 18 || buf[buf.length - 17] !== 0x2e) return null;   // at least one character of order id, '.', 16 bytes
  const orderId = buf.subarray(0, buf.length - 17).toString();
  const given = buf.subarray(buf.length - 16);
  let expected;
  try { expected = mac16(orderId); } catch (e) { return null; }
  return crypto.timingSafeEqual(given, expected) ? orderId : null;
}

// Orders placed in the WhatsApp catalog store Meta's retailer id instead of the website slug (handlers/messageHandler.js PRODUCTS).
const RETAILER_SLUG = { '91slwpjdqq': 'atta-original', 'w2w5ynf2m5': 'atta-kesari', 'vf5p90bcy5': 'atta-lite-sugar', '97q9r5q5q3': 'atta-ajwain' };

/** One row per flavour the buyer received; gift sets are opened up into their flavours. */
function flavoursFor(order) {
  const items = ((order && order.items) || []).map((it) => (it && !it.slug && RETAILER_SLUG[it.product_retailer_id] ? { ...it, slug: RETAILER_SLUG[it.product_retailer_id] } : it));
  const boxes = boxesBySlug(items);
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
  if (!wanted.length) return fail('There is nothing to rate in this order.');
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

// ── Who is due, and sending ──────────────────────────────────────────────────
const DAY = 86400000;
const ASK_AFTER_DAYS = 4;          // days after delivery
const REMIND_AFTER_DAYS = 6;       // days after the ask (day 10 for a normal order; measured from the ask so old deliveries are not asked and reminded on consecutive days)
const PHONE_GAP_DAYS = 30;         // one ask per phone per 30 days, however many orders
const REVIEW_URL = 'https://munchingo.com/review?t=';
const TEMPLATE = { standard: 'munchingo_review_request', founders: 'munchingo_review_founders' };

let deps = null;
function setDeps(d) { deps = d; } // tests only
function D() {
  if (deps) return deps;
  return { db: require('./database'), wa: require('./whatsapp'), mail: require('./mailer'), now: () => Date.now() };
}
const enabled = () => /^(1|true|yes)$/i.test(String(process.env.REVIEW_REQUESTS_ENABLED || ''));

/** Digits with the 91 prefix, so 9810000001 and +91 98100 00001 are the same person. */
function normPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  return d.length === 10 ? '91' + d : d;
}
const at = (e) => Date.parse(e.created_at);
const last = (events, name) => (events || []).filter((e) => e.event === name).sort((a, b) => at(b) - at(a))[0] || null;

/** Pure: which orders get an ask or a reminder now. */
function dueRequests({ orders, eventsByOrder = {}, tasters = [], now }) {
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const tasterPhones = new Set(tasters.map((t) => normPhone(t.phone)));
  // The latest ask (or reminder) sent to each phone, across all its orders.
  const lastAskByPhone = {};
  const foundersSent = new Set();   // the founders message goes once per phone, ever
  for (const o of orders) {
    const ph = normPhone(o.customer_phone);
    for (const e of eventsByOrder[o.order_id] || []) {
      if (e.event !== 'review_requested' && e.event !== 'review_reminded') continue;
      if (!lastAskByPhone[ph] || at(e) > lastAskByPhone[ph]) lastAskByPhone[ph] = at(e);
      if (e.event === 'review_requested' && e.meta && e.meta.founders) foundersSent.add(ph);
    }
  }
  const out = [];
  const askedThisRun = new Set();
  const eligible = orders
    .filter((o) => o.status === 'paid' && o.delivered_at && !/^MNG-TEST/i.test(o.order_id) && normPhone(o.customer_phone) && flavoursFor(o).length)
    .sort((a, b) => Date.parse(a.delivered_at) - Date.parse(b.delivered_at));
  for (const o of eligible) {
    const ev = eventsByOrder[o.order_id] || [];
    const ph = normPhone(o.customer_phone);
    if (last(ev, 'review_received')) continue;
    const asked = last(ev, 'review_requested');
    if (!asked) {
      if (nowMs - Date.parse(o.delivered_at) < ASK_AFTER_DAYS * DAY) continue;
      if (askedThisRun.has(ph)) continue;
      if (lastAskByPhone[ph] && nowMs - lastAskByPhone[ph] < PHONE_GAP_DAYS * DAY) continue;
      askedThisRun.add(ph);
      out.push({ order: o, kind: 'ask', founders: tasterPhones.has(ph) && !foundersSent.has(ph) });
    } else if (!last(ev, 'review_reminded') && nowMs - at(asked) >= REMIND_AFTER_DAYS * DAY) {
      out.push({ order: o, kind: 'reminder', founders: false });
    }
  }
  return out;
}

/** The daily job: send what is due, record each send on the order timeline. Never throws for one order.
 *  Safety: the timeline is read with a call that throws (a failed read must never look like "never asked"), each ask is
 *  claimed on the timeline BEFORE anything is sent (a unique index stops two overlapping runs claiming the same order),
 *  and nothing is sent while the founding tasters list is empty (they would otherwise get the standard message). */
async function sweepRequests() {
  if (!enabled()) return { disabled: true };
  const { db, wa, mail, now } = D();
  const nowMs = now();
  const saved = await db.listFoundingTasters();
  const tasters = saved.filter((t) => !t.removed);
  if (!saved.length) return { blocked: 'Save the founding tasters list in the admin first (More > Founding tasters).' };
  const orders = await db.listDeliveredOrders({ since: new Date(nowMs - 120 * DAY).toISOString() });
  const ids = orders.map((o) => o.order_id);
  const eventsByOrder = {};
  for (const name of ['review_requested', 'review_reminded', 'review_received']) {
    for (let i = 0; i < ids.length; i += 200) {
      for (const e of await db.listOrderEventsByName(name, ids.slice(i, i + 200))) (eventsByOrder[e.order_id] = eventsByOrder[e.order_id] || []).push(e);
    }
  }
  const list = dueRequests({ orders, eventsByOrder, tasters, now: nowMs });
  const res = { checked: orders.length, asked: 0, reminded: 0, skipped: orders.length - list.length, failed: 0 };
  for (const { order, kind, founders } of list) {
    const event = kind === 'ask' ? 'review_requested' : 'review_reminded';
    if (!(await db.claimOrderEvent({ actor_name: 'System', order_id: order.order_id, event, meta: { founders } }))) { res.skipped++; continue; }
    const token = signToken(order.order_id);
    const url = REVIEW_URL + token;
    let waResult = 'sent', emailResult = 'none';
    try { await wa.sendTemplateWithUrlButton(normPhone(order.customer_phone), founders ? TEMPLATE.founders : TEMPLATE.standard, 'en', [firstName(order) || 'there', order.order_id], token); }
    catch (e) { waResult = 'failed'; console.error(`[REVIEWS] WhatsApp ${kind} failed for ${order.order_id}:`, e.message); }
    if (order.customer_email) {
      try { await mail.sendReviewRequestEmail({ order, url, founders }); emailResult = 'sent'; }
      catch (e) { emailResult = 'failed'; console.error(`[REVIEWS] email ${kind} failed for ${order.order_id}:`, e.message); }
    }
    if (waResult === 'failed' || emailResult === 'failed') res.failed++;
    await db.logOrderEvent({ actor_name: 'System', order_id: order.order_id, event: 'review_request_result', meta: { kind, founders, wa: waResult, email: emailResult } });
    if (kind === 'ask') res.asked++; else res.reminded++;
  }
  return res;
}

// ── The review page's two calls ──────────────────────────────────────────────
const LOW_RATING = 2;   // any flavour at or below this emails the owner straight away

/** What the page needs: first name, the flavours received, and whether this order was already reviewed. Nothing else. */
async function getForm(token) {
  const { db } = D();
  const orderId = readToken(token);
  const order = orderId ? await db.getOrder(orderId) : null;
  if (!order) return { status: 404, body: { error: "This link doesn't work." } };
  const reviewed = !!(await db.getReviewByOrder(order.order_id));
  return { status: 200, body: { first: firstName(order), flavours: flavoursFor(order), reviewed } };
}

async function submit(token, body) {
  const { db, mail } = D();
  const orderId = readToken(token);
  const order = orderId ? await db.getOrder(orderId) : null;
  if (!order) return { status: 404, body: { error: "This link doesn't work." } };
  if (await db.getReviewByOrder(order.order_id)) return { status: 409, body: { error: 'Thanks, we have your review.' } };
  const v = validateSubmission(order, body);
  if (!v.ok) return { status: v.status, body: { error: v.error } };
  const phone = normPhone(order.customer_phone);
  const tasters = (await db.listFoundingTasters()).filter((t) => !t.removed);
  const src = order.delivery_address && order.delivery_address.source;
  const row = { ...v.row, network: require('./orderSource').isNetwork(src) || order.known_to_us === true, founding_taster: tasters.some((t) => normPhone(t.phone) === phone), status: 'new' };
  try { await db.insertReview(row); }
  catch (e) { if (e.message === 'duplicate') return { status: 409, body: { error: 'Thanks, we have your review.' } }; throw e; }
  await db.logOrderEvent({ actor_name: 'Customer', order_id: order.order_id, event: 'review_received', meta: { ratings: row.ratings } });
  const low = Object.entries(row.ratings).filter(([, n]) => n <= LOW_RATING);
  if (low.length) {
    const names = Object.fromEntries(FLAVOURS);
    const rating = Object.entries(row.ratings).map(([slug, n]) => `${names[slug]} ${n}/5`).join(', ');
    try { await mail.sendFeedbackAlert({ customerPhone: phone, customerName: order.customer_name, rating, comments: `Review for order ${order.order_id}. ${row.comment || '(no comment)'}` }); }
    catch (e) { console.error('[REVIEWS] low-rating alert failed:', e.message); }
  }
  return { status: 201, body: { ok: true, googleUrl: process.env.GOOGLE_REVIEW_URL || '' } };
}

module.exports = { _deps: () => D(), getForm, submit, signToken, readToken, flavoursFor, firstName, cityOf, validateSubmission, FLAVOURS, MAX_COMMENT, setDeps, normPhone, dueRequests, sweepRequests, TEMPLATE, REVIEW_URL };
