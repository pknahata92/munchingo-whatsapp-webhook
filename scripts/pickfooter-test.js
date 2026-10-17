'use strict';
// Pick-list footer logic.   node scripts/pickfooter-test.js
const F = require('../admin/pickfooter');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const orders = [
  { id: 'A1', state: 'topack' }, { id: 'A2', state: 'topack' }, { id: 'A3', state: 'topack' }, { id: 'P1', state: 'packed' },
  { id: 'S1', state: 'shipped' }, { id: 'S2', state: 'shipped' }, { id: 'D1', state: 'delivered' },
  { id: 'U1', state: 'unpaid' }, { id: 'FX82-2309', state: 'test' }, { id: 'R1', state: 'refunded' }, { id: 'C1', state: 'cancelled' },
];
let g = F.build(['A1', 'A2', 'P1'], orders); const by = (k) => g.find((x) => x.key === k);
ok(by('topack').count === 1 && by('topack').ids.join() === 'A3', 'a to-pack order that was not ticked is named');
ok(by('test').ids.join() === 'FX82-2309' && /test order/.test(by('test').why), 'a test order is named and explained');
ok(by('unpaid').ids.join() === 'U1' && by('refunded').ids.join() === 'R1' && by('cancelled').ids.join() === 'C1', 'unpaid, refunded and cancelled orders are named');
ok(by('shipped').count === 2 && by('shipped').ids.length === 0 && by('delivered').count === 1, 'shipped and delivered orders are only counted');
ok(!by('packed'), 'a covered order never appears under "left out"');
ok(g.map((x) => x.key).join() === 'topack,unpaid,test,refunded,cancelled,shipped,delivered', 'groups come in a fixed, sensible order');
ok(F.build(orders.map((o) => o.id), orders).length === 0, 'when everything is on the list nothing is left out');
ok(F.build([], []).length === 0 && F.build(null, null).length === 0, 'empty input is safe');
const many = Array.from({ length: 55 }, (_, i) => ({ id: 'U' + i, state: 'unpaid' }));
g = F.build([], many); ok(by('unpaid').count === 55 && by('unpaid').ids.length === 40 && by('unpaid').more === 15, 'a long list of IDs is capped and says how many more');
g = F.build([], [{ id: 'X', state: 'weird' }]); ok(g[0].key === 'weird' && g[0].why === 'weird', 'an unknown state is still reported, never silently dropped');
console.log(`pickfooter-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
