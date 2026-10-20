'use strict';

/**
 * WhatsApp order-update notices that go out next to the shipped email:
 *   notifyShipped        one order, called from Admin's Mark shipped (never throws, never blocks shipping)
 *   notifyPickupDelayBatch  owner-triggered, for parcels packed but not collected by the courier
 *
 * Both use approved UTILITY templates (never free text: that only delivers inside WhatsApp's 24h window).
 * OFF until SHIPPED_WA_ENABLED=1 on Render, because Meta must approve the templates first.
 */

let sender = (to, key, data) => require('./refundTemplates').sendScenario(to, key, data);
function _setSender(fn) { sender = fn; } // tests only

const enabled = () => /^(1|true|yes)$/i.test(String(process.env.SHIPPED_WA_ENABLED || ''));
const cleanPhone = (p) => String(p || '').replace(/\D/g, '');

async function send(order, key, data) {
  const to = cleanPhone(order && order.customer_phone);
  if (!to) return { sent: false, reason: 'no phone' };
  try {
    await sender(to, key, { customer_name: order.customer_name || 'there', order_id: order.order_id, ...data });
    return { sent: true };
  } catch (err) {
    console.error(`[WA] ${key} failed for ${order.order_id}:`, err.message);
    return { sent: false, reason: 'error', error: err.message };
  }
}

async function notifyShipped({ order, carrier, awb, trackUrl }) {
  if (!enabled()) return { sent: false, reason: 'disabled' };
  if (!awb && !trackUrl) return { sent: false, reason: 'no tracking' };
  return send(order, 'order_shipped', { courier: carrier || 'our courier', awb: awb || 'See link', tracking_url: trackUrl || `on ${carrier || 'the courier'}'s website, using tracking ID ${awb}` });
}

async function notifyPickupDelayBatch(orders) {
  const out = { sent: 0, failed: [], skipped: [] };
  if (!enabled()) { out.skipped = orders.map((o) => ({ orderId: o.order_id, reason: 'disabled' })); return out; }
  const seen = new Set();
  for (const order of orders) {
    if (seen.has(order.order_id)) continue;
    seen.add(order.order_id);
    const r = await send(order, 'pickup_delay', {});
    if (r.sent) out.sent++;
    else if (r.reason === 'error') out.failed.push({ orderId: order.order_id, error: r.error });
    else out.skipped.push({ orderId: order.order_id, reason: r.reason });
  }
  return out;
}

module.exports = { notifyShipped, notifyPickupDelayBatch, _setSender };
