'use strict';

const wa = require('./whatsapp');
const { sendRefundEmail, sendHumanHandoffAlert } = require('./mailer');

/**
 * Tell a customer their refund was processed. Tries WhatsApp (works inside the
 * 24h window), then email (if they gave one). If neither reaches them, emails
 * the owner so the customer can be messaged by hand — free-form WhatsApp text
 * fails outside the 24h window, and no refund template is approved yet.
 */
async function notifyRefund(order, amountRupees, isFull) {
  const name  = order.customer_name || 'there';
  const phone = order.customer_phone;
  let delivered = false;

  if (phone) {
    try {
      await wa.sendText(
        phone,
        `\u{1F4B8} *Refund processed*\n\n` +
          `Hi ${name}, we've refunded \u20B9${amountRupees} for order *#${order.order_id}*` +
          `${isFull ? ' and the order is now cancelled' : ''}.\n\n` +
          `It should reach your original payment method within 5\u20137 working days, depending on your bank. ` +
          `Questions? Just reply here. \u{1F36A}`
      );
      delivered = true;
    } catch (err) {
      console.warn(`[REFUND] WhatsApp not delivered for ${order.order_id}: ${err.message}`);
    }
  }

  if (order.customer_email) {
    try {
      await sendRefundEmail({
        email: order.customer_email,
        customerName: order.customer_name,
        orderId: order.order_id,
        amount: amountRupees,
        isFull,
      });
      delivered = true;
    } catch (err) {
      console.error(`[REFUND] Email failed for ${order.order_id}:`, err.message);
    }
  }

  if (!delivered) {
    try {
      await sendHumanHandoffAlert({
        customerPhone: phone,
        customerName: order.customer_name,
        message: `Refund of \u20B9${amountRupees} for order #${order.order_id} was processed, but we could not reach the customer on WhatsApp (outside the 24h window) and they gave no email. Please message them yourself.`,
      });
    } catch (err) {
      console.error('[REFUND] Owner alert failed:', err.message);
    }
  }
  return delivered;
}

module.exports = { notifyRefund };
