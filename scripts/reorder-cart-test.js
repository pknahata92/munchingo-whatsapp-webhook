'use strict';
// Reorder cart link (growth journey J4 and J6, 16 Nov 2026): the path after https://munchingo.com/ that refills the bag in one tap.
// Two of the favourite plus one Flavor never bought, if one is in stock; otherwise the last order again. Sold-out Flavors never
// appear; nothing in stock opens the shop. Every link carries the utm tags.   node scripts/reorder-cart-test.js
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const cart = require('../utils/reorderCart');
const ALL = new Set(['atta-original', 'atta-kesari', 'atta-ajwain', 'atta-lite-sugar']);
let n = 0;
const O = (boxes, extra = []) => ({ order_id: 'MNG-T-' + (++n), status: 'paid', items: [...Object.entries(boxes).map(([slug, quantity]) => ({ slug, quantity })), ...extra] });
const UTM = (campaign, medium = 'journey') => `utm_source=whatsapp&utm_medium=${medium}&utm_campaign=${campaign}`;

// ── the three cases in the plan ──
eq(cart.cartLink({ orders: [O({ 'atta-original': 2 })], inStock: ALL, campaign: 'j4_reorder', medium: 'journey' }).path,
  'cart?add=atta-original:2,atta-kesari&utm_source=whatsapp&utm_medium=journey&utm_campaign=j4_reorder', 'favourite x2 + first untried in stock');
eq(cart.cartLink({ orders: [O({ 'atta-original': 2 })], inStock: new Set(['atta-ajwain']), campaign: 'c', medium: 'journey' }).path.startsWith('cart?add=atta-ajwain'), true, 'sold-out favourite never in the cart');
eq(cart.cartLink({ orders: [O({ 'atta-original': 2 })], inStock: new Set(), campaign: 'c', medium: 'journey' }).path.startsWith('shop?'), true, 'nothing in stock -> shop');
eq(cart.cartLink({ orders: [O({ 'atta-original': 2 })], inStock: new Set(), campaign: 'c', medium: 'journey' }).path, 'shop?' + UTM('c'), 'the shop link carries the utm tags');

// ── the try ──
let r = cart.cartLink({ orders: [O({ 'atta-original': 2 })], inStock: ALL, campaign: 'j4_reorder', medium: 'journey' });
eq(r.trySlug, 'atta-kesari', 'trySlug names the untried Flavor');
eq(r.favSlug, 'atta-original', 'favSlug names the favourite');
r = cart.cartLink({ orders: [O({ 'atta-original': 2 }), O({ 'atta-kesari': 2 })], inStock: ALL, campaign: 'c', medium: 'journey' });
eq(r.path, 'cart?add=atta-original:2,atta-ajwain&' + UTM('c'), 'a Flavor bought in ANY earlier order is not offered as the try');
r = cart.cartLink({ orders: [O({ 'atta-original': 2 })], inStock: new Set(['atta-original', 'atta-lite-sugar']), campaign: 'c', medium: 'journey' });
eq(r.path, 'cart?add=atta-original:2,atta-lite-sugar&' + UTM('c'), 'the try is the first untried Flavor that is IN STOCK');

// ── the favourite ──
eq(cart.cartLink({ orders: [O({ 'atta-original': 1, 'atta-kesari': 3 })], inStock: ALL, campaign: 'c', medium: 'journey' }).path, 'cart?add=atta-kesari:2,atta-ajwain&' + UTM('c'), 'favourite = most boxes in the newest order');
eq(cart.cartLink({ orders: [O({ 'atta-kesari': 2, 'atta-original': 2 })], inStock: ALL, campaign: 'c', medium: 'journey' }).path, 'cart?add=atta-original:2,atta-ajwain&' + UTM('c'), 'a tie goes to the first in Original, Kesari, Ajwain, Sugar-Lite');
eq(cart.cartLink({ orders: [O({ 'atta-ajwain': 1 }), O({ 'atta-kesari': 5 })], inStock: ALL, campaign: 'c', medium: 'journey' }).favSlug, 'atta-ajwain', 'the favourite comes from the NEWEST order (orders are newest first)');
r = cart.cartLink({ orders: [O({ 'atta-original': 3, 'atta-kesari': 1 })], inStock: new Set(['atta-kesari', 'atta-ajwain']), campaign: 'c', medium: 'journey' });
eq(r.path, 'cart?add=atta-kesari:2,atta-ajwain&' + UTM('c'), 'favourite sold out: the next Flavor from that order that is in stock');
r = cart.cartLink({ orders: [O({ 'atta-original': 2 })], inStock: new Set(['atta-ajwain']), campaign: 'c', medium: 'journey' });
eq(r.favSlug, null, 'nothing from the last order in stock: favSlug is null (so "your usual" would not be true)');
eq(r.path, 'cart?add=atta-ajwain&' + UTM('c'), 'and the cart holds only the untried Flavor');

// ── no untried Flavor in stock: the last order again ──
r = cart.cartLink({ orders: [O({ 'atta-original': 2, 'atta-kesari': 1, 'atta-ajwain': 1, 'atta-lite-sugar': 1 })], inStock: ALL, campaign: 'j6_reorder', medium: 'broadcast' });
eq(r.path, 'cart?add=atta-original:2,atta-kesari:1,atta-ajwain:1,atta-lite-sugar:1&' + UTM('j6_reorder', 'broadcast'), 'everything tried: the newest order\'s singles as slug:qty (medium and campaign as given)');
eq(r.trySlug, null, 'no try -> trySlug null');
r = cart.cartLink({ orders: [O({ 'atta-original': 2, 'atta-kesari': 2 })], inStock: new Set(['atta-original']), campaign: 'c', medium: 'journey' });
eq(r.path, 'cart?add=atta-original:2&' + UTM('c'), 'a sold-out Flavor is left out of the repeat cart');
r = cart.cartLink({ orders: [O({}, [{ slug: 'full-range-set', quantity: 1 }])], inStock: ALL, campaign: 'c', medium: 'journey' });
eq(r.path, 'cart?add=atta-original:1,atta-kesari:1,atta-ajwain:1,atta-lite-sugar:1&' + UTM('c'), 'a Set is opened into single boxes (the cart link takes singles only)');
r = cart.cartLink({ orders: [O({}, [{ slug: 'trio-gift-set-kesari-lite-sugar-original', quantity: 1 }, { slug: 'shipping', quantity: 1 }])], inStock: ALL, campaign: 'c', medium: 'journey' });
eq(r.path, 'cart?add=atta-original:2,atta-ajwain&' + UTM('c'), 'a Trio counts its three Flavors (one each, tie -> Original); the shipping line is not a box');

// ── odd inputs ──
r = cart.cartLink({ orders: [O({}, [{ product_retailer_id: 'w2w5ynf2m5', quantity: 2 }])], inStock: ALL, campaign: 'c', medium: 'journey' });
eq(r.path, 'cart?add=atta-kesari:2,atta-original&' + UTM('c'), 'a WhatsApp catalog line (retailer id, no slug) counts as its Flavor');
eq(cart.cartLink({ orders: [], inStock: ALL, campaign: 'c', medium: 'journey' }).path, 'shop?' + UTM('c'), 'no orders: the shop');
eq(cart.cartLink({ orders: undefined, inStock: undefined, campaign: 'c', medium: 'journey' }).path, 'shop?' + UTM('c'), 'missing inputs never throw');
ok(['atta-original', 'atta-kesari', 'atta-ajwain', 'atta-lite-sugar'].join() === cart.SLUGS.join(), 'SLUGS is the tie-break order');

console.log(`reorder-cart-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
