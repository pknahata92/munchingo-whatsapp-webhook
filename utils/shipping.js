'use strict';

/**
 * Order minimum and shipping for the website (25 Oct 2026, "Pack of 2" flow):
 *   - the minimum order is 2 boxes (a Pack of 2: any two flavors); gift sets count as 3 and 4 boxes;
 *   - an order with a gift box (Trio, Full Range) always ships free (9 Nov 2026);
 *   - items under FREE_FROM rupees (before any discount) pay SHIPPING_FEE; from FREE_FROM up, shipping is free.
 *     Three boxes at Rs 259 come to exactly Rs 777, and both gift sets are above it.
 * The fee is stored on the order as an ordinary line (slug 'shipping'), so the total, the Razorpay amount, the GST invoice, Zoho,
 * refunds and the customer emails all carry it without special cases. Anything that counts or packs goods must skip it (goodsOnly).
 * Keep MIN_BOXES, FREE_FROM and SHIPPING_FEE equal to the values in the website's js/cart.js.
 */
const SHIPPING_SLUG = 'shipping';
const SHIPPING_NAME = 'Shipping charges';
const MIN_BOXES = 2;
const FREE_FROM = Number(process.env.FREE_SHIPPING_FROM) || 777;
const SHIPPING_FEE = Number(process.env.SHIPPING_FEE) || 49;

const isShippingItem = (i) => !!i && (i.slug === SHIPPING_SLUG || i.productName === SHIPPING_NAME || i.name === SHIPPING_NAME);
const goodsOnly = (items) => (items || []).filter((i) => !isShippingItem(i));

// True when any item is a gift box (a Trio or the Full Range: more than one box in a single item). Ignores the shipping line.
const hasGiftBox = (items) => (items || []).some((i) => !!i && !!i.slug && !isShippingItem(i) && require('./catalog').boxesForSlug(i.slug) > 1);

// Rupees of shipping for this many rupees of goods (before any discount). An order with a gift box ships free (9 Nov 2026).
const shippingFor = (goodsTotal, opts) => ((opts && opts.hasGiftBox) || goodsTotal >= FREE_FROM ? 0 : SHIPPING_FEE);

// The line saved on the order when a fee applies.
const shippingItem = (fee) => ({ productName: SHIPPING_NAME, quantity: 1, item_price: fee, unit: null, slug: SHIPPING_SLUG });

module.exports = { SHIPPING_SLUG, SHIPPING_NAME, MIN_BOXES, FREE_FROM, SHIPPING_FEE, isShippingItem, goodsOnly, hasGiftBox, shippingFor, shippingItem };
