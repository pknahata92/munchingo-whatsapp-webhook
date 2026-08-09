'use strict';

const express = require('express');
const router = express.Router();

// Reuse the REAL, already-deployed modules — do not duplicate them.
const { createPaymentLink } = require('../utils/razorpay');
const { saveOrder, updateOrderAddress, updateOrderPaymentLink } = require('../utils/database');
const { sendOrderEmail } = require('../utils/mailer');
const { priceForSlug, isAvailable } = require('../utils/catalog');
const { rateLimit } = require('../utils/rateLimit');

// Minimum order value for the automated (nationwide courier) checkout.
// Single-box orders are only fulfilled hyperlocally/manually, not through
// this system - see the check in POST /api/checkout below.
const MIN_ORDER_VALUE = 599;

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
// Returns { items } on success. Returns { error } if any slug isn't
// recognised, or is recognised but currently marked sold out in
// utils/catalog.js — either way, nothing is saved/charged.
function normaliseItems(cartItems) {
    for (const c of (cartItems || [])) {
          if (priceForSlug(c.slug) == null) {
                return { error: 'One or more items in your cart are no longer recognised. Please refresh and try again.' };
          }
          if (!isAvailable(c.slug)) {
                return { error: `Sorry, "${c.name}" is currently sold out. Please remove it from your cart and try again.` };
          }
    }
    const items = cartItems.map((c) => ({
          productName: c.name,
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
          const { name, phone, address, email, items, total } = req.body;

      if (!name || !phone || !address || !Array.isArray(items) || !items.length || !total) {
              return res.status(400).json({ ok: false, error: 'Missing required fields: name, phone, address, items, total' });
      }

      const customerPhone = normalisePhone(phone);
          if (customerPhone.length < 12) {
                  return res.status(400).json({ ok: false, error: 'Phone number looks invalid - include a 10-digit number' });
          }

      const { items: enrichedItems, error: itemsError } = normaliseItems(items);
          if (itemsError) {
                  return res.status(400).json({ ok: false, error: itemsError });
          }

      // Recompute the total server-side from real catalog prices - never trust
      // the client's submitted total (see normaliseItems for why).
      const realTotal = enrichedItems.reduce((sum, i) => sum + i.item_price * i.quantity, 0);

      // Minimum order value for the automated (nationwide courier) checkout.
      // Single-box / below-MOV orders are fulfilled manually/hyperlocally by
      // Prashant directly, outside this system entirely - not something the
      // automated flow accepts.
      if (realTotal < MIN_ORDER_VALUE) {
        return res.status(400).json({
          ok: false,
          error: `Minimum order value is ₹${MIN_ORDER_VALUE} for delivery. Please add more to your cart, or message us on WhatsApp directly for a single-box order.`,
        });
      }

      const orderId = generateOrderId();
          const timestamp = new Date().toISOString();

      // 1. Save order (status -> pending_address, then immediately attach address -> pending_payment)
      await saveOrder({
              orderId,
              customerPhone,
              customerName: name,
              customerEmail: (email || '').trim() || null,
              items: enrichedItems,
              total: realTotal,
              currency: 'INR',
              timestamp,
      });
          await updateOrderAddress(orderId, address);

      // 2. Create Razorpay Payment Link via the EXISTING utils/razorpay.js
      //    (real createPaymentLink returns { id, url }, takes amount in rupees)
      const { id: paymentLinkId, url: paymentLinkUrl } = await createPaymentLink({
              orderId,
              amount: realTotal,
              customerName: name,
              customerPhone,
      });
          await updateOrderPaymentLink(orderId, { paymentLinkId, paymentLinkUrl });

      // 3. Notify the owner by email (mirrors handlers/messageHandler.js's WhatsApp order flow)
      try {
        await sendOrderEmail({ orderId, customerPhone, customerName: name, items: enrichedItems, total: realTotal, timestamp });
      } catch (err) {
        console.error('[MAILER] Failed to send order notification:', err.message);
      }

      console.log(`[CHECKOUT] Order ${orderId} created via website, payment link issued`);
          res.json({ ok: true, orderId, paymentUrl: paymentLinkUrl });
    } catch (err) {
          console.error('[CHECKOUT] Error:', err.message);
          res.status(500).json({ ok: false, error: 'Something went wrong creating your order. Please try again or message us on WhatsApp.' });
    }
});

module.exports = router;
