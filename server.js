'use strict';

require('dotenv').config();
const express = require('express');
const handler = require('./handlers/messageHandler');
const wa = require('./utils/whatsapp');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'munchingo_webhook_secret_2026';

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
