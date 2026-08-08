'use strict';

const express = require('express');
const router = express.Router();

// Reuse the REAL, already-deployed modules — do not duplicate them.
const { createPaymentLink } = require('../utils/razorpay');
const { saveOrder, updateOrderAddress, updateOrderPaymentLink } = require('../utils/database');
const { sendOrderEmail } = require('../utils/mailer');

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
function normaliseItems(cartItems) {
    return (cartItems || []).map((c) => ({
          productName: c.name,
          quantity: c.qty,
          item_price: c.price,
          unit: c.unit,
          slug: c.slug,
    }));
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
router.post('/api/checkout', async (req, res) => {
    try {
          const { name, phone, address, items, total } = req.body;

      if (!name || !phone || !address || !Array.isArray(items) || !items.length || !total) {
              return res.status(400).json({ ok: false, error: 'Missing required fields: name, phone, address, items, total' });
      }

      const customerPhone = normalisePhone(phone);
          if (customerPhone.length < 12) {
                  return res.status(400).json({ ok: false, error: 'Phone number looks invalid - include a 10-digit number' });
          }

      const orderId = generateOrderId();
          const timestamp = new Date().toISOString();
          const enrichedItems = normaliseItems(items);

      // 1. Save order (status -> pending_address, then immediately attach address -> pending_payment)
      await saveOrder({
              orderId,
              customerPhone,
              customerName: name,
              items: enrichedItems,
              total,
              currency: 'INR',
              timestamp,
      });
          await updateOrderAddress(orderId, address);

      // 2. Create Razorpay Payment Link via the EXISTING utils/razorpay.js
      //    (real createPaymentLink returns { id, url }, takes amount in rupees)
      const { id: paymentLinkId, url: paymentLinkUrl } = await createPaymentLink({
              orderId,
              amount: total,
              customerName: name,
              customerPhone,
      });
          await updateOrderPaymentLink(orderId, { paymentLinkId, paymentLinkUrl });

      // 3. Notify the owner by email (mirrors handlers/messageHandler.js's WhatsApp order flow)
      try {
        await sendOrderEmail({ orderId, customerPhone, customerName: name, items: enrichedItems, total, timestamp });
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
