'use strict';

const wa = require('../utils/whatsapp');
const { sendOrderEmail, sendFeedbackAlert, sendBulkInquiryAlert } = require('../utils/mailer');
const {
  saveOrder,
  updateOrderAddress,
  updateOrderEmail,
  updateOrderPaymentLink,
  cancelOrder,
  getRecentPendingOrder,
  getRecentPendingPaymentOrder,
  getRecentOrders,
} = require('../utils/database');
const { createPaymentLink, expirePaymentLink } = require('../utils/razorpay');

// WhatsApp Flow that collects delivery details as a structured form instead of
// free text (published in WhatsApp Manager > Flows > Delivery Details).
const DELIVERY_FLOW_ID = '1699615387965702';
// Standalone feedback flow, sent on request or after delivery.
const FEEDBACK_FLOW_ID = '1743198853381814';
// Corporate/bulk gifting lead-capture flow.
const BULK_GIFTING_FLOW_ID = '1066239432999546';
// Minimum order value for the automated catalog/checkout flow. Below this,
// an order is only fulfilled hyperlocally/manually by Prashant directly, not
// through the bot. Referenced in the pre-catalog nudge (sendProductList) and
// enforced for real in handleOrderMessage.
const MIN_ORDER_VALUE = 599;

// ── Product catalogue ─────────────────────────────────────────────────────────
const PRODUCTS = [
  {
    id: 'original-atta-cookie',
    retailerId: '91slwpjdqq',
    name: 'Munchingo Atta Original',
    mrp: 300,
    price: 259,
    emoji: '🍪',
    description: 'Cardamom-kissed. The one we started with. Slow-baked to a warm gold, with just enough sweetness to know it\'s a cookie.',
  },
  {
    id: 'kesari-atta-cookie',
    retailerId: 'w2w5ynf2m5',
    name: 'Munchingo Atta Kesari',
    mrp: 350,
    price: 299,
    emoji: '🌸',
    description: 'Real saffron, hand-mixed into every batch. What you serve when someone visits and you want to impress them.',
  },
  {
    id: 'lite-sugar-atta-cookie',
    retailerId: 'vf5p90bcy5',
    name: 'Munchingo Atta Sugar-Lite',
    mrp: 350,
    price: 299,
    emoji: '💛',
    description: '95% less sugar than our Original. Sweetened with maltitol. For the person who reads the back of the pack first.',
  },
  {
    id: 'ajwain-atta-cookie',
    retailerId: '97q9r5q5q3',
    name: 'Munchingo Atta Ajwain',
    mrp: 300,
    price: 259,
    emoji: '🌿',
    description: 'Ajwain-forward, less sweet, more aromatic. Best with strong chai and a slow evening.',
  },
];

// ── Retailer ID → product lookup ──────────────────────────────────────────────
const RETAILER_MAP = Object.fromEntries(PRODUCTS.map((p) => [p.retailerId, p]));

// ── Order status display helpers ──────────────────────────────────────────────
const STATUS_EMOJI = {
  pending_address: '📍',
  pending_payment: '💳',
  paid:            '✅',
  shipped:         '🚚',
  delivered:       '🎉',
  cancelled:       '❌',
};

const STATUS_TEXT = {
  pending_address: 'Waiting for delivery address',
  pending_payment: 'Payment pending',
  paid:            'Confirmed — being packed',
  shipped:         'Shipped',
  delivered:       'Delivered',
  cancelled:       'Cancelled',
};

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

// ── Greet a new / returning user ──────────────────────────────────────────────
async function sendWelcome(to, name) {
  const greeting = name ? `Hi ${name}! 👋` : 'Hey there! 👋';
  await wa.sendButtons(
    to,
    `${greeting} Welcome to *Munchingo* — pure desi ghee atta cookies baked with love. 🍪\n\nWhat can I help you with today?`,
    [
      { id: 'btn_products', title: '🛒 Browse Products' },
      { id: 'btn_order',    title: '📦 Place an Order' },
      { id: 'btn_faq',      title: 'ℹ️ More Info' },
    ]
  );
}

