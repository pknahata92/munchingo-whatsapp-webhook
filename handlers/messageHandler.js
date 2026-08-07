'use strict';

const wa = require('../utils/whatsapp');
const { sendOrderEmail } = require('../utils/mailer');
const { saveOrder, updateOrderAddress, getRecentPendingOrder } = require('../utils/database');

// ── Product catalogue ─────────────────────────────────────────────────────────
const PRODUCTS = [
  {
    id: 'original-atta-cookie',
    retailerId: '91slwpjdqq',
    name: 'Munchingo Atta Original',
    mrp: 330,
    price: 279,
    emoji: '🍪',
    description: 'Cardamom-kissed. The one we started with. Slow-baked to a warm gold, with just enough sweetness to know it\'s a cookie.',
  },
  {
    id: 'kesari-atta-cookie',
    retailerId: 'w2w5ynf2m5',
    name: 'Munchingo Atta Kesari',
    mrp: 375,
    price: 319,
    emoji: '🌸',
    description: 'Real saffron, hand-mixed into every batch. What you serve when someone visits and you want to impress them.',
  },
  {
    id: 'lite-sugar-atta-cookie',
    retailerId: 'vf5p90bcy5',
    name: 'Munchingo Atta Lite-Sugar',
    mrp: 375,
    price: 319,
    emoji: '💛',
    description: '95% less sugar than our Original. Sweetened with maltitol. For the person who reads the back of the pack first.',
  },
  {
    id: 'ajwain-atta-cookie',
    retailerId: '97q9r5q5q3',
    name: 'Munchingo Atta Ajwain',
    mrp: 330,
    price: 279,
    emoji: '🌿',
    description: 'Ajwain-forward, less sweet, more aromatic. Best with strong chai and a slow evening.',
  },
];

// ── Retailer ID → product lookup ──────────────────────────────────────────────
const RETAILER_MAP = Object.fromEntries(PRODUCTS.map((p) => [p.retailerId, p]));

