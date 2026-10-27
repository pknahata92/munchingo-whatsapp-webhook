'use strict';
// Owner alerts on WhatsApp (27 Oct 2026). OWNER_PHONE gets one message for every paid order and one for an order left unpaid for
// an hour. The unpaid alert skips a customer who paid another order within 3 hours (people retry: on 27 Oct all 4 unpaid orders
// were retries or tests), test orders, the owner's own number and anything over a day old.
// Sending: the approved owner template first; if it cannot be used (not approved yet, renamed), the same words as plain text,
// which WhatsApp only delivers inside the 24-hour window. The order email still goes either way. Each alert is written on the
// order timeline (owner_paid_alert / owner_unpaid_alert) so it never repeats; a failure is written as owner_alert_failed and
// tried again next time. Nothing here throws into the payment flow.
const TEMPLATE = { paid: 'munchingo_owner_paid_order', unpaid: 'munchingo_owner_unpaid_order' };
const UNPAID_AFTER_MS = 60 * 60000, UNPAID_UNTIL_MS = 24 * 3600000, RETRY_WINDOW_MS = 3 * 3600000;

let deps = null;
function setDeps(d) { deps = d; } // tests only
function D() {
  if (deps) return deps;
  return { db: require('./database'), wa: require('./whatsapp'), now: () => Date.now() };
}
const digits = (p) => String(p || '').replace(/\D/g, '');
const ownerPhone = () => digits(process.env.OWNER_PHONE);
const has = (events, name) => (events || []).some((e) => e.event === name);

/** "3 boxes: Trio Gift Set ×1 · Mumbai · GIFT" */
function packLine(order) {
  const items = (order.items || []).filter((i) => !/shipping/i.test(i.slug || i.productName || ''));
  const box = require('./inventory').boxesBySlug(items.map((i) => ({ slug: i.slug, quantity: i.quantity || 1 })));
  const n = Object.values(box).reduce((a, b) => a + b, 0);
  const city = (order.delivery_address && (order.delivery_address.city || '')) || '';
  return `${n} box${n === 1 ? '' : 'es'}: ${items.map((i) => `${i.productName || i.slug} ×${i.quantity || 1}`).join(', ')}${city ? ' · ' + city : ''}${order.gift_note ? ' · GIFT' : ''}`;
}

async function deliver(kind, order, params, text) {
  const { wa, db } = D();
  const to = ownerPhone();
  if (!to) return { sent: false, reason: 'no_owner_phone' };
  let how = null, err = '';
  try { await wa.sendTemplate(to, TEMPLATE[kind], 'en', params); how = 'template'; }
  // A plain message is accepted by WhatsApp even outside the 24-hour window and only fails a moment later, so it is recorded as
  // unconfirmed: the timeline never claims an alert arrived when it may not have.
  catch (e) { err = e.message; try { await wa.sendText(to, text); how = 'text_unconfirmed'; } catch (e2) { err += ' | text: ' + e2.message; } }
  try {
    if (how) await db.logOrderEvent({ actor_name: 'System', order_id: order.order_id, event: `owner_${kind}_alert`, meta: { how } });
    else await db.logOrderEvent({ actor_name: 'System', order_id: order.order_id, event: 'owner_alert_failed', meta: { kind, error: err.slice(0, 300) } });
  } catch (e) { console.error('[OWNER-ALERT] could not record', order.order_id, e.message); }
  if (!how) console.error(`[OWNER-ALERT] ${kind} ${order.order_id} not sent:`, err);
  return how ? { sent: true, how } : { sent: false, reason: 'error', error: err };
}

/** A paid order: tell the owner on WhatsApp, once. */
async function paidAlert(order) {
  try {
    if (!ownerPhone()) return { sent: false, reason: 'no_owner_phone' };
    const { db } = D();
    if (has(await db.listOrderEvents(order.order_id), 'owner_paid_alert')) return { sent: false, reason: 'already' };
    const total = String(Math.round(Number(order.total)));
    const params = [order.order_id, total, order.customer_name || 'Customer', packLine(order)];
    const text = `🛍️ New paid order ${params[0]}: ₹${total} from ${params[2]}.\n${params[3]}\nPack it from the admin.`;
    return await deliver('paid', order, params, text);
  } catch (e) { console.error('[OWNER-ALERT] paid', order && order.order_id, e.message); return { sent: false, reason: 'error', error: e.message }; }
}

const waited = (ms) => { const h = Math.floor(ms / 3600000); return h >= 1 ? `${h} hour${h === 1 ? '' : 's'}` : `${Math.floor(ms / 60000)} minutes`; };

/** Orders left unpaid for an hour (and less than a day): one alert each, skipping retries that were paid, tests and the owner. */
async function unpaidSweep() {
  const res = { alerted: 0, skipped: 0 };
  try {
    const { db, now } = D();
    const t = now();
    const orders = (await db.listOrdersSince(new Date(t - UNPAID_UNTIL_MS - RETRY_WINDOW_MS).toISOString())) || [];
    const paidByPhone = {};
    orders.filter((o) => o.status === 'paid').forEach((o) => { (paidByPhone[digits(o.customer_phone)] = paidByPhone[digits(o.customer_phone)] || []).push(Date.parse(o.created_at)); });
    for (const o of orders) {
      if (!/^pending/.test(o.status || '')) continue;
      const age = t - Date.parse(o.created_at), ph = digits(o.customer_phone);
      const retried = (paidByPhone[ph] || []).some((p) => Math.abs(p - Date.parse(o.created_at)) <= RETRY_WINDOW_MS);
      if (age < UNPAID_AFTER_MS || age > UNPAID_UNTIL_MS || /^MNG-TEST/i.test(o.order_id) || (ph && ph === ownerPhone()) || retried) { res.skipped++; continue; }
      if (has(await db.listOrderEvents(o.order_id), 'owner_unpaid_alert')) { res.skipped++; continue; }
      const params = [o.order_id, o.customer_name || 'Customer', String(Math.round(Number(o.total))), waited(age), ph];
      const text = `⏳ Order ${params[0]} from ${params[1]} (₹${params[2]}) has been waiting ${params[3]} without payment.\nMessage them: https://wa.me/${ph}`;
      const r = await deliver('unpaid', o, params, text);
      if (r.sent) res.alerted++;
    }
  } catch (e) { console.error('[OWNER-ALERT] unpaid sweep:', e.message); res.error = e.message; }
  return res;
}

let timer = null;
function start() {
  if (timer || !ownerPhone()) return;
  const run = () => unpaidSweep().then((r) => { if (r.alerted || r.error) console.log('[OWNER-ALERT] unpaid sweep', JSON.stringify(r)); });
  setTimeout(run, 180_000);
  timer = setInterval(run, 20 * 60_000);
  if (timer.unref) timer.unref();
}

module.exports = { TEMPLATE, setDeps, paidAlert, unpaidSweep, start, packLine };
