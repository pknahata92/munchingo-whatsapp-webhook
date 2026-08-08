'use strict';

const axios = require('axios');

const API_VERSION = 'v21.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

function getHeaders() {
  return {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

async function sendMessage(payload) {
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  const url = `${BASE_URL}/${phoneNumberId}/messages`;

  try {
    const res = await axios.post(url, payload, { headers: getHeaders() });
    console.log('[WA] Message sent →', res.data.messages?.[0]?.id);
    return res.data;
  } catch (err) {
    const errData = err.response?.data?.error || err.message;
    console.error('[WA] Send error:', JSON.stringify(errData));
    throw err;
  }
}

// ── Approved template message (bypasses the 24h session window) ───────────────
async function sendTemplate(to, templateName, languageCode, bodyParams) {
  return sendMessage({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components: [
        {
          type: 'body',
          parameters: bodyParams.map((text) => ({ type: 'text', text: String(text) })),
        },
      ],
    },
  });
}

// ── Plain text ────────────────────────────────────────────────────────────────
async function sendText(to, text) {
  return sendMessage({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body: text, preview_url: false },
  });
}

// ── Mark message as read (removes the clock icon for the sender) ──────────────
async function markRead(messageId) {
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  const url = `${BASE_URL}/${phoneNumberId}/messages`;
  await axios.post(
    url,
    { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
    { headers: getHeaders() }
  );
}

// ── Typing indicator (shows "…" to user while bot is "thinking") ──────────────
async function sendTyping(to) {
  // WhatsApp Cloud API doesn't have a separate typing API;
  // marking the last message as read is enough to clear the indicator.
  // This is a no-op placeholder so handlers can call it without if-checks.
}

// ── Quick-reply button message ────────────────────────────────────────────────
async function sendButtons(to, body, buttons) {
  // buttons: [{ id, title }]  — max 3
  return sendMessage({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body },
      action: {
        buttons: buttons.map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  });
}

// ── Single-column list message ────────────────────────────────────────────────
async function sendList(to, headerText, body, buttonLabel, sections) {
  // sections: [{ title, rows: [{ id, title, description? }] }]
  return sendMessage({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: headerText },
      body: { text: body },
      action: {
        button: buttonLabel,
        sections,
      },
    },
  });
}

// ── Catalog message (opens the WhatsApp in-chat catalog) ─────────────────────
async function sendCatalog(to, bodyText, thumbnailRetailerId) {
  const catalogId = process.env.CATALOG_ID;
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'catalog_message',
      body: { text: bodyText },
      action: { name: 'catalog_message' },
    },
  };

  if (thumbnailRetailerId) {
    payload.interactive.action.parameters = {
      thumbnail_product_retailer_id: thumbnailRetailerId,
    };
  }

  return sendMessage(payload);
}

// ── Image message ─────────────────────────────────────────────────────────────
async function sendImage(to, imageUrl, caption) {
  return sendMessage({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'image',
    image: { link: imageUrl, caption },
  });
}

module.exports = {
  sendTemplate,
  sendText,
  sendButtons,
  sendList,
  sendCatalog,
  sendImage,
  markRead,
  sendTyping,
};
