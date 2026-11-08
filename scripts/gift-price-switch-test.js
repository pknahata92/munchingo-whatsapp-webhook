'use strict';
// Gift sets 8 Nov 2026: Full Range stays Rs 999 and Trio Rs 799 past 9 Nov (no promo note); an admin price above still wins.
//   node scripts/gift-price-switch-test.js
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const promo = require('../utils/giftPromo');
const stubPrices = (table) => { const p = require.resolve('../utils/prices'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { current: () => table, ensureFresh: async () => {}, isOn: () => !!table } }; };
stubPrices({ 'atta-original': { price: 259, mrp: 300 }, 'trio-gift-set': { price: 799, mrp: null }, 'full-range-set': { price: 999, mrp: null } });
const cat = require('../utils/catalog');
const at = (iso) => promo.setNow(() => Date.parse(iso));

at('2026-11-08T23:59:00+05:30');
ok(cat.priceForSlug('trio-gift-set-ajwain-kesari-original') === 799 && cat.priceForSlug('full-range-set') === 999, 'Diwali night: still 799 / 999');
let b = cat.priceBook();
ok(!b['trio-gift-set'].promo && !b['full-range-set'].promo, 'no promo note on either set');
ok(b['trio-gift-set'].mrp === null && b['full-range-set'].mrp === null, 'no struck-through MRP for sets');
ok(!b['atta-original'].promo && b['atta-original'].price === 259, 'single boxes untouched');

at('2026-11-09T00:00:00+05:30');
ok(cat.priceForSlug('trio-gift-set-ajwain-kesari-original') === 799 && cat.priceForSlug('full-range-set') === 999, '9 Nov 00:00 IST: Trio 799, Full Range 999');
b = cat.priceBook();
ok(b['trio-gift-set'].price === 799 && !b['trio-gift-set'].promo && b['full-range-set'].price === 999 && !b['full-range-set'].promo, 'price list after 9 Nov: 799 / 999, no promo note');
ok(cat.priceForSlug('atta-original') === 259, 'single boxes still untouched');
stubPrices({ 'trio-gift-set': { price: 999, mrp: null }, 'full-range-set': { price: 1299, mrp: null } });
ok(cat.priceForSlug('trio-gift-set-ajwain-kesari-original') === 999 && cat.priceForSlug('full-range-set') === 1299, 'after the switch an admin price above the list price still wins');
stubPrices(null);
ok(cat.priceForSlug('full-range-set') === 999 && cat.priceForSlug('trio-gift-set-ajwain-kesari-original') === 799, 'built-in prices (table off): 799 / 999 after 9 Nov');
at('2026-10-28T10:00:00+05:30');
ok(cat.priceForSlug('full-range-set') === 999 && !cat.priceBook()['full-range-set'].promo, 'built-in prices before 9 Nov: 999, no note');
promo.setNow(null);
console.log(`gift-price-switch-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
