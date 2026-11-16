'use strict';
// Stock history grouping: rows saved by one take-out or receipt are shown as one entry.   node scripts/history-groups-test.js
const G = require('../admin/historygroups');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const T1 = '2026-11-10T08:00:00.123456+00:00', T2 = '2026-11-09T08:00:00.000000+00:00';
let id = 100;
const row = (o) => ({ id: id--, item_slug: 'atta-original', qty: -8, type: 'OFFLINE_SALE', lot_code: null, ref: 'PENDING', party: 'Barkha', note: 'Hamper x 8', actor_name: 'Prashant', created_at: T1, delivery_id: null, reverses_id: null, reversed: false, ...o });
const hamper = () => [row({ item_slug: 'atta-original' }), row({ item_slug: 'atta-ajwain' }), row({ item_slug: 'atta-kesari', qty: -8 }), row({ item_slug: 'atta-lite-sugar' })];

let g = G.group(hamper());
ok(g.length === 1 && g[0].rows.length === 4, 'four rows saved together with the same time, type, buyer, note and person are one entry');
ok(g[0].boxes.map((b) => b.slug + ':' + b.qty).join() === 'atta-original:8,atta-ajwain:8,atta-kesari:8,atta-lite-sugar:8', 'the entry lists boxes per flavour, in the order they were saved');
ok(g[0].total === 32, 'the entry totals its boxes');
ok(g[0].created_at === T1 && g[0].type === 'OFFLINE_SALE' && g[0].party === 'Barkha', 'the entry carries the shared time, type and buyer');

g = G.group([row({}), row({ created_at: T2 })]);
ok(g.length === 2, 'the same flavour at two different times is two entries');
g = G.group([row({}), row({ item_slug: 'atta-ajwain', party: 'Dhruv' })]);
ok(g.length === 2, 'a different buyer at the same time is never merged');
g = G.group([row({}), row({ item_slug: 'atta-ajwain', type: 'GIFT' })]);
ok(g.length === 2, 'a different type at the same time is never merged');
g = G.group([row({}), row({ item_slug: 'atta-ajwain', note: 'other' })]);
ok(g.length === 2, 'a different note at the same time is never merged');
g = G.group([row({}), row({ item_slug: 'atta-ajwain', actor_name: 'Staff' })]);
ok(g.length === 2, 'a different person at the same time is never merged');

g = G.group([row({ lot_code: '27OCT26', qty: -5 }), row({ lot_code: 'MNGO-261105-01', qty: -3 })]);
ok(g.length === 1 && g[0].boxes.length === 1 && g[0].boxes[0].qty === 8 && g[0].total === 8, 'one flavour taken from two lots is one flavour line of 8 boxes');

const mixed = [row({ created_at: T2, item_slug: 'atta-kesari', type: 'GIFT', party: null, ref: 'Sarthak' }), ...hamper(), row({ created_at: T2, item_slug: 'atta-ajwain', type: 'GIFT', party: null, ref: 'Sarthak' })];
g = G.group(mixed);
ok(g.length === 2 && g[0].type === 'GIFT' && g[1].type === 'OFFLINE_SALE', 'entries keep the order of the first row of each (newest first stays newest first)');
ok(g[0].rows.length === 2, 'rows of one entry are joined even when other rows sit between them');

g = G.group([row({ reversed: true }), row({ item_slug: 'atta-ajwain' })]);
ok(g[0].allReversed === false && g[0].someReversed === true, 'an entry with one cancelled line is flagged as partly cancelled');
g = G.group([row({ reversed: true }), row({ item_slug: 'atta-ajwain', reversed: true })]);
ok(g[0].allReversed === true, 'an entry whose lines are all cancelled is flagged as cancelled');

g = G.group([row({ type: 'REVERSAL', reverses_id: 5 }), row({ type: 'REVERSAL', reverses_id: 6, item_slug: 'atta-ajwain' })]);
ok(g.length === 2, 'reversal lines are never merged');

g = G.group([row({ type: 'RECEIVE', delivery_id: 3, qty: 30 }), row({ type: 'RECEIVE', delivery_id: 4, qty: 30, item_slug: 'atta-ajwain' })]);
ok(g.length === 2, 'receipts from different deliveries are never merged');

g = G.group([row({}), row({ id: 7, item_slug: 'atta-ajwain', created_at: T2, note: 'x' })], { truncated: true });
ok(g.length === 1, 'when the list was cut by the row limit, the last entry (it may be incomplete) is dropped');
g = G.group([row({})], { truncated: true });
ok(g.length === 1, 'a cut list of one entry keeps it, never shows an empty history');
g = G.group([row({})], { truncated: false });
ok(g.length === 1, 'a complete list keeps its last entry');
ok(G.group([]).length === 0 && G.group(null).length === 0, 'empty input is safe');
console.log(`history-groups-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
