'use strict';
// Channel sync: the Meta catalogue and Google Merchant Center follow the admin's stock and prices.   node scripts/channel-sync-test.js
const path = require('path'); const root = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);
(async () => {
  // ---- shape: public state and Meta/Google mapping ----
  const shape = require(path.join(root, 'utils/channels/shape.js'));
  const P = { 'atta-original': { price: 259, mrp: 300 }, 'atta-kesari': { price: 299, mrp: 350 }, 'atta-ajwain': { price: 259, mrp: 300 }, 'atta-lite-sugar': { price: 329, mrp: 350 } };
  eq(shape.SLUGS, ['atta-original', 'atta-kesari', 'atta-ajwain', 'atta-lite-sugar'], 'the four single flavours');
  eq(shape.META_IDS, { 'atta-original': '91slwpjdqq', 'atta-ajwain': '97q9r5q5q3', 'atta-kesari': 'w2w5ynf2m5', 'atta-lite-sugar': 'vf5p90bcy5' }, 'Meta retailer ids');
  eq(shape.GOOGLE_OFFER_IDS, { 'atta-original': 'MNG-ORIGINAL-250', 'atta-ajwain': 'MNG-AJWAIN-250', 'atta-kesari': 'MNG-KESARI-250', 'atta-lite-sugar': 'MNG-LITE-250' }, 'Google offer ids');

  const st = shape.publicState({ isAvailable: (s) => s !== 'atta-kesari', prices: P });
  eq(Object.keys(st).sort(), shape.SLUGS.slice().sort(), 'public state has the four flavours and no gift sets');
  ok(st['atta-kesari'].availability === 'out of stock' && ['atta-original', 'atta-ajwain', 'atta-lite-sugar'].every((s) => st[s].availability === 'in stock'), 'Kesari out of stock, the other three in stock');
  ok(shape.SLUGS.every((s) => st[s].price === P[s].price && st[s].mrp === P[s].mrp), 'prices exactly as given');
  eq(Object.keys(shape.publicState({ isAvailable: () => true, prices: Object.assign({ 'full-range-set': { price: 1, mrp: 2 } }, P) })).sort(), shape.SLUGS.slice().sort(), 'a gift set in the prices never reaches the output');

  // no MRP, or MRP not above the price: only availability goes out
  const noMrp = shape.publicState({ isAvailable: () => true, prices: { 'atta-original': { price: 259, mrp: null }, 'atta-kesari': { price: 259, mrp: 259 }, 'atta-ajwain': { price: 259 }, 'atta-lite-sugar': { price: 329, mrp: 300 } } });
  ok(shape.SLUGS.every((s) => noMrp[s].mrp === null), 'mrp is null when missing, equal to the price, or below it');
  eq(shape.toMeta('atta-original', noMrp['atta-original']), { id: '91slwpjdqq', availability: 'in stock' }, 'toMeta without an MRP carries no price or sale_price');
  const gNoMrp = shape.toGoogle(noMrp['atta-original']);
  ok(gNoMrp.availability === 'IN_STOCK' && !('price' in gNoMrp) && !('salePrice' in gNoMrp), 'toGoogle without an MRP carries no price or salePrice');

  // a flavour missing from prices still gets its availability
  const gap = shape.publicState({ isAvailable: () => false, prices: { 'atta-original': { price: 259, mrp: 300 } } });
  ok(gap['atta-kesari'].availability === 'out of stock' && gap['atta-kesari'].price === null && gap['atta-kesari'].mrp === null, 'a flavour with no price entry keeps its availability, prices null');
  ok(shape.publicState({ isAvailable: () => true })['atta-ajwain'].mrp === null, 'no prices argument does not throw');
  eq(shape.toMeta('atta-kesari', gap['atta-kesari']), { id: 'w2w5ynf2m5', availability: 'out of stock' }, 'a flavour with no price entry sends availability only');

  // Meta
  eq(shape.toMeta('atta-original', { availability: 'in stock', price: 259, mrp: 300 }), { id: '91slwpjdqq', availability: 'in stock', price: '300.00 INR', sale_price: '259.00 INR' }, 'toMeta: price is the MRP, sale_price the web price');
  eq(shape.fromMeta({ retailer_id: '91slwpjdqq', availability: 'in stock', price: '₹300.00', sale_price: '₹259.00' }), { availability: 'in stock', price: 259, mrp: 300 }, 'fromMeta with a sale price');
  eq(shape.fromMeta({ availability: 'out of stock', price: 'INR1,050.00' }), { availability: 'out of stock', price: 1050, mrp: null }, 'fromMeta without a sale price, with a thousands comma');
  eq(shape.fromMeta({ availability: 'in stock', price: '300.00 INR', sale_price: '259.00 INR' }), { availability: 'in stock', price: 259, mrp: 300 }, 'fromMeta reads the format toMeta writes');
  eq(shape.fromMeta({ availability: 'in stock' }), { availability: 'in stock', price: null, mrp: null }, 'fromMeta with no price at all gives nulls');

  // Google
  const g = shape.toGoogle({ availability: 'out of stock', price: 299, mrp: 350 });
  ok(g.availability === 'OUT_OF_STOCK' && g.price.amountMicros === '350000000' && g.salePrice.amountMicros === '299000000' && g.price.currencyCode === 'INR' && g.salePrice.currencyCode === 'INR', 'toGoogle: micros as strings, INR, price is the MRP');
  ok(shape.toGoogle({ availability: 'in stock', price: 259, mrp: 300 }).availability === 'IN_STOCK', 'toGoogle in stock');
  eq(shape.fromGoogle({ productAttributes: { title: 'Atta Kesari', availability: 'IN_STOCK', price: { amountMicros: '350000000' }, salePrice: { amountMicros: '299000000' } } }), { availability: 'in stock', price: 299, mrp: 350, title: 'Atta Kesari' }, 'fromGoogle with a sale price');
  eq(shape.fromGoogle({ productAttributes: { title: 'Atta Original', availability: 'OUT_OF_STOCK', price: { amountMicros: '259000000' } } }), { availability: 'out of stock', price: 259, mrp: null, title: 'Atta Original' }, 'fromGoogle without a sale price');
  eq(shape.fromGoogle({ productAttributes: { availability: 'PREORDER' } }).availability, 'preorder', 'an availability we never send comes back as something that will not match');
  ok(shape.fromGoogle({}).price === null && shape.fromGoogle({}).availability === '', 'fromGoogle on an empty product does not throw');

  // what we push is what we read back
  const sample = { availability: 'in stock', price: 329, mrp: 350 };
  const m = shape.toMeta('atta-lite-sugar', sample); const back = shape.fromMeta({ availability: m.availability, price: m.price, sale_price: m.sale_price });
  ok(shape.sameState(sample, back), 'Meta round trip matches');
  const gg = shape.toGoogle(sample); const back2 = shape.fromGoogle({ productAttributes: { availability: gg.availability, price: gg.price, salePrice: gg.salePrice } });
  ok(shape.sameState(sample, back2), 'Google round trip matches');

  // sameState
  const w = { availability: 'in stock', price: 259, mrp: 300 };
  ok(shape.sameState(w, { availability: 'in stock', price: 259, mrp: 300 }), 'same values match');
  ok(!shape.sameState(w, { availability: 'out of stock', price: 259, mrp: 300 }), 'availability differs');
  ok(!shape.sameState(w, { availability: 'in stock', price: 249, mrp: 300 }), 'sale price differs');
  ok(!shape.sameState(w, { availability: 'in stock', price: 259, mrp: 350 }), 'MRP differs');
  ok(!shape.sameState(w, { availability: 'in stock', price: 259, mrp: null }), 'channel has no sale price but we want one');
  ok(shape.sameState({ availability: 'in stock', price: 259, mrp: null }, { availability: 'in stock', price: 999, mrp: null }), 'no MRP wanted: prices are not compared');
  ok(!shape.sameState({ availability: 'in stock', price: 259, mrp: null }, { availability: 'out of stock', price: 259, mrp: null }), 'no MRP wanted: availability still compared');

  console.log(`channel-sync-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
