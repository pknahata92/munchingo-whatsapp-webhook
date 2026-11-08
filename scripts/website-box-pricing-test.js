'use strict';
// Website prices and the bag follow the box rule (9 Nov 2026): a Trio / the Full Range costs the singles minus 8% / 12.5%,
// rounded to a price ending in 9, per mix; a bag with a gift box ships free; suggestions use the approved wording.
//   SITE_DIR=../munchingo-website-box-pricing node scripts/website-box-pricing-test.js
const fs = require('fs'), path = require('path');
let JSDOM, ResourceLoader;
try { ({ JSDOM, ResourceLoader } = require('jsdom')); } catch (e) { console.log('jsdom is not installed: run  npm install --no-save jsdom@24'); process.exit(1); }
const SITE = process.env.SITE_DIR || path.resolve(__dirname, '../../../munchingo-website');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SINGLES = { 'atta-original': { price: 259, mrp: 300 }, 'atta-ajwain': { price: 259, mrp: 300 }, 'atta-kesari': { price: 299, mrp: 350 }, 'atta-lite-sugar': { price: 329, mrp: 350 } };
const RULE = { 3: 8, 4: 12.5 };
const T = (a) => 'trio-gift-set-' + a.slice().sort().join('-');
const OAK = T(['original', 'ajwain', 'kesari']);

