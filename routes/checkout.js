'use strict';

const express = require('express');
const router = express.Router();

// Reuse the REAL, already-deployed modules — do not duplicate them.
const { createPaymentLink, orderIdFromReference } = require('../utils/razorpay');
const { saveOrder, updateOrderAddress, updateOrderPaymentLink, getOrder } = require('../utils/database');
const { sendContactFormEmail } = require('../utils/mailer');
const { ordersOpen, CLOSED_MESSAGE } = require('../utils/launch');
const { priceForSlug, isAvailable, nameForSlug, boxesForSlug } = require('../utils/catalog');
const { rateLimit } = require('../utils/rateLimit');
const { validateCoupon } = require('../utils/coupons');
const { createSubscription, attachSubscriptionToOrder } = require('../utils/subscriptions');

// "Subscribe & Save" — flat discount on every renewal (see
// subscriptions_migration.sql for why this is a "generate a fresh payment
// link each cycle" model, not true autopay). A subscribing order always
// gets this discount instead of any coupon code — the two are mutually
// exclusive by design, to avoid compounding-discount margin risk.
const SUBSCRIPTION_DISCOUNT_PCT = 8;
const SUBSCRIPTION_FREQUENCY_DAYS = 30;

// Minimum order for the automated (nationwide courier) checkout, counted in BOXES:
// the courier mailer packs hold 3-4 boxes, so smaller orders are not fulfilled through
// this system (singles are arranged manually/hyperlocally). A Trio gift set counts as
// 3 boxes and the Full Range set as 4 - see boxesForSlug in utils/catalog.js.
// Keep equal to MIN_BOXES in the website's js/cart.js.
const MIN_BOXES = 3;

// Helpers
function generateOrderId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const rand = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    return `MNG-${rand}-${dd}${mm}`;
}

// Website cart items look like { name, price, qty, unit, slug }.
// saveOrder just stores whatever shape is in items (jsonb column) - match the
// shape messageHandler.js already uses elsewhere so anything reading order.items
// downstream (owner email, etc.) stays consistent.
//
// SECURITY: item_price is looked up server-side from utils/catalog.js by
// slug, never trusted from the client's submitted price/total - a customer
// could otherwise tamper with the POST body (devtools, curl) and pay
// whatever amount they choose for real products.
//
// SECURITY: productName is likewise looked up server-side by slug, never
// taken from the client's submitted name - that name later gets dropped,
// unescaped, into the owner's order-notification email and the branded
// order-confirmed.html page, so trusting it would let a crafted checkout
// POST inject markup/script into both.
//
// Returns { items } on success. Returns { error } if any slug isn't
// recognised, or is recognised but currently marked sold out in
// utils/catalog.js — either way, nothing is saved/charged.
function normaliseItems(cartItems) {
    for (const c of (cartItems || [])) {
          // A negative or fractional qty on one line would discount the others.
          if (!Number.isInteger(c.qty) || c.qty < 1 || c.qty > 50) {
                return { error: 'One or more item quantities look invalid. Please refresh your cart and try again.' };
          }
          if (priceForSlug(c.slug) == null) {
                return { error: 'One or more items in your cart are no longer recognised. Please refresh and try again.' };
          }
          if (!isAvailable(c.slug)) {
                return { error: `Sorry, "${nameForSlug(c.slug)}" is currently sold out. Please remove it from your cart and try again.` };
          }
    }
    const items = cartItems.map((c) => ({
          productName: nameForSlug(c.slug),
          quantity: c.qty,
          item_price: priceForSlug(c.slug),
          unit: c.unit,
          slug: c.slug,
    }));
    return { items };
}

function normalisePhone(rawPhone) {
    // Accepts 9988992024, +919988992024, 919988992024 -> returns 919988992024
  let digits = String(rawPhone || '').replace(/\D/g, '');
    if (digits.length === 10) digits = '91' + digits; // assume India if no country code given
  return digits;
}

