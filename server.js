'use strict';

require('dotenv').config();
const crypto  = require('crypto');
const express = require('express');
const handler = require('./handlers/messageHandler');
const wa      = require('./utils/whatsapp');
const checkoutRoutes = require('./routes/checkout');

// Verifies Meta's X-Hub-Signature-256 header on incoming WhatsApp webhook
// calls, using the App Secret from Meta Developer Portal > App Settings.
// Without this, anyone who finds this URL can POST fake WhatsApp messages
// (any "from" number, any content) and the bot will act on them.
//
// Fails OPEN (logs a warning, allows the request) if META_APP_SECRET isn't
// set yet, so this doesn't take the live bot down before the secret is
// configured in Render. Once set, it fails CLOSED like the Razorpay check.
let warnedMissingAppSecret = false;
function verifyMetaSignature(rawBody, signatureHeader) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) {
    if (!warnedMissingAppSecret) {
      console.warn('[WEBHOOK] META_APP_SECRET not set — incoming WhatsApp webhook requests are NOT signature-verified. Set it in Render to close this gap.');
      warnedMissingAppSecret = true;
    }
    return true;
  }
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

  try {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const expectedBuf  = Buffer.from(expected, 'hex');
    const providedBuf  = Buffer.from(signatureHeader.slice('sha256='.length), 'hex');
    if (expectedBuf.length !== providedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, providedBuf);
  } catch (err) {
    console.warn('[WEBHOOK] Signature verification error:', err.message);
    return false;
  }
}

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// CORS - the checkout page on munchingo.com calls this backend from the browser.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.SITE_ORIGIN || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(checkoutRoutes);

const PORT         = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'munchingo_webhook_secret_2026';


