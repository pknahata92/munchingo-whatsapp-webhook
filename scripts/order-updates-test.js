'use strict';
// Order update timing: packed / shipped (only once the courier has the parcel) / delivered, email + WhatsApp, with stand-ins for everything.
//   node scripts/order-updates-test.js
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

(async () => {
  const u = require('../utils/orderUpdates');
  const events = []; const orders = []; const mail = []; const wa = []; let stage = 'booked'; let waOn = true; let mailFail = 0; let tracked = [];
  const mk = (id, extra = {}) => ({ order_id: id, status: 'paid', customer_name: 'Aarav', customer_email: id + '@x.test', customer_phone: '9198765' + id.slice(-5), carrier: 'Delhivery', awb: '88000' + id.slice(-5) + '1', shipped_at: '2026-10-18T10:00:00Z', delivered_at: null, ...extra });
  u.setDeps({
    db: {
      getOrdersInTransit: async () => orders.filter((o) => o.shipped_at && !o.delivered_at && o.status === 'paid'),
      listOrderEvents: async (id) => events.filter((e) => e.order_id === id),
      logOrderEvent: async (e) => { events.push(e); },
      updateOrderIf: async (id, where, f) => { const o = orders.find((x) => x.order_id === id); if (Object.entries(where).some(([k, v]) => (v === null ? o[k] != null : o[k] !== v))) return false; Object.assign(o, f); return true; },
    },
    mail: {
      sendPackedEmail: async ({ order }) => { mail.push(['packed', order.order_id]); },
      sendShippedEmail: async ({ order }) => { if (mailFail > 0) { mailFail--; throw new Error('smtp down'); } mail.push(['shipped', order.order_id]); },
      sendDeliveredEmail: async ({ order }) => { mail.push(['delivered', order.order_id]); },
    },
    notify: {
      notifyPacked: async ({ order }) => { if (!waOn) return { sent: false, reason: 'disabled' }; wa.push(['packed', order.order_id]); return { sent: true }; },
      notifyShipped: async ({ order }) => { if (!waOn) return { sent: false, reason: 'disabled' }; wa.push(['shipped', order.order_id]); return { sent: true }; },
      notifyDelivered: async ({ order }) => { if (!waOn) return { sent: false, reason: 'disabled' }; wa.push(['delivered', order.order_id]); return { sent: true }; },
    },
    track: { fetchStage: async (awb) => { tracked.push(awb); return { stage }; } },
  });
  const reset = () => { events.length = 0; orders.length = 0; mail.length = 0; wa.length = 0; tracked = []; stage = 'booked'; waOn = true; mailFail = 0; };
  const has = (k, id) => events.some((e) => e.order_id === id && e.event === k);

  // Packed: both channels, once.
  reset(); let o = mk('MNG-A-10001');
  await u.onPacked(o); await u.onPacked(o);
  ok(mail.filter((m) => m[0] === 'packed').length === 1 && wa.filter((w) => w[0] === 'packed').length === 1, 'packed: one email, one WhatsApp, even if called twice');
  ok(has('packed_email', o.order_id) && has('packed_wa', o.order_id), 'packed: both sends recorded');

  // Shipped (deferred): nothing at "Mark shipped"; the sweep sends once the courier has it.
  reset(); o = mk('MNG-B-10002'); orders.push(o); events.push({ order_id: o.order_id, event: 'shipped', meta: { notify: 'deferred' } });
  let r = await u.sweepOnce();
  ok(mail.length === 0 && wa.length === 0 && r.waiting === 1, 'booked but not collected: no customer message, counted as waiting');
  stage = 'picked_up'; r = await u.sweepOnce();
  ok(mail.length === 1 && mail[0][0] === 'shipped' && wa.length === 1 && wa[0][0] === 'shipped', 'courier has it: shipped email + WhatsApp go out');
  r = await u.sweepOnce(); ok(mail.length === 1 && wa.length === 1, 'next sweep: no repeat');
  ok(o.delivered_at === null, 'still in transit: order not marked delivered');

  // Delivered: order marked delivered by the sweep, notices sent once, then it leaves the watch list.
  stage = 'delivered'; r = await u.sweepOnce();
  ok(o.delivered_at && o.delivered_by === 'Delhivery', 'delivered: order stamped delivered by Delhivery');
  ok(mail.some((m) => m[0] === 'delivered') && wa.some((w) => w[0] === 'delivered'), 'delivered: email + WhatsApp sent');
  ok(has('delivered', o.order_id), 'delivered: timeline event written');
  const before = mail.length + wa.length; r = await u.sweepOnce(); ok(mail.length + wa.length === before && tracked.length < 6, 'delivered order is not polled or messaged again');

  // Parcels already marked shipped (email already sent at that time) get no second shipped email, but do get the WhatsApp.
  reset(); o = mk('MNG-C-10003'); orders.push(o); events.push({ order_id: o.order_id, event: 'shipped', meta: { carrier: 'Delhivery' } });
  stage = 'picked_up'; await u.sweepOnce();
  ok(!mail.some((m) => m[0] === 'shipped') && wa.some((w) => w[0] === 'shipped'), 'legacy shipped order: no duplicate email, WhatsApp still sent');

  // Delivered before we ever saw a pick-up: delivered notice only, never a stale "shipped".
  reset(); o = mk('MNG-D-10004'); orders.push(o); events.push({ order_id: o.order_id, event: 'shipped', meta: { notify: 'deferred' } });
  stage = 'delivered'; await u.sweepOnce();
  ok(!mail.some((m) => m[0] === 'shipped') && !wa.some((w) => w[0] === 'shipped') && mail.some((m) => m[0] === 'delivered'), 'delivered without a seen pick-up: delivered notice only');

  ok(events.length > 0 && events.filter((e) => e.event !== 'shipped').every((e) => e.actor_name), 'every automatic event names its actor (System) so the order timeline shows who did it');

  // Failures: a channel that failed is retried, a channel that worked is not repeated; stops after 3 failures.
  reset(); o = mk('MNG-E-10005'); orders.push(o); events.push({ order_id: o.order_id, event: 'shipped', meta: { notify: 'deferred' } });
  stage = 'picked_up'; mailFail = 1; await u.sweepOnce();
  ok(wa.length === 1 && mail.length === 0 && has('shipped_notify_failed', o.order_id), 'email failed: WhatsApp still sent, failure recorded');
  await u.sweepOnce(); ok(mail.length === 1 && wa.length === 1, 'next sweep retries only the email');
  reset(); o = mk('MNG-F-10006'); orders.push(o); events.push({ order_id: o.order_id, event: 'shipped', meta: { notify: 'deferred' } });
  stage = 'picked_up'; mailFail = 99; for (let i = 0; i < 6; i++) await u.sweepOnce();
  ok(events.filter((e) => e.event === 'shipped_notify_failed').length === 3, 'gives up after 3 failed attempts');

  // WhatsApp switched off: email still goes, nothing is logged as a WhatsApp send (so it is not lost when switched on).
  reset(); o = mk('MNG-G-10007'); orders.push(o); events.push({ order_id: o.order_id, event: 'shipped', meta: { notify: 'deferred' } });
  waOn = false; stage = 'picked_up'; await u.sweepOnce();
  ok(mail.length === 1 && wa.length === 0 && !has('shipped_wa', o.order_id), 'WhatsApp off: email only, no false record');

  // Returning to sender: no customer message, owner-visible event once.
  reset(); o = mk('MNG-H-10008'); orders.push(o); events.push({ order_id: o.order_id, event: 'shipped', meta: { notify: 'deferred' } });
  stage = 'returning'; await u.sweepOnce(); await u.sweepOnce();
  ok(mail.length === 0 && wa.length === 0 && events.filter((e) => e.event === 'delivery_exception').length === 1, 'returning: no customer message, one exception event');

  // Unknown stage / non-Delhivery: left alone.
  reset(); o = mk('MNG-I-10009'); orders.push(o); events.push({ order_id: o.order_id, event: 'shipped', meta: { notify: 'deferred' } });
  stage = 'unknown'; await u.sweepOnce(); ok(mail.length === 0 && wa.length === 0, 'unknown status: nothing sent');
  reset(); orders.push(mk('MNG-J-10010', { carrier: 'Porter', awb: 'https://porter.in/x' })); stage = 'picked_up'; await u.sweepOnce();
  ok(tracked.length === 0 && mail.length === 0, 'non-Delhivery order is not polled');

  // Immediate path (Porter, India Post, hand): shipped notice goes at "Mark shipped".
  reset(); o = mk('MNG-K-10011', { carrier: 'Porter', awb: 'https://porter.in/x' });
  await u.onShipped(o, { carrier: 'Porter', awb: 'https://porter.in/x', trackUrl: 'https://porter.in/x' });
  ok(mail.length === 1 && wa.length === 1, 'immediate shipped: email + WhatsApp');

  // Kill switch: ORDER_UPDATES_POLL=0 means Delhivery orders are also notified at Mark shipped (old behaviour).
  process.env.ORDER_UPDATES_POLL = '0'; ok(u.deferShipped('delhivery') === false, 'poll off: Delhivery not deferred');
  delete process.env.ORDER_UPDATES_POLL; ok(u.deferShipped('delhivery') === true && u.deferShipped('porter') === false && u.deferShipped('hand') === false, 'poll on: only Delhivery is deferred');

  // owner button: a WhatsApp notice for the current step, even if one already went
  reset(); { const o = mk('MNG-BTN-0001'); orders.push(o); events.push({ order_id: o.order_id, event: 'packed_wa' });
    let r = await u.resendWhatsapp(o, 'packed');
    ok(r.sent && wa.length === 1 && events.some((e) => e.event === 'packed_wa_manual'), 'button: sends again although one already went, and records it');
    waOn = false; r = await u.resendWhatsapp(o, 'packed'); ok(!r.sent && r.reason === 'disabled' && wa.length === 1, 'button: says so when WhatsApp updates are switched off'); waOn = true; }
  console.log(`order-updates: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