// ── Product catalogue ─────────────────────────────────────────────────────────
async function sendProductList(to) {
  await wa.sendCatalog(
    to,
    `🍪 Our pure desi ghee atta cookies — starting at ₹259 for a 250g pack.\n\nTap a product to add it to your cart! *Minimum order value is ₹${MIN_ORDER_VALUE} for delivery.*`,
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
      `Minimum order value: ₹599 for delivery\n` +
      `Delivery across India 🇮🇳`,
    [
      { id: 'btn_products', title: '🛒 Browse Products' },
      { id: 'btn_contact',  title: '📞 Talk to Us' },
    ]
  );
}

// ── Ingredients ───────────────────────────────────────────────────────────────
// Per-SKU ingredient lists, sourced from Munchingo_Product_Guide.pdf (verified
// source of truth — see CLAUDE.md Section 3). Ingredients genuinely differ by
// SKU (Ajwain has salt not cardamom; Lite-sugar has no sugar/glucose at all),
// so this can't be a single shared "same base" claim.
async function sendIngredients(to) {
  await wa.sendText(
    to,
    `🌾 *What's in Munchingo atta cookies?*\n\n` +
      `✅ Whole wheat atta — the biggest ingredient in every pack\n` +
      `✅ Pure desi ghee — no palm oil, no refined oils\n` +
      `✅ No maida / refined flour\n` +
      `✅ No trans fat\n\n` +
      `Full ingredient list per flavour:\n` +
      `• *Original* — whole wheat atta, sugar, desi cow ghee, milk solids, glucose, raising agent, cardamom\n` +
      `• *Kesari* — same as Original, plus real saffron (kesar)\n` +
      `• *Sugar-Lite* — whole wheat atta, desi cow ghee, sweetener (maltitol), milk solids, cardamom, raising agent — *no added sugar*\n` +
      `• *Ajwain* — whole wheat atta, desi cow ghee, sugar, milk solids, glucose, salt, raising agent, ajwain (carom seed)\n\n` +
      `Ask me "allergens" for allergen details.`
  );
}

// ── Allergen information ──────────────────────────────────────────────────────
async function sendAllergenInfo(to) {
  await wa.sendText(
    to,
    `⚠️ *Allergen Information:*\n\n` +
      `Our cookies *contain:*\n` +
      `• *Wheat* (whole wheat atta) — *contains gluten*\n` +
      `• *Dairy* (milk solids, desi ghee)\n\n` +
      `⚠️ *Made in a facility that also processes tree nuts and other spices* — not guaranteed nut-free.\n\n` +
      `Our cookies do *NOT* contain:\n` +
      `❌ Eggs\n` +
      `❌ Soy\n` +
      `❌ Artificial colours or flavours\n\n` +
      `⚠️ *Not suitable for:* gluten intolerance / coeliac disease, dairy/lactose intolerance, or tree nut allergies.\n\n` +
      `Note: Sugar-Lite contains polyols (maltitol) — excess consumption may have a laxative effect.\n\n` +
      `If you have severe allergies, please consult before ordering.`
  );
}

// ── Shipping / delivery info ──────────────────────────────────────────────────
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
      { id: 'btn_contact',  title: '📞 Ask Us' },
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
    `💰 *Munchingo Pricing:*\n\n${lines}\n\n🚚 Free delivery on orders ₹599+\n_Prices inclusive of 5% GST (GSTIN 06AIIPN5005C2ZP)_`,
    [
      { id: 'btn_products', title: '🛒 Shop Now' },
      { id: 'btn_order',    title: '📦 How to Order' },
    ]
  );
}

// ── Return & refund policy ────────────────────────────────────────────────────
async function sendReturnPolicy(to) {
  await wa.sendButtons(
    to,
    `↩️ *Return & Refund Policy:*\n\n` +
      `We stand behind every pack we ship! Here's our policy:\n\n` +
      `✅ *Damaged in transit* — Full replacement or refund, no questions asked. Share a photo within 48 hours of delivery.\n\n` +
      `✅ *Wrong item received* — We'll send the correct order immediately.\n\n` +
      `✅ *Quality issue* — Stale or broken cookies? We'll replace the pack.\n\n` +
      `❌ *Taste preference* — We don't offer returns for taste-related reasons, but feedback is always welcome!\n\n` +
      `❌ *Opened packs* — We can't accept returns on opened products for hygiene reasons.\n\n` +
      `📸 To raise a concern, reply with a photo of the issue and we'll resolve it within 24 hours.`,
    [
      { id: 'btn_contact',  title: '📞 Contact Us' },
      { id: 'btn_products', title: '🛒 Shop Now' },
    ]
  );
}