// ── Generate a short human-friendly order ID ──────────────────────────────────
function generateOrderId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rand = Array.from({ length: 4 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join('');
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  return `MNG-${rand}-${dd}${mm}`;
}

// ── Greet a new / returning user ─────────────────────────────────────────────
async function sendWelcome(to, name) {
  const greeting = name ? `Hi ${name}! 👋` : 'Hey there! 👋';
  await wa.sendButtons(
    to,
    `${greeting} Welcome to *Munchingo* — pure desi ghee atta cookies baked with love. 🍪\n\nWhat can I help you with today?`,
    [
      { id: 'btn_products', title: '🛒 Browse Products' },
      { id: 'btn_order', title: '📦 Place an Order' },
      { id: 'btn_faq', title: 'ℹ️ More Info' },
    ]
  );
}

// ── Product list ──────────────────────────────────────────────────────────────
async function sendProductList(to) {
  await wa.sendCatalog(
    to,
    '🍪 Our pure desi ghee atta cookies — starting at ₹279 for a 250g pack.\n\nTap a product to add it to your cart!',
    '91slwpjdqq'
  );
}

// ── Ordering instructions ─────────────────────────────────────────────────────
async function sendOrderInstructions(to) {
  await wa.sendButtons(
    to,
    `📦 *How to order from Munchingo:*\n\n` +
      `1️⃣ Tap *Browse Products* to open our catalog\n` +
      `2️⃣ Select the cookies you want & tap *Add to Cart*\n` +
      `3️⃣ When ready, tap *View Cart → Checkout*\n` +
      `4️⃣ We'll confirm your order and share payment & delivery details\n\n` +
      `Minimum order: 1 pack (from ₹279)\n` +
      `Delivery across India 🇮🇳`,
    [
      { id: 'btn_products', title: '🛒 Browse Products' },
      { id: 'btn_contact', title: '📞 Talk to Us' },
    ]
  );
}

// ── Ingredients / what's inside ───────────────────────────────────────────────
async function sendIngredients(to) {
  await wa.sendText(
    to,
    `🌾 *What's in a Munchingo cookie?*\n\n` +
      `✅ 100% whole wheat atta\n` +
      `✅ Pure desi ghee (no refined oils)\n` +
      `✅ Natural cane sugar\n` +
      `✅ No artificial flavours or preservatives\n` +
      `✅ No maida / refined flour\n\n` +
      `Each variant uses the same clean base — only the flavour changes:\n` +
      `• *Original* — pure & buttery\n` +
      `• *Kesari* — saffron & cardamom\n` +
      `• *Lite-Sugar* — reduced sugar, same love ❤️\n` +
      `• *Ajwain* — carom seeds, great for digestion 🌿`
  );
}

// ── Shipping info ─────────────────────────────────────────────────────────────
async function sendShippingInfo(to) {
  await wa.sendButtons(
    to,
    `🚚 *Munchingo delivers across India!*\n\n` +
      `📍 We ship to all major cities & tier-2 towns\n` +
      `⏱️ Standard delivery: 3–5 business days\n` +
      `💰 Free delivery on orders above ₹599\n` +
      `📦 Orders are packed fresh & sealed securely\n\n` +
      `Questions about your area? Just ask!`,
    [
      { id: 'btn_products', title: '🛒 Order Now' },
      { id: 'btn_contact', title: '📞 Ask Us' },
    ]
  );
}

// ── Price list ────────────────────────────────────────────────────────────────
async function sendPriceList(to) {
  const lines = PRODUCTS.map(
    (p) => `${p.emoji} *${p.name}*\n   ~~₹${p.mrp}~~ → *₹${p.price}* (250g pack, ~60 pcs)`
  ).join('\n\n');

  await wa.sendButtons(
    to,
    `💰 *Munchingo Pricing:*\n\n${lines}\n\n🚚 Free delivery on orders ₹599+`,
    [
      { id: 'btn_products', title: '🛒 Shop Now' },
      { id: 'btn_order', title: '📦 How to Order' },
    ]
  );
}

// ── FAQ / more info ───────────────────────────────────────────────────────────
async function sendFAQ(to) {
  await wa.sendList(
    to,
    '❓ Munchingo FAQs',
    "Pick a topic and I'll answer instantly:",
    'Choose a topic',
    [
      {
        title: 'About our cookies',
        rows: [
          { id: 'faq_ingredients', title: "What's inside? 🌾", description: 'Ingredients & no-nasties promise' },
          { id: 'faq_price', title: 'How much? 💰', description: 'Full price list' },
          { id: 'faq_shelf', title: 'Shelf life? ⏳', description: 'How long they stay fresh' },
        ],
      },
      {
        title: 'Orders & delivery',
        rows: [
          { id: 'faq_shipping', title: 'Do you deliver to me? 🚚', description: 'Delivery coverage & timelines' },
          { id: 'faq_order', title: 'How do I order? 📦', description: 'Step-by-step ordering guide' },
          { id: 'faq_payment', title: 'Payment options? 💳', description: 'UPI, cards, COD' },
        ],
      },
    ]
  );
}

// ── Handle a WhatsApp order (sent when user checks out from catalog) ──────────
async function handleOrderMessage(to, order, contactName) {
  const name = contactName || 'there';
  const items = order.product_items || [];
  const orderId = generateOrderId();
  const timestamp = new Date().toISOString();

  const enrichedItems = items.map((item) => {
    const product = RETAILER_MAP[item.product_retailer_id];
    return { ...item, productName: product ? product.name : item.product_retailer_id };
  });

  const lines = enrichedItems
    .map((item) => `• ${item.productName} × ${item.quantity} — ₹${item.item_price * item.quantity}`)
    .join('\n');

  const total = items.reduce((sum, i) => sum + i.item_price * i.quantity, 0);

  // 1. Send order receipt
  await wa.sendText(
    to,
    `🧾 *Order Received, ${name}!*\n\n` +
      `*Order #${orderId}*\n\n` +
      `${lines}\n\n` +
      `*Total: ₹${total}*\n\n` +
      `Just one more step — we need your delivery address! 📍`
  );

  // 2. Ask for delivery address
  await wa.sendText(
    to,
    `📍 *Please reply with your delivery address:*\n\n` +
      `Include flat/house no., area/locality, city, and pincode.\n\n` +
      `_Example: 42, Shanti Nagar, Koramangala, Bengaluru 560034_`
  );

  // 3. Save to Supabase (status = pending_address)
  try {
    await saveOrder({
      orderId,
      customerPhone: to,
      customerName: name,
      items: enrichedItems,
      total,
      currency: order.currency,
      timestamp,
    });
  } catch (err) {
    console.error('[DB] Failed to save order:', err.message);
  }

  // 4. Send email notification
  console.log('[ORDER]', { orderId, customer: to, name, total, timestamp });
  try {
    await sendOrderEmail({ orderId, customerPhone: to, customerName: name, items: enrichedItems, total, timestamp });
  } catch (err) {
    console.error('[MAILER] Failed to send order notification:', err.message);
  }
}

// ── Route text messages by keyword ───────────────────────────────────────────
async function routeText(to, text, name) {
  const t = text.toLowerCase().trim();

  // ── Address collection: catch free-text replies for pending orders ─────────
  // Skip if it looks like a greeting/menu command
  if (!/^(hi|hello|hey|namaste|hola|start|menu)/.test(t)) {
    try {
      const pendingOrder = await getRecentPendingOrder(to);
      if (pendingOrder) {
        await updateOrderAddress(pendingOrder.order_id, text);
        await wa.sendText(
          to,
          `✅ *Address saved!*\n\n` +
            `📍 ${text}\n\n` +
            `Your payment link for *Order #${pendingOrder.order_id}* (₹${pendingOrder.total}) will be sent to you shortly.\n\n` +
            `We'll dispatch your cookies once payment is confirmed. 🍪`
        );
        return;
      }
    } catch (err) {
      console.error('[DB] Address lookup error:', err.message);
      // fall through to normal routing
    }
  }

  // ── Standard keyword routing ───────────────────────────────────────────────
  if (/^(hi|hello|hey|namaste|hola|start|menu)/.test(t)) {
    return sendWelcome(to, name);
  }
  if (/product|catalog|catalogue|show|browse|cookie|atta/.test(t)) {
    return sendProductList(to);
  }
  if (/order|buy|purchase|cart|checkout|want/.test(t)) {
    return sendOrderInstructions(to);
  }
  if (/ingredient|recipe|inside|ghee|maida|wheat|sugar|made of/.test(t)) {
    return sendIngredients(to);
  }
  if (/ship|deliver|delivery|city|area|india|pin|pincode/.test(t)) {
    return sendShippingInfo(to);
  }
  if (/price|cost|rate|how much|₹|rs\.?/.test(t)) {
    return sendPriceList(to);
  }
  if (/shelf|expiry|expire|last|fresh|store/.test(t)) {
    return wa.sendText(
      to,
      `⏳ *Shelf life:*\n\nOur cookies stay fresh for *30 days* from the bake date (printed on the pack).\n\nStore in a cool, dry place — and try not to eat them all at once! 😄`
    );
  }
  if (/pay|payment|upi|gpay|phonepe|card|cod|cash/.test(t)) {
    return wa.sendText(
      to,
      `💳 *Payment options:*\n\n✅ UPI (Google Pay, PhonePe, Paytm)\n✅ Debit / Credit card\n✅ Net banking\n✅ Cash on Delivery (select pincodes)\n\nWe'll share a secure payment link after confirming your order.`
    );
  }
  if (/faq|help|info|question|know/.test(t)) {
    return sendFAQ(to);
  }

  // Default fallback
  return wa.sendButtons(
    to,
    `Thanks for writing in! 🍪 I'm Munchingo's cookie bot — here's what I can help with:`,
    [
      { id: 'btn_products', title: '🛒 Browse Products' },
      { id: 'btn_order', title: '📦 How to Order' },
      { id: 'btn_faq', title: 'ℹ️ More Info' },
    ]
  );
}

// ── Route interactive replies (button & list) ─────────────────────────────────
async function routeInteractive(to, interactive, name) {
  const type = interactive.type;

  let buttonId;
  if (type === 'button_reply') {
    buttonId = interactive.button_reply?.id;
  } else if (type === 'list_reply') {
    buttonId = interactive.list_reply?.id;
  }

  switch (buttonId) {
    case 'btn_products':
      return sendProductList(to);

    case 'btn_order':
      return sendOrderInstructions(to);

    case 'btn_faq':
      return sendFAQ(to);

    case 'btn_contact':
      return wa.sendText(
        to,
        `📞 *Reach us directly:*\n\nEmail: hello@munchingo.com\nWebsite: www.munchingo.com\n\nWe typically reply within a few hours. 🍪`
      );

    case 'faq_ingredients':
      return sendIngredients(to);

    case 'faq_price':
      return sendPriceList(to);

    case 'faq_shipping':
      return sendShippingInfo(to);

    case 'faq_order':
      return sendOrderInstructions(to);

    case 'faq_shelf':
      return wa.sendText(
        to,
        `⏳ Munchingo cookies stay fresh for *30 days* from the bake date.\n\nBest enjoyed fresh — store in a cool, dry place out of direct sunlight.`
      );

    case 'faq_payment':
      return wa.sendText(
        to,
        `💳 *Payment options:*\n\n✅ UPI (Google Pay, PhonePe, Paytm)\n✅ Debit / Credit card\n✅ Net banking\n✅ Cash on Delivery (select pincodes)\n\nWe'll share a secure payment link after confirming your order.`
      );

    default:
      return sendWelcome(to, name);
  }
}

module.exports = {
  sendWelcome,
  sendProductList,
  sendOrderInstructions,
  sendIngredients,
  sendShippingInfo,
  sendPriceList,
  sendFAQ,
  handleOrderMessage,
  routeText,
  routeInteractive,
};
