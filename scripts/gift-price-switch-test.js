'use strict';
// Gift sets: Rs 799 / 999 with a promo note until Diwali, Rs 949 / 1,199 charged automatically from 9 Nov 00:00 IST.
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
ok(b['trio-gift-set'].promo && b['trio-gift-set'].promo.next === 949 && b['full-range-set'].promo.next === 1199 && /Promotional brand offer until Diwali/.test(b['trio-gift-set'].promo.label), 'price list carries the promo note and the coming price');
ok(b['trio-gift-set'].mrp === null && b['full-range-set'].mrp === null, 'no struck-through MRP for sets');
ok(!b['atta-original'].promo && b['atta-original'].price === 259, 'single boxes untouched');

at('2026-11-09T00:00:00+05:30');
ok(cat.priceForSlug('trio-gift-set-ajwain-kesari-original') === 949 && cat.priceForSlug('full-range-set') === 1199, '9 Nov 00:00 IST: 949 / 1,199 charged');
b = cat.priceBook();
ok(b['trio-gift-set'].price === 949 && !b['trio-gift-set'].promo && b['full-range-set'].price === 1199 && !b['full-range-set'].promo, 'price list shows the new prices, no promo note');
ok(cat.priceForSlug('atta-original') === 259, 'single boxes still untouched');
stubPrices({ 'trio-gift-set': { price: 999, mrp: null }, 'full-range-set': { price: 1299, mrp: null } });
ok(cat.priceForSlug('trio-gift-set-ajwain-kesari-original') === 999 && cat.priceForSlug('full-range-set') === 1299, 'after the switch an admin price above the list price still wins');
stubPrices(null);
ok(cat.priceForSlug('full-range-set') === 1199 && cat.priceForSlug('trio-gift-set-ajwain-kesari-original') === 949, 'built-in prices (table off) follow the switch too');
at('2026-10-28T10:00:00+05:30');
ok(cat.priceForSlug('full-range-set') === 999 && cat.priceBook()['full-range-set'].promo, 'built-in prices before the switch: 999 with the promo note');
promo.setNow(null);
console.log(`gift-price-switch-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
