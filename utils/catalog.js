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

/**
 * Look up the real price for a website cart item slug.
 * Returns the price in rupees, or null if the slug isn't recognised.
 */
function priceForSlug(slug) {
  if (Object.prototype.hasOwnProperty.call(PRICES, slug)) return PRICES[slug];
  if (typeof slug === 'string' && slug.startsWith(TRIO_PREFIX)) return TRIO_PRICE;
  return null;
}

module.exports = { priceForSlug };
