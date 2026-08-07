'use strict';
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

/**
 * Persist a new order to Supabase.
 * Status starts as 'pending_address' so the bot knows to collect delivery info.
 */
async function saveOrder({ orderId, customerPhone, customerName, items, total, currency, timestamp }) {
  const { data, error } = await supabase
    .from('orders')
    .insert({
      order_id:       orderId,
      customer_phone: customerPhone,
      customer_name:  customerName,
      items,
      total,
      currency:   currency || 'INR',
      status:     'pending_address',
      created_at: timestamp,
    })
    .select()
    .single();

  if (error) throw new Error(`Supabase insert failed: ${error.message}`);
  console.log(`[DB] Order ${orderId} saved`);
  return data;
}

/**
 * Save the customer's delivery address and advance status to 'pending_payment'.
 */
async function updateOrderAddress(orderId, rawAddress) {
  const { error } = await supabase
    .from('orders')
    .update({
      delivery_address: { raw: rawAddress },
      status: 'pending_payment',
    })
    .eq('order_id', orderId);

  if (error) throw new Error(`Supabase update (address) failed: ${error.message}`);
  console.log(`[DB] Order ${orderId} address saved`);
}

/**
 * Store the Razorpay payment link against the order.
 */
async function updateOrderPaymentLink(orderId, { paymentLinkId, paymentLinkUrl }) {
  const { error } = await supabase
    .from('orders')
    .update({ payment_link_id: paymentLinkId, payment_link_url: paymentLinkUrl })
    .eq('order_id', orderId);

  if (error) throw new Error(`Supabase update (payment link) failed: ${error.message}`);
  console.log(`[DB] Order ${orderId} payment link saved`);
}

/**
 * Mark an order as paid after Razorpay webhook confirms payment.
 */
async function markOrderPaid(orderId, paymentId) {
  const { error } = await supabase
    .from('orders')
    .update({ status: 'paid', payment_id: paymentId })
    .eq('order_id', orderId);

  if (error) throw new Error(`Supabase update (paid) failed: ${error.message}`);
  console.log(`[DB] Order ${orderId} marked paid`);
}

/**
 * Return the most recent order for a customer that is still waiting for an address.
 * Returns null if none found.
 */
async function getRecentPendingOrder(customerPhone) {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('customer_phone', customerPhone)
    .eq('status', 'pending_address')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[DB] getRecentPendingOrder error:', error.message);
    return null;
  }
  return data;
}

module.exports = {
  saveOrder,
  updateOrderAddress,
  updateOrderPaymentLink,
  markOrderPaid,
  getRecentPendingOrder,
};
