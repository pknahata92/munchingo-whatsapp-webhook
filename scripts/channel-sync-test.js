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
    ok(c2.data.allow_upsert === false, 'meta push: allow_upsert is false, so an UPDATE never creates a missing item (Graph default is true)');
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
    const hBlank = merchant({ sources: [Object.assign(sheet(5), { primaryProductDataSource: { defaultRule: { takeFromDataSources: [] } } })], products: three() });
    await make(hBlank).setup();
    eq(hits(hBlank, 'PATCH', `${DS}/5`)[0].data.primaryProductDataSource.defaultRule.takeFromDataSources, [{ supplementalDataSourceName: OURS }, { self: true }], 'google setup: an empty rule [] becomes ours then the sheet');

    // which primary gets ours first: any primary that already has ours first is enough; otherwise the one FILE primary (a Google Sheet if there are several)
    const primary = (id, input, extra) => Object.assign({ name: `accounts/1/dataSources/${id}`, displayName: `Primary ${id}`, input, primaryProductDataSource: { defaultRule: { takeFromDataSources: [{ self: true }] } } }, extra);
    const gsheet = (id) => primary(id, 'FILE', { fileInput: { fileInputType: 'GOOGLE_SHEETS' } });
    const hAuto = merchant({ sources: [primary(4, 'AUTOFEED'), gsheet(5)], products: three() });
    const rAuto = await make(hAuto).setup();
    ok(rAuto.source === OURS && hits(hAuto, 'PATCH', `${DS}/5`).length === 1 && hits(hAuto, 'PATCH', `${DS}/4`).length === 0, 'google setup: an AUTOFEED primary beside one Google Sheet: the Sheet gets ours first, the autofeed is left alone');
    const hFiles = merchant({ sources: [primary(6, 'FILE', { fileInput: { fileInputType: 'FETCH' } }), gsheet(5)], products: three() });
    await make(hFiles).setup();
    ok(hits(hFiles, 'PATCH', `${DS}/5`).length === 1 && hits(hFiles, 'PATCH', `${DS}/6`).length === 0, 'google setup: two FILE primaries, one a Google Sheet: the Sheet is used');
    const oursFirst = primary(5, 'FILE', { primaryProductDataSource: { defaultRule: { takeFromDataSources: [{ supplementalDataSourceName: OURS }, { self: true }] } } });
    const hFirst = merchant({ sources: [{ name: OURS, displayName: 'Munchingo admin stock', supplementalProductDataSource: {} }, oursFirst, primary(6, 'FILE')], products: three() });
    const rFirst = await make(hFirst).setup();
    ok(rFirst.steps.includes('Already first') && hFirst.calls.filter((c) => c.method === 'PATCH').length === 0, 'google setup: two primaries, one already has ours first: "Already first", no PATCH (' + JSON.stringify(rFirst.steps) + ')');
    const hApi = merchant({ sources: [sheet(5), { name: 'accounts/1/dataSources/6', displayName: 'Api primary', input: 'API', primaryProductDataSource: {} }], products: three() });
    ok((await make(hApi).setup()).source === OURS && hits(hApi, 'PATCH', `${DS}/5`).length === 1, 'google setup: an API primary is not counted as a sheet');
    const hTwo = merchant({ sources: [sheet(5), sheet(6)], products: three() });
    const twoMsg = await caught(make(hTwo).setup());
    ok(/found 2 sheet data sources, expected 1; link "Munchingo admin stock" by hand in Merchant Center/.test(twoMsg), 'google setup: two sheets stop with the by-hand message');
    eq(hits(hTwo, 'PATCH', `${DS}/5`).length + hits(hTwo, 'PATCH', `${DS}/6`).length, 0, 'google setup: two sheets patch nothing');
    ok(/found 0 sheet data sources/.test(await caught(make(merchant({ sources: [], products: three() })).setup())), 'google setup: no sheet stops too');
    ok(/found 0 sheet data sources/.test(await caught(make(merchant({ sources: [primary(4, 'AUTOFEED')], products: three() })).setup())), 'google setup: an autofeed alone is not a sheet');
    // a failure brings back the steps done before it, for the owner's set-up panel
    let stopped = null; try { await make(merchant({ sources: [sheet(5), sheet(6)], products: three() })).setup(); } catch (e) { stopped = e; }
    eq(stopped && stopped.steps, ['Registered with Google', 'Created the source "Munchingo admin stock"'], 'google setup: the error carries the steps done before it stopped');

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

  // ---- engine: push on change, read-back, alerts, modes (fake clients, in-memory state, fake clock and timers; no network) ----
  {
    const sync = require(path.join(root, 'utils/channelSync.js'));
    const { SLUGS, GOOGLE_OFFER_IDS, toMeta } = shape;
    const MIN = 60000; const T0 = Date.UTC(2026, 10, 3, 5, 0);
    const SOURCE = 'accounts/1/dataSources/77';
    const NAMES = Object.fromEntries(SLUGS.map((s) => [s, `en~IN~${GOOGLE_OFFER_IDS[s]}`]));
    const OWNER = { email: 'owner@example.test', name: 'Owner', role: 'owner' };
    const settle = () => new Promise((r) => setImmediate(r));
    const clone = (x) => JSON.parse(JSON.stringify(x));
    const rejects = async (p) => { try { await p; return false; } catch (e) { return true; } };
    const throwsMsg = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

    // A fake channel: `shown` is what it holds (all four in stock at the built-in prices); a push lands there unless `lag` is on.
    function fakeChannel(label) {
      const ch = { on: true, lag: false, missing: new Set(), omit: new Set(), pushFails: 0, readFails: 0, reads: [], pushes: [], setups: 0,
        shown: Object.fromEntries(SLUGS.map((s) => [s, { availability: 'in stock', price: P[s].price, mrp: P[s].mrp }])) };
      ch.configured = () => ch.on;
      ch.read = async (slugs, names) => {
        ch.reads.push({ slugs: slugs.slice(), names });
        if (ch.readFails > 0) { ch.readFails--; throw new Error(`${label}: read refused`); }
        const o = {}; slugs.filter((s) => !ch.omit.has(s)).forEach((s) => { o[s] = ch.missing.has(s) ? null : { ...ch.shown[s] }; }); return o;
      };
      ch.push = async (items, opts) => {
        ch.pushes.push({ items: clone(items), opts: opts && clone(opts) });
        if (ch.pushFails > 0) { ch.pushFails--; throw new Error(`${label}: Invalid OAuth access token`); }
        if (!ch.lag) items.forEach(({ slug, state }) => { ch.shown[slug] = { ...state }; });
        return { ok: true };
      };
      ch.setup = async () => { ch.setups++; await settle(); return { registered: true, source: SOURCE, names: { ...NAMES }, missing: [], steps: ['Registered with Google'] }; };
      return ch;
    }
    // One test world: both channels in `mode` (Google set up) unless `state` says otherwise; `deps` replaces any fake.
    function world({ state, mode = 'all', out = [], deps = {} } = {}) {
      const w = { t: T0, out: new Set(out), table: clone(P), pricesOn: true, stockOn: true, timers: [], logs: [], mails: [], saves: 0, mailFails: 0, meta: fakeChannel('meta'), google: fakeChannel('google') };
      const initial = state !== undefined ? state : { meta: { mode, items: {} }, google: { mode, source: SOURCE, names: NAMES, items: {} } };
      w.stored = initial == null ? null : JSON.stringify(initial);
      sync.setDeps(Object.assign({
        meta: w.meta, google: w.google,
        load: async () => (w.stored == null ? null : JSON.parse(w.stored)),
        save: async (s) => { w.saves++; w.stored = JSON.stringify(s); },
        stock: { refresh: async () => {}, soldOutSlugs: () => (w.stockOn ? [...w.out] : null) },
        prices: { refresh: async () => {}, isOn: () => w.pricesOn, current: () => (w.pricesOn ? w.table : null) },
        isAvailable: (s) => !w.out.has(s),
        mail: async (a) => { if (w.mailFails > 0) { w.mailFails--; throw new Error('Resend is down'); } w.mails.push(clone(a)); },
        now: () => w.t,
        setTimer: (fn, ms) => { w.timers.push({ fn, ms }); return w.timers.length; },
        log: { info: (m) => w.logs.push(m), error: (m) => w.logs.push(m) },
      }, deps));
      w.fire = async () => { w.timers.splice(0).forEach((x) => x.fn()); await settle(); };
      w.at = (min) => { w.t = T0 + min * MIN; };
      w.item = (ch, slug) => (JSON.parse(w.stored)[ch].items[slug] || {});
      w.pushed = (ch) => w[ch].pushes.map((p) => p.items.map((i) => i.slug));
      return w;
    }
    let w; let s;

    // no saved state: both channels start off, even with a token; nothing is read or pushed
    w = world({ state: null });
    s = await sync.status();
    ok(s.meta.mode === 'off' && s.google.mode === 'off' && s.meta.on === false && s.google.on === false, 'engine: with no saved state both channels start off');
    eq([s.meta.why, s.google.why], ['switched off', 'not set up'], 'engine: Meta switched off, Google not set up');
    await sync.sweepOnce(); w.out.add('atta-kesari'); sync.nudge('pause'); await w.fire();
    ok(w.meta.reads.length + w.meta.pushes.length + w.google.reads.length + w.google.pushes.length === 0, 'engine: nothing is read or pushed while off');

    // a change pushes only that item; the same state again pushes nothing
    w = world();
    let r = await sync.sweepOnce();
    ok(w.meta.reads.length === 1 && w.google.reads.length === 1 && w.meta.pushes.length === 0 && w.google.pushes.length === 0, 'engine: a sweep reads both channels and pushes nothing when they match');
    eq(r, { meta: { pushed: [], errors: [] }, google: { pushed: [], errors: [] } }, 'engine: runOnce reports what it pushed per channel');
    eq(w.google.reads[0].names, NAMES, 'engine: Google is read with the stored product names');
    w.out.add('atta-kesari'); sync.nudge('pause');
    eq(w.timers.map((x) => x.ms), [3000], 'engine: a nudge waits 3 s');
    ok(w.meta.pushes.length === 0, 'engine: nothing is pushed before the 3 s are up');
    await w.fire();
    eq(w.pushed('meta'), [['atta-kesari']], 'engine: Kesari out of stock pushes only Kesari to Meta, once');
    eq(w.pushed('google'), [['atta-kesari']], 'engine: and only Kesari to Google, once');
    eq(w.meta.pushes[0].items[0].state, { availability: 'out of stock', price: 299, mrp: 350 }, 'engine: the pushed state is the public state');
    eq(w.google.pushes[0].opts, { source: SOURCE, names: NAMES }, 'engine: Google pushes go to the stored source with the stored names');
    ok(w.item('meta', 'atta-kesari').pushed.availability === 'out of stock' && w.item('meta', 'atta-kesari').pushedAt === T0, 'engine: pushed and pushedAt are saved');
    sync.nudge('again'); await w.fire();
    ok(w.meta.pushes.length === 1 && w.google.pushes.length === 1, 'engine: a second nudge with the same state pushes nothing');

    // a burst: 20 nudges before the timer fires make exactly one run (and one push)
    let runs = 0;
    w = world({ deps: { runOnce: async () => { runs++; return {}; } } });
    for (let i = 0; i < 20; i++) sync.nudge('take');
    eq(w.timers.length, 1, 'engine: 20 nudges set one timer');
    await w.fire();
    eq(runs, 1, 'engine: 20 nudges inside the window make exactly one runOnce');
    w = world(); await sync.sweepOnce(); w.out.add('atta-kesari');
    for (let i = 0; i < 20; i++) sync.nudge('bulk-pack');
    await w.fire();
    eq(w.meta.pushes.length, 1, 'engine: a burst of 20 changes gives one Meta push');

    // a nudge during a run schedules exactly one more run after it
    runs = 0; const gates = [];
    w = world({ deps: { runOnce: async () => { runs++; await new Promise((res) => gates.push(res)); return {}; } } });
    sync.nudge('a'); await w.fire();
    eq(runs, 1, 'engine: the first nudge starts a run');
    sync.nudge('b'); await w.fire(); sync.nudge('c'); await w.fire();
    eq(runs, 1, 'engine: nudges during a run wait for it');
    gates.shift()(); await settle();
    eq(runs, 2, 'engine: one more run starts when the first ends');
    gates.shift()(); await settle();
    ok(runs === 2 && gates.length === 0, 'engine: exactly one more run, not one per nudge');

    // cold start or a database hiccup: nothing is pushed on a guess
    w = world(); w.stockOn = false; w.out.add('atta-kesari');
    eq(await sync.runOnce({ readBack: true, reason: 'test' }), { skipped: 'stock or prices not loaded' }, 'engine: stock not loaded skips the run');
    sync.nudge('pause'); await w.fire();
    w.stockOn = true; w.pricesOn = false;
    eq(await sync.runOnce({ readBack: false, reason: 'test' }), { skipped: 'stock or prices not loaded' }, 'engine: prices not loaded skips the run');
    ok(w.meta.reads.length + w.meta.pushes.length + w.google.reads.length + w.google.pushes.length === 0 && w.saves === 0, 'engine: a skipped run calls no client and saves nothing');

    // modes: off (even with a token), test (Original only), token not set
    w = world({ mode: 'off' }); w.out.add('atta-kesari');
    await sync.sweepOnce(); sync.nudge('pause'); await w.fire();
    ok(w.meta.reads.length + w.meta.pushes.length + w.google.reads.length + w.google.pushes.length === 0, 'engine: mode off with a token reads and pushes nothing');
    eq((await sync.status()).meta.why, 'switched off', 'engine: mode off says switched off');
    w = world({ mode: 'test' });
    SLUGS.forEach((x) => { w.meta.shown[x].availability = 'out of stock'; w.google.shown[x].availability = 'out of stock'; });
    await sync.sweepOnce();
    eq([w.meta.reads[0].slugs, w.google.reads[0].slugs], [['atta-original'], ['atta-original']], 'engine: mode test reads only Original');
    eq([w.pushed('meta'), w.pushed('google')], [[['atta-original']], [['atta-original']]], 'engine: mode test pushes only Original');
    w.out.add('atta-kesari'); sync.nudge('pause'); await w.fire();
    ok(w.meta.pushes.length === 1 && w.google.pushes.length === 1, 'engine: mode test ignores a Kesari change');
    w = world(); w.meta.on = false; w.out.add('atta-kesari');
    ok(!(await rejects(sync.sweepOnce())), 'engine: a channel with no token does not make the run fail');
    ok(w.meta.reads.length === 0 && w.meta.pushes.length === 0, 'engine: no token, Meta is not called');
    eq(w.pushed('google'), [['atta-kesari']], 'engine: no Meta token, Google still pushes');
    s = await sync.status();
    ok(s.meta.why === 'token not set' && s.meta.on === false && s.google.why === 'waiting for Google to update' && s.google.on === true, 'engine: status says token not set for Meta; Google, just pushed, is waiting for Google to update');

    // retry after a failed push: the next sweep pushes again, fails resets once the read-back matches
    w = world(); await sync.sweepOnce();
    w.meta.pushFails = 1; w.out.add('atta-kesari'); sync.nudge('pause'); await w.fire();
    ok(w.item('meta', 'atta-kesari').fails === 1 && /Invalid OAuth/.test(w.item('meta', 'atta-kesari').lastError) && w.item('meta', 'atta-kesari').pushed.availability === 'in stock', 'engine: a failed push counts a failure and keeps the old pushed state');
    ok(w.logs.some((l) => /^\[CHANNELS\] meta: .*Invalid OAuth/.test(l)), 'engine: a failed push is logged with [CHANNELS]');
    w.at(15); await sync.sweepOnce();
    ok(w.meta.pushes.length === 2 && w.meta.pushes[1].items[0].slug === 'atta-kesari', 'engine: the next sweep pushes the failed item again');
    eq(w.item('meta', 'atta-kesari').fails, 1, 'engine: a successful push keeps the failure count until the read-back matches');
    w.at(30); await sync.sweepOnce();
    ok(w.item('meta', 'atta-kesari').fails === 0 && w.meta.pushes.length === 2, 'engine: the matching read-back resets fails, with no further push');
    const longErr = 'x'.repeat(500);
    w.meta.push = async () => { throw new Error(`meta: ${longErr}`); }; w.out.delete('atta-kesari'); sync.nudge('receive'); await w.fire();
    eq(w.item('meta', 'atta-kesari').lastError.length, 200, 'engine: lastError is cut to 200 characters');

    // a hand edit in Commerce Manager is pushed back, but not within 20 min of our last push
    w = world({ out: ['atta-kesari'] });
    w.meta.shown['atta-kesari'].availability = 'out of stock'; w.google.shown['atta-kesari'].availability = 'out of stock';
    await sync.sweepOnce();
    w.out.delete('atta-kesari'); sync.nudge('receive'); await w.fire();
    eq(w.pushed('meta'), [['atta-kesari']], 'engine: restocked Kesari pushed at t=0');
    w.meta.shown['atta-kesari'].availability = 'out of stock';
    w.at(10); await sync.sweepOnce();
    eq(w.meta.pushes.length, 1, 'engine: a hand edit seen 10 min after our push is not pushed yet');
    w.at(21); await sync.sweepOnce();
    ok(w.meta.pushes.length === 2 && JSON.stringify(w.meta.pushes[1].items) === JSON.stringify([{ slug: 'atta-kesari', state: { availability: 'in stock', price: 299, mrp: 350 } }]), 'engine: at 21 min the hand edit is pushed back');
    eq(w.mails.length, 0, 'engine: no alert for a hand edit fixed inside 30 min');

    // Google lags behind a push: no re-push before 20 min, no alert before 30, one alert per episode
    w = world(); await sync.sweepOnce();
    w.google.lag = true; w.out.add('atta-kesari'); sync.nudge('pause'); await w.fire();
    eq(w.google.pushes.length, 1, 'engine: Google push at t=0');
    w.at(15); await sync.sweepOnce();
    ok(w.google.pushes.length === 1 && w.mails.length === 0, 'engine: Google still shows the old value at 15 min: no push, no alert');
    s = await sync.status();
    ok(s.google.why === 'waiting for Google to update' && s.google.problems.length === 0 && s.meta.why === 'matches', 'engine: status says waiting for Google to update, Meta matches');
    eq(s.google.checkedAt, new Date(T0 + 15 * MIN).toISOString(), 'engine: checkedAt is the time of the last read-back');
    w.at(31); await sync.sweepOnce();
    eq(w.mails.length, 1, 'engine: still mismatched at 31 min: one alert');
    eq(w.mails[0], { channel: 'google', problems: [{ slug: 'atta-kesari', name: 'Atta Kesari', text: 'Atta Kesari shows in stock; the admin says out of stock' }] }, 'engine: the alert names the channel and the problem');
    s = await sync.status();
    ok(s.google.why === 'problem' && s.google.problems.length === 1, 'engine: a mismatch over 30 min is a problem');
    w.at(46); await sync.sweepOnce();
    eq(w.mails.length, 1, 'engine: still mismatched at 46 min: no second alert');
    w.google.lag = false; w.google.shown['atta-kesari'] = { availability: 'out of stock', price: 299, mrp: 350 };
    w.at(50); await sync.sweepOnce();
    ok(!('alertedAt' in w.item('google', 'atta-kesari')) && !('mismatchSince' in w.item('google', 'atta-kesari')), 'engine: the matching read-back clears alertedAt and mismatchSince');
    eq((await sync.status()).google.why, 'matches', 'engine: Google matches again');

    // a revoked token: three failures in a row send one alert; a fourth sends none; the other channel carries on
    w = world(); await sync.sweepOnce();
    w.meta.pushFails = 99; w.out.add('atta-kesari'); sync.nudge('pause'); await w.fire();
    w.at(1); await sync.sweepOnce();
    eq(w.mails.length, 0, 'engine: two failures, no alert yet');
    w.at(2); await sync.sweepOnce();
    eq(w.mails.length, 1, 'engine: the third failure in a row sends one alert');
    eq(w.mails[0].problems, [{ slug: 'atta-kesari', name: 'Atta Kesari', text: 'Meta did not accept the change: Invalid OAuth access token' }], 'engine: the alert says Meta did not accept the change');
    s = await sync.status();
    ok(s.meta.why === 'problem' && s.meta.problems.length === 1 && s.meta.items['atta-kesari'].fails === 3, 'engine: status shows the failing item as a problem');
    w.at(3); await sync.sweepOnce();
    ok(w.mails.length === 1 && w.item('meta', 'atta-kesari').fails === 4, 'engine: a fourth failure sends no second alert');
    ok(w.google.pushes.length === 1 && w.item('google', 'atta-kesari').pushed.availability === 'out of stock', 'engine: Google is unaffected by Meta failing');
    ok(w.logs.some((l) => l.startsWith('[CHANNELS] meta: alert sent')), 'engine: the alert is logged');

    // a throwing mailer is logged and never rejects the run; the alert goes once mail works again
    w = world(); await sync.sweepOnce();
    w.meta.pushFails = 99; w.mailFails = 1; w.out.add('atta-kesari'); sync.nudge('pause'); await w.fire();
    w.at(1); await sync.sweepOnce(); w.at(2);
    ok(!(await rejects(sync.sweepOnce())), 'engine: a throwing mailer does not reject runOnce');
    ok(w.mails.length === 0 && w.logs.some((l) => l.startsWith('[CHANNELS]') && l.includes('Resend is down')), 'engine: the mail failure is logged with [CHANNELS]');
    w.at(3); await sync.sweepOnce();
    eq(w.mails.length, 1, 'engine: the alert is sent on the next run once mail works');

    // a product missing in a channel: reported, never pushed, the other three still sync
    w = world();
    w.google.missing.add('atta-lite-sugar'); w.meta.omit.add('atta-lite-sugar');
    SLUGS.forEach((x) => { w.google.shown[x].availability = 'out of stock'; });
    await sync.sweepOnce();
    eq(w.pushed('google'), [['atta-original', 'atta-kesari', 'atta-ajwain']], 'engine: the other three are pushed to Google');
    s = await sync.status();
    eq(s.google.problems, [{ slug: 'atta-lite-sugar', name: 'Atta Sugar-Lite', text: 'not found in Google: MNG-LITE-250' }], 'engine: not found in Google: MNG-LITE-250');
    eq(s.meta.problems, [{ slug: 'atta-lite-sugar', name: 'Atta Sugar-Lite', text: 'not found in Meta: vf5p90bcy5' }], 'engine: a key missing from the Meta read is not found too');
    ok(s.google.why === 'problem' && s.meta.why === 'problem', 'engine: a missing product is a problem');
    w.out.add('atta-lite-sugar'); sync.nudge('pause'); await w.fire();
    w.at(31); await sync.sweepOnce();
    ok([...w.meta.pushes, ...w.google.pushes].every((p) => p.items.every((i) => i.slug !== 'atta-lite-sugar')), 'engine: no push ever contains the missing product, not even after a change');
    ok(w.mails.some((m) => m.channel === 'google' && m.problems.some((p) => p.text === 'not found in Google: MNG-LITE-250')), 'engine: a missing product is alerted once after 30 min');

    // no MRP: availability only, and prices are not compared
    w = world(); await sync.sweepOnce();
    w.table['atta-original'] = { price: 259, mrp: null }; w.out.add('atta-original'); sync.nudge('price'); await w.fire();
    eq(w.meta.pushes[0].items[0].state, { availability: 'out of stock', price: 259, mrp: null }, 'engine: Original with no MRP is pushed with mrp null');
    eq(toMeta('atta-original', w.meta.pushes[0].items[0].state), { id: '91slwpjdqq', availability: 'out of stock' }, 'engine: so only availability goes to Meta');
    ok(w.logs.includes('[CHANNELS] meta: price not synced: no MRP (atta-original)') && w.logs.includes('[CHANNELS] google: price not synced: no MRP (atta-original)'), 'engine: logs price not synced: no MRP');
    w.meta.shown['atta-original'] = { availability: 'out of stock', price: 999, mrp: 1200 };
    w.at(25); await sync.sweepOnce();
    ok(w.meta.pushes.length === 1 && !('mismatchSince' in w.item('meta', 'atta-original')), 'engine: with no MRP the channel prices are ignored: it matches, no re-push');

    // prices come from the same table as the website, and go out through the real Meta client
    const wire = [];
    const realMeta = require(path.join(root, 'utils/channels/meta.js')).makeMeta({ http: async (cfg) => { wire.push(cfg); return { data: { handles: ['h'] } }; }, token: 'test-token' });
    const want0 = shape.publicState({ isAvailable: () => true, prices: P });
    const seeded = (mode) => ({ meta: { mode, items: Object.fromEntries(SLUGS.map((x) => [x, { pushed: want0[x], pushedAt: T0 }])) }, google: { mode: 'off', source: null, names: {}, items: {} } });
    w = world({ state: seeded('all'), deps: { meta: realMeta } });
    w.table['atta-original'] = { price: 249, mrp: 300 }; sync.nudge('price'); await w.fire();
    const reqs = wire.length === 1 ? JSON.parse(wire[0].data.requests) : [];
    eq(reqs, [{ method: 'UPDATE', data: { id: '91slwpjdqq', availability: 'in stock', price: '300.00 INR', sale_price: '249.00 INR' } }], "engine: a price change pushes sale_price '249.00 INR' for Original only");

    // nudge and every other call never throw into the caller
    w = world({ deps: { runOnce: () => { throw new Error('boom'); } } });
    eq(throwsMsg(() => sync.nudge('x')), null, 'engine: nudge returns even when the run throws');
    await w.fire();
    ok(w.logs.some((l) => l.startsWith('[CHANNELS]') && l.includes('boom')), 'engine: the run error is logged with [CHANNELS]');
    w = world({ deps: { setTimer: () => { throw new Error('no timers'); } } });
    ok(throwsMsg(() => sync.nudge('x')) === null && w.logs.some((l) => l.startsWith('[CHANNELS]') && l.includes('no timers')), 'engine: nudge returns even when the timer cannot be set');
    w = world({ deps: { load: async () => { throw new Error('db down'); } } });
    eq(await sync.runOnce({ readBack: true }), { skipped: 'state not loaded' }, 'engine: a state that cannot be read skips the run');
    ok(w.meta.reads.length + w.meta.pushes.length === 0 && w.saves === 0, 'engine: and pushes and saves nothing (modes are never lost to a hiccup)');
    ok(!(await rejects(sync.status())) && !(await rejects(sync.setMode('meta', 'all', OWNER))) && !(await rejects(sync.setupGoogle(OWNER))), 'engine: status, setMode and setupGoogle do not reject when the state cannot be read');
    w = world({ deps: { save: async () => { throw new Error('write refused'); } } });
    ok(!(await rejects(sync.sweepOnce())) && w.logs.some((l) => l.startsWith('[CHANNELS]') && l.includes('write refused')), 'engine: a save failure is logged, not thrown');
    w = world(); w.meta.readFails = 1;
    ok(!(await rejects(sync.sweepOnce())) && w.item('meta', 'atta-original').fails === 1 && w.google.reads.length === 1, 'engine: a failed read is counted, logged and the other channel still runs');
    ok(w.logs.every((l) => l.startsWith('[CHANNELS] ')), 'engine: every log line starts with [CHANNELS]');

    // setMode: validation, audit trail, an immediate read-back when switched on
    w = world({ state: null });
    const why = async (p) => { try { await p; return ''; } catch (e) { return e.message; } };
    ok(/meta or google/.test(await why(sync.setMode('x', 'all', OWNER))), 'engine: setMode refuses a channel other than meta or google');
    ok(/off, test or all/.test(await why(sync.setMode('meta', 'on', OWNER))), 'engine: setMode refuses a mode outside off, test or all');
    ok(w.saves === 0 && w.meta.reads.length === 0, 'engine: a refused setMode changes nothing');
    s = await sync.setMode('meta', 'test', OWNER);
    ok(s.meta.mode === 'test' && s.meta.on === true && s.meta.why === 'matches', 'engine: setMode test returns the new status');
    eq(w.meta.reads.map((x) => x.slugs), [['atta-original']], 'engine: switching to test reads Original back straight away');
    ok(s.meta.items['atta-original'].shown.availability === 'in stock' && s.meta.items['atta-original'].pushed.availability === 'in stock', 'engine: the read-back is in the status');
    const st0 = JSON.parse(w.stored);
    ok(st0.meta.modeBy === 'owner@example.test' && typeof st0.meta.modeAt === 'string' && st0.google.mode === 'off', 'engine: setMode records who switched it, and leaves Google off');
    s = await sync.setMode('meta', 'off', OWNER);
    ok(s.meta.why === 'switched off' && w.meta.reads.length === 1, 'engine: switching off reads nothing');

    // setupGoogle: one setup at a time, the result saved into the state
    w = world({ state: null });
    const [g1, g2] = await Promise.all([sync.setupGoogle(OWNER), sync.setupGoogle(OWNER)]);
    ok(w.google.setups === 1 && g1 === g2 && g1.source === SOURCE, 'engine: two setupGoogle calls at once run one setup and share its result');
    const st1 = JSON.parse(w.stored).google;
    ok(st1.source === SOURCE && JSON.stringify(st1.names) === JSON.stringify(NAMES) && st1.mode === 'off', 'engine: the source and product names are saved, mode stays off');
    eq((await sync.status()).google.why, 'switched off', 'engine: after setup Google is switched off, no longer not set up');
    w.google.setup = async () => { throw new Error('google: The caller does not have permission'); };
    const g3 = await sync.setupGoogle(OWNER);
    ok(g3 && /permission/.test(g3.error) && JSON.parse(w.stored).google.source === SOURCE, 'engine: a failed setup returns the error and keeps the saved source');

    // startSweep: first run at 3 min, then every 15 min; a second call does nothing
    w = world();
    sync.startSweep(); sync.startSweep();
    eq(w.timers.map((x) => x.ms), [180000], 'engine: the first sweep is set for 3 min, once');
    await w.fire();
    ok(w.meta.reads.length === 1 && w.google.reads.length === 1, 'engine: the sweep reads both channels back');
    eq(w.timers.map((x) => x.ms), [900000], 'engine: then every 15 min');
    await w.fire();
    ok(w.meta.reads.length === 2 && w.timers.length === 1, 'engine: and again');

    // the real state store: stock_settings key channel_sync, a JSON string (database stubbed; no network)
    {
      const dbPath = require.resolve(path.join(root, 'utils/database.js')); const had = require.cache[dbPath];
      const calls = []; const row = { value: null, error: null };
      const q = {
        select: (c) => { calls.push(['select', c]); return q; },
        eq: (k, v) => { calls.push(['eq', k, v]); return q; },
        maybeSingle: async () => ({ data: row.value == null ? null : { value: row.value }, error: row.error }),
        upsert: async (x) => { calls.push(['upsert', x]); row.value = x.value; return { error: null }; },
      };
      require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { client: () => ({ from: (t) => { calls.push(['from', t]); return q; } }) } };
      w = world();
      const d = {}; ['meta', 'google', 'stock', 'prices', 'isAvailable', 'mail', 'now', 'setTimer', 'log'].forEach((k) => { d[k] = { meta: w.meta, google: w.google, stock: { refresh: async () => {}, soldOutSlugs: () => [] }, prices: { refresh: async () => {}, isOn: () => true, current: () => P }, isAvailable: () => true, mail: async () => {}, now: () => T0, setTimer: () => 0, log: { info: (m) => w.logs.push(m), error: (m) => w.logs.push(m) } }[k]; });
      sync.setDeps(d);
      await sync.setMode('meta', 'test', OWNER);
      const up = calls.filter((c) => c[0] === 'upsert');
      ok(calls.some((c) => c[0] === 'from' && c[1] === 'stock_settings') && calls.some((c) => c[0] === 'select' && c[1] === 'value') && calls.some((c) => c[0] === 'eq' && c[1] === 'key' && c[2] === 'channel_sync'), 'engine: the state is read from stock_settings key channel_sync');
      ok(up.length >= 1 && up.every((c) => c[1].key === 'channel_sync' && typeof c[1].value === 'string') && JSON.parse(row.value).meta.mode === 'test', 'engine: the state is saved as a JSON string under channel_sync');
      eq((await sync.status()).meta.mode, 'test', 'engine: status reads the saved state back');
      row.error = { message: 'relation does not exist' };
      eq(await sync.runOnce({ readBack: true }), { skipped: 'state not loaded' }, 'engine: a database error on load skips the run');
      if (had) require.cache[dbPath] = had; else delete require.cache[dbPath];
    }
    sync.setDeps(null);

    // the owner alert email (Resend stubbed; no network)
    {
      const resendPath = require.resolve('resend', { paths: [path.join(root, 'utils')] });
      const mailerPath = require.resolve(path.join(root, 'utils/mailer.js'));
      const keep = { resend: require.cache[resendPath], mailer: require.cache[mailerPath], to: process.env.NOTIFY_EMAIL };
      const sent = []; let reply = { error: null };
      require.cache[resendPath] = { id: resendPath, filename: resendPath, loaded: true, exports: { Resend: class { constructor() { this.emails = { send: async (p) => { sent.push(p); return reply; } }; } } } };
      delete require.cache[mailerPath]; process.env.NOTIFY_EMAIL = 'owner@example.test';
      const mailer = require(mailerPath);
      ok(typeof mailer.sendChannelSyncAlert === 'function', 'mailer exports sendChannelSyncAlert');
      await mailer.sendChannelSyncAlert({ channel: 'meta', problems: [{ slug: 'atta-kesari', name: 'Atta Kesari', text: 'Atta Kesari shows in stock; the admin says out of stock' }] });
      eq(sent[0] && [sent[0].subject, sent[0].to], ['Meta does not match the admin: Atta Kesari', ['owner@example.test']], 'alert email: subject names the one flavour, sent to NOTIFY_EMAIL');
      ok(sent[0] && sent[0].html.includes('Atta Kesari shows in stock; the admin says out of stock') && sent[0].html.includes('Nothing is blocked; the website is unaffected. It retries every 15 minutes.'), 'alert email: one line per problem, then the reassurance');
      await mailer.sendChannelSyncAlert({ channel: 'google', problems: [{ slug: 'atta-lite-sugar', name: 'Atta Sugar-Lite', text: 'not found in Google: MNG-LITE-250' }, { slug: 'atta-kesari', name: 'Atta Kesari', text: 'Google did not accept the change: <b>quota</b> & "limits"' }] });
      eq(sent[1] && sent[1].subject, 'Google does not match the admin: 2 flavours', 'alert email: two flavours in the subject');
      ok(sent[1] && sent[1].html.includes('Atta Sugar-Lite: not found in Google: MNG-LITE-250'), 'alert email: a line that does not name the flavour gets the name in front');
      ok(sent[1] && sent[1].html.includes('&lt;b&gt;quota&lt;/b&gt; &amp; &quot;limits&quot;') && !sent[1].html.includes('<b>quota'), 'alert email: every value is escaped');
      reply = { error: { message: 'domain not verified' } };
      ok(await rejects(mailer.sendChannelSyncAlert({ channel: 'meta', problems: [{ slug: 'atta-kesari', name: 'Atta Kesari', text: 'x' }] })), 'alert email: a Resend error rejects, for the engine to log');
      if (keep.resend) require.cache[resendPath] = keep.resend; else delete require.cache[resendPath];
      if (keep.mailer) require.cache[mailerPath] = keep.mailer; else delete require.cache[mailerPath];
      if (keep.to === undefined) delete process.env.NOTIFY_EMAIL; else process.env.NOTIFY_EMAIL = keep.to;
    }
  }

  // ---- hooks: the triggers sit at the right places, after the action has succeeded ----
  {
    const fs = require('fs');
    const rejects = async (p) => { try { await p; return false; } catch (e) { return true; } };
    const abs = (p) => require.resolve(path.join(root, p));
    // earlier sections may already hold the real engine; set those cache entries aside, stub, and put everything back afterwards
    const keys = ['utils/channelSync.js', 'utils/adminActions.js', 'utils/adminAuth.js', 'utils/stock.js', 'utils/inventory.js', 'utils/database.js', 'utils/prices.js', 'utils/razorpay.js', 'utils/creditNote.js', 'utils/refunds.js', 'utils/refundFlow.js', 'routes/admin.js'].map(abs);
    const kept = keys.map((k) => require.cache[k]);
    keys.forEach((k) => { delete require.cache[k]; });
    const stub = (p, exp) => { const f = abs(p); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp }; };
    const nudges = []; let nudgeThrows = false; let saveThrows = false; const saved = [];
    const CHAN = { meta: { why: 'switched off' }, google: { why: 'switched off' } }; let statusThrows = false;   // the Stock screen also carries the channel lines (Task 6)
    stub('utils/channelSync.js', { nudge: (r) => { if (nudgeThrows) throw new Error('boom'); nudges.push(r); }, startSweep: () => {}, status: async () => { if (statusThrows) throw new Error('bad saved row'); return CHAN; } });
    // refunds: a fully refunded paid order is closed (status cancelled), which frees its unpacked boxes
    let closeFails = false; const closed = []; let paymentsAtRazorpay = [];
    const paidOrder = { order_id: 'MNG-TEST-0001', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), status: 'paid', payment_id: 'pay_1', customer_name: 'C', customer_phone: '919810000001', customer_email: 'c@example.test', total: 259, discount_amount: 0, items: [{ slug: 'atta-original', productName: 'Atta Original', quantity: 1, item_price: 259, unit: '250g' }], delivery_address: { raw: 'Delhi - 110001', state: 'Delhi' } };
    stub('utils/database.js', {
      listStock: async () => [], setStock: async () => {},
      listRecentOrders: async () => [paidOrder], getInvoicesByOrderIds: async () => ({}), getCreditNotesByOrderIds: async () => [], listOrderEventsByName: async () => [], logOrderEvent: async () => {},
      markOrderRefunded: async (id) => { if (closeFails) throw new Error('db down'); closed.push(id); },
      getCreditNoteByRefund: async () => null, getInvoiceByOrder: async () => null, getCreditNotesByOrder: async () => [],
    });
    stub('utils/razorpay.js', { listPayments: async () => paymentsAtRazorpay });
    stub('utils/creditNote.js', { issueCreditNote: async () => null });
    stub('utils/refunds.js', { notifyRefund: async () => {} });
    const table = { 'atta-original': { price: 300, mrp: 300 } };
    stub('utils/prices.js', { refresh: async () => {}, ensureFresh: async () => {}, isOn: () => true, current: () => table, save: async (x) => { if (saveThrows) throw new Error('write refused'); saved.push(x); } });
    class StockError extends Error { constructor(m) { super(m); this.status = 400; this.extra = {}; } }
    let invMode = 'ok';
    stub('utils/inventory.js', { StockError, instance: () => ({ sellable: async () => ({}), overview: async () => ({ items: [] }), receive: async () => { if (invMode === 'refuse') throw new StockError('Refused.'); if (invMode === 'crash') throw new Error('db down'); return { id: 1 }; } }) });
    const quiet = console.log; const quietErr = console.error;
    const keepNotify = process.env.NOTIFY_EMAIL; delete process.env.NOTIFY_EMAIL;   // the refund flow must not reach the owner-email step
    try {
      const actions = require(abs('utils/adminActions.js'));
      const actor = { email: 't@x' };
      const setPrice = async (args) => { console.log = () => {}; try { return await actions.setPrice({ actor, ...args }); } finally { console.log = quiet; } };

      await setPrice({ slug: 'atta-original', price: 259, mrp: 300 });
      eq(nudges, ['price'], 'hooks: setPrice records exactly one nudge, reason price');
      eq(saved.map((x) => [x.slug, x.price, x.mrp]), [['atta-original', 259, 300]], 'hooks: and the price was saved');
      ok(await rejects(setPrice({ slug: 'atta-original', price: 10, mrp: 300 })) && nudges.length === 1, 'hooks: a refused price (validation) sends no nudge');
      saveThrows = true;
      ok(await rejects(setPrice({ slug: 'atta-original', price: 259, mrp: 300 })) && nudges.length === 1, 'hooks: a price that could not be saved sends no nudge');
      saveThrows = false; nudgeThrows = true;
      eq(await setPrice({ slug: 'atta-original', price: 249, mrp: 300 }), {}, 'hooks: a nudge that throws never breaks the price change');
      nudgeThrows = false;
      eq(saved.length, 2, 'hooks: the price was still saved when the nudge threw');

      // the owner's sold-out switch (POST /admin/api/stock -> setStock): one nudge after the change, none when refused
      nudges.length = 0;
      console.log = () => {}; await actions.setStock({ slug: 'atta-original', available: false, actor }); console.log = quiet;
      eq(nudges, ['stock'], 'hooks: the owner sold-out switch sends one nudge, reason stock');
      ok(await rejects(actions.setStock({ slug: 'trio-gift-set', available: false, actor })) && nudges.length === 1, 'hooks: an unknown flavour on the switch sends no nudge');

      // a refund that closes an order: the admin list closes orders Razorpay shows fully refunded; the refund.processed flow closes them too
      nudges.length = 0;
      paymentsAtRazorpay = [{ id: 'pay_1', status: 'refunded', amount: 25900, amount_refunded: 25900, created_at: Math.floor(Date.now() / 1000) }];
      await actions.listOrders(); await new Promise((r) => setImmediate(r));
      eq([closed, nudges], [['MNG-TEST-0001'], ['refund']], 'hooks: the admin list closes a fully refunded order and sends one nudge, reason refund');
      const refunds = require(abs('utils/refundFlow.js'));
      const refundOf = (amount) => refunds.processRefund({ order: { order_id: 'MNG-TEST-0002', status: 'paid', total: 259, customer_phone: '919810000002' }, refund: { id: 'rfnd_' + amount, payment_id: 'pay_2', amount, notes: {} } });
      const quietWarn = console.warn;
      const quietly = async (fn) => { console.log = () => {}; console.warn = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = quiet; console.warn = quietWarn; console.error = quietErr; } };   // the flow logs; a FAIL line must still show
      nudges.length = 0; closed.length = 0;
      await quietly(() => refundOf(25900));
      eq([closed, nudges], [['MNG-TEST-0002'], ['refund']], 'hooks: a full refund (refund.processed) closes the order and sends one nudge, reason refund');
      nudges.length = 0; closed.length = 0;
      await quietly(() => refundOf(10000));
      eq([closed, nudges], [[], []], 'hooks: a part refund closes nothing and sends no nudge');
      closeFails = true; await quietly(() => refundOf(25900)); closeFails = false;
      eq(nudges, [], 'hooks: a full refund whose close failed sends no nudge (and the flow carries on)');

      // the stock wrapper in routes/admin.js, run for real with a fake inventory: POST nudges once after success, GET and failures do not
      const router = require(abs('routes/admin.js'));
      const handler = (method, p) => router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]).route.stack.slice(-1)[0].handle;
      const hit = async (method, p) => { let out; await handler(method, p)({ method: method.toUpperCase(), body: {}, query: {}, admin: { email: 'a@b', role: 'owner' } }, { json: (x) => { out = x; }, status() { return this; } }); return out; };
      nudges.length = 0;
      eq(await hit('get', '/admin/api/inventory'), { ok: true, items: [], channels: CHAN }, 'hooks: a stock screen read answers as before, with the channel lines');
      statusThrows = true; console.error = () => {};
      eq(await hit('get', '/admin/api/inventory'), { ok: true, items: [], channels: null }, 'hooks: a stock screen read still answers when the channel lines cannot be read');
      console.error = quietErr; statusThrows = false;
      eq(nudges, [], 'hooks: a stock GET sends no nudge');
      eq(await hit('post', '/admin/api/inventory/receive'), { ok: true, id: 1 }, 'hooks: a stock POST answers as before');
      eq(nudges, ['stock'], 'hooks: a successful stock POST sends one nudge, reason stock');
      invMode = 'refuse'; console.error = () => {};
      eq((await hit('post', '/admin/api/inventory/receive')).ok, false, 'hooks: a refused stock POST is still refused');
      invMode = 'crash';
      eq((await hit('post', '/admin/api/inventory/receive')).ok, false, 'hooks: a crashed stock POST still reports the error');
      console.error = quietErr; invMode = 'ok';
      eq(nudges, ['stock'], 'hooks: a stock POST that fails sends no nudge');
      nudgeThrows = true;
      eq(await hit('post', '/admin/api/inventory/receive'), { ok: true, id: 1 }, 'hooks: a nudge that throws never breaks a stock action');
      nudgeThrows = false;
    } finally {
      console.log = quiet; console.error = quietErr;
      if (keepNotify === undefined) delete process.env.NOTIFY_EMAIL; else process.env.NOTIFY_EMAIL = keepNotify;
      keys.forEach((k, i) => { if (kept[i]) require.cache[k] = kept[i]; else delete require.cache[k]; });
    }

    // the other hook points, found in the source text (a later edit that loses one fails here and names it)
    const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
    const admin = read('routes/admin.js'), server = read('server.js'), act = read('utils/adminActions.js'), refundFlow = read('utils/refundFlow.js');
    const slice = (src, from, to) => { const a = src.indexOf(from); if (a < 0) return ''; const b = src.indexOf(to, a + from.length); return src.slice(a, b < 0 ? undefined : b); };
    const fnBody = (src, name) => slice(src, `async function ${name}(`, '\n}\n');
    const safe = (reason) => `try\\s*\\{\\s*require\\('[^']*channelSync'\\)\\.nudge\\('${reason}'\\);\\s*\\}\\s*catch\\s*\\(_\\)\\s*\\{\\s*\\}`;   // the nudge can never throw into the action
    const after = (body, first, rx) => { const a = body.indexOf(first); const m = rx.exec(body); return a >= 0 && !!m && m.index > a; };
    const missing = [];
    const sw = slice(admin, 'const sw = ', '\nrouter.');
    if (!(sw && after(sw, 'await fn(', new RegExp(`if\\s*\\(req\\.method === 'POST'\\)\\s*\\{\\s*${safe('stock')}`)))) missing.push("routes/admin.js: stock actions (sw wrapper: nudge('stock') after fn, POST only)");
    if (!after(fnBody(act, 'advance'), 'deductForOrder', new RegExp(`if\\s*\\(to === 'packed'\\)\\s*\\{\\s*${safe('packed')}`))) missing.push("utils/adminActions.js: Packed (advance: nudge('packed') after deductForOrder)");
    if (!after(fnBody(act, 'undoStep'), 'restoreForOrder', new RegExp(`if\\s*\\(from === 'packed'\\)\\s*\\{\\s*${safe('unpacked')}`))) missing.push("utils/adminActions.js: Undo packed (undoStep: nudge('unpacked') after restoreForOrder)");
    if (!after(fnBody(act, 'setPrice'), "prices').save", new RegExp(safe('price')))) missing.push("utils/adminActions.js: price change (setPrice: nudge('price') after prices.save)");
    if (!new RegExp(`\\[RAZORPAY\\] Order \\$\\{orderId\\} paid[^\\n]*\\n\\s*${safe('paid')}`).test(server)) missing.push("server.js: paid order (nudge('paid') straight after the [RAZORPAY] Order paid log)");
    if (!/require\('\.\/utils\/channelSync'\)\.startSweep\(\)/.test(slice(server, 'app.listen(PORT', '\n});'))) missing.push('server.js: the 15-minute check (startSweep in the app.listen callback)');
    if (!after(fnBody(act, 'setStock'), 'stock.setAvailable', new RegExp(safe('stock')))) missing.push("utils/adminActions.js: owner sold-out switch (setStock: nudge('stock') after stock.setAvailable)");
    if (!after(fnBody(act, 'loadOrders'), 'markOrderRefunded', new RegExp(`o\\.status = 'cancelled';\\s*${safe('refund')}`))) missing.push("utils/adminActions.js: refund closes an order (loadOrders auto-close: nudge('refund') after markOrderRefunded)");
    if (!after(fnBody(refundFlow, 'processRefund'), 'markOrderRefunded', new RegExp(safe('refund')))) missing.push("utils/refundFlow.js: refund.processed closes an order (processRefund: nudge('refund') after markOrderRefunded)");
    ok(missing.length === 0, `hooks missing: ${missing.join(' | ')}`);
  }

  console.log(`channel-sync-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