// ── Bulk / corporate / gifting orders ─────────────────────────────────────────
async function sendBulkOrderInfo(to) {
  await wa.sendButtons(
    to,
    `🎁 *Bulk & Corporate Orders:*\n\n` +
      `We love gifting enquiries!\n\n` +
      `*What we offer:*\n` +
      `• Custom gift packs for corporate gifting\n` +
      `• Festival hampers (Diwali, Holi, Eid & more)\n` +
      `• Branded packaging (MOQ: 50 packs)\n` +
      `• Freshly baked to order\n\n` +
      `*Bulk discounts:*\n` +
      `10–24 packs — 10% off\n` +
      `25–99 packs — 15% off\n` +
      `100+ packs — Custom quote\n\n` +
      `Reach out and we'll get back with a quote within 24 hours! 🍪`,
    [
      { id: 'btn_bulk_flow', title: '📝 Request a Quote' },
      { id: 'btn_products',  title: '🛒 Browse Products' },
    ]
  );
}

// ── Human handoff ─────────────────────────────────────────────────────────────
async function sendHumanHandoff(to, name, message) {
  await wa.sendText(
    to,
    `👋 *We'll get a real person to you!*\n\n` +
      `A Munchingo team member will reach out to you shortly on WhatsApp.\n\n` +
      `You can also reach us directly:\n` +
      `📧 Email: hello@munchingo.com\n` +
      `🌐 Website: www.munchingo.com\n\n` +
      `We typically respond within a few hours. Thanks for your patience! 🍪`
  );
  console.log(`[HANDOFF] Customer ${to} requested human agent`);

  const ownerPhone = process.env.OWNER_PHONE;
  if (ownerPhone) {
    try {
      await wa.sendText(
        ownerPhone,
        `👋 *Human handoff requested*\n\n` +
          `Customer: ${name || 'Unknown'}\n` +
          `WhatsApp: +${to}\n` +
          (message ? `Message: "${message}"\n\n` : '\n') +
          `Reply directly on WhatsApp: https://wa.me/${to}`
      );
    } catch (err) {
      console.error('[WA] Failed to notify owner of handoff request:', err.message);
    }
  } else {
    console.warn('[HANDOFF] OWNER_PHONE not set — owner not notified via WhatsApp');
  }

  try {
    const { sendHumanHandoffAlert } = require('../utils/mailer');
    await sendHumanHandoffAlert({ customerPhone: to, customerName: name, message });
  } catch (err) {
    console.error('[MAILER] Failed to send human handoff alert:', err.message);
  }
}