// ── Payment success redirect (GET) ────────────────────────────────────────────
// Razorpay redirects the customer's browser here after payment.
// The actual order confirmation is handled by the POST /razorpay-webhook.
app.get('/payment-success', (req, res) => {
  const SITE_URL = process.env.SITE_ORIGIN || 'https://munchingo.com';
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="4;url=${SITE_URL}">
  <title>Payment Successful – Munchingo</title>
  <style>
    body { font-family: sans-serif; text-align: center; padding: 60px 20px; background: #fffbf5; color: #333; }
    h1 { font-size: 2rem; margin-bottom: 8px; }
    p  { font-size: 1.1rem; color: #666; }
    .emoji { font-size: 3rem; }
    a  { color: #6B3A2A; font-weight: 600; }
  </style>
</head>
<body>
  <div class="emoji">🍪</div>
  <h1>Payment Successful!</h1>
  <p>Thank you for ordering from <strong>Munchingo</strong>.</p>
  <p>You'll receive a WhatsApp confirmation shortly.</p>
  <p>Redirecting you back to <a href="${SITE_URL}">munchingo.com</a>…</p>
</body>
</html>`);
});


// ── Razorpay webhook (POST) ───────────────────────────────────────────────────
// Register this URL in Razorpay Dashboard → Webhooks:
//   https://munchingo-whatsapp-webhook.onrender.com/razorpay-webhook
//
// Subscribe to these events:
//   ✅ payment_link.paid
//   ✅ payment_link.expired
//   ✅ payment.failed
//
app.post('/razorpay-webhook', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const { verifyWebhookSignature } = require('./utils/razorpay');

  if (!verifyWebhookSignature(req.rawBody, signature)) {
    console.warn('[RAZORPAY] Webhook signature mismatch — ignoring');
    return res.sendStatus(400);
  }

  // Acknowledge fast — Razorpay retries if we don't respond within 5 s
  res.sendStatus(200);

  try {
    const event = req.body;
    console.log('[RAZORPAY] Event:', event.event);

    // ── payment_link.paid ─────────────────────────────────────────────────────
    if (event.event === 'payment_link.paid') {
      const pl        = event.payload.payment_link.entity;
      const payment   = event.payload.payment.entity;
      const orderId   = pl.reference_id;
      const paymentId = payment.id;
      const phone     = pl.customer?.contact?.replace(/^\+/, '');

      const { getOrder, markOrderPaid } = require('./utils/database');

      // Idempotency: skip if already paid (duplicate webhook)
      const existing = await getOrder(orderId);
      if (existing?.status === 'paid') {
        console.log(`[RAZORPAY] Duplicate webhook for ${orderId} — ignoring`);
        return;
      }

      await markOrderPaid(orderId, paymentId);
      console.log(`[RAZORPAY] Order ${orderId} paid — paymentId: ${paymentId}`);

      if (phone) {
        // Uses the approved "munchingo_order_confirmed" template instead of free text --
        // free text only delivers within WhatsApp's 24h session window, which a
        // website-checkout customer has almost never opened with the bot.
        const itemsSummary = (existing?.items || [])
          .map((item) => `${item.quantity}x ${item.productName || item.product_retailer_id}`)
          .join(', ');
        try {
          await wa.sendTemplate(phone, 'munchingo_order_confirmed', 'en', [
            existing?.customer_name || 'there',
            orderId,
            itemsSummary || 'your order',
            existing?.total,
          ]);
        } catch (err) {
          console.error('[WA] Failed to send order_confirmed template:', err.message);
        }
      }

      // Customer email confirmation — optional, only sent if the customer gave an email
      if (existing?.customer_email) {
        try {
          const { sendCustomerConfirmationEmail } = require('./utils/mailer');
          await sendCustomerConfirmationEmail({
            email:        existing.customer_email,
            orderId,
            customerName: existing.customer_name,
            items:        existing.items,
            total:        existing.total,
            timestamp:    existing.created_at,
          });
        } catch (err) {
          console.error('[MAILER] Failed to send customer confirmation:', err.message);
        }
      }
      return;
    }

    // ── payment_link.expired ──────────────────────────────────────────────────
    // Customer didn't pay within 24 hours — auto-generate a fresh link.
    if (event.event === 'payment_link.expired') {
      const pl      = event.payload.payment_link.entity;
      const orderId = pl.reference_id;
      const phone   = pl.customer?.contact?.replace(/^\+/, '');

      const { getOrder, updateOrderPaymentLink } = require('./utils/database');
      const { createPaymentLink }                 = require('./utils/razorpay');

      const existing = await getOrder(orderId);
      if (!existing || existing.status !== 'pending_payment') {
        console.log(`[RAZORPAY] payment_link.expired for ${orderId} — status: ${existing?.status}, skipping`);
        return;
      }

      console.log(`[RAZORPAY] Link expired for ${orderId} — generating new link`);

      if (phone) {
        try {
          const { id: newLinkId, url: newLinkUrl } = await createPaymentLink({
            orderId,
            amount:        existing.total,
            customerPhone: phone,
            customerName:  existing.customer_name,
          });
          await updateOrderPaymentLink(orderId, { paymentLinkId: newLinkId, paymentLinkUrl: newLinkUrl });

          await wa.sendText(
            phone,
            `⏰ *Your payment link expired.*\n\n` +
              `No worries — here's a fresh one for order *#${orderId}* (₹${existing.total}):\n\n` +
              `👉 ${newLinkUrl}\n\n` +
              `Valid for 24 hours. Let us know if you need any help! 🍪`
          );
        } catch (err) {
          console.error('[RAZORPAY] Failed to regenerate expired link:', err.message);
          // Link generation failed — tell the customer to ask for a new one manually
          await wa.sendText(
            phone,
            `⚠️ Your payment link for order *#${orderId}* has expired.\n\n` +
              `Reply *resend link* to get a fresh one, or contact us at hello@munchingo.com. 🍪`
          );
        }
      }
      return;
    }

    // ── payment.failed ────────────────────────────────────────────────────────
    // Customer attempted payment but it failed (wrong PIN, insufficient funds, etc.)
    if (event.event === 'payment.failed') {
      const payment = event.payload.payment.entity;
      const phone   = payment.contact?.replace(/^\+/, '');
      const reason  = payment.error_description || 'Payment failed';

      // Extract order ID from description "Munchingo Order MNG-XXXX-DDMM"
      const match   = (payment.description || '').match(/MNG-[A-Z0-9]+-\d{4}/);
      const orderId = match ? match[0] : null;

      console.log(`[RAZORPAY] payment.failed — orderId: ${orderId}, phone: ${phone}, reason: ${reason}`);

      if (phone) {
        await wa.sendText(
          phone,
          `⚠️ *Payment Unsuccessful*\n\n` +
            `We couldn't process your payment${orderId ? ` for order *#${orderId}*` : ''}.\n\n` +
            `*Reason:* ${reason}\n\n` +
            `Your order is still saved — please try again using the same link, ` +
            `or reply *resend link* to get a fresh payment link. 🍪\n\n` +
            `Need help? Reply *human* to speak with our team.`
        );
      }
      return;
    }

    console.log(`[RAZORPAY] Unhandled event type: ${event.event}`);
  } catch (err) {
    console.error('[RAZORPAY] Webhook processing error:', err.message);
  }
});