// POST /api/checkout
// Body: { name, phone, address, items: [{name,price,qty,unit,slug}], total }
// Mirrors what handlers/messageHandler.js already does for WhatsApp-native orders:
// saveOrder -> updateOrderAddress -> createPaymentLink -> updateOrderPaymentLink.
// Payment confirmation, failed-payment, and expired-link handling all live in the
// EXISTING POST /razorpay-webhook route in server.js - this route does not touch
// any of that, so there's exactly one webhook handler, not two.
// Max 5 checkout attempts per IP per minute — generous for a real customer
// (who submits once), tight enough to blunt scripted abuse.
router.post('/api/checkout', rateLimit({ windowMs: 60_000, max: 5 }), async (req, res) => {
    try {
          const { name, phone, address, email, items, total, couponCode, subscribe, giftNote, addressParts, previewKey } = req.body;

      // Orders open at launch (see utils/launch.js); the owner can test earlier with the preview key.
      if (!ordersOpen(previewKey)) {
        return res.status(403).json({ ok: false, closed: true, error: CLOSED_MESSAGE });
      }

      if (typeof name !== 'string' || typeof address !== 'string' || name.length > 100 || address.length > 600) {
        return res.status(400).json({ ok: false, error: 'Name or address looks too long. Please shorten it and try again.' });
      }
      if (!name || !phone || !address || !Array.isArray(items) || !items.length || !total) {
              return res.status(400).json({ ok: false, error: 'Missing required fields: name, phone, address, items, total' });
      }

      const customerPhone = normalisePhone(phone);
          if (customerPhone.length < 12) {
                  return res.status(400).json({ ok: false, error: 'Phone number looks invalid - include a 10-digit number' });
          }

      await require('../utils/stock').ensureFresh();
      const { items: enrichedItems, error: itemsError } = normaliseItems(items);
          if (itemsError) {
                  return res.status(400).json({ ok: false, error: itemsError });
          }

      // Recompute the total server-side from real catalog prices - never trust
      // the client's submitted total (see normaliseItems for why).
      const realTotal = enrichedItems.reduce((sum, i) => sum + i.item_price * i.quantity, 0);

      // Minimum order for the automated (nationwide courier) checkout, in boxes.
      const totalBoxes = enrichedItems.reduce((n, i) => n + i.quantity * boxesForSlug(i.slug), 0);
      if (totalBoxes < MIN_BOXES) {
        return res.status(400).json({
          ok: false,
          error: `Online orders start at ${MIN_BOXES} boxes. Please add ${MIN_BOXES - totalBoxes} more box${MIN_BOXES - totalBoxes === 1 ? '' : 'es'} (or pick a gift set), or message us on WhatsApp directly for a smaller order.`,
        });
      }

      // "Subscribe & Save" requires an email on file — it's the only reliable
      // channel for renewal reminders (see subscriptions_migration.sql).
      const trimmedEmail = String(email || '').trim().slice(0, 120);
      if (trimmedEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmedEmail)) {
        return res.status(400).json({ ok: false, error: 'That email address does not look right. Please check it.' });
      }
      // A pre-order's dispatch date and tracking link only reach the customer by email (the 48-hour WhatsApp template is
      // skipped during the pre-order window), so the email is required until dispatch starts.
      if (require('../utils/launch').isPreorder() && !trimmedEmail) {
        return res.status(400).json({ ok: false, error: 'Please add your email address. Pre-orders are confirmed, and tracking is sent, by email.' });
      }
      if (subscribe && !trimmedEmail) {
        return res.status(400).json({ ok: false, error: 'An email address is required to subscribe — that\'s how we\'ll notify you each month your box is ready.' });
      }

      // Coupon (optional) — re-validated here even if the client already
      // called /api/validate-coupon, since that earlier "valid" response is
      // never trusted on its own (a cap could have filled up, a code could
      // have expired, in the time between the two calls). Validated against
      // realTotal, the server-computed pre-discount total, not the client's.
      // Mutually exclusive with Subscribe & Save — a subscribing order always
      // gets the flat subscription discount instead, never both stacked.
      let finalTotal = realTotal;
      let discountAmount = 0;
      let appliedCouponCode = null;
      if (subscribe) {
        discountAmount = Math.round(realTotal * (SUBSCRIPTION_DISCOUNT_PCT / 100));
        finalTotal = realTotal - discountAmount;
      } else if (couponCode) {
        const cartSlugs = enrichedItems.map((i) => i.slug);
        const couponResult = await validateCoupon(couponCode, { cartSlugs, realTotal, customerPhone });
        if (!couponResult.ok) {
          return res.status(400).json({ ok: false, error: couponResult.error });
        }
        finalTotal = couponResult.finalTotal;
        discountAmount = couponResult.discountAmount;
        appliedCouponCode = couponResult.coupon.code;
      }

      const orderId = generateOrderId();
          const timestamp = new Date().toISOString();

      // 1. Save order (status -> pending_address, then immediately attach address -> pending_payment)
      await saveOrder({
              orderId,
              customerPhone,
              customerName: name,
              customerEmail: trimmedEmail || null,
              items: enrichedItems,
              total: finalTotal,
              currency: 'INR',
              timestamp,
              couponCode: appliedCouponCode,
              discountAmount,
              giftNote: String(giftNote || '').trim().slice(0, 300) || null,
      });
          // Structured parts (state drives CGST/SGST vs IGST on the invoice). Strings only, length-capped.
          const parts = {};
          for (const k of ['state', 'city', 'pincode']) {
            if (addressParts && typeof addressParts[k] === 'string') parts[k] = addressParts[k].trim().slice(0, 60);
          }
          await updateOrderAddress(orderId, address, parts);

      // 2. Create Razorpay Payment Link via the EXISTING utils/razorpay.js
      //    (real createPaymentLink returns { id, url }, takes amount in rupees)
      // Charges finalTotal (post-discount), not realTotal.
      const { id: paymentLinkId, url: paymentLinkUrl } = await createPaymentLink({
              orderId,
              amount: finalTotal,
              customerName: name,
              customerPhone,
      });
          await updateOrderPaymentLink(orderId, { paymentLinkId, paymentLinkUrl });

      // Coupon redemption is recorded in the payment_link.paid webhook, so
      // abandoned orders don't consume a use.

      // 2c. Set up the recurring record for "Subscribe & Save". This first
      //     order is charged exactly like any other (finalTotal above already
      //     has the subscription discount baked in) — the subscription row
      //     only governs cycle 2 onward, picked up by the daily renewal cron.
      if (subscribe) {
        try {
          const subscriptionItems = enrichedItems.map((i) => ({ slug: i.slug, name: i.productName, unit: i.unit, quantity: i.quantity }));
          const subscription = await createSubscription({
            customerPhone,
            customerName: name,
            customerEmail: trimmedEmail,
            deliveryAddress: address,
            items: subscriptionItems,
            discountPct: SUBSCRIPTION_DISCOUNT_PCT,
            frequencyDays: SUBSCRIPTION_FREQUENCY_DAYS,
            firstOrderId: orderId,
          });
          await attachSubscriptionToOrder(orderId, subscription.id);
        } catch (err) {
          // Don't fail the whole checkout over this — the customer's actual
          // order and payment link are already committed at this point.
          // Worth Prashant seeing in the logs and setting up manually if it
          // ever happens, but not worth losing a real sale over.
          console.error('[CHECKOUT] Failed to create subscription record:', err.message);
        }
      }

      // No owner email here any more: an unpaid order is not news. The owner gets ONE email when the
      // payment lands (utils/invoiceFlow.js) and the 8:00 AM daily summary.

      console.log(`[CHECKOUT] Order ${orderId} created via website, payment link issued`);
          res.json({ ok: true, orderId, paymentUrl: paymentLinkUrl });
    } catch (err) {
          console.error('[CHECKOUT] Error:', err.message);
          res.status(500).json({ ok: false, error: 'Something went wrong creating your order. Please try again or message us on WhatsApp.' });
    }
});

