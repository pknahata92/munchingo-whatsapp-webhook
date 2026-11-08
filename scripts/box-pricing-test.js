'use strict';
// One box rule for every set (3 = 8% off, 4 = 12.5% off, price ends in 9): prices, price list, /api/prices.
//   node scripts/box-pricing-test.js
const path = require('path');
process.env.SUPABASE_URL = 'x'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'x'; process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'x';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const stub = (rel, exp) => { const f = require.resolve(path.join(__dirname, '..', rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };
const stubPrices = (table) => stub('utils/prices.js', { current: () => table, ensureFresh: async () => {}, isOn: () => !!table });
stub('utils/stock.js', { ensureFresh: async () => {}, soldOutSlugs: () => [], sellable: async () => ({}) });
stub('utils/rateLimit.js', { rateLimit: () => (req, res, next) => next() });
stub('utils/database.js', {});

const box = require('../utils/boxPricing');
const cat = require('../utils/catalog');
const T = 'trio-gift-set-';
const bp = (total, d) => Math.floor((total * (1 - d) + 1) / 10) * 10 - 1;

(async () => {
  // table off: built-in single prices
  stubPrices(null);
  ok(box.BOX_DISCOUNT[3] === 0.08 && box.BOX_DISCOUNT[4] === 0.125, 'BOX_DISCOUNT is 8% for 3 and 12.5% for 4');
  ok(cat.priceForSlug(T + 'ajwain-kesari-original') === 749, 'O+A+K 749');
  ok(cat.priceForSlug(T + 'ajwain-lite-sugar-original') === 779, 'O+A+SL 779');
  ok(cat.priceForSlug(T + 'kesari-lite-sugar-original') === 809, 'O+K+SL 809');
  ok(cat.priceForSlug(T + 'ajwain-kesari-lite-sugar') === 809, 'A+K+SL 809');
  ok(cat.priceForSlug('full-range-set') === 999, 'Full Range 999');
  ok(cat.priceForSlug('atta-original') === 259 && cat.priceForSlug('atta-ajwain') === 259 && cat.priceForSlug('atta-kesari') === 299 && cat.priceForSlug('atta-lite-sugar') === 329, 'singles unchanged');
  ok(cat.priceForSlug('nope') === null, 'unknown slug is null');

  // invalid trio slugs
  ok(cat.priceForSlug(T + 'original-kesari-ajwain') === null, 'non-canonical order is null');
  ok(cat.priceForSlug(T + 'original-original-kesari') === null, 'repeated flavour is null');
  ok(cat.priceForSlug(T + 'x-y-z') === null, 'unknown tokens are null');
  ok(box.mixOf(T + 'original-kesari-ajwain') === null && box.mixOf(T + 'x-y-z') === null && box.mixOf('atta-original') === null, 'mixOf is null for invalid slugs');
  ok(JSON.stringify(box.mixOf(T + 'ajwain-kesari-original')) === JSON.stringify(['atta-ajwain', 'atta-kesari', 'atta-original']), 'mixOf gives base slugs');
  ok(box.allTrioMixes().length === 4 && box.allTrioMixes().every((s) => cat.isValidTrioSlug(s)), 'allTrioMixes: 4 canonical slugs');

  // boxPrice
  const priceOf = (s) => ({ 'atta-original': 259, 'atta-ajwain': 259, 'atta-kesari': 299, 'atta-lite-sugar': 329 })[s];
  ok(box.boxPrice(['atta-original', 'atta-ajwain', 'atta-kesari'], priceOf) === 749, 'boxPrice trio');
  let threw = false; try { box.boxPrice(['atta-original', 'atta-ajwain'], priceOf); } catch (_) { threw = true; }
  ok(threw, 'boxPrice throws on an unknown size');
  threw = false; try { box.boxPrice(['atta-original', 'atta-ajwain', 'full-range-set'], priceOf); } catch (_) { threw = true; }
  ok(threw, 'boxPrice throws on a non-base slug');

  // live table: Original 249; the table's own set rows are ignored
  stubPrices({ 'atta-original': { price: 249, mrp: 300 }, 'atta-ajwain': { price: 259, mrp: 300 }, 'atta-kesari': { price: 299, mrp: 350 }, 'atta-lite-sugar': { price: 329, mrp: 350 },
    'trio-gift-set': { price: 999, mrp: null }, 'full-range-set': { price: 1999, mrp: null } });
  ok(cat.priceForSlug(T + 'ajwain-kesari-original') === 739 && 739 === bp(249 + 259 + 299, 0.08), 'live table: O+A+K 739');
  ok(cat.priceForSlug('full-range-set') === 989 && 989 === bp(249 + 259 + 299 + 329, 0.125), 'live table: Full Range 989');
  ok(cat.priceForSlug('atta-original') === 249, 'live single price used');

  // every price ends in 9 and beats the singles
  for (let p = 200; p <= 400; p += 7) {
    const row = (m) => ({ price: p, mrp: m });
    stubPrices({ 'atta-original': row(300), 'atta-ajwain': row(300), 'atta-kesari': row(350), 'atta-lite-sugar': row(350) });
    const trio = cat.priceForSlug(T + 'ajwain-kesari-original'), full = cat.priceForSlug('full-range-set');
    ok(trio % 10 === 9 && trio < 3 * p, `single ${p}: trio ${trio} ends in 9 and is below 3 singles`);
    ok(full % 10 === 9 && full < 4 * p, `single ${p}: full ${full} ends in 9 and is below 4 singles`);
  }

  // price book
  stubPrices(null);
  let b = cat.priceBook();
  const t = b['trio-gift-set'];
  ok(t.price === 749 && t.mrp === null && t.from === true, 'book trio: 749, no MRP, from');
  ok(JSON.stringify(Object.keys(t.byMix).sort()) === JSON.stringify(['ajwain-kesari-lite-sugar', 'ajwain-kesari-original', 'ajwain-lite-sugar-original', 'kesari-lite-sugar-original']), 'byMix has exactly the 4 mixes');
  ok(t.byMix['ajwain-kesari-original'] === 749 && t.byMix['ajwain-lite-sugar-original'] === 779 && t.byMix['kesari-lite-sugar-original'] === 809 && t.byMix['ajwain-kesari-lite-sugar'] === 809, 'byMix prices');
  ok(b['full-range-set'].price === 999 && b['full-range-set'].mrp === null, 'book Full Range 999, no MRP');
  ok(!JSON.stringify(b).includes('promo'), 'no promo key anywhere (table off)');
  ok(b['atta-original'].price === 259 && b['atta-original'].mrp === 300, 'book singles carry MRP');
  stubPrices({ 'atta-original': { price: 249, mrp: 300 }, 'atta-ajwain': { price: 259, mrp: 300 }, 'atta-kesari': { price: 299, mrp: 350 }, 'atta-lite-sugar': { price: 329, mrp: 350 }, 'trio-gift-set': { price: 999, mrp: 1, promo: 'x' } });
  b = cat.priceBook();
  ok(b['trio-gift-set'].price === 739 && b['trio-gift-set'].mrp === null && b['full-range-set'].price === 989, 'book with live table follows the rule');
  ok(!JSON.stringify(b).includes('promo'), 'no promo key anywhere (table on)');

  // /api/prices
  stubPrices(null);
  const express = require('express');
  const app = express(); app.use(require('../routes/checkout'));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const j = await (await fetch('http://127.0.0.1:' + server.address().port + '/api/prices')).json();
  server.close();
  ok(j.ok && j.boxRule && j.boxRule[3] === 8 && j.boxRule[4] === 12.5, '/api/prices carries boxRule {3: 8, 4: 12.5}');
  ok(j.prices['trio-gift-set'].price === 749, '/api/prices has the rule price');

  console.log(`box-pricing-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
