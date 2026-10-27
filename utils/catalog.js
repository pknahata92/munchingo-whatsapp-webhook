'use strict';

// Server-side source of truth for website checkout pricing, keyed by the
// slug the website's Add-to-Bag buttons use (js/cart.js). Never trust a
// price/total submitted by the client — always look it up here.
// Printed MRP on the packs (display only, never used to charge): the web price is the online floor below it.
const MRPS = { 'atta-original': 300, 'atta-ajwain': 300, 'atta-kesari': 350, 'atta-lite-sugar': 350 };
const PRICES = {
  'atta-original':   259,
  'atta-kesari':      299,
  'atta-lite-sugar':  329,   // Prashant, 27 Oct 2026 (was 299; MRP 350 unchanged)
  'atta-ajwain':      259,
  'full-range-set':   999,
};

// The Trio gift set's slug is built dynamically from the 3 chosen flavours
// (e.g. "trio-gift-set-ajwain-kesari-original") but the price is flat.
const TRIO_PREFIX = 'trio-gift-set';
const TRIO_PRICE = 799;
const TRIO_TOKENS = ['ajwain', 'kesari', 'lite-sugar', 'original'];

// A gift set never holds two boxes of the same flavour: a Trio is exactly 3 DIFFERENT flavours (the website builder and
// bag already enforce this; this stops a hand-made request such as "trio-gift-set-original-original-original" paying
// the Trio price for 3 of one flavour). Slug = prefix + the 3 flavour tokens in alphabetical order.
function isValidTrioSlug(slug) {
  if (typeof slug !== 'string' || !slug.startsWith(TRIO_PREFIX + '-')) return false;
  let rest = slug.slice(TRIO_PREFIX.length + 1);
  const found = [];
  while (rest) {
    const t = TRIO_TOKENS.find((tok) => rest === tok || rest.startsWith(tok + '-'));
    if (!t) return false;
    found.push(t);
    rest = rest.slice(t.length + 1);
  }
  return found.length === 3 && new Set(found).size === 3 && found.join('-') === [...found].sort().join('-');
}

// Manual stock control for the website's checkout path only. WhatsApp's own
// catalog ordering flow already reflects stock status set in Meta Commerce
// Manager (that catalog is separate from this file entirely) — this list
// only needs updating when a flavour needs to be pulled from the WEBSITE.
// To mark a flavour sold out, add its base slug here and redeploy; to
// restock, remove it. Website Add-to-Bag buttons should be updated to match
// (see js/cart.js's SOLD_OUT_SLUGS) so customers don't add it in the first
// place, but this is the check that actually blocks a tampered request.
const SOLD_OUT_SLUGS = [
  // 'atta-kesari',
];

const BASE_SLUGS = ['atta-original', 'atta-kesari', 'atta-lite-sugar', 'atta-ajwain'];

// The live list comes from the product_stock table (see utils/stock.js, toggled in the admin).
// Until it has loaded once, or if it cannot be read, the hard-coded SOLD_OUT_SLUGS above applies.
function soldOutNow() {
  try { return require('./stock').soldOutSlugs() || SOLD_OUT_SLUGS; } catch (_) { return SOLD_OUT_SLUGS; }
}

// Display names, matching what js/cart.js's own Add-to-Bag buttons already
// show (see gifting.html/index.html's data-name attributes) — a website
// order's item name should never come from the client, since a crafted
// POST body could otherwise inject an arbitrary string into the owner's
// order emails and the branded order-confirmed.html page.
const NAMES = {
  'atta-original':   'Atta Original',
  'atta-kesari':      'Atta Kesari',
  'atta-lite-sugar':  'Atta Sugar-Lite',
  'atta-ajwain':      'Atta Ajwain',
  'full-range-set':   'Full Range Gift Set',
};
const TRIO_NAME = 'Trio Gift Set';

/**
 * How many physical boxes one unit of this slug is: singles 1, Trio gift set 3,
 * Full Range gift set 4. The minimum order is a box count (MIN_BOXES in utils/shipping.js, boxes counted with this function).
 */
function boxesForSlug(slug) {
  if (slug === 'full-range-set') return 4;
  if (typeof slug === 'string' && slug.startsWith(TRIO_PREFIX)) return 3;
  return 1;
}

/**
 * Look up the real price for a website cart item slug.
 * Returns the price in rupees, or null if the slug isn't recognised.
 */
function priceForSlug(slug) {
  const live = require('./prices').current();
  const key = typeof slug === 'string' && slug.startsWith(TRIO_PREFIX) ? 'trio-gift-set' : slug;
  const promo = require('./giftPromo');
  if (live && live[key]) return promo.effective(key, live[key].price);
  if (Object.prototype.hasOwnProperty.call(PRICES, slug)) return promo.effective(slug, PRICES[slug]);
  if (typeof slug === 'string' && slug.startsWith(TRIO_PREFIX)) return promo.effective('trio-gift-set', TRIO_PRICE);
  return null;
}

// What the shop shows struck through (printed MRP), or null for none. Display only: never used to charge.
function mrpForSlug(slug) {
  const live = require('./prices').current();
  const key = typeof slug === 'string' && slug.startsWith(TRIO_PREFIX) ? 'trio-gift-set' : slug;
  return live && live[key] ? live[key].mrp : null;
}

// Everything the website needs to show prices: the live table, or the built-in prices before the table is switched on.
// Gift sets: the price charged today (see utils/giftPromo.js) plus, while the pre-Diwali offer runs, a `promo` note.
function priceBook() {
  const live = require('./prices').current();
  let book = {};
  if (live) Object.keys(live).forEach((k) => { book[k] = { ...live[k] }; });
  else {
    Object.keys(PRICES).forEach((k) => { book[k] = { price: PRICES[k], mrp: MRPS[k] || null }; });
    book['trio-gift-set'] = { price: TRIO_PRICE, mrp: null };
  }
  const promo = require('./giftPromo');
  ['trio-gift-set', 'full-range-set'].forEach((k) => {
    if (!book[k]) return;
    const p = promo.promoFor(k, book[k].price);
    book[k].price = promo.effective(k, book[k].price);
    if (p) book[k].promo = p;
  });
  return book;
}

/**
 * Look up the real display name for a website cart item slug. Returns null
 * for an unrecognised slug (same recognised set as priceForSlug).
 */
function nameForSlug(slug) {
  if (Object.prototype.hasOwnProperty.call(NAMES, slug)) return NAMES[slug];
  if (typeof slug === 'string' && slug.startsWith(TRIO_PREFIX)) return TRIO_NAME;
  return null;
}

/**
 * Whether a recognised slug is currently sellable. Gift sets are only
 * available if every flavour they contain is in stock — the Full Range set
 * needs all 4, and a Trio set needs whichever 3 flavour tokens are encoded
 * in its slug suffix (matched by hyphen-bounded substring since
 * "lite-sugar" itself contains a hyphen).
 */
function isAvailable(slug) {
  const out = soldOutNow();
  if (BASE_SLUGS.includes(slug)) return !out.includes(slug);
  if (slug === 'full-range-set') return out.length === 0;
  if (typeof slug === 'string' && slug.startsWith(TRIO_PREFIX)) {
    return !out.some((soldSlug) => {
      const token = soldSlug.replace(/^atta-/, '');
      return new RegExp(`(^|-)${token}(-|$)`).test(slug);
    });
  }
  return true; // unrecognised slugs are rejected elsewhere by priceForSlug
}

module.exports = {
  isValidTrioSlug, boxesForSlug, priceForSlug, mrpForSlug, priceBook, isAvailable, nameForSlug, BASE_SLUGS };