// ── Order status lookup ───────────────────────────────────────────────────────
async function sendOrderStatus(to) {
  try {
    const orders = await getRecentOrders(to, 3);

    if (!orders.length) {
      return wa.sendButtons(
        to,
        `🔍 No orders found for your number.\n\nReady to try our cookies? 🍪`,
        [{ id: 'btn_products', title: '🛒 Browse Products' }]
      );
    }

    const lines = orders.map((o) => {
      const emoji = STATUS_EMOJI[o.status] || '📦';
      const text  = STATUS_TEXT[o.status]  || o.status;
      const date  = new Date(o.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      return `${emoji} *#${o.order_id}* — ₹${o.total}\n   ${text} · ${date}`;
    }).join('\n\n');

    await wa.sendButtons(
      to,
      `📦 *Your Recent Orders:*\n\n${lines}`,
      [
        { id: 'btn_products', title: '🛒 Order Again' },
        { id: 'btn_contact',  title: '📞 Need Help?' },
      ]
    );
  } catch (err) {
    console.error('[STATUS] Error fetching orders:', err.message);
    await wa.sendText(to, `Sorry, couldn't fetch your orders right now. Please try again in a moment.`);
  }
}

// ── Order cancellation ────────────────────────────────────────────────────────
async function handleCancellation(to) {
  try {
    // Check pending_address first, then pending_payment
    let order = await getRecentPendingOrder(to);
    if (!order) order = await getRecentPendingPaymentOrder(to);

    if (!order) {
      return wa.sendButtons(
        to,
        `❓ No active orders found to cancel.\n\nIf you need help with a paid or shipped order, please contact us.`,
        [{ id: 'btn_contact', title: '📞 Contact Us' }]
      );
    }

    await cancelOrder(order.order_id);

    // Cancel the Razorpay payment link if one exists (fire & forget)
    if (order.payment_link_id) {
      expirePaymentLink(order.payment_link_id).catch(() => {});
    }

    await wa.sendButtons(
      to,
      `❌ *Order Cancelled*\n\n` +
        `Order *#${order.order_id}* (₹${order.total}) has been cancelled.\n\n` +
        `No payment was charged. Want to start a fresh order? 🍪`,
      [
        { id: 'btn_products', title: '🛒 Browse Products' },
        { id: 'btn_order',    title: '📦 Place New Order' },
      ]
    );
  } catch (err) {
    console.error('[CANCEL] Error:', err.message);
    await wa.sendText(to, `Something went wrong while cancelling. Please contact us at hello@munchingo.com.`);
  }
}

// ── Resend / refresh payment link ─────────────────────────────────────────────
async function resendPaymentLink(to, name) {
  try {
    const order = await getRecentPendingPaymentOrder(to);

    if (!order) {
      // Maybe they're still at pending_address stage
      const pendingAddr = await getRecentPendingOrder(to);
      if (pendingAddr) {
        return wa.sendText(
          to,
          `📍 We still need your delivery address for order *#${pendingAddr.order_id}* before we can send a payment link.\n\n` +
            `Please reply with your complete address (flat no., area, city, pincode).`
        );
      }
      return wa.sendText(
        to,
        `💳 No pending payment found.\n\nIf you've already paid, reply *status* to check your order. 🍪`
      );
    }

    // We already have a stored link — just resend it
    if (order.payment_link_url) {
      return wa.sendText(
        to,
        `💳 *Your Payment Link:*\n\n` +
          `*Order #${order.order_id}* — ₹${order.total}\n\n` +
          `👉 ${order.payment_link_url}\n\n` +
          `Pay securely via UPI, card, or net banking. 🍪`
      );
    }

    // No stored link — generate a fresh one
    await wa.sendText(to, `🔗 Generating a fresh payment link for you...`);
    const { id: paymentLinkId, url: paymentLinkUrl } = await createPaymentLink({
      orderId:       order.order_id,
      amount:        order.total,
      customerPhone: to,
      customerName:  order.customer_name || name,
    });
    await updateOrderPaymentLink(order.order_id, { paymentLinkId, paymentLinkUrl });
    await wa.sendText(
      to,
      `💳 *Pay for your Munchingo Order*\n\n` +
        `*Order #${order.order_id}* — ₹${order.total}\n\n` +
        `👉 ${paymentLinkUrl}\n\n` +
        `Link valid for 24 hours. 🍪`
    );
  } catch (err) {
    console.error('[RESEND] Error:', err.message);
    await wa.sendText(
      to,
      `Couldn't generate a link right now. Please try again in a moment or contact us at hello@munchingo.com.`
    );
  }
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
          { id: 'faq_ingredients', title: "What's inside? 🌾",   description: 'Ingredients & no-nasties promise' },
          { id: 'faq_allergens',   title: 'Allergens? ⚠️',       description: 'Gluten, dairy & allergy info' },
          { id: 'faq_price',       title: 'How much? 💰',        description: 'Full price list' },
          { id: 'faq_shelf',       title: 'Shelf life? ⏳',      description: 'How long they stay fresh' },
        ],
      },
      {
        title: 'Orders & delivery',
        rows: [
          { id: 'faq_shipping', title: 'Do you deliver to me? 🚚', description: 'Delivery coverage & timelines' },
          { id: 'faq_order',    title: 'How do I order? 📦',       description: 'Step-by-step ordering guide' },
          { id: 'faq_payment',  title: 'Payment options? 💳',      description: 'UPI, cards, COD' },
          { id: 'faq_return',   title: 'Returns & refunds? ↩️',   description: 'Our return policy' },
        ],
      },
      {
        title: 'Special & support',
        rows: [
          { id: 'faq_bulk',  title: 'Bulk / gifting? 🎁',    description: 'Corporate & bulk order discounts' },
          { id: 'faq_human', title: 'Talk to a person? 👋',  description: 'Connect with our team directly' },
        ],
      },
    ]
  );
}

