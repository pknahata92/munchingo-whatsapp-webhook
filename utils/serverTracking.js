'use strict';

/**
 * Server-side purchase tracking for Meta (Conversions API) and GA4 (Measurement Protocol).
 *
 * Why: the website fires the Purchase event only from the customer's browser on order-confirmed.html. A customer who pays in a
 * UPI app and never returns to that page was never counted (checked 16 Oct 2026: 2 of 11 paid orders missing in Meta).
 * Here the server sends the event itself for every paid order, a few minutes after payment, from the order record.
 *
 * Needs (Prashant adds both on Render; Claude never sees them):
 *   META_CAPI_TOKEN   Events Manager > Data sources > pixel "Munchingo Website Pixel" > Settings > Conversions API > Generate access token
 *   GA4_API_SECRET    GA4 Admin > Data streams > the Munchingo web stream > Measurement Protocol API secrets > Create
 * Optional: META_PIXEL_ID (default below), GA4_MEASUREMENT_ID (default below), META_TEST_EVENT_CODE (Events Manager > Test events,
 * so a test order shows up there and does not count), TRACKING_DELAY_MIN (default 10).
 *
 * Double counting:
 *   Meta : browser pixel and server share event_id = order id, so Meta keeps one.
 *   GA4  : the browser asks POST /api/purchase-seen before firing; the server sends GA4 only if the browser never reported it,
 *          and the browser skips GA4 if the server already sent it. GA4 also de-duplicates on transaction_id.
 * No database migration: everything is recorded as rows in the existing order_events table
 *   (events: purchase_tracked_browser, purchase_tracked_server, purchase_server_failed).
 */
const crypto = require('crypto');

const PIXEL_ID = () => process.env.META_PIXEL_ID || '975114194987428';
const GA4_ID = () => process.env.GA4_MEASUREMENT_ID || 'G-456YHSDMX6';
const SITE = 'https://munchingo.com';
const TIMEOUT_MS = 8000;
const SWEEP_MAX_AGE_H = 48;
const MAX_FAILS = 3;

// Meta catalogue retailer IDs for the four boxes (gift sets are not catalogue items). Same map as order-confirmed.html.
const META_IDS = { 'atta original': '91slwpjdqq', 'atta ajwain': '97q9r5q5q3', 'atta kesari': 'w2w5ynf2m5', 'atta sugar-lite': 'vf5p90bcy5' };

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');

let deps = null;   // injected by tests; otherwise the real database module
function db() { return deps || require('./database'); }
function setDeps(d) { deps = d; }

function enabled() { return { meta: !!process.env.META_CAPI_TOKEN, ga4: !!process.env.GA4_API_SECRET }; }
function delayMs() { return Math.max(1, Number(process.env.TRACKING_DELAY_MIN) || 10) * 60_000; }

function itemName(i) { return String((i && (i.productName || i.product_retailer_id)) || 'Munchingo'); }
function itemQty(i) { return Number(i && i.quantity) || 1; }
function itemPrice(i) { return Number(i && (i.item_price != null ? i.item_price : i.price)) || 0; }

function addressParts(order) {
  const a = (order && order.delivery_address) || {};
  const raw = String(a.raw || '');
  let state = a.state, pin = a.pincode, city = a.city;
  const m = /([A-Za-z .&]+?)\s*-\s*(\d{6})\s*$/.exec(raw);
  if (m) { state = state || m[1]; pin = pin || m[2]; }
  return { state: state || '', pin: pin || '', city: city || '' };
}

/**
 * What the browser and request tell us about the buyer's device, kept on the order (delivery_address.track) so the server Purchase
 * can carry the same identifiers the pixel would: _fbp, _fbc (the ad click id), client IP and user agent. Raises Meta's Event Match
 * Quality. Everything is validated (shape and length) because it comes from the browser.
 */
