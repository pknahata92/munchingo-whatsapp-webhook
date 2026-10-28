'use strict';
// Pre-Diwali website fixes (28 Oct 2026): sold-out Flavors can't be bought from their own page, cart or checkout; product data
// follows stock; pre-launch and retired-offer copy is gone; 404 page; Build a box heading, paused state and set data; card stepper.
//   SITE_DIR=../munchingo-website node scripts/prediwali-site-test.js
const fs = require('fs'), path = require('path');
let JSDOM, ResourceLoader;
try { ({ JSDOM, ResourceLoader } = require('jsdom')); } catch (e) { console.log('jsdom is not installed: run  npm install --no-save jsdom@24'); process.exit(1); }
const SITE = process.env.SITE_DIR || path.resolve(__dirname, '../../../munchingo-website');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
class Local extends ResourceLoader { fetch(url) { const u = new URL(url); if (u.hostname !== 'localhost') return Promise.resolve(Buffer.from('')); const f = path.join(SITE, decodeURIComponent(u.pathname)); return Promise.resolve(fs.existsSync(f) ? fs.readFileSync(f) : Buffer.from('')); } }
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const read = (f) => fs.readFileSync(path.join(SITE, f), 'utf8');
const visibleText = (html) => html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ');

async function open(page, { soldOut = [], cart = [] } = {}) {
  const dom = new JSDOM(read(page), {
    url: 'http://localhost/' + page, runScripts: 'dangerously', resources: new Local(), pretendToBeVisual: true,
    beforeParse(w) {
      w.localStorage.setItem('munchingo_soldout', JSON.stringify(soldOut));
      if (cart.length) w.localStorage.setItem('munchingo_cart', JSON.stringify(cart));
      w.fetch = (u) => Promise.resolve({ ok: true, status: 200, json: async () => (/stock/.test(u) ? { ok: true, soldOut } : { ok: true, prices: {} }) });
      w.scrollTo = () => {}; w.SVGElement.prototype.getComputedTextLength = () => 100;
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, addListener() {} }));
      w.HTMLCanvasElement.prototype.getContext = () => null;
    },
  });
  await wait(900);
  return dom;
}
const schemaAvail = (d) => [...d.querySelectorAll('script[type="application/ld+json"]')].map((s) => { try { return JSON.parse(s.textContent); } catch (e) { return null; } })
  .flatMap((j) => (j ? (j['@graph'] || (Array.isArray(j) ? j : [j])) : [])).filter((n) => n && n['@type'] === 'Product' && n.offers)
  .map((n) => ({ sku: n.sku, a: (Array.isArray(n.offers) ? n.offers[0] : n.offers).availability }));
const ITEM = (slug, name, price) => ({ slug, name, price, mrp: price + 41, unit: '250g', qty: 1 });

