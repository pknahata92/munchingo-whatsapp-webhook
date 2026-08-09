'use strict';

// Server-side source of truth for website checkout pricing, keyed by the
// slug the website's Add-to-Bag buttons use (js/cart.js). Never trust a
// price/total submitted by the client — always look it up here.
const PRICES = {
  'atta-original':   279,
  'atta-kesari':      319,
  'atta-lite-sugar':  319,
  'atta-ajwain':      279,
  'full-range-set':  1079,
};

// The Trio gift set's slug is built dynamically from the 3 chosen flavours
// (e.g. "trio-gift-set-ajwain-kesari-original") but the price is flat.
const TRIO_PREFIX = 'trio-gift-set';
const TRIO_PRICE = 789;

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

/**
 * Look up the real price for a website cart item slug.
 * Returns the price in rupees, or null if the slug isn't recognised.
 */
function priceForSlug(slug) {
  if (Object.prototype.hasOwnProperty.call(PRICES, slug)) return PRICES[slug];
  if (typeof slug === 'string' && slug.startsWith(TRIO_PREFIX)) return TRIO_PRICE;
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
  if (BASE_SLUGS.includes(slug)) return !SOLD_OUT_SLUGS.includes(slug);
  if (slug === 'full-range-set') return SOLD_OUT_SLUGS.length === 0;
  if (typeof slug === 'string' && slug.startsWith(TRIO_PREFIX)) {
    return !SOLD_OUT_SLUGS.some((soldSlug) => {
      const token = soldSlug.replace(/^atta-/, '');
      return new RegExp(`(^|-)${token}(-|$)`).test(slug);
    });
  }
  return true; // unrecognised slugs are rejected elsewhere by priceForSlug
}

module.exports = { priceForSlug, isAvailable };
