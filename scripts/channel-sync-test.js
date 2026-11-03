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

  // ---- google: Merchant Center client (a routing fake stands in for axios; throwaway key made here; no network) ----
  {
    const crypto = require('crypto');
    const google = require(path.join(root, 'utils/channels/google.js'));
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const keyJson = JSON.stringify({ client_email: 'sync@munchingo-test.iam.gserviceaccount.com', private_key: PEM });
    const API = 'https://merchantapi.googleapis.com';
    const TOKEN_URL = 'https://oauth2.googleapis.com/token';
    const REG = `${API}/accounts/v1/accounts/1/developerRegistration:registerGcp`;
    const DS = `${API}/datasources/v1/accounts/1/dataSources`;
    const PR = `${API}/products/v1/accounts/1/products`;
    const INSERT = `${API}/products/v1/accounts/1/productInputs:insert`;
    const OURS = 'accounts/1/dataSources/9';
    const caught = async (p) => { try { await p; return null; } catch (e) { return e.message; } };
    const httpErr = (status, message) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: { error: { code: status, message } } } });
    const sheet = (id) => ({ name: `accounts/1/dataSources/${id}`, displayName: `Sheet ${id}`, input: 'FILE', primaryProductDataSource: { defaultRule: { takeFromDataSources: [{ self: true }] } } });
    const product = (offerId, attrs) => ({ name: `accounts/1/products/en~IN~${offerId}`, offerId, contentLanguage: 'en', feedLabel: 'IN', productAttributes: Object.assign({ title: offerId, availability: 'IN_STOCK' }, attrs) });
    const three = () => [product('MNG-ORIGINAL-250'), product('MNG-KESARI-250'), product('MNG-AJWAIN-250')];
    const hits = (f, method, url) => f.calls.filter((c) => c.method === method && c.url.split('?')[0] === url);
    let clock = Date.UTC(2026, 10, 3, 10, 0, 0);
    const T0 = clock;
    const make = (f, extra) => google.makeGoogle(Object.assign({ http: f, keyJson, accountId: '1', now: () => clock }, extra));

    // One router over method + url: answers each endpoint the client uses, records every call, refuses anything else.
    const merchant = ({ sources = [], products = [], pageLen = 100 } = {}) => {
      let n = 0;
      const f = async (cfg) => {
        f.calls.push(cfg);
        const [url, query = ''] = cfg.url.split('?');
        const route = `${cfg.method} ${url}`;
        if (route === `POST ${TOKEN_URL}`) return { data: { access_token: `AT-${++n}`, expires_in: 3600 } };
        if (route === `POST ${REG}`) { if (f.registerError) throw f.registerError; return { data: {} }; }
        if (route === `GET ${DS}`) return { data: { dataSources: f.sources } };
        if (route === `POST ${DS}`) { const made = Object.assign({ name: OURS }, cfg.data); f.sources.push(made); return { data: made }; }
        if (cfg.method === 'PATCH' && url.startsWith(`${DS}/`)) {
          const hit = f.sources.find((s) => `${API}/datasources/v1/${s.name}` === url);
          hit.primaryProductDataSource.defaultRule = cfg.data.primaryProductDataSource.defaultRule; return { data: hit };
        }
        if (route === `GET ${PR}`) {
          const start = Number((new URLSearchParams(query).get('pageToken') || 'page-0').slice(5));
          const more = start + pageLen < f.products.length;
          return { data: Object.assign({ products: f.products.slice(start, start + pageLen) }, more ? { nextPageToken: `page-${start + pageLen}` } : {}) };
        }
        if (cfg.method === 'GET' && url.startsWith(`${PR}/`)) {
          const name = `accounts/1/products/${decodeURIComponent(url.slice(PR.length + 1))}`;
          if (f.productError) throw f.productError;
          const hit = f.products.find((p) => p.name === name);
          if (!hit) throw httpErr(404, 'Product not found');
          return { data: hit };
        }
        if (route === `POST ${INSERT}`) { const e = f.insertError && f.insertError(cfg); if (e) throw e; return { data: { name: 'accounts/1/productInputs/x' } }; }
        throw new Error(`unexpected call ${route}`);
      };
      f.calls = []; f.sources = sources; f.products = products;
      return f;
    };

    // token: form-encoded jwt-bearer grant, RS256 JWT, cached until 60 s before it expires
    const h1 = merchant();
    const g1 = make(h1);
    ok(g1.configured() === true, 'google configured() with a key and an account');
    const tok = await g1.token();
    const c1 = h1.calls[0];
    eq([c1.method, c1.url], ['POST', TOKEN_URL], 'google token: POST to the OAuth token endpoint');
    eq(c1.headers, { 'Content-Type': 'application/x-www-form-urlencoded' }, 'google token: form content type, no bearer header on the token request itself');
    ok(typeof c1.data === 'string' && c1.data.startsWith('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion='), 'google token: body is a form string with the jwt-bearer grant');
    ok(c1.timeout === 20000, 'google token: 20 s timeout');
    const form = new URLSearchParams(c1.data);
    eq(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer', 'google token: grant type decodes to the jwt-bearer URN');
    const jwt = form.get('assertion'); const [jh, jp, js] = jwt.split('.');
    ok(jwt.split('.').length === 3 && !/[=+/]/.test(jwt), 'google token: three base64url parts, no padding');
    eq(JSON.parse(Buffer.from(jh, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' }, 'google token: JWT header');
    eq(JSON.parse(Buffer.from(jp, 'base64url').toString()), { iss: 'sync@munchingo-test.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/content', aud: TOKEN_URL, iat: T0 / 1000, exp: T0 / 1000 + 3600 }, 'google token: JWT payload (iat and exp in seconds)');
    ok(crypto.createVerify('RSA-SHA256').update(`${jh}.${jp}`).verify(publicKey, Buffer.from(js, 'base64url')), 'google token: the signature verifies with the public key');
    ok(tok === 'AT-1', 'google token: returns the access token');
    await g1.token(); clock = T0 + 3539 * 1000; await g1.token();
    eq(h1.calls.length, 1, 'google token: no second HTTP call inside the hour (still cached at 3539 s)');
    clock = T0 + 3541 * 1000; const tok2 = await g1.token();
    ok(h1.calls.length === 2 && tok2 === 'AT-2', 'google token: 60 s before expiry it fetches a fresh one');
    clock = T0;

    // setup: first run against a shop with no supplemental source and one Sheets primary
    const h2 = merchant({ sources: [sheet(5)], products: three(), pageLen: 2 });
    const g2 = make(h2);
    const res = await g2.setup();
    eq(hits(h2, 'POST', REG).map((c) => c.data), [{}], 'google setup: registers with an empty body');
    eq(hits(h2, 'POST', DS).map((c) => c.data), [{ displayName: 'Munchingo admin stock', supplementalProductDataSource: {} }], 'google setup: creates the supplemental source');
    const patch = hits(h2, 'PATCH', `${DS}/5`);
    eq(patch.length, 1, 'google setup: one PATCH on the sheet source');
    eq(patch[0].params, { updateMask: 'primaryProductDataSource.defaultRule' }, 'google setup: PATCH with the update mask');
    eq(patch[0].data.primaryProductDataSource.defaultRule.takeFromDataSources, [{ supplementalDataSourceName: OURS }, { self: true }], 'google setup: ours first, the sheet kept');
    const pages = hits(h2, 'GET', PR);
    ok(pages.length === 2 && pages[0].url === `${PR}?pageSize=250` && pages[1].url === `${PR}?pageSize=250&pageToken=page-2`, 'google setup: products listed 250 at a time, following nextPageToken');
    ok(res.registered === true && res.source === OURS, 'google setup: registered, source is the created data source name');
    eq(res.names, { 'atta-original': 'en~IN~MNG-ORIGINAL-250', 'atta-ajwain': 'en~IN~MNG-AJWAIN-250', 'atta-kesari': 'en~IN~MNG-KESARI-250' }, 'google setup: names are language~label~offerId, only for the products Google has');
    eq(res.missing, ['MNG-LITE-250'], 'google setup: the offer id Google lacks is reported missing');
    eq(res.steps, ['Registered with Google', 'Created the source "Munchingo admin stock"', 'Put it first, ahead of the Google sheet', 'Found 3 of 4 products'], 'google setup: four plain-word steps in order');

    // setup again: nothing to create, nothing to patch
    const before = h2.calls.length;
    const res2 = await g2.setup();
    const again = h2.calls.slice(before);
    eq(again.filter((c) => c.method === 'POST' && c.url === DS).length, 0, 'google setup again: no POST to dataSources');
    eq(again.filter((c) => c.method === 'PATCH').length, 0, 'google setup again: no PATCH');
    ok(res2.source === OURS && res2.missing.length === 1, 'google setup again: same source, same missing');
    eq(res2.steps.slice(1, 3), ['Found the source "Munchingo admin stock"', 'Already first'], 'google setup again: says it found the source and it is already first');

    // the PATCH replaces the whole rule, so existing entries are kept and ours is not duplicated
    const hRule = merchant({ sources: [{ name: OURS, displayName: 'Munchingo admin stock', supplementalProductDataSource: {} }, Object.assign(sheet(5), { primaryProductDataSource: { defaultRule: { takeFromDataSources: [{ self: true }, { supplementalDataSourceName: 'accounts/1/dataSources/7' }, { supplementalDataSourceName: OURS }] } } })], products: three() });
    await make(hRule).setup();
    eq(hits(hRule, 'PATCH', `${DS}/5`)[0].data.primaryProductDataSource.defaultRule.takeFromDataSources, [{ supplementalDataSourceName: OURS }, { self: true }, { supplementalDataSourceName: 'accounts/1/dataSources/7' }], 'google setup: ours moved first, other entries kept, no duplicate');
    const hEmpty = merchant({ sources: [Object.assign(sheet(5), { primaryProductDataSource: {} })], products: three() });
    await make(hEmpty).setup();
    eq(hits(hEmpty, 'PATCH', `${DS}/5`)[0].data.primaryProductDataSource.defaultRule.takeFromDataSources, [{ supplementalDataSourceName: OURS }, { self: true }], 'google setup: a missing rule becomes ours then the sheet');

    // the sheet primary is the one primary whose input is not API
    const hApi = merchant({ sources: [sheet(5), { name: 'accounts/1/dataSources/6', displayName: 'Api primary', input: 'API', primaryProductDataSource: {} }], products: three() });
    ok((await make(hApi).setup()).source === OURS && hits(hApi, 'PATCH', `${DS}/5`).length === 1, 'google setup: an API primary is not counted as a sheet');
    const hTwo = merchant({ sources: [sheet(5), sheet(6)], products: three() });
    const twoMsg = await caught(make(hTwo).setup());
    ok(/found 2 sheet data sources, expected 1; link "Munchingo admin stock" by hand in Merchant Center/.test(twoMsg), 'google setup: two sheets stop with the by-hand message');
    eq(hits(hTwo, 'PATCH', `${DS}/5`).length + hits(hTwo, 'PATCH', `${DS}/6`).length, 0, 'google setup: two sheets patch nothing');
    ok(/found 0 sheet data sources/.test(await caught(make(merchant({ sources: [], products: three() })).setup())), 'google setup: no sheet stops too');

    // "already registered" is success, anything else is not
    const hReg = merchant({ sources: [sheet(5)], products: three() }); hReg.registerError = httpErr(409, 'Conflict');
    const r409 = await make(hReg).setup();
    ok(r409.registered === true && r409.steps[0] === 'Already registered with Google', 'google setup: HTTP 409 on registration counts as registered');
    const hReg2 = merchant({ sources: [sheet(5)], products: three() }); hReg2.registerError = httpErr(400, 'GCP project is already registered');
    ok((await make(hReg2).setup()).registered === true, 'google setup: an "already registered" message counts as registered');
    const hReg3 = merchant({ sources: [sheet(5)], products: three() }); hReg3.registerError = httpErr(403, 'The caller does not have permission');
    eq(await caught(make(hReg3).setup()), 'google: The caller does not have permission', 'google setup: a real registration failure throws');
    eq(hits(hReg3, 'GET', DS).length, 0, 'google setup: stops at the failed step');

    // push: supplemental insert into our source
    const h3 = merchant();
    const g3 = make(h3);
    const names = { 'atta-kesari': 'en~IN~MNG-KESARI-250', 'atta-ajwain': 'en~IN~MNG-AJWAIN-250', 'atta-original': 'en~IN~MNG-ORIGINAL-250' };
    await g3.push([{ slug: 'atta-kesari', state: { availability: 'out of stock', price: 299, mrp: 350 } }], { source: OURS, names });
    const ins = hits(h3, 'POST', INSERT);
    eq(ins.length, 1, 'google push: one insert per item');
    eq(ins[0].url, `${INSERT}?dataSource=${OURS}`, 'google push: productInputs:insert for our data source');
    eq(ins[0].data, { offerId: 'MNG-KESARI-250', contentLanguage: 'en', feedLabel: 'IN', productAttributes: { availability: 'OUT_OF_STOCK', price: { amountMicros: '350000000', currencyCode: 'INR' }, salePrice: { amountMicros: '299000000', currencyCode: 'INR' } } }, 'google push: body has the offer, language, label and the availability and prices');
    await g3.push([{ slug: 'atta-original', state: { availability: 'in stock', price: 259, mrp: null } }], { source: OURS, names });
    eq(hits(h3, 'POST', INSERT)[1].data.productAttributes, { availability: 'IN_STOCK' }, 'google push: no MRP sends availability only');
    ok(hits(h3, 'POST', INSERT).every((c) => c.timeout === 20000 && /^Bearer AT-\d+$/.test(c.headers.Authorization)), 'google push: bearer token, 20 s timeout');

    // push stops at the first failure and names the slug
    const h4 = merchant(); h4.insertError = (cfg) => (cfg.data.offerId === 'MNG-AJWAIN-250' ? httpErr(400, 'Invalid price') : null);
    const items = ['atta-kesari', 'atta-ajwain', 'atta-original'].map((slug) => ({ slug, state: { availability: 'in stock', price: 259, mrp: 300 } }));
    eq(await caught(make(h4).push(items, { source: OURS, names })), 'google: atta-ajwain: Invalid price', 'google push: first failure throws google: <slug>: <message>');
    eq(hits(h4, 'POST', INSERT).length, 2, 'google push: nothing is sent after the failure');
    ok(/source not set/.test(await caught(make(merchant()).push(items, { names }))), 'google push without a source throws');
    ok(/no product name/.test(await caught(make(merchant()).push(items, { source: OURS, names: {} }))), 'google push without a stored name throws');
    eq(await make(merchant()).push([], { source: OURS, names }), { ok: true }, 'google push of nothing is ok');

    // read: one GET per slug, a 404 is null and the others still come back
    const h5 = merchant({ products: [product('MNG-ORIGINAL-250', { price: { amountMicros: '300000000', currencyCode: 'INR' }, salePrice: { amountMicros: '259000000', currencyCode: 'INR' } }), product('MNG-AJWAIN-250', { availability: 'OUT_OF_STOCK' })] });
    const got = await make(h5).read(['atta-original', 'atta-kesari', 'atta-ajwain', 'atta-lite-sugar'], names);
    eq(hits(h5, 'GET', `${PR}/en~IN~MNG-ORIGINAL-250`).length + hits(h5, 'GET', `${PR}/en~IN~MNG-KESARI-250`).length + hits(h5, 'GET', `${PR}/en~IN~MNG-AJWAIN-250`).length, 3, 'google read: one GET per known slug');
    eq(got['atta-original'], { availability: 'in stock', price: 259, mrp: 300, title: 'MNG-ORIGINAL-250' }, 'google read: product mapped to a state');
    eq(got['atta-kesari'], null, 'google read: a 404 is null');
    eq(got['atta-ajwain'].availability, 'out of stock', 'google read: the slug after a 404 is still read');
    eq(got['atta-lite-sugar'], null, 'google read: a slug with no stored name is null');
    eq(h5.calls.filter((c) => c.method === 'GET').length, 3, 'google read: no call for the slug with no name');
    eq(await make(merchant()).read(['full-range-set'], names), {}, 'google read ignores a slug that is not a catalogue item');
    const h5b = merchant({ products: three() }); h5b.productError = httpErr(500, 'Backend Error');
    eq(await caught(make(h5b).read(['atta-original'], names)), 'google: Backend Error', 'google read: only a 404 is null, anything else throws');

    // failures carry Google's message only, never the key, the token or the assertion
    const secretNet = merchant(); secretNet.insertError = () => new Error('timeout of 20000ms exceeded');
    eq(await caught(make(secretNet).push(items.slice(0, 1), { source: OURS, names })), 'google: atta-kesari: timeout of 20000ms exceeded', 'google: a network error carries its own message');
    const hBody = async (cfg) => { if (cfg.url === TOKEN_URL) return { data: { access_token: 'AT-SECRET', expires_in: 3600 } }; return { data: { error: { message: 'Bad request' } } }; };
    eq(await caught(make(hBody).read(['atta-original'], names)), 'google: Bad request', 'google: an error body in a 200 reply throws');
    const hLeak = async (cfg) => { if (cfg.url === TOKEN_URL) return { data: { access_token: 'AT-SECRET', expires_in: 3600 } }; throw httpErr(401, `Rejected AT-SECRET and ${PEM}`); };
    const leak = await caught(make(hLeak).read(['atta-original'], names));
    ok(typeof leak === 'string' && leak.startsWith('google: ') && !leak.includes('AT-SECRET') && !leak.includes('PRIVATE KEY'), 'google: the access token and the key are scrubbed out of an error message');
    const hTok = async () => { throw Object.assign(new Error('Request failed with status code 400'), { response: { status: 400, data: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } } }); };
    eq(await caught(make(hTok).token()), 'google: Invalid JWT Signature.', 'google token: a token endpoint error carries its description');
    const hAll = merchant({ sources: [sheet(5)], products: three() });
    const gAll = make(hAll); await gAll.setup(); await gAll.push(items.slice(0, 1), { source: OURS, names }); await gAll.read(['atta-original'], names);
    const merchantCalls = hAll.calls.filter((c) => c.url !== TOKEN_URL);
    ok(merchantCalls.length > 5 && merchantCalls.every((c) => /^Bearer AT-\d+$/.test(c.headers.Authorization) && c.timeout === 20000), 'google: every Merchant call has a bearer token and a 20 s timeout');
    ok(!JSON.stringify(merchantCalls.map((c) => [c.url, c.params, c.data])).includes('AT-'), 'google: the access token is in the header and nowhere else');
    ok(!JSON.stringify(hAll.calls.map((c) => [c.url, c.params, c.data, c.headers])).includes('PRIVATE KEY'), 'google: the private key is never sent anywhere');

    // not configured: nothing calls out
    const hOff = merchant();
    const badKeys = { none: { keyJson: '' }, 'not json': { keyJson: '{"private_key": "SECRETBITS' }, 'no client_email': { keyJson: JSON.stringify({ private_key: PEM }) }, 'no private_key': { keyJson: JSON.stringify({ client_email: 'a@b' }) }, 'no account': { accountId: '' } };
    Object.keys(badKeys).forEach((k) => ok(make(hOff, badKeys[k]).configured() === false, `google configured() is false with ${k}`));
    const offMsgs = [await caught(make(hOff, badKeys['not json']).token()), await caught(make(hOff, badKeys['no account']).setup()), await caught(make(hOff, badKeys.none).read(['atta-original'], names)), await caught(make(hOff, badKeys.none).push(items, { source: OURS, names }))];
    ok(offMsgs.every((m) => /^google: .*not set/.test(m) && !m.includes('SECRETBITS')), 'google: every call refuses when not configured, without echoing the key');
    eq(hOff.calls.length, 0, 'google not configured never calls http');

    // defaults: the real key and account come from the environment at call time
    const was = [process.env.GOOGLE_MERCHANT_KEY, process.env.GOOGLE_MERCHANT_ID];
    delete process.env.GOOGLE_MERCHANT_KEY; delete process.env.GOOGLE_MERCHANT_ID; const offByEnv = google.client().configured();
    process.env.GOOGLE_MERCHANT_KEY = keyJson; process.env.GOOGLE_MERCHANT_ID = '1'; const onByEnv = google.client().configured();
    if (was[0] === undefined) delete process.env.GOOGLE_MERCHANT_KEY; else process.env.GOOGLE_MERCHANT_KEY = was[0];
    if (was[1] === undefined) delete process.env.GOOGLE_MERCHANT_ID; else process.env.GOOGLE_MERCHANT_ID = was[1];
    ok(offByEnv === false && onByEnv === true, 'google client() reads GOOGLE_MERCHANT_KEY and GOOGLE_MERCHANT_ID');
  }

  console.log(`channel-sync-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