// ── Handle a WhatsApp checkout order ─────────────────────────────────────────
async function handleOrderMessage(to, order, contactName) {
  const name  = contactName || 'there';
  const items = order.product_items || [];
  const orderId    = generateOrderId();
  const timestamp  = new Date().toISOString();

  const enrichedItems = items.map((item) => {
    const product = RETAILER_MAP[item.product_retailer_id];
    return { ...item, productName: product ? product.name : item.product_retailer_id };
  });

  const lines = enrichedItems
    .map((item) => `• ${item.productName} × ${item.quantity} — ₹${item.item_price * item.quantity}`)
    .join('\n');

  const total = items.reduce((sum, i) => sum + i.item_price * i.quantity, 0);

  if (total < MIN_ORDER_VALUE) {
    await wa.sendButtons(
      to,
      `📦 Your order comes to *₹${total}*, just under our *₹${MIN_ORDER_VALUE} minimum order value* for delivery.\n\n` +
        `Add a bit more to your cart, or reply *human* if you'd like to arrange a single-box order directly with our team.`,
      [
        { id: 'btn_products', title: '🛒 Add More' },
        { id: 'btn_contact',  title: '📞 Talk to Us' },
      ]
    );
    return;
  }

  // 1. Save to Supabase FIRST. If this fails, the customer must not be told
  // to reply with an address for an order that doesn't exist -- their next
  // message would then be silently misinterpreted as a normal chat message
  // (no order to attach it to), leaving them stuck with no error shown.
  try {
    await saveOrder({
      orderId,
      customerPhone: to,
      customerName:  name,
      items:         enrichedItems,
      total,
      currency:      order.currency,
      timestamp,
    });
  } catch (err) {
    console.error('[DB] Failed to save order:', err.message);
    await wa.sendText(
      to,
      `⚠️ Sorry, something went wrong saving your order. Please try placing it again in a moment, ` +
        `or reply *human* to speak with our team directly.`
    );
    return;
  }

  // 2. Send order receipt
  const gstAmount = Math.round(total - total / 1.05);
  await wa.sendText(
    to,
    `🧾 *Order Received, ${name}!*\n\n` +
      `*Order #${orderId}*\n\n` +
      `${lines}\n\n` +
      `*Total: ₹${total}* _(incl. GST 5%: ₹${gstAmount} · GSTIN 06AIIPN5005C2ZP)_\n\n` +
      `Just one more step — we need your delivery address! 📍`
  );

  // 3. Ask for delivery address via the structured Flow form. Falls back to
  // free text automatically -- if the customer just types their address
  // instead of tapping the flow button, step 3 of routeText() still catches it.
  try {
    await wa.sendFlow(to, {
      flowId: DELIVERY_FLOW_ID,
      bodyText: `Just one more step — tap below to share your delivery address for order #${orderId}. 📍`,
      ctaText: 'Enter delivery details',
      screenId: 'WELCOME',
    });
  } catch (err) {
    console.error('[WA] Failed to send delivery flow, falling back to text prompt:', err.message);
    await wa.sendText(
      to,
      `📍 *Please reply with your delivery address:*\n\n` +
        `Include flat/house no., area/locality, city, and pincode.\n\n` +
        `_Example: 42, Shanti Nagar, Koramangala, Bengaluru 560034_\n\n` +
        `Want an email confirmation too? Add your email on a new line — totally optional.`
    );
  }

  // 4. Send email notification
  console.log('[ORDER]', { orderId, customer: to, name, total, timestamp });
  try {
    await sendOrderEmail({ orderId, customerPhone: to, customerName: name, items: enrichedItems, total, timestamp });
  } catch (err) {
    console.error('[MAILER] Failed to send order notification:', err.message);
  }
}