(async () => {
  // 1. Product page, sold out
  let dom = await open('atta-kesari.html', { soldOut: ['atta-kesari', 'atta-lite-sugar'] }); let d = dom.window.document;
  ok(d.getElementById('add').disabled && /Sold out/.test(text(d.getElementById('add'))), 'Kesari sold out: main button disabled and says Sold out');
  ok(d.getElementById('add2').disabled, 'Kesari sold out: sticky bar button disabled');
  ok(d.getElementById('soldout-note') && /Kesari is sold out/.test(text(d.getElementById('soldout-note'))) && /wa\.me\/919988992024/.test(d.querySelector('#soldout-note a').href), 'sold-out note with a WhatsApp "tell me" link');
  ok(d.getElementById('mov').hidden, 'minimum-order nudge hidden while the Flavor cannot be bought');
  ok(schemaAvail(d).some((x) => /OutOfStock/.test(x.a)), 'product data says OutOfStock');
  dom.window.close();
  // 1b. same page, in stock
  dom = await open('atta-kesari.html', { soldOut: [] }); d = dom.window.document;
  ok(!d.getElementById('add').disabled && !d.getElementById('soldout-note'), 'Kesari in stock: buy box normal');
  ok(schemaAvail(d).every((x) => /InStock/.test(x.a)), 'product data says InStock');
  ok(/Royally sweet/.test(text(d.querySelector('.v2-buy .v2-tag'))), 'Kesari tag is "Royally sweet" (approved 28 Oct)');
  dom.window.close();

  // 2. Cart and checkout hold a sold-out box
  const cart = [ITEM('atta-kesari', 'Atta Kesari', 299), ITEM('atta-original', 'Atta Original', 259)];
  dom = await open('cart.html', { soldOut: ['atta-kesari'], cart }); d = dom.window.document;
  const go = d.getElementById('cart-checkout');
  ok(go.getAttribute('aria-disabled') === 'true' && /Remove sold-out box/.test(text(go)), 'cart: checkout held with a reason: ' + text(go));
  ok(d.querySelector('.cart-row.sold-out') && /Sold out for now/.test(text(d.querySelector('.cart-row.sold-out'))), 'cart: the sold-out line is marked');
  dom.window.close();
  dom = await open('cart.html', { soldOut: [], cart }); d = dom.window.document;
  ok(d.getElementById('cart-checkout').getAttribute('aria-disabled') !== 'true', 'cart: in stock, checkout open');
  dom.window.close();
  dom = await open('checkout.html', { soldOut: ['atta-kesari'], cart }); d = dom.window.document;
  ok(d.getElementById('ck-submit').disabled && /sold-out/.test(text(d.getElementById('ck-submit'))), 'checkout: Pay disabled with a reason: ' + text(d.getElementById('ck-submit')));
  ok(/Atta Kesari is sold out/.test(text(d.querySelector('.ck-soldout'))), 'checkout: summary names the sold-out box');
  dom.window.close();

  // 3. Pre-launch and retired-offer copy gone from what people (and crawlers) read
  const home = read('index.html');
  ok(!/16 Oct|Pre-order now|Pre-orders are open|scratch with your finger/i.test(visibleText(home)) && !/id="countdown"/.test(home), 'home: no pre-launch copy or countdown');
  ok(!/FOUNDING10/.test(visibleText(read('checkout.html'))), 'checkout: FOUNDING10 not in the page text');
  ['atta-original', 'atta-ajwain', 'atta-kesari', 'atta-lite-sugar'].forEach((s) => ok(new RegExp('<a href="' + s + '\\.html">').test(home), 'home: plain link to ' + s));
  ok(!/delivered free to your doorstep/i.test(visibleText(home)), 'home: no unconditional free-delivery promise');
  ok(/og-home\.jpg/.test(home) && /og:image:width" content="1200"/.test(home), 'home: 1200x630 share image of all four Flavors');
  // 28 Oct (Prashant): the home page is not gift-first. Meet the Flavors, then the Pack of 2 (how to start), then gift boxes.
  const at = (id) => home.indexOf('id="' + id + '"');
  ok(at('range') > 0 && at('range') < at('pack-of-2') && at('pack-of-2') < at('gifts'), 'home order: Flavors, then the Pack of 2, then gift boxes');
  ok(!/2026-11-09/.test(home) && !/Gifting this Diwali/.test(home), 'home: no Diwali reorder script, no gift chip on the hero');
  ok(/href="#pack-of-2" data-launch-pill/.test(home), 'hero pill points to the Pack of 2');

  // 4. 404 page
  const nf = read('404.html');
  ok(/<meta name="robots" content="noindex">/.test(nf) && /<title>Page not found/.test(nf) && ['atta-original', 'atta-kesari', 'shop', 'build-a-box'].every((s) => nf.includes('href="' + s + '.html"')), '404 page: noindex, title, links to products, shop, build a box');

  // 5. Build a box: real heading, paused state, set product data
  dom = await open('build-a-box.html', { soldOut: ['atta-kesari', 'atta-lite-sugar'] }); d = dom.window.document;
  const h1 = d.querySelector('h1');
  ok(h1 && h1.classList.contains('gb-h1') && h1.querySelector('.gb-l2'), 'build a box: one H1 with its second line');
  ok(!d.querySelector('[data-gb="paused"]').hidden && d.querySelector('.gb-panel').classList.contains('gb-is-paused'), 'two Flavors out: builder shows the paused card');
  ok(/Kesari and Sugar-Lite are sold out/.test(text(d.querySelector('[data-gb="pausedText"]'))) && /wa\.me/.test(d.querySelector('[data-gb="notify"]').href), 'paused card explains and offers "tell me"');
  ok(schemaAvail(d).filter((x) => /gift-set|full-range/.test(x.sku)).every((x) => /OutOfStock/.test(x.a)) && schemaAvail(d).length >= 2, 'set product data: OutOfStock while paused');
  ok(!/wa-float/.test(read('build-a-box.html')), 'no WhatsApp bubble over the builder');
  dom.window.close();
  dom = await open('build-a-box.html', { soldOut: [] }); d = dom.window.document;
  ok(d.querySelector('[data-gb="paused"]').hidden && schemaAvail(d).every((x) => /InStock/.test(x.a)), 'all in stock: no paused card, sets InStock');
  dom.window.close();

  // 6. Range cards: the stepper that replaces Add to bag has its own class (no borrowed margin)
  dom = await open('shop.html', { soldOut: [] }); d = dom.window.document; const w = dom.window;
  const btn = d.querySelector('#range [data-add-to-cart][data-slug="atta-original"]');
  btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); await wait(100);
  const card = btn.closest('.v2-card');
  ok(card.querySelector('.v2-qty') && !card.querySelector('.v2-qty').hidden && !card.querySelector('.v2-step'), 'card: stepper is .v2-qty, not .v2-step');
  dom.window.close();
  const css = read('css/style.css');
  ok(/button,input,select,textarea\{font-family:inherit/.test(css), 'controls inherit the page font');
  ok(/\.v2-range \.v2-card \.v2-body \.v2-add,\.v2-range \.v2-card \.v2-qty\{height:48px;margin:6px 0 0/.test(css), 'button and stepper share one 48px box');

  // 7. Home: the Pack of 2 picker knows what is already in the bag (it sits right under the Flavor cards).
  dom = await open('index.html', { cart: [ITEM('atta-original', 'Atta Original', 259), ITEM('atta-ajwain', 'Atta Ajwain', 259)] }); d = dom.window.document;
  let have = d.querySelector('[data-p2-have]');
  ok(have && !have.hidden && /2 boxes/.test(text(have)) && have.querySelector('a[href="checkout.html"]'), 'Pack of 2: bag with 2 boxes says so and links to checkout: ' + text(have));
  dom.window.close();
  dom = await open('index.html', { cart: [ITEM('atta-original', 'Atta Original', 259)] }); d = dom.window.document;
  have = d.querySelector('[data-p2-have]');
  ok(have && !have.hidden && /1 box/.test(text(have)) && /one more/.test(text(have)), 'Pack of 2: bag with 1 box asks for one more: ' + text(have));
  dom.window.close();
  dom = await open('index.html', {}); d = dom.window.document;
  have = d.querySelector('[data-p2-have]');
  ok(have && have.hidden, 'Pack of 2: empty bag, no bag line');
  dom.window.close();

  console.log(`prediwali-site-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