function cleanTrack(t, req) {
  const pick = (v, re, max) => { v = String(v == null ? '' : v).trim().slice(0, max); return re.test(v) ? v : ''; };
  const fbp = pick(t && t.fbp, /^fb\.\d\.\d{10,14}\.\d{4,12}$/, 60);
  const fbc = pick(t && t.fbc, /^fb\.\d\.\d{10,14}\.[A-Za-z0-9_-]{8,400}$/, 450);
  const ua = req && typeof req.get === 'function' ? String(req.get('user-agent') || '').slice(0, 300) : '';
  const ip = req && req.ip ? String(req.ip).replace(/^::ffff:/, '').slice(0, 64) : '';
  const out = {};
  if (fbp) out.fbp = fbp;
  if (fbc) out.fbc = fbc;
  if (ip) out.ip = ip;
  if (ua) out.ua = ua;
  return out;
}

/** Pure: the Meta Conversions API request body for one paid order. */
function buildMetaBody(order, { testCode } = {}) {
  const items = order.items || [];
  const ids = items.map((i) => META_IDS[norm(itemName(i)).replace(/^munchingo\s+/, '').replace(/\s*\(.*$/, '')]).filter(Boolean);
  const name = norm(order.customer_name).split(/\s+/).filter(Boolean);
  const ap = addressParts(order);
  const ud = { country: [sha('in')] };
  if (norm(order.customer_email)) ud.em = [sha(norm(order.customer_email))];
  const ph = digits(order.customer_phone);
  if (ph) ud.ph = [sha(ph.length === 10 ? '91' + ph : ph)];
  if (name[0]) ud.fn = [sha(name[0])];
  if (name.length > 1) ud.ln = [sha(name[name.length - 1])];
  if (norm(ap.city)) ud.ct = [sha(norm(ap.city).replace(/[^a-z]/g, ''))];
  if (norm(ap.state)) ud.st = [sha(norm(ap.state).replace(/[^a-z]/g, ''))];
  if (ap.pin) ud.zp = [sha(String(ap.pin))];
  if (ph) ud.external_id = [sha(ph.length === 10 ? '91' + ph : ph)];
  const tr = (order.delivery_address && order.delivery_address.track) || {};
  if (tr.fbp) ud.fbp = tr.fbp;
  if (tr.fbc) ud.fbc = tr.fbc;
  if (tr.ip) ud.client_ip_address = tr.ip;
  if (tr.ua) ud.client_user_agent = tr.ua;
  const at = Date.parse(order.updated_at || order.created_at || '') || Date.now();
  const body = {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor(Math.min(at, Date.now()) / 1000),
      event_id: String(order.order_id),
      action_source: 'website',
      event_source_url: `${SITE}/order-confirmed.html`,
      user_data: ud,
      custom_data: {
        value: Number(order.total), currency: 'INR', content_type: 'product', content_ids: ids,
        num_items: items.reduce((n, i) => n + itemQty(i), 0), order_id: String(order.order_id),
      },
    }],
  };
  if (testCode) body.test_event_code = testCode;
  return body;
}

/** Pure: the GA4 Measurement Protocol body for one paid order. */
function buildGa4Body(order) {
  const at = Date.parse(order.updated_at || order.created_at || '') || Date.now();
  return {
    client_id: `server.${order.order_id}`,
    timestamp_micros: Math.floor(Math.min(at, Date.now()) * 1000),
    events: [{
      name: 'purchase',
      params: {
        transaction_id: String(order.order_id), value: Number(order.total), currency: 'INR', engagement_time_msec: 1,
        items: (order.items || []).map((i) => ({ item_name: itemName(i), quantity: itemQty(i), price: itemPrice(i) })),
      },
    }],
  };
}

async function post(url, body) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl ? ctl.signal : undefined });
    let text = ''; try { text = await r.text(); } catch (_) { /* ignore */ }
    return { ok: r.ok, status: r.status, text };
  } catch (err) {
    return { ok: false, status: 0, text: err && err.name === 'AbortError' ? 'timeout' : String(err && err.message) };
  } finally { if (timer) clearTimeout(timer); }
}

async function sendMeta(order) {
  const token = process.env.META_CAPI_TOKEN;
  if (!token) return { ok: false, skipped: 'not_configured' };
  const url = `https://graph.facebook.com/v21.0/${PIXEL_ID()}/events?access_token=${encodeURIComponent(token)}`;
  const r = await post(url, buildMetaBody(order, { testCode: process.env.META_TEST_EVENT_CODE }));
  return { ok: r.ok, status: r.status, detail: r.ok ? '' : String(r.text).slice(0, 200).replace(token, '***') };
}

