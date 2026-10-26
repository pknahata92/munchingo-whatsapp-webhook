'use strict';

/**
 * Customer order updates, timed to what is actually true:
 *   packed     when the order is marked packed
 *   shipped    when the courier HAS the parcel. Delhivery: found by polling (sweepOnce); Porter / India Post / by hand: at Mark shipped.
 *   delivered  when Delhivery reports delivery (the order is marked delivered for you) or when you mark it delivered.
 * Each goes by email and WhatsApp. Every send is recorded on the order timeline (`<kind>_email`, `<kind>_wa`) so nothing repeats,
 * a failed channel is retried on the next sweep (3 tries), and a channel that worked is never sent twice.
 *
 * ORDER_UPDATES_POLL=0 on Render switches back to the old behaviour (shipped notice at Mark shipped, no polling).
 */
const MAX_FAILS = 3;

let deps = null;
function setDeps(d) { deps = d; } // tests only
function D() {
  if (deps) return deps;
  return {
    db: require('./database'),
    mail: require('./mailer'),
    notify: require('./shipNotify'),
    track: require('./delhiveryTrack'),
  };
}

const pollOn = () => process.env.ORDER_UPDATES_POLL !== '0';
/** Delhivery parcels wait for the courier; every other method is handed over on the spot. */
const deferShipped = (method) => pollOn() && method === 'delhivery';

