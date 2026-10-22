'use strict';
// Shipped tab split: a Delhivery parcel that is booked but not yet collected is "awaiting pickup"; once the courier has it, it is "with courier".
// Manual hand-offs (Porter, India Post, by hand) have no tracking, so they are never "awaiting pickup".
//   node scripts/shipped-split-test.js
const path = require('path');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

(async () => {
  const root = path.join(__dirname, '..');
  const asked = [];
  const mk = (id, extra = {}) => ({ order_id: id, status: 'paid', payment_id: 'pay_' + id, customer_name: 'Aarav', customer_phone: '919876500001', total: 600, items: [], created_at: '2026-10-20T05:00:00Z', updated_at: '2026-10-20T05:05:00Z', ...extra });
  const orders = [
    mk('A-SHIP-DLV', { packed_at: '2026-10-21T04:00:00Z', shipped_at: '2026-10-21T05:00:00Z', carrier: 'Delhivery', awb: '1234567890' }),
    mk('B-SHIP-DLV-COLLECTED', { packed_at: '2026-10-21T04:00:00Z', shipped_at: '2026-10-21T05:00:00Z', carrier: 'Delhivery', awb: '2234567890' }),
    mk('C-SHIP-PORTER', { packed_at: '2026-10-21T04:00:00Z', shipped_at: '2026-10-21T05:00:00Z', carrier: 'Porter', awb: 'https://porter.in/x' }),
    mk('D-PACKED', { packed_at: '2026-10-21T04:00:00Z' }),
    mk('E-DELIVERED', { packed_at: '2026-10-20T04:00:00Z', shipped_at: '2026-10-20T05:00:00Z', delivered_at: '2026-10-21T05:00:00Z', carrier: 'Delhivery', awb: '3234567890' }),
    mk('F-SHIP-NO-AWB', { packed_at: '2026-10-21T04:00:00Z', shipped_at: '2026-10-21T05:00:00Z', carrier: 'Delhivery', awb: '' }),
  ];
  const f = path.join(root, 'utils/database.js');
  require.cache[f] = { id: f, filename: f, loaded: true, exports: {
    listRecentOrders: async () => orders,
    getInvoicesByOrderIds: async () => ({}),
    getCreditNotesByOrderIds: async () => [],
    listOrderEventsByName: async (name, ids) => { asked.push({ name, ids: ids.slice() }); return name === 'courier_picked_up' ? [{ order_id: 'B-SHIP-DLV-COLLECTED', event: name }] : []; },
  } };
  process.env.RESEND_API_KEY = 'x';
  const actions = require('../utils/adminActions');

  // shapeOrder on its own: the 5th argument says whether the courier pick-up was recorded.
  const shape = (o, pickedUp) => actions.shapeOrder(o, null, [], null, pickedUp);
  ok(shape(orders[0], false).awaiting_pickup === true, 'Delhivery parcel, shipped, no pick-up recorded: awaiting pickup');
  ok(shape(orders[0], true).awaiting_pickup === false, 'Delhivery parcel with the pick-up recorded: with courier, not awaiting');
  ok(shape(orders[0]).awaiting_pickup === true, 'pick-up flag left out means not collected yet');
  ok(shape(orders[2], false).awaiting_pickup === false, 'Porter hand-off has no tracking: never awaiting pickup');
  ok(shape(orders[3], false).awaiting_pickup === false, 'a packed order is not awaiting pickup (it has no shipment yet)');
  ok(shape(orders[4], false).awaiting_pickup === false, 'a delivered order is not awaiting pickup');
  ok(shape(orders[5], false).awaiting_pickup === false, 'Delhivery order without a usable tracking number cannot be tracked, so it is not flagged');
  ok(shape(orders[0], false).state === 'shipped' && shape(orders[3], false).state === 'packed', 'the order state itself is unchanged (still shipped / packed)');

  // The list: one lookup for the pick-up markers, only for shipped Delhivery parcels.
  const list = await actions.listOrders();
  const byId = Object.fromEntries(list.map((o) => [o.id, o]));
  ok(byId['A-SHIP-DLV'].awaiting_pickup === true, 'list: booked parcel is awaiting pickup');
  ok(byId['B-SHIP-DLV-COLLECTED'].awaiting_pickup === false, 'list: parcel with a recorded pick-up is with the courier');
  ok(byId['C-SHIP-PORTER'].awaiting_pickup === false && byId['D-PACKED'].awaiting_pickup === false && byId['E-DELIVERED'].awaiting_pickup === false, 'list: Porter, packed and delivered orders are never awaiting pickup');
  ok(asked.length === 1 && asked[0].name === 'courier_picked_up', 'list: one lookup, for the courier_picked_up marker (asked ' + JSON.stringify(asked.map((a) => a.name)) + ')');
  ok(asked.length === 1 && asked[0].ids.slice().sort().join(',') === 'A-SHIP-DLV,B-SHIP-DLV-COLLECTED', 'list: asks only about shipped Delhivery parcels (asked ' + (asked[0] ? asked[0].ids.join(',') : 'nothing') + ')');

  console.log(`shipped-split: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