// ── Shared by both the Flow form and the free-text fallback: saves the
// address/email, then generates and sends the payment link ───────────────────
async function completeAddressCollection(to, pendingOrder, address, email) {
  await updateOrderAddress(pendingOrder.order_id, address);
  if (email) {
    try {
      await updateOrderEmail(pendingOrder.order_id, email);
    } catch (err) {
      console.error('[DB] Failed to save email:', err.message);
    }
  }

  await wa.sendText(
    to,
    `✅ *Address saved!*\n\n` +
      `📍 ${address}` +
      (email ? `\n✉️ Confirmation will be sent to ${email}` : '') +
      `\n\nGenerating your payment link... 🔗`
  );

  try {
    const { id: paymentLinkId, url: paymentLinkUrl } = await createPaymentLink({
      orderId:       pendingOrder.order_id,
      amount:        pendingOrder.total,
      customerPhone: to,
      customerName:  pendingOrder.customer_name,
    });
    await updateOrderPaymentLink(pendingOrder.order_id, { paymentLinkId, paymentLinkUrl });
    await wa.sendText(
      to,
      `💳 *Pay for your Munchingo Order*\n\n` +
        `*Order #${pendingOrder.order_id}* — ₹${pendingOrder.total} _(incl. 5% GST)_\n\n` +
        `👉 ${paymentLinkUrl}\n\n` +
        `Link valid for 24 hours. We'll confirm & ship once payment is received! 🍪`
    );
  } catch (err) {
    console.error('[RAZORPAY] Failed to create payment link:', err.message);
    await wa.sendText(
      to,
      `✅ Address saved! We'll share your payment link shortly.\n\n` +
        `If you don't hear from us in 10 minutes, reply *resend link* and we'll generate a fresh one.`
    );
  }
}