// A page with just prices.js and cart.js, storage pre-seeded, fetch stubbed (the live API is never called).
function load({ book, rule, cart } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://munchingo.com/', runScripts: 'outside-only' });
  const w = dom.window;
  w.fetch = () => new Promise(() => {});
  if (book) w.localStorage.setItem('munchingo_prices', JSON.stringify(book));
  if (rule) w.localStorage.setItem('munchingo_box_rule', JSON.stringify(rule));
  if (cart) w.localStorage.setItem('munchingo_cart', JSON.stringify(cart));
  w.eval(fs.readFileSync(path.join(SITE, 'js/prices.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(SITE, 'js/cart.js'), 'utf8'));
  return w;
}
const line = (slug, price, qty = 1) => ({ slug, name: slug, price, unit: 'x', qty });
const textOf = (html) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

// ---- prices ----
let w = load({ book: SINGLES, rule: RULE }); let P = w.MunchingoPrices;
ok(P.price(OAK, 0) === 749, 'fresh book: O+A+K 749, got ' + P.price(OAK, 0));
ok(P.price('trio-gift-set', 0) === 749, 'fresh book: trio-gift-set is the lowest (from) price 749');
ok(P.price('full-range-set', 0) === 999, 'fresh book: Full Range 999');
ok(P.price(T(['original', 'ajwain', 'lite-sugar']), 0) === 779, 'O+A+SL 779');
ok(P.price(T(['original', 'kesari', 'lite-sugar']), 0) === 809, 'O+K+SL 809');
ok(P.price(T(['ajwain', 'kesari', 'lite-sugar']), 0) === 809, 'A+K+SL 809');
ok(P.boxPrice(['atta-original', 'atta-ajwain', 'atta-kesari']) === 749, 'boxPrice(O,A,K) 749');
ok(P.boxPrice(['atta-original', 'atta-ajwain', 'atta-kesari', 'atta-lite-sugar']) === 999, 'boxPrice(all four) 999');
ok(P.boxRule()[3] === 8 && P.boxRule()[4] === 12.5, 'boxRule() gives 8 and 12.5');
ok(P.price('atta-original', 0) === 259 && P.price('atta-kesari', 0) === 299, 'singles unchanged');
ok(!('promo' in P) && !('promoText' in P), 'promo and promoText are gone');
ok(P.mrp('trio-gift-set', null) === null && P.mrp('full-range-set', null) === null, 'sets have no MRP');

// a book stored before the deploy: flat Trio 799, no rule, no byMix. The set price stored there is never used.
w = load({ book: Object.assign({}, SINGLES, { 'trio-gift-set': { price: 799, mrp: null }, 'full-range-set': { price: 1100, mrp: 1300 } }) }); P = w.MunchingoPrices;
ok(P.price(OAK, 0) === 749 && P.price('trio-gift-set', 0) === 749, 'old stored book: still 749');
ok(P.price('full-range-set', 0) === 999, 'old stored book: Full Range 999 from singles plus the built-in rule');
ok(P.boxRule()[3] === 8 && P.boxRule()[4] === 12.5, 'old stored book: built-in rule');
w = load({ book: SINGLES, rule: { 3: 'x' } }); ok(w.MunchingoPrices.price(OAK, 0) === 749, 'invalid stored rule falls back to the built-in one');

// no book at all
w = load(); P = w.MunchingoPrices;
ok(P.price(OAK, 0) === 749 && P.price('full-range-set', 0) === 999 && P.price('trio-gift-set', 0) === 749, 'no book: 749 / 749 / 999');

// Original at 249
w = load({ book: Object.assign({}, SINGLES, { 'atta-original': { price: 249, mrp: 300 } }), rule: RULE }); P = w.MunchingoPrices;
ok(P.price(OAK, 0) === 739, 'Original 249: O+A+K 739, got ' + P.price(OAK, 0));
ok(P.price('full-range-set', 0) === 989, 'Original 249: Full Range 989, got ' + P.price('full-range-set', 0));

// ---- the bag ----
w = load({ book: SINGLES, rule: RULE, cart: [line(OAK, 799)] });
ok(w.MunchingoCart.getCart()[0].price === 749, 'a stored Trio line at 799 reads back at 749');
ok(w.MunchingoCart.getCart()[0].mrp === undefined, 'a Trio line has no MRP');
w = load({ cart: [line('full-range-set', 1100)] });
ok(w.MunchingoCart.getCart()[0].price === 999, 'with no book, a stored Full Range line reads back at 999');

// suggestions (the core finds them; the bag shows them when switched on)
const core = (cart, opts) => { const x = load(Object.assign({ book: SINGLES, rule: RULE, cart }, opts)); return { C: x.MunchingoCart, sg: x.MunchingoCart.suggestionCore() }; };
let r = core([line('atta-original', 259), line('atta-ajwain', 259), line('atta-kesari', 299)]);
ok(r.sg && r.sg.kind === 'trio' && r.sg.saved === 68, '3 singles O+A+K: trio saved 68, got ' + JSON.stringify(r.sg));
ok(r.sg && textOf(r.C.suggestionHtml(r.sg)) === 'Make it a Trio and save ₹68', 'trio wording: ' + (r.sg && textOf(r.C.suggestionHtml(r.sg))));
r = core([line('atta-original', 259), line('atta-ajwain', 259), line('atta-kesari', 299), line('atta-lite-sugar', 329)]);
ok(r.sg && r.sg.kind === 'full' && r.sg.saved === 147, '4 singles: full saved 147, got ' + JSON.stringify(r.sg));
ok(r.sg && textOf(r.C.suggestionHtml(r.sg)) === 'Make it the Full Range and save ₹147', 'full wording: ' + (r.sg && textOf(r.C.suggestionHtml(r.sg))));
[[['original', 'ajwain', 'kesari'], 'atta-lite-sugar', 79], [['original', 'ajwain', 'lite-sugar'], 'atta-kesari', 79],
 [['original', 'kesari', 'lite-sugar'], 'atta-ajwain', 69], [['ajwain', 'kesari', 'lite-sugar'], 'atta-original', 69]].forEach(([mix, single, saved]) => {
  const p = ({ original: 259, ajwain: 259, kesari: 299, 'lite-sugar': 329 });
  const tp = Math.floor((mix.reduce((n, t) => n + p[t], 0) * (1 - 0.08) + 1) / 10) * 10 - 1;
  const x = core([line(T(mix), tp), line(single, 1)]);
  ok(x.sg && x.sg.kind === 'merge' && x.sg.saved === saved, 'merge ' + mix.join('+') + ' + ' + single + ': saved ' + saved + ', got ' + JSON.stringify(x.sg));
  ok(x.sg && textOf(x.C.suggestionHtml(x.sg)) === 'Make it the Full Range and save ₹' + saved, 'merge wording ' + mix.join('+'));
});

// ---- shipping ----
w = load({ book: SINGLES, rule: RULE, cart: [line('atta-original', 259, 2)] }); let C = w.MunchingoCart;
ok(C.cartTotal() === 518 && C.cartShipping() === 49, '2 singles (518): shipping 49');
ok(textOf(C.renderAovProgressHtml(C.getCart())).indexOf('Add one more box and it ships free (free shipping from ₹777).') >= 0, '2 singles: one more box nudge, exact sentence');
w = load({ book: SINGLES, rule: RULE, cart: [line(OAK, 749)] }); C = w.MunchingoCart;
ok(C.cartTotal() === 749 && C.cartShipping() === 0 && C.cartPayable() === 749, 'the 749 box alone: shipping 0');
ok(/Gift boxes ship free/.test(textOf(C.renderAovProgressHtml(C.getCart()))), 'a gift box says Gift boxes ship free');
ok(C.shippingFor(518, false) === 49 && C.shippingFor(777, false) === 0 && C.shippingFor(749, true) === 0 && C.shippingFor(100, true) === 0, 'shippingFor mirrors the backend');
w = load({ book: SINGLES, rule: RULE, cart: [line('atta-original', 259, 3)] }); C = w.MunchingoCart;
ok(C.cartShipping() === 0, '3 singles at 777: free');
w = load({ book: SINGLES, rule: RULE, cart: [line('atta-original', 259), line(OAK, 749)] }); C = w.MunchingoCart;
ok(C.cartShipping() === 0, 'a gift box plus a single ships free');
w = load({ book: SINGLES, rule: RULE }); w.MunchingoCart.addToCart({ slug: 'atta-original', name: 'o', price: 259, unit: 'x' }); w.MunchingoCart.addToCart({ slug: 'atta-ajwain', name: 'a', price: 259, unit: 'x' }); w.MunchingoCart.addToCart({ slug: 'atta-kesari', name: 'k', price: 299, unit: 'x' });
ok(w.MunchingoCart.getCart().length === 3 && w.MunchingoCart.autoPackOfFour === undefined, 'adding singles never swaps the bag');

// ---- pages: nothing promo is visible ----
class Local extends ResourceLoader { fetch(url) { const u = new URL(url); if (u.hostname !== 'localhost') return Promise.resolve(Buffer.from('')); const f = path.join(SITE, decodeURIComponent(u.pathname)); return Promise.resolve(fs.existsSync(f) ? fs.readFileSync(f) : Buffer.from('')); } }
async function page(file) {
  const dom = new JSDOM(fs.readFileSync(path.join(SITE, file), 'utf8'), {
    url: 'http://localhost/' + file, runScripts: 'dangerously', resources: new Local(), pretendToBeVisual: true,
    beforeParse(x) { x.localStorage.setItem('munchingo_prices', JSON.stringify(SINGLES)); x.localStorage.setItem('munchingo_box_rule', JSON.stringify(RULE)); x.fetch = () => new Promise(() => {}); x.scrollTo = () => {}; x.SVGElement.prototype.getComputedTextLength = () => 100; x.matchMedia = x.matchMedia || (() => ({ matches: false, addEventListener() {}, addListener() {} })); },
  });
  await wait(700);
  return dom.window.document;
}
(async () => {
  for (const f of ['index.html', 'shop.html', 'build-a-box.html']) {
    const d = await page(f);
    const shown = Array.from(d.querySelectorAll('[data-promo-for],[data-was-for]')).filter((el) => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) { if (n.hidden || /display:\s*none/.test(n.getAttribute('style') || '')) return false; } return true; });
    ok(shown.length === 0, f + ': no promo or was-price element is visible (' + shown.length + ')');
    const sets = Array.from(d.querySelectorAll('[data-price-for="trio-gift-set"],[data-price-for="full-range-set"]')).map((e) => e.textContent.trim());
    ok(sets.length > 0 && sets.every((t) => t === '₹749' || t === '₹999'), f + ': set prices read 749 / 999: ' + sets.join(','));
  }
  console.log(`website-box-pricing-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
