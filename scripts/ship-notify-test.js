'use strict';
// WhatsApp "shipped" and "pickup delayed" notices (stand-in sender: no network, no database).
//   node scripts/ship-notify-test.js
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

(async () => {
  const rt = require('../utils/refundTemplates');
  const order = { order_id: 'MNG-4821-0310', customer_name: 'Aarav', customer_phone: '919876543210' };

  // Templates: defined once, valid for Meta, English + Hindi.
  for (const [key, name, params] of [
    ['order_shipped', 'munchingo_order_shipped', ['customer_name', 'order_id', 'courier', 'awb', 'tracking_url']],
    ['pickup_delay', 'munchingo_pickup_delay_notice', ['customer_name', 'order_id']],
    ['order_packed', 'munchingo_order_packed', ['customer_name', 'order_id']],
    ['order_delivered', 'munchingo_order_delivered', ['customer_name', 'order_id']],
  ]) {
    const t = rt.BY_KEY[key];
    ok(t && t.name === name, `${key}: template exists as ${name}`);
    ok(t && JSON.stringify(t.params) === JSON.stringify(params), `${key}: params ${params.join(',')}`);
    ok(t && t.hi && /[ऀ-ॿ]/.test(t.hi.body), `${key}: Hindi body present`);
  }
  ok(rt.validate().length === 0, 'all templates still pass Meta validation: ' + rt.validate().join('; '));
  ok(!/\b(delivered in|within \d+ days?|by \d{1,2} (oct|nov))/i.test(rt.BY_KEY.order_shipped.body + rt.BY_KEY.pickup_delay.body), 'no delivery-day promise in either notice');

  ok(/picked up|collected/i.test(rt.BY_KEY.order_shipped.body), 'shipped template says the courier has collected the parcel');
  ok(!/booked with/i.test(rt.BY_KEY.order_shipped.body), 'shipped template no longer hedges with "booked"');

  // Emails for the two new steps render, name the order, and promise no delivery day.
  const et = require('../utils/emailTemplates');
  for (const [fn, re] of [['packedHtml', /packed/i], ['deliveredHtml', /delivered/i]]) {
    const html = typeof et[fn] === 'function' ? et[fn]({ order: { ...order, items: [] } }) : '';
    ok(html.includes('MNG-4821-0310') && re.test(html) && html.includes('Aarav'), `${fn}: renders with order id and first name`);
    ok(!/\b(within \d+ (working )?days?|by \d{1,2} (oct|nov))/i.test(html.replace(/within 48 hours/gi, '')), `${fn}: no delivery-day promise`);
  }

  const n = require('../utils/shipNotify');
  const sent = [];
  n._setSender(async (to, key, data) => { sent.push({ to, key, data }); return { ok: true }; });

  // Off by default: nothing is sent until SHIPPED_WA_ENABLED is set (templates need Meta approval first).
  delete process.env.SHIPPED_WA_ENABLED;
  let r = await n.notifyShipped({ order, carrier: 'Delhivery', awb: '1234567890123', trackUrl: 'https://www.delhivery.com/track/package/1234567890123' });
  ok(r.sent === false && r.reason === 'disabled' && sent.length === 0, 'disabled by default');

  process.env.SHIPPED_WA_ENABLED = '1';
  r = await n.notifyShipped({ order, carrier: 'Delhivery', awb: '1234567890123', trackUrl: 'https://www.delhivery.com/track/package/1234567890123' });
  ok(r.sent === true && sent.length === 1, 'shipped notice sent when enabled');
  ok(sent[0] && sent[0].key === 'order_shipped' && sent[0].to === '919876543210', 'goes to the customer phone with the right template key');
  ok(sent[0] && sent[0].data.awb === '1234567890123' && sent[0].data.courier === 'Delhivery' && sent[0].data.order_id === 'MNG-4821-0310' && sent[0].data.customer_name === 'Aarav' && /delhivery\.com\/track/.test(sent[0].data.tracking_url), 'data carries name, order, courier, AWB, link');

  // A '+' or spaces in the stored phone are cleaned.
  sent.length = 0;
  await n.notifyShipped({ order: { ...order, customer_phone: '+91 98765 43210' }, carrier: 'Delhivery', awb: '1', trackUrl: 'https://x.test/1' });
  ok(sent[0] && sent[0].to === '919876543210', 'phone normalised');

  // Courier with a number but no tracking page (DTDC etc.): the link slot must not hold a bare number.
  sent.length = 0;
  await n.notifyShipped({ order, carrier: 'DTDC', awb: 'D99', trackUrl: '' });
  ok(sent[0] && !/^D99$/.test(sent[0].data.tracking_url) && /DTDC/.test(sent[0].data.tracking_url) && /D99/.test(sent[0].data.tracking_url), 'no link: tells the customer to use the number on the courier site, got: ' + (sent[0] && sent[0].data.tracking_url));

  // No phone, or no tracking to share (Porter / by hand): skipped, never throws.
  sent.length = 0;
  r = await n.notifyShipped({ order: { ...order, customer_phone: '' }, carrier: 'Delhivery', awb: '1', trackUrl: 'https://x.test/1' });
  ok(r.sent === false && r.reason === 'no phone' && sent.length === 0, 'no phone: skipped');
  r = await n.notifyShipped({ order, carrier: 'By hand', awb: '', trackUrl: '' });
  ok(r.sent === false && r.reason === 'no tracking' && sent.length === 0, 'nothing to track: skipped');

  // Sender failure never escapes (shipping must not break because WhatsApp did).
  n._setSender(async () => { throw new Error('Template name does not exist in the translation'); });
  r = await n.notifyShipped({ order, carrier: 'Delhivery', awb: '1', trackUrl: 'https://x.test/1' });
  ok(r.sent === false && /Template name/.test(r.error), 'sender error returned, not thrown');

  // Packed and delivered use the same switch and the same safety.
  n._setSender(async (to, key, data) => { sent.push({ to, key, data }); return { ok: true }; });
  sent.length = 0;
  r = await n.notifyPacked({ order }); ok(r.sent && sent[0].key === 'order_packed' && Object.keys(sent[0].data).sort().join() === 'customer_name,order_id', 'packed notice: name + order only');
  r = await n.notifyDelivered({ order }); ok(r.sent && sent[1].key === 'order_delivered', 'delivered notice sent');
  delete process.env.SHIPPED_WA_ENABLED; sent.length = 0;
  r = await n.notifyPacked({ order }); ok(!r.sent && r.reason === 'disabled' && !sent.length, 'packed/delivered also off until enabled');
  process.env.SHIPPED_WA_ENABLED = '1';
  n._setSender(async () => { throw new Error('x'); });
  r = await n.notifyDelivered({ order }); ok(!r.sent && r.reason === 'error', 'delivered: sender error returned, not thrown');
  n._setSender(async (to, key, data) => { sent.push({ to, key, data }); return { ok: true }; });

  // Pickup-delay notice: owner-triggered for many orders; one failure does not stop the rest.
  const got = [];
  n._setSender(async (to, key, data) => { if (to === '919999900000') throw new Error('boom'); got.push({ to, key, data }); return { ok: true }; });
  const res = await n.notifyPickupDelayBatch([order, { ...order, order_id: 'B', customer_phone: '919999900000' }, { ...order, order_id: 'C', customer_phone: '' }, { ...order, order_id: 'D', customer_phone: '918888800000' }]);
  ok(res.sent === 2 && res.failed.length === 1 && res.skipped.length === 1, 'batch: 2 sent, 1 failed, 1 skipped; got ' + JSON.stringify({ s: res.sent, f: res.failed.length, k: res.skipped.length }));
  ok(got.every((g) => g.key === 'pickup_delay') && got.map((g) => g.data.order_id).join() === 'MNG-4821-0310,D', 'batch uses pickup_delay and continues past the failure');
  const dup = await n.notifyPickupDelayBatch([order, order]);
  ok(dup.sent === 1, 'same order twice in one batch is messaged once');

  console.log(`ship-notify: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