// ── Route text messages by keyword ───────────────────────────────────────────
async function routeText(to, text, name) {
  const t = text.toLowerCase().trim();

  // ── 1. Greetings (skip all other checks) ──────────────────────────────────
  if (/^(hi|hello|hey|namaste|hola|start|menu)/.test(t)) {
    return sendWelcome(to, name);
  }

  // ── 2. Explicit commands — always take priority over address collection ────
  // Order status
  if (/\bstatus\b|track.*order|order.*status|where.*order|my order/.test(t)) {
    return sendOrderStatus(to);
  }
  // Feedback
  if (/\bfeedback\b|\breview\b|rate.*(order|experience|us)/.test(t)) {
    if (!FEEDBACK_FLOW_ID) {
      return wa.sendText(to, `🙏 We'd love your feedback! Reply here with a quick note and we'll pass it straight to the team.`);
    }
    return wa.sendFlow(to, {
      flowId: FEEDBACK_FLOW_ID,
      bodyText: `We'd love to hear how we did! 🍪`,
      ctaText: 'Share feedback',
      screenId: 'FEEDBACK',
    });
  }
  // Cancellation
  if (/\bcancel\b/.test(t)) {
    return handleCancellation(to);
  }
  // Resend payment link
  if (/resend|send.*link|payment.*link|link.*again|new.*link|get.*link/.test(t)) {
    return resendPaymentLink(to, name);
  }
  // Human handoff
  if (/\bhuman\b|real person|talk.*person|speak.*someone|live.*agent|\bsupport\b/.test(t)) {
    return sendHumanHandoff(to, name, text);
  }
  // Return / refund
  if (/return|refund|damage|broken|wrong.*item/.test(t)) {
    return sendReturnPolicy(to);
  }
  // Bulk / gifting
  if (/bulk|wholesale|corporate|gift(ing)?|hamper/.test(t)) {
    return sendBulkOrderInfo(to);
  }
  // Allergens
  if (/allerg|gluten|lactose|dairy.*free|nut free|peanut/.test(t)) {
    return sendAllergenInfo(to);
  }

  // ── 3. Address collection: free text = delivery address ───────────────────
  try {
    const pendingOrder = await getRecentPendingOrder(to);
    if (pendingOrder) {
      // Customer may have added an email on its own line along with the address — pull it out.
      const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
      const email = emailMatch ? emailMatch[0] : null;
      const address = email ? text.replace(email, '').trim() : text;

      // Sanity check: a real address is reasonably long and has a number in
      // it somewhere (house no., pincode, etc). Without this, a stray reply
      // ("how much is shipping?") gets silently locked in as the delivery
      // address and a payment link generated for it.
      const looksLikeAddress = address.length >= 12 && /\d/.test(address);
      if (!looksLikeAddress) {
        await wa.sendText(
          to,
          `That doesn't look like a delivery address yet — I still need one to continue ` +
            `order *#${pendingOrder.order_id}*.\n\n` +
            `📍 Please reply with your full address (flat/house no., area, city, pincode).\n\n` +
            `_Example: 42, Shanti Nagar, Koramangala, Bengaluru 560034_`
        );
        return;
      }

      await completeAddressCollection(to, pendingOrder, address, email);
      return;
    }
  } catch (err) {
    console.error('[DB] Address lookup error:', err.message);
    // fall through to normal routing
  }

  // ── 4. Standard keyword routing ───────────────────────────────────────────
  if (/product|catalog|catalogue|show|browse|cookie|atta/.test(t))           return sendProductList(to);
  if (/order|buy|purchase|cart|checkout|want/.test(t))                        return sendOrderInstructions(to);
  if (/ingredient|recipe|inside|ghee|maida|wheat|sugar|made of/.test(t))     return sendIngredients(to);
  if (/ship|deliver|delivery|city|area|india|pin|pincode/.test(t))            return sendShippingInfo(to);
  if (/price|cost|rate|how much|₹|rs\.?/.test(t))                             return sendPriceList(to);
  if (/shelf|expiry|expire|last|fresh|store/.test(t)) {
    return wa.sendText(
      to,
      `⏳ *Shelf life:*\n\nOur cookies stay fresh for *90 days* from the bake date (printed on the pack).\n\nStore in a cool, dry place — and try not to eat them all at once! 😄`
    );
  }
  if (/pay|payment|upi|gpay|phonepe|card|cod|cash/.test(t)) {
    return wa.sendText(
      to,
      `💳 *Payment options:*\n\n✅ UPI (Google Pay, PhonePe, Paytm)\n✅ Debit / Credit card\n✅ Net banking\n\nAll orders are pre-paid — we'll share a secure payment link after confirming your order.`
    );
  }
  if (/faq|help|info|question|know/.test(t)) return sendFAQ(to);

  // ── 5. Default fallback ────────────────────────────────────────────────────
  return wa.sendButtons(
    to,
    `Thanks for writing in! 🍪 I'm Munchingo's cookie bot — here's what I can help with:`,
    [
      { id: 'btn_products', title: '🛒 Browse Products' },
      { id: 'btn_order',    title: '📦 How to Order' },
      { id: 'btn_faq',      title: 'ℹ️ More Info' },
    ]
  );
}

