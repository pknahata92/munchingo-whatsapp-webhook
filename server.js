'use strict';

require('dotenv').config();
const express = require('express');
const handler = require('./handlers/messageHandler');
const wa = require('./utils/whatsapp');

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'munchingo_webhook_secret_2026';


// ── Test email notification (remove after verifying) ─────────────────────────
app.get('/test-email', async (req, res) => {
  const { sendOrderEmail } = require('./utils/mailer');
  try {
    await sendOrderEmail({
      orderId: 'MNG-TEST-0708',
      customerPhone: '919999999999',
      customerName: 'Test Customer',
      items: [
        { productName: 'Munchingo Atta Original', quantity: 2, item_price: 250, product_retailer_id: '91slwpjdqq' },
        { productName: 'Munchingo Atta Kesari', quantity: 1, item_price: 250, product_retailer_id: 'w2w5ynf2m5' },
      ],
      total: 750,
      timestamp: new Date().toISOString(),
    });
    res.json({ ok: true, message: 'Test email sent to ' + process.env.NOTIFY_EMAIL });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});



// ── Payment success redirect (GET) ───────────────────────────────────────────
// Razorpay redirects the customer's browser here after payment.
// The actual order confirmation is handled by the POST /razorpay-webhook.
app.get('/payment-success', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Payment Successful – Munchingo</title>
  <style>
    body { font-family: sans-serif; text-align: center; padding: 60px 20px; background: #fffbf5; color: #333; }
    h1 { font-size: 2rem; margin-bottom: 8px; }
    p  { font-size: 1.1rem; color: #666; }
    .emoji { font-size: 3rem; }
  </style>
</head>
<body>
  <div class="emoji">🍪</div>
  <h1>Payment Successful!</h1>
  <p>Thank you for ordering from <strong>Munchingo</strong>.</p>
  <p>You'll receive a WhatsApp confirmation shortly.</p>
</body>
</html>`);
});

// ── Razorpay payment webhook (POST) ──────────────────────────────────────────
// Razorpay calls this when a payment link is paid.
// Register this URL in Razorpay Dashboard → Webhooks:
//   https://munchingo-whatsapp-webhook.onrender.com/razorpay-webhook
// Events to subscribe: payment_link.paid
app.post('/razorpay-webhook', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const { verifyWebhookSignature } = require('./utils/razorpay');
  const { markOrderPaid } = require('./utils/database');

  if (!verifyWebhookSignature(req.rawBody, signature)) {
    console.warn('[RAZORPAY] Webhook signature mismatch — ignoring');
    return res.sendStatus(400);
  }

  // Acknowledge fast — Razorpay will retry if we don't respond in 5 s
  res.sendStatus(200);

  try {
    const event = req.body; // already parsed by express.json()
    console.log('[RAZORPAY] Event:', event.event);

    if (event.event === 'payment_link.paid') {
      const pl        = event.payload.payment_link.entity;
      const payment   = event.payload.payment.entity;
      const orderId   = pl.reference_id;   // e.g. MNG-XXXX-DDMM
      const paymentId = payment.id;
      const phone     = pl.customer?.contact?.replace(/^\+/, ''); // strip + for WA

      await markOrderPaid(orderId, paymentId);
      console.log(`[RAZORPAY] Order ${orderId} paid — paymentId: ${paymentId}`);

      // Send confirmation on WhatsApp
      if (phone) {
        await wa.sendText(
          phone,
          `🎉 *Payment Confirmed!*\n\n` +
            `Your Munchingo order *#${orderId}* is confirmed!\n\n` +
            `We'll pack it fresh and ship within 1–2 business days. ` +
            `You'll get a tracking number once it's dispatched. 🍪\n\n` +
            `Thank you for ordering from Munchingo!`
        );
      }
    }
  } catch (err) {
    console.error('[RAZORPAY] Webhook processing error:', err.message);
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Munchingo WhatsApp Webhook', ts: new Date().toISOString() });
});

// ── Webhook verification (GET) ────────────────────────────────────────────────
// Meta calls this once when you register the webhook URL in the Developer Portal
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('[Webhook] Verification request:', { mode, token: token ? '***' : undefined });

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[Webhook] ✅ Verified');
    return res.status(200).send(challenge);
  }

  console.warn('[Webhook] ❌ Token mismatch — check VERIFY_TOKEN env var');
  return res.sendStatus(403);
});

// ── Incoming messages (POST) ──────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  // Acknowledge immediately — Meta will retry if we don't respond within 20 s
  res.sendStatus(200);

  const body = req.body;

  // Validate it's a WhatsApp Business Account event
  if (body.object !== 'whatsapp_business_account') {
    console.log('[Webhook] Ignoring non-WABA event:', body.object);
    return;
  }

  try {
    const changes = body.entry?.[0]?.changes?.[0];
    if (!changes) return;

    const value    = changes.value;
    const messages = value?.messages;
    const contacts = value?.contacts;
    const statuses = value?.statuses;

    // Handle status updates (delivered, read) — just log them
    if (statuses?.length) {
      for (const s of statuses) {
        console.log(`[Status] ${s.id} → ${s.status} (${s.recipient_id})`);
      }
      return;
    }

    if (!messages?.length) return;

    const message = messages[0];
    const from    = message.from;          // customer's phone number (E.164)
    const msgId   = message.id;
    const type    = message.type;

    // Extract contact name if Meta includes it
    const contactName = contacts?.[0]?.profile?.name || '';

    console.log(`[Message] from=${from} type=${type} name="${contactName}"`);

    // Mark as read so the customer sees double blue ticks
    await wa.markRead(msgId).catch(() => {});

    switch (type) {
      case 'text':
        await handler.routeText(from, message.text.body, contactName);
        break;

      case 'interactive':
        await handler.routeInteractive(from, message.interactive, contactName);
        break;

      case 'order':
        await handler.handleOrderMessage(from, message.order, contactName);
        break;

      case 'button':
        // Legacy quick-reply buttons (pre-API)
        await handler.routeInteractive(from, {
          type: 'button_reply',
          button_reply: { id: message.button?.payload, title: message.button?.text },
        }, contactName);
        break;

      case 'image':
      case 'video':
      case 'audio':
      case 'document':
      case 'sticker':
        // Media received — send a friendly nudge
        await wa.sendButtons(
          from,
          `Thanks for the ${type}! 📎 I'm a text bot — I might not be able to process media right now. How can I help?`,
          [
            { id: 'btn_products', title: '🛒 Browse Products' },
            { id: 'btn_order', title: '📦 How to Order' },
            { id: 'btn_faq', title: 'ℹ️ More Info' },
          ]
        );
        break;

      case 'reaction':
        // Emoji reaction on our message — log only
        console.log(`[Reaction] ${from} reacted ${message.reaction?.emoji} to ${message.reaction?.message_id}`);
        break;

      default:
        console.log(`[Webhook] Unhandled message type: ${type}`);
        await handler.sendWelcome(from, contactName);
    }
  } catch (err) {
    // Never crash on a webhook error — Meta will retry endlessly
    console.error('[Webhook] Error processing message:', err.message);
  }
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Munchingo WhatsApp webhook running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/`);
  console.log(`   Webhook: http://localhost:${PORT}/webhook`);
});