const has = (events, name) => (events || []).some((e) => e.event === name);
const count = (events, name) => (events || []).filter((e) => e.event === name).length;
const trackUrlFor = (awb) => (/^https?:\/\//i.test(awb || '') ? awb : (awb ? `https://www.delhivery.com/track/package/${encodeURIComponent(awb)}` : ''));

/** Send one kind of update on both channels, once each. Never throws. */
async function send(kind, order, { carrier, awb, trackUrl, events, skipEmail = false } = {}) {
  const { db, mail, notify } = D();
  const ev = events || (await db.listOrderEvents(order.order_id));
  const out = { email: 'skipped', wa: 'skipped' };
  if (count(ev, `${kind}_notify_failed`) >= MAX_FAILS) return { ...out, gaveUp: true };
  const failures = [];
  const cap = kind[0].toUpperCase() + kind.slice(1);

  if (!skipEmail && order.customer_email && !has(ev, `${kind}_email`)) {
    try { await mail[`send${cap}Email`]({ order, carrier, awb, trackUrl }); await db.logOrderEvent({ actor_name: 'System', order_id: order.order_id, event: `${kind}_email`, meta: null }); out.email = 'sent'; }
    catch (e) { out.email = 'failed'; failures.push(`email: ${e.message}`); }
  } else if (has(ev, `${kind}_email`)) out.email = 'already';

  if (!has(ev, `${kind}_wa`)) {
    const r = await notify[`notify${cap}`]({ order, carrier, awb, trackUrl });
    if (r.sent) { await db.logOrderEvent({ actor_name: 'System', order_id: order.order_id, event: `${kind}_wa`, meta: null }); out.wa = 'sent'; }
    else if (r.reason === 'error') { out.wa = 'failed'; failures.push(`whatsapp: ${r.error}`); }
    else out.wa = r.reason || 'skipped';
  } else out.wa = 'already';

  if (failures.length) { await db.logOrderEvent({ actor_name: 'System', order_id: order.order_id, event: `${kind}_notify_failed`, meta: { errors: failures } }); console.error(`[UPDATES] ${kind} ${order.order_id}:`, failures.join('; ')); }
  return out;
}

/** The owner pressed "Send WhatsApp update": send the WhatsApp notice for that step now, even if one already went. WhatsApp only (no email). */
async function resendWhatsapp(order, kind, { carrier, awb, trackUrl } = {}) {
  const { db, notify } = D();
  const cap = kind[0].toUpperCase() + kind.slice(1);
  const r = await notify[`notify${cap}`]({ order, carrier, awb, trackUrl: trackUrl || trackUrlFor(awb) });
  if (r.sent) await db.logOrderEvent({ actor_name: 'Owner (button)', order_id: order.order_id, event: `${kind}_wa_manual`, meta: null });
  return r;
}

const onPacked = (order) => send('packed', order);
const onShipped = (order, { carrier, awb, trackUrl }) => send('shipped', order, { carrier, awb, trackUrl: trackUrl || trackUrlFor(awb) });
const onDelivered = (order) => send('delivered', order);

/** One pass over Delhivery parcels that are shipped but not delivered. */
async function sweepOnce() {
  const { db, track } = D();
  const orders = (await db.getOrdersInTransit()) || [];
  const res = { checked: 0, waiting: 0, shipped: 0, delivered: 0, exceptions: 0, unknown: 0 };
  for (const order of orders) {
    if (!/delhivery/i.test(order.carrier || '') || !/^[0-9]{8,20}$/.test(String(order.awb || '').trim())) continue;
    res.checked++;
    try {
      const events = await db.listOrderEvents(order.order_id);
      const { stage, edd } = await track.fetchStage(order.awb);
      // Delhivery's promised delivery date: saved when it is new or has moved (the admin shows it and flags LATE orders).
      if (edd && edd !== order.expected_delivery_at && db.setExpectedDelivery) {
        try { await db.setExpectedDelivery(order.order_id, edd); } catch (e) { console.error(`[UPDATES] ${order.order_id} could not save the delivery date:`, e.message); }
      }
      if (stage === 'booked') { res.waiting++; continue; }
      if (stage === 'unknown') { res.unknown++; continue; }
      // The courier has had this parcel at some point: record it once. The admin Shipped tab uses this to tell
      // "Awaiting pickup" (booked, not collected) from "With courier". It also fills in parcels collected before this existed.
      if (!has(events, 'courier_picked_up')) await db.logOrderEvent({ actor_name: 'System', order_id: order.order_id, event: 'courier_picked_up', meta: { stage } });
      if (stage === 'returning') {
        if (!has(events, 'delivery_exception')) { await db.logOrderEvent({ actor_name: 'System', order_id: order.order_id, event: 'delivery_exception', meta: { stage } }); console.error(`[UPDATES] ${order.order_id} is being returned to sender`); }
        res.exceptions++; continue;
      }
      if (stage === 'delivered') {
        const done = new Date().toISOString();
        if (await db.updateOrderIf(order.order_id, { status: 'paid', delivered_at: null }, { delivered_at: done, delivered_by: 'Delhivery' })) {
          await db.logOrderEvent({ actor_name: 'System', order_id: order.order_id, event: 'delivered', from_state: 'shipped', to_state: 'delivered', meta: { method: 'delhivery_tracking' } });
        }
        await onDelivered(order);
        res.delivered++; continue;
      }
      // picked_up / out_for_delivery: tell the customer it is on its way. The email is skipped when it already went at Mark shipped.
      const shippedEvent = (events || []).filter((e) => e.event === 'shipped').pop();
      const emailAlreadySent = !(shippedEvent && shippedEvent.meta && shippedEvent.meta.notify === 'deferred');
      const r = await send('shipped', order, { carrier: order.carrier, awb: order.awb, trackUrl: trackUrlFor(order.awb), events, skipEmail: emailAlreadySent });
      if (r.email === 'sent' || r.wa === 'sent') res.shipped++;
    } catch (e) { console.error(`[UPDATES] ${order.order_id} error:`, e.message); }
  }
  return res;
}

let timer = null;
function startSweep() {
  if (timer || !pollOn()) return;
  const run = () => sweepOnce().then((r) => { if (r.shipped || r.delivered || r.exceptions) console.log('[UPDATES] sweep', JSON.stringify(r)); }).catch((e) => console.error('[UPDATES] sweep error:', e.message));
  setTimeout(run, 120_000);
  timer = setInterval(run, 20 * 60_000);
  if (timer.unref) timer.unref();
}

module.exports = { setDeps, resendWhatsapp, onPacked, onShipped, onDelivered, sweepOnce, startSweep, deferShipped };
