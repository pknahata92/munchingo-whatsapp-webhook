'use strict';
const { createClient } = require('@supabase/supabase-js');

// ── Lazy client — only initialised on first DB call ───────────────────────────
let _supabase = null;
function db() {
  if (!_supabase) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars must be set');
    }
    // Service role key, not anon: RLS is enabled on `orders` with zero public
    // policies, so the anon key can no longer read/write it at all. Only the
    // service role (server-side only, never exposed to a browser) bypasses RLS.
    _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return _supabase;
}

/**
 * Persist a new order. Status = 'pending_address' so the bot
 * knows to collect delivery info next.
 */
async function saveOrder({ orderId, customerPhone, customerName, customerEmail, items, total, currency, timestamp }) {
  const { data, error } = await db()
    .from('orders')
    .insert({
      order_id:       orderId,
      customer_phone: customerPhone,
      customer_name:  customerName,
      customer_email: customerEmail || null,
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
 * Save the customer's delivery address and advance to 'pending_payment'.
 */
async function updateOrderAddress(orderId, rawAddress) {
  const { error } = await db()
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
 * Save/update the customer's email for order confirmation. Optional field —
 * pass null/empty to leave it unset (no confirmation email will be sent).
 */
async function updateOrderEmail(orderId, email) {
  const { error } = await db()
    .from('orders')
    .update({ customer_email: email || null })
    .eq('order_id', orderId);

  if (error) throw new Error(`Supabase update (email) failed: ${error.message}`);
  console.log(`[DB] Order ${orderId} email saved`);
}

/**
 * Store the Razorpay payment link against the order.
 */
async function updateOrderPaymentLink(orderId, { paymentLinkId, paymentLinkUrl }) {
  const { error } = await db()
    .from('orders')
    .update({ payment_link_id: paymentLinkId, payment_link_url: paymentLinkUrl })
    .eq('order_id', orderId);

  if (error) throw new Error(`Supabase update (payment link) failed: ${error.message}`);
  console.log(`[DB] Order ${orderId} payment link saved`);
}

/**
 * Mark an order as paid after Razorpay confirms payment.
 */
async function markOrderPaid(orderId, paymentId) {
  const { error } = await db()
    .from('orders')
    .update({ status: 'paid', payment_id: paymentId })
    .eq('order_id', orderId);

  if (error) throw new Error(`Supabase update (paid) failed: ${error.message}`);
  console.log(`[DB] Order ${orderId} marked paid`);
}

/**
 * Cancel an active order (pending_address or pending_payment).
 * Returns true on success.
 */
async function cancelOrder(orderId) {
  const { error } = await db()
    .from('orders')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('order_id', orderId);

  if (error) { console.error('[DB] cancelOrder error:', error.message); return false; }
  console.log(`[DB] Order ${orderId} cancelled`);
  return true;
}

/**
 * Most recent order waiting for delivery address.
 */
async function getRecentPendingOrder(customerPhone) {
  const { data, error } = await db()
    .from('orders')
    .select('*')
    .eq('customer_phone', customerPhone)
    .eq('status', 'pending_address')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) { console.error('[DB] getRecentPendingOrder error:', error.message); return null; }
  return data;
}

/**
 * Most recent order waiting for payment (address already collected).
 */
async function getRecentPendingPaymentOrder(customerPhone) {
  const { data, error } = await db()
    .from('orders')
    .select('*')
    .eq('customer_phone', customerPhone)
    .eq('status', 'pending_payment')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) { console.error('[DB] getRecentPendingPaymentOrder error:', error.message); return null; }
  return data;
}

/**
 * Return the N most recent orders for a customer (all statuses).
 * Used for the order-status enquiry flow.
 */
async function getRecentOrders(customerPhone, limit = 3) {
  const { data, error } = await db()
    .from('orders')
    .select('*')
    .eq('customer_phone', customerPhone)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) { console.error('[DB] getRecentOrders error:', error.message); return []; }
  return data || [];
}

/**
 * Lookup order by Razorpay payment link ID.
 * Used when handling payment_link.expired webhook events.
 */
async function getOrderByPaymentLinkId(paymentLinkId) {
  const { data, error } = await db()
    .from('orders')
    .select('*')
    .eq('payment_link_id', paymentLinkId)
    .maybeSingle();

  if (error) { console.error('[DB] getOrderByPaymentLinkId error:', error.message); return null; }
  return data;
}

/**
 * Fetch a single order by order_id. Returns null if not found.
 */
async function getOrder(orderId) {
  const { data, error } = await db()
    .from('orders')
    .select('*')
    .eq('order_id', orderId)
    .maybeSingle();

  if (error) { console.error('[DB] getOrder error:', error.message); return null; }
  return data;
}

module.exports = {
  saveOrder,
  updateOrderAddress,
  updateOrderEmail,
  updateOrderPaymentLink,
  markOrderPaid,
  cancelOrder,
  getRecentPendingOrder,
  getRecentPendingPaymentOrder,
  getRecentOrders,
  getOrderByPaymentLinkId,
  getOrder,
};