// ── Daily packing-list digest (GET) ───────────────────────────────────────────
// Triggered once a day by a scheduled GitHub Actions workflow (see
// .github/workflows/daily-digest.yml) rather than an in-process cron, since
// this service runs on Render's free tier and can spin down between requests
// — a timer inside the process isn't guaranteed to fire at a wall-clock time.
// Protected by a shared secret (DIGEST_SECRET) rather than left open, since it
// reads and emails every customer's name/phone/address for the window.
app.get('/internal/daily-digest', async (req, res) => {
  const secret = process.env.DIGEST_SECRET;
  if (!secret) {
    console.warn('[DIGEST] DIGEST_SECRET not set — refusing to run');
    return res.sendStatus(503);
  }
  const provided = req.query.secret || '';
  const expectedBuf = Buffer.from(secret);
  const providedBuf = Buffer.from(String(provided));
  const matches = expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf);
  if (!matches) return res.sendStatus(403);

  try {
    const { getOrdersPaidSince } = require('./utils/database');
    const { sendDailyDigestEmail } = require('./utils/mailer');

    const until = new Date();
    const since = new Date(until.getTime() - 24 * 60 * 60 * 1000);
    const orders = await getOrdersPaidSince(since.toISOString(), until.toISOString());

    const windowLabel = until.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
    await sendDailyDigestEmail({ orders, windowLabel });

    res.json({ ok: true, orders: orders.length });
  } catch (err) {
    console.error('[DIGEST] Failed to send daily digest:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Munchingo WhatsApp Webhook', ts: new Date().toISOString() });
});


// ── Webhook verification (GET) ────────────────────────────────────────────────
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
  if (!verifyMetaSignature(req.rawBody, req.headers['x-hub-signature-256'])) {
    console.warn('[WEBHOOK] Signature mismatch — ignoring request');
    return res.sendStatus(401);
  }

  // Acknowledge immediately — Meta retries if we don't respond within 20 s
  res.sendStatus(200);

  const body = req.body;

  if (body.object !== 'whatsapp_business_account') {
    console.log('[Webhook] Ignoring non-WABA event:', body.object);
    return;
  }

  try {
    const changes  = body.entry?.[0]?.changes?.[0];
    if (!changes) return;

    const value    = changes.value;
    const messages = value?.messages;
    const contacts = value?.contacts;
    const statuses = value?.statuses;

    // Status updates (delivered, read) — log only
    if (statuses?.length) {
      for (const s of statuses) {
        console.log(`[Status] ${s.id} → ${s.status} (${s.recipient_id})`);
      }
      return;
    }

    if (!messages?.length) return;

    const message     = messages[0];
    const from        = message.from;
    const msgId       = message.id;
    const type        = message.type;
    const contactName = contacts?.[0]?.profile?.name || '';

    console.log(`[Message] from=${from} type=${type} name="${contactName}"`);

    // Mark as read (double blue tick)
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
        await wa.sendButtons(
          from,
          `Thanks for the ${type}! 📎 I'm a text bot — I might not be able to process media right now. How can I help?`,
          [
            { id: 'btn_products', title: '🛒 Browse Products' },
            { id: 'btn_order',    title: '📦 How to Order' },
            { id: 'btn_faq',      title: 'ℹ️ More Info' },
          ]
        );
        break;

      case 'reaction':
        console.log(`[Reaction] ${from} reacted ${message.reaction?.emoji} to ${message.reaction?.message_id}`);
        break;

      default:
        console.log(`[Webhook] Unhandled message type: ${type}`);
        await handler.sendWelcome(from, contactName);
    }
  } catch (err) {
    console.error('[Webhook] Error processing message:', err.message);
  }
});


// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Munchingo WhatsApp webhook running on port ${PORT}`);
  console.log(`   Health:  http://localhost:${PORT}/`);
  console.log(`   Webhook: http://localhost:${PORT}/webhook`);
});