// POST /api/validate-coupon
// Body: { code, phone, items: [{name,price,qty,unit,slug}] }
// Live "Apply" check from checkout.html — lets the customer see the
// discount before submitting the full order. This result is NOT trusted at
// final checkout; POST /api/checkout re-validates the code itself. Phone is
// optional here (the customer may not have typed it yet when they hit
// Apply) — the per-customer usage cap is skipped in that case and enforced
// for real at final submission instead.
router.post('/api/validate-coupon', rateLimit({ windowMs: 60_000, max: 10 }), async (req, res) => {
    try {
          const { code, phone, items } = req.body;
      if (!code || !Array.isArray(items) || !items.length) {
              return res.status(400).json({ ok: false, error: 'Missing required fields: code, items' });
      }

      await require('../utils/stock').ensureFresh();
      const { items: enrichedItems, error: itemsError } = normaliseItems(items);
          if (itemsError) return res.status(400).json({ ok: false, error: itemsError });

      const realTotal = enrichedItems.reduce((sum, i) => sum + i.item_price * i.quantity, 0);
      const cartSlugs = enrichedItems.map((i) => i.slug);
      const customerPhone = phone ? normalisePhone(phone) : null;

      const result = await validateCoupon(code, { cartSlugs, realTotal, customerPhone });
      if (!result.ok) return res.status(400).json({ ok: false, error: result.error });

      res.json({ ok: true, discountAmount: result.discountAmount, finalTotal: result.finalTotal });
    } catch (err) {
          console.error('[VALIDATE-COUPON] Error:', err.message);
          res.status(500).json({ ok: false, error: 'Could not check that code right now. Please try again.' });
    }
});

