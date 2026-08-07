'use strict';
const axios = require('axios');
const crypto = require('crypto');

/**
 * Create a Razorpay Payment Link for a Munchingo order.
 * Returns { id, short_url } from Razorpay.
 */
async function createPaymentLink({ orderId, amount, customerPhone, customerName }) {
  const keyId     = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET env vars must be set');
  }

  // WhatsApp sends phone as "919XXXXXXXXX" — Razorpay wants "+91XXXXXXXXX"
  const phone = customerPhone.startsWith('+') ? customerPhone : `+${customerPhone}`;

  // Amount in paise (₹1 = 100 paise)
  const amountPaise = amount * 100;

  // Payment link expires in 24 hours
  const expireBy = Math.floor(Date.now() / 1000) + 86400;

  const payload = {
    amount:       amountPaise,
    currency:     'INR',
    description:  `Munchingo Order ${orderId}`,
    reference_id: orderId,
    customer: {
      name:    customerName || 'Munchingo Customer',
      contact: phone,
    },
    notify: {
      sms:       false,   // We send via WhatsApp ourselves
      email:     false,
      whatsapp:  false,
    },
    reminder_enable: false,
    expire_by:       expireBy,
    callback_url:    `https://munchingo-whatsapp-webhook.onrender.com/razorpay-webhook`,
    callback_method: 'get',
  };

  const response = await axios.post(
    'https://api.razorpay.com/v1/payment_links',
    payload,
    {
      auth: { username: keyId, password: keySecret },
      timeout: 10000,
    }
  );

  console.log(`[RAZORPAY] Payment link created: ${response.data.short_url}`);
  return { id: response.data.id, url: response.data.short_url };
}

/**
 * Verify a Razorpay webhook signature.
 * Returns true if the signature is valid.
 */
function verifyWebhookSignature(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(signature,  'hex')
  );
}

module.exports = { createPaymentLink, verifyWebhookSignature };
