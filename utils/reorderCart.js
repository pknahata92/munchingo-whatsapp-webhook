'use strict';
// Reorder cart link (16 Nov 2026, growth journey J4 and J6): the path after https://munchingo.com/ that refills a buyer's bag in
// one tap. Two of their favourite plus one Flavor they have never had, when one is in stock; otherwise their last order again.
// Sold-out Flavors never appear, and with nothing to put in the bag the link opens the shop. No discount, no Sets: the site's
// cart link (js/cart-link.js, add=<slug>:<qty>,<slug>, utm tags kept) takes single boxes only, so when the last order had a Set
// the link opens Build a box instead of breaking the Set into singles (ruling R20). Every cart is at least 2 boxes, the site's
// minimum: a smaller one has its first slug (the favourite, or the try when no favourite is in stock) topped up (ruling R30).
//   Tests: scripts/reorder-cart-test.js
const { boxesBySlug } = require('./inventory');
const { flavoursFor } = require('./reviews');
const { isGiftSet } = require('./orderText');

const SLUGS = ['atta-original', 'atta-kesari', 'atta-ajwain', 'atta-lite-sugar'];   // tie-break order, and the order in the link
const MIN_BOXES = 2;   // the site's 2-box minimum (R30)

// A WhatsApp catalog line stores Meta's retailer id instead of the slug; flavoursFor knows the mapping.
const withSlug = (it) => (it && !it.slug ? { ...it, slug: (flavoursFor({ items: [it] })[0] || {}).slug } : it);
const boxesIn = (order) => boxesBySlug(((order && order.items) || []).map(withSlug));

/**
 * { orders (that phone's paid orders, newest first), inStock: Set of slugs, campaign, medium: 'journey' | 'broadcast' }
 *   -> { path, trySlug, favSlug }
 * favSlug: the in-stock Flavor with the most boxes in the newest order (a tie goes to the first in SLUGS), or null when nothing
 * from that order is in stock (then "your usual" would not be true). trySlug: the first in-stock Flavor never bought, or null
 * (always null when the last order had a Set: that link is build-a-box?utm_...).
 */
function cartLink({ orders, inStock, campaign, medium }) {
  const list = orders || [];
  const has = (s) => !!inStock && inStock.has(s);
  const utm = `utm_source=whatsapp&utm_medium=${medium}&utm_campaign=${campaign}`;
  const shop = { path: `shop?${utm}`, trySlug: null, favSlug: null };
  if (!list.length) return shop;
  const last = boxesIn(list[0]);
  const bought = new Set();
  for (const o of list) for (const [slug, boxes] of Object.entries(boxesIn(o))) if (boxes > 0) bought.add(slug);
  let favSlug = null;
  for (const s of SLUGS) if (has(s) && last[s] > 0 && (!favSlug || last[s] > last[favSlug])) favSlug = s;
  if (!SLUGS.some(has)) return shop;
  if (((list[0] && list[0].items) || []).some((it) => it && isGiftSet(it))) return { path: `build-a-box?${utm}`, trySlug: null, favSlug };
  const trySlug = SLUGS.find((s) => has(s) && !bought.has(s)) || null;
  const lines = trySlug
    ? [favSlug && [favSlug, 2], [trySlug, 1]].filter(Boolean)
    : SLUGS.filter((s) => has(s) && last[s] > 0).map((s) => [s, last[s]]);
  if (!lines.length) return shop;
  const total = lines.reduce((n, [, q]) => n + q, 0);
  if (total < MIN_BOXES) lines[0][1] += MIN_BOXES - total;   // R30: never a cart under the 2-box minimum
  const parts = lines.map(([s, q]) => (s === trySlug && q === 1 ? s : `${s}:${q}`));   // one try box keeps the bare slug, as before
  return { path: `cart?add=${parts.join(',')}&${utm}`, trySlug, favSlug };
}

module.exports = { cartLink, SLUGS };