// POST /api/contact
// Body: { name, email, orderNumber, message }
// contact.html's contact form used to just re-open WhatsApp with the message
// stuffed into free text - which the bot has no reliable way to route to a
// human (it'd hit routeText()'s generic fallback unless it happened to match
// a keyword). This actually emails the owner instead, same pattern as the
// other *Alert mailer functions.
// Max 5 submissions per IP per minute - same generous-but-not-open ceiling
// as checkout.
router.post('/api/contact', rateLimit({ windowMs: 60_000, max: 5 }), async (req, res) => {
    try {
          const { name, email, orderNumber, message } = req.body;

      if (!name || !email || !message) {
              return res.status(400).json({ ok: false, error: 'Missing required fields: name, email, message' });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
              return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
      }

      await sendContactFormEmail({
              name: String(name).slice(0, 200),
              email: String(email).slice(0, 200),
              orderNumber: orderNumber ? String(orderNumber).slice(0, 50) : null,
              message: String(message).slice(0, 5000),
      });

      res.json({ ok: true });
    } catch (err) {
          console.error('[CONTACT] Error:', err.message);
          res.status(500).json({ ok: false, error: 'Something went wrong sending your message. Please try again or email us directly at info.munchingo@gmail.com.' });
    }
});

// GET /api/order/:orderId
// Powers order-confirmed.html — the real branded confirmation page, which
// polls this for the order's actual status rather than trusting Razorpay's
// callback redirect on its own (the callback can arrive before the webhook
// that actually marks the order paid; this endpoint always reflects the
// webhook-verified status in the database, the real source of truth).
// Deliberately returns only what a confirmation page needs to render —
// never phone, email, or internal payment/link IDs — so this stays safe to
// call from the browser with nothing but an order ID in the URL. orderId's
// own format (MNG-<4 random chars>-DDMM) is the access control here; rate
// limited the same as the other public endpoints against enumeration.
router.get('/api/order/:orderId', rateLimit({ windowMs: 60_000, max: 20 }), async (req, res) => {
    try {
          const order = await getOrder(orderIdFromReference(String(req.params.orderId || '').slice(0, 40)));
      if (!order) {
              return res.status(404).json({ ok: false, error: 'Order not found.' });
      }

      res.json({
              ok: true,
              orderId: order.order_id,
              status: order.status,
              customerName: order.customer_name,
              items: (order.items || []).map((i) => ({
                      name: i.productName || i.product_retailer_id,
                      quantity: i.quantity,
                      price: i.item_price,
              })),
              total: order.total,
              createdAt: order.created_at,
      });
    } catch (err) {
          console.error('[ORDER] Lookup error:', err.message);
          res.status(500).json({ ok: false, error: 'Could not look up that order right now.' });
    }
});

// Public, read-only: which base flavours are sold out right now (the cart greys them out).
router.get('/api/stock', rateLimit({ windowMs: 60_000, max: 60 }), async (req, res) => {
  const stock = require('../utils/stock');
  await stock.ensureFresh();
  res.set('Cache-Control', 'public, max-age=30').json({ ok: true, soldOut: stock.soldOutSlugs() || [] });
});

// Public, read-only: how many Founding 100 places are left. Nothing else about the coupon is exposed.
router.get('/api/promo/founding', rateLimit({ windowMs: 60_000, max: 60 }), async (req, res) => {
  try {
    const c = await require('../utils/database').getCouponUsage('FOUNDING10');
    const live = c && c.active && !(c.expires_at && new Date(c.expires_at) < new Date()) && c.max_uses != null;
    const remaining = live ? Math.max(0, c.max_uses - (c.uses_count || 0)) : 0;
    res.set('Cache-Control', 'public, max-age=60').json({ ok: true, remaining, total: live ? c.max_uses : 0 });
  } catch (err) {
    console.error('[PROMO] founding count failed:', err.message);
    res.status(503).json({ ok: false });
  }
});

module.exports = router;