async function sendGa4(order) {
  const secret = process.env.GA4_API_SECRET;
  if (!secret) return { ok: false, skipped: 'not_configured' };
  const url = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(GA4_ID())}&api_secret=${encodeURIComponent(secret)}`;
  const r = await post(url, buildGa4Body(order));
  return { ok: r.ok, status: r.status, detail: r.ok ? '' : String(r.text).slice(0, 200).replace(secret, '***') };   // MP returns 2xx even for a bad payload: see the README
}

const has = (events, name) => (events || []).some((e) => e.event === name);
const count = (events, name) => (events || []).filter((e) => e.event === name).length;

/** Browser asks before firing GA4. Records that the browser reported it; refuses if the server already sent GA4. */
async function claimBrowser(orderId) {
  const order = await db().getOrder(orderId);
  if (!order || order.status !== 'paid') return { ok: false, fire: false, reason: 'not_paid' };
  const events = await db().listOrderEvents(orderId);
  const server = (events || []).find((e) => e.event === 'purchase_tracked_server');
  if (server && server.meta && server.meta.ga4 === 'sent') return { ok: true, fire: false, reason: 'server_sent' };
  if (has(events, 'purchase_tracked_browser')) return { ok: true, fire: false, reason: 'already_reported' };
  await db().logOrderEvent({ order_id: orderId, event: 'purchase_tracked_browser', meta: { at: new Date().toISOString() } });
  return { ok: true, fire: true };
}

/** One pass: send server-side events for paid orders old enough that the browser has had its chance. */
async function sweepOnce(now = Date.now()) {
  const cfg = enabled();
  if (!cfg.meta && !cfg.ga4) return { skipped: 'not_configured', sent: 0 };
  const since = new Date(now - SWEEP_MAX_AGE_H * 3600_000).toISOString();
  const until = new Date(now - delayMs()).toISOString();
  const orders = await db().getOrdersPaidSince(since, until);
  let sent = 0;
  for (const order of orders) {
    try {
      const events = await db().listOrderEvents(order.order_id);
      if (has(events, 'purchase_tracked_server') || count(events, 'purchase_server_failed') >= MAX_FAILS) continue;
      const out = {};
      let failed = false;
      if (cfg.meta) { const m = await sendMeta(order); out.meta = m.ok ? 'sent' : 'failed'; if (!m.ok) { failed = true; out.metaStatus = m.status; out.metaDetail = m.detail; } }
      if (cfg.ga4) {
        if (has(events, 'purchase_tracked_browser')) out.ga4 = 'skipped_browser_reported';
        else { const g = await sendGa4(order); out.ga4 = g.ok ? 'sent' : 'failed'; if (!g.ok) { failed = true; out.ga4Status = g.status; out.ga4Detail = g.detail; } }
      }
      if (failed) {
        await db().logOrderEvent({ order_id: order.order_id, event: 'purchase_server_failed', meta: out });
        console.error(`[TRACKING] ${order.order_id} failed:`, JSON.stringify(out));
      } else {
        await db().logOrderEvent({ order_id: order.order_id, event: 'purchase_tracked_server', meta: out });
        console.log(`[TRACKING] ${order.order_id} sent:`, JSON.stringify(out));
        sent++;
      }
    } catch (err) { console.error(`[TRACKING] ${order.order_id} error:`, err.message); }
  }
  return { sent, checked: orders.length };
}

let timer = null;
/** Called once at startup. Does nothing until at least one secret is set on Render. */
function startSweep() {
  if (timer) return;
  const run = () => sweepOnce().catch((e) => console.error('[TRACKING] sweep error:', e.message));
  setTimeout(run, 90_000);
  timer = setInterval(run, 10 * 60_000);
  if (timer.unref) timer.unref();
}

module.exports = { cleanTrack, buildMetaBody, buildGa4Body, sendMeta, sendGa4, claimBrowser, sweepOnce, startSweep, enabled, setDeps };