// ── Handle a completed WhatsApp Flow submission ────────────────────────────────
// Flows all land here regardless of which one was filled out (WhatsApp doesn't
// tell us which flow in nfm_reply.name -- it's always "flow"), so we dispatch
// on which fields the response actually contains.
async function routeFlowReply(to, nfmReply, name) {
  let data;
  try {
    data = JSON.parse(nfmReply?.response_json || '{}');
  } catch (err) {
    console.error('[FLOW] Failed to parse response_json:', err.message);
    return;
  }

  // Delivery Details flow
  if (data.address_line) {
    const address = [data.full_name, data.address_line, data.city, data.state, data.pincode]
      .filter(Boolean)
      .join(', ');
    const email = data.email || null;

    try {
      const pendingOrder = await getRecentPendingOrder(to);
      if (!pendingOrder) {
        await wa.sendText(
          to,
          `Thanks! I couldn't find an order waiting for an address right now — if you're still expecting one, reply *status* to check.`
        );
        return;
      }
      await completeAddressCollection(to, pendingOrder, address, email);
    } catch (err) {
      console.error('[FLOW] Failed to complete address collection:', err.message);
    }
    return;
  }

  // Feedback flow
  if (data.rating) {
    console.log('[FEEDBACK]', { customer: to, name, rating: data.rating, comments: data.comments });
    try {
      await sendFeedbackAlert({ customerPhone: to, customerName: name, rating: data.rating, comments: data.comments });
    } catch (err) {
      console.error('[MAILER] Failed to send feedback alert:', err.message);
    }
    await wa.sendText(to, `🙏 *Thank you for the feedback!* It genuinely helps us get better.`);
    return;
  }

  // Corporate/bulk gifting inquiry flow
  if (data.company_name) {
    console.log('[BULK INQUIRY]', { customer: to, name, ...data });
    try {
      await sendBulkInquiryAlert({ customerPhone: to, customerName: name, ...data });
    } catch (err) {
      console.error('[MAILER] Failed to send bulk inquiry alert:', err.message);
    }
    await wa.sendText(
      to,
      `🎁 *Thanks, ${data.contact_name || name}!* We've got your gifting inquiry and will get back with a quote within 24 hours.`
    );
    return;
  }

  console.log('[FLOW] Unrecognized flow reply payload:', JSON.stringify(data));
}

// ── Route interactive replies (button, list & Flow submissions) ───────────────
async function routeInteractive(to, interactive, name) {
  const type = interactive.type;

  if (type === 'nfm_reply') {
    return routeFlowReply(to, interactive.nfm_reply, name);
  }

  let buttonId;
  if (type === 'button_reply')    buttonId = interactive.button_reply?.id;
  else if (type === 'list_reply') buttonId = interactive.list_reply?.id;

  switch (buttonId) {
    case 'btn_products':    return sendProductList(to);
    case 'btn_order':       return sendOrderInstructions(to);
    case 'btn_faq':         return sendFAQ(to);
    case 'btn_contact':
      return wa.sendText(
        to,
        `📞 *Reach us directly:*\n\nEmail: hello@munchingo.com\nWebsite: www.munchingo.com\n\nWe typically reply within a few hours. 🍪`
      );
    case 'btn_bulk_flow':
      return wa.sendFlow(to, {
        flowId: BULK_GIFTING_FLOW_ID,
        bodyText: `Tap below to tell us what you need — we'll get back with a quote within 24 hours. 🎁`,
        ctaText: 'Request a quote',
        screenId: 'GIFTING_INQUIRY',
      });

    case 'faq_ingredients': return sendIngredients(to);
    case 'faq_allergens':   return sendAllergenInfo(to);
    case 'faq_price':       return sendPriceList(to);
    case 'faq_shipping':    return sendShippingInfo(to);
    case 'faq_order':       return sendOrderInstructions(to);
    case 'faq_return':      return sendReturnPolicy(to);
    case 'faq_bulk':        return sendBulkOrderInfo(to);
    case 'faq_human':       return sendHumanHandoff(to, name);
    case 'faq_shelf':
      return wa.sendText(
        to,
        `⏳ Munchingo cookies stay fresh for *90 days* from the bake date.\n\nBest enjoyed fresh — store in a cool, dry place out of direct sunlight.`
      );
    case 'faq_payment':
      return wa.sendText(
        to,
        `💳 *Payment options:*\n\n✅ UPI (Google Pay, PhonePe, Paytm)\n✅ Debit / Credit card\n✅ Net banking\n\nAll orders are pre-paid — we'll share a secure payment link after confirming your order.`
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
  sendAllergenInfo,
  sendShippingInfo,
  sendPriceList,
  sendReturnPolicy,
  sendBulkOrderInfo,
  sendHumanHandoff,
  sendOrderStatus,
  handleCancellation,
  resendPaymentLink,
  sendFAQ,
  handleOrderMessage,
  routeText,
  routeInteractive,
};
