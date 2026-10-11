'use strict';

/**
 * Prices a cart for the website: the subtotal, the single-box subtotal, the best stock-up tier, an optional code, and the ONE
 * discount the customer gets. Used by POST /api/quote (what the checkout page shows) and POST /api/checkout (what is charged),
 * so the two can never disagree.
 *
 * Rules: Subscribe & Save stands alone. Otherwise the larger of (best tier, code) wins; a tie goes to the tier so no code use
 * is burned. Gift sets never count towards a tier and a tier never discounts them: they are already priced as a deal.
 * Tiers live in spend_tiers (offers_migration.sql), cached 30 s. If the table cannot be read there are simply no tiers.
 */
const db = require('./database');
const { validateCoupon } = require('./coupons');
const { BASE_SLUGS } = require('./catalog');

const TTL_MS = 30_000;
let cache = null;
let loadedAt = 0;
async function tierRows() {
  if (Date.now() - loadedAt > TTL_MS) {
    try { cache = await db.listSpendTiers(); }
    catch (err) { console.error('[OFFERS] could not read spend_tiers, no tiers for now:', err.message); cache = cache || []; }
    loadedAt = Date.now();
  }
  return cache || [];
}
function invalidate() { loadedAt = 0; cache = null; }

function liveTiers(rows, now = Date.now()) {
  return (rows || [])
    .filter((t) => t.active && (!t.starts_at || Date.parse(t.starts_at) <= now) && (!t.ends_at || Date.parse(t.ends_at) >= now))
    .map((t) => ({ id: t.id, min: Number(t.min_singles), off: Number(t.discount), label: t.label || null }))
    .sort((a, b) => a.min - b.min);
}
function bestTier(tiers, singles) {
  let best = null;
  for (const t of tiers) if (singles >= t.min && (!best || t.off > best.off)) best = t;
  return best;
}
function nextTier(tiers, singles, current) {
  const t = tiers.find((x) => x.min > singles && x.off > (current ? current.off : 0));
  return t ? { need: t.min - singles, off: t.off, min: t.min } : null;
}
const tierLabel = (t) => t.label || `Spend ₹${t.min.toLocaleString('en-IN')} on single boxes`;

function chooseDiscount({ tier, coupon }) {
  const t = tier ? { kind: 'tier', amount: tier.off, label: tierLabel(tier), code: null } : null;
  const c = coupon ? { kind: 'coupon', amount: coupon.discountAmount, label: `Promo (${coupon.coupon.code})`, code: coupon.coupon.code } : null;
  if (t && c) return c.amount > t.amount ? { ...c, beat: t } : { ...t, beat: c };
  return c || t || null;
}

async function priceCart({ items, couponCode, customerPhone, subscribe, subscriptionPct }) {
  const realTotal = items.reduce((n, i) => n + i.item_price * i.quantity, 0);
  const singles = items.filter((i) => BASE_SLUGS.includes(i.slug)).reduce((n, i) => n + i.item_price * i.quantity, 0);
  if (subscribe) {
    const amount = Math.round(realTotal * (subscriptionPct / 100));
    return { realTotal, singles, discount: { kind: 'subscription', amount, label: `Subscribe & Save (${subscriptionPct}%)`, code: null }, finalTotal: realTotal - amount, next: null, tiers: [], couponError: null };
  }
  const tiers = liveTiers(await tierRows());
  const hit = bestTier(tiers, singles);
  const tier = hit ? { ...hit, off: Math.min(hit.off, singles) } : null;
  let coupon = null;
  let couponError = null;
  if (couponCode) {
    const r = await validateCoupon(couponCode, { cartSlugs: items.map((i) => i.slug), realTotal, singlesTotal: singles, customerPhone });
    if (r.ok) coupon = r; else couponError = r.error;
  }
  const discount = chooseDiscount({ tier, coupon });
  return {
    realTotal, singles, discount, finalTotal: realTotal - (discount ? discount.amount : 0),
    next: nextTier(tiers, singles, tier), tiers: tiers.map((t) => ({ min: t.min, off: t.off })), couponError,
  };
}

module.exports = { priceCart, invalidate, liveTiers, bestTier, nextTier, chooseDiscount, tierLabel };
