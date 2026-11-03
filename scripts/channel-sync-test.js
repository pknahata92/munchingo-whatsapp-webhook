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

  // ---- meta: catalogue client (a recording fake stands in for axios; no network) ----
  {
    const meta = require(path.join(root, 'utils/channels/meta.js'));
    const GRAPH = 'https://graph.facebook.com/v21.0/1592646269154053';
    const fakeHttp = (reply) => { const calls = []; const f = async (cfg) => { calls.push(cfg); const r = typeof reply === 'function' ? reply(cfg) : reply; if (r instanceof Error) throw r; return r; }; f.calls = calls; return f; };
    const caught = async (p) => { try { await p; return null; } catch (e) { return e.message; } };

    // read: one GET filtered by retailer id, token in the header only
    const h1 = fakeHttp({ data: { data: [{ retailer_id: '91slwpjdqq', availability: 'in stock', price: '₹300.00', sale_price: '₹259.00' }] } });
    const got = await meta.makeMeta({ http: h1, token: 'T' }).read(['atta-original', 'atta-kesari']);
    const c1 = h1.calls[0];
    eq(h1.calls.length, 1, 'meta read makes one call');
    eq([c1.method, c1.url], ['GET', `${GRAPH}/products`], 'meta read: GET on the catalogue products');
    eq(c1.params, { fields: 'retailer_id,availability,price,sale_price', limit: 25, filter: '{"retailer_id":{"is_any":["91slwpjdqq","w2w5ynf2m5"]}}' }, 'meta read: fields, limit and the retailer id filter');
    eq(c1.headers.Authorization, 'Bearer T', 'meta read: bearer header');
    ok(c1.timeout === 15000, 'meta read: 15 s timeout');
    ok(!JSON.stringify(c1).includes('access_token'), 'meta read: no access_token anywhere');
    eq(got, { 'atta-original': { availability: 'in stock', price: 259, mrp: 300 }, 'atta-kesari': null }, 'meta read: found item mapped, missing item null');
    eq(await meta.makeMeta({ http: fakeHttp({ data: {} }), token: 'T' }).read(['atta-ajwain']), { 'atta-ajwain': null }, 'meta read: a reply with no data list means not found');
    const h1b = fakeHttp({ data: { data: [] } });
    eq(await meta.makeMeta({ http: h1b, token: 'T' }).read([]), {}, 'meta read of nothing is empty');
    eq(await meta.makeMeta({ http: h1b, token: 'T' }).read(['full-range-set']), {}, 'meta read ignores a slug that is not a catalogue item');
    eq(h1b.calls.length, 0, 'meta read with nothing to ask makes no call');

    // push: one items_batch UPDATE per call, price = MRP, sale_price = web price
    const h2 = fakeHttp({ data: { handles: ['AbC'] } });
    const pushed = await meta.makeMeta({ http: h2, token: 'T' }).push([{ slug: 'atta-kesari', state: { availability: 'in stock', price: 299, mrp: 350 } }]);
    const c2 = h2.calls[0];
    eq([c2.method, c2.url], ['POST', `${GRAPH}/items_batch`], 'meta push: POST to items_batch');
    eq(c2.data.item_type, 'PRODUCT_ITEM', 'meta push: item type');
    eq(c2.data.requests, '[{"method":"UPDATE","data":{"id":"w2w5ynf2m5","availability":"in stock","price":"350.00 INR","sale_price":"299.00 INR"}}]', 'meta push: requests is the JSON string of the UPDATE');
    eq(c2.headers.Authorization, 'Bearer T', 'meta push: bearer header');
    ok(c2.timeout === 15000 && !JSON.stringify(c2).includes('access_token'), 'meta push: 15 s timeout, no access_token');
    eq(pushed, { ok: true, handles: ['AbC'] }, 'meta push returns ok and the handles');
    const h2b = fakeHttp({ data: {} });
    eq(await meta.makeMeta({ http: h2b, token: 'T' }).push([{ slug: 'atta-original', state: { availability: 'out of stock', price: 259, mrp: null } }]), { ok: true, handles: [] }, 'meta push with no handles in the reply');
    eq(JSON.parse(h2b.calls[0].data.requests), [{ method: 'UPDATE', data: { id: '91slwpjdqq', availability: 'out of stock' } }], 'meta push without an MRP sends availability only');
    const h2c = fakeHttp({ data: {} });
    eq(await meta.makeMeta({ http: h2c, token: 'T' }).push([]), { ok: true, handles: [] }, 'meta push of nothing is ok');
    eq(h2c.calls.length, 0, 'meta push of nothing makes no call');

    // failures: plain Error('meta: ...'), never the token
    const bad = { state: { availability: 'in stock', price: 1, mrp: null } };
    const SECRET = 'SECRET-TOKEN-123';
    ok(/^meta: Invalid OAuth$/.test(await caught(meta.makeMeta({ http: fakeHttp({ data: { error: { message: 'Invalid OAuth' } } }), token: 'T' }).push([Object.assign({ slug: 'atta-kesari' }, bad)]))), 'meta push: an error body throws meta: <graph message>');
    ok(/^meta: Invalid OAuth$/.test(await caught(meta.makeMeta({ http: fakeHttp({ data: { error: { message: 'Invalid OAuth' } } }), token: 'T' }).read(['atta-kesari']))), 'meta read: an error body throws too');
    const httpErr = Object.assign(new Error('Request failed with status code 400'), { response: { data: { error: { message: 'Unsupported post request' } } } });
    ok(/^meta: Unsupported post request$/.test(await caught(meta.makeMeta({ http: fakeHttp(httpErr), token: 'T' }).read(['atta-kesari']))), 'meta: an HTTP error carries the Graph message');
    ok(/^meta: timeout of 15000ms exceeded$/.test(await caught(meta.makeMeta({ http: fakeHttp(new Error('timeout of 15000ms exceeded')), token: 'T' }).read(['atta-kesari']))), 'meta: a network error carries its own message');
    const leak = await caught(meta.makeMeta({ http: fakeHttp({ data: { error: { message: `Bad token ${SECRET}` } } }), token: SECRET }).push([Object.assign({ slug: 'atta-kesari' }, bad)]));
    ok(typeof leak === 'string' && leak.startsWith('meta: ') && !leak.includes(SECRET), 'meta: the token is scrubbed out of an error message');
    const h3 = fakeHttp({ data: { data: [] } });
    await meta.makeMeta({ http: h3, token: SECRET }).read(['atta-kesari']);
    ok(h3.calls[0].headers.Authorization === `Bearer ${SECRET}` && !JSON.stringify([h3.calls[0].url, h3.calls[0].params, h3.calls[0].data]).includes(SECRET), 'meta: the token is in the header and nowhere else');

    // not configured: reads and pushes refuse and never call out
    const h4 = fakeHttp({ data: {} });
    const off = meta.makeMeta({ http: h4, token: '' });
    ok(off.configured() === false && meta.makeMeta({ http: h4, token: 'T' }).configured() === true, 'meta configured() follows the token');
    ok(/^meta: token not set$/.test(await caught(off.read(['atta-original']))), 'meta read without a token throws');
    ok(/^meta: token not set$/.test(await caught(off.push([Object.assign({ slug: 'atta-original' }, bad)]))), 'meta push without a token throws');
    eq(h4.calls.length, 0, 'meta without a token never calls http');

    // defaults: the real token comes from the environment at call time
    const was = process.env.META_CATALOG_TOKEN;
    delete process.env.META_CATALOG_TOKEN; const offByEnv = meta.client().configured();
    process.env.META_CATALOG_TOKEN = 'x'; const onByEnv = meta.client().configured();
    if (was === undefined) delete process.env.META_CATALOG_TOKEN; else process.env.META_CATALOG_TOKEN = was;
    ok(offByEnv === false && onByEnv === true, 'meta client() reads META_CATALOG_TOKEN');
  }

  console.log(`channel-sync-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
