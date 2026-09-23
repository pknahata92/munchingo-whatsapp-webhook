'use strict';
const { createClient } = require('@supabase/supabase-js');

// Same lazy-client pattern as utils/database.js and utils/coupons.js —
// service role key only, RLS enabled with zero public policies.
let _supabase = null;
function db() {
  if (!_supabase) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars must be set');
    }
    _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return _supabase;
}

function todayISODate() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysISODate(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Create a new subscription. Called right after a subscribing customer's
 * FIRST order has already been charged via the normal checkout flow — that
 * first order is NOT created here, only the recurring record for cycle 2
 * onward. next_order_date is therefore set to today + frequency_days, not
 * today.
 */
async function createSubscription({ customerPhone, customerName, customerEmail, deliveryAddress, items, discountPct, frequencyDays, firstOrderId }) {
  const { data, error } = await db()
    .from('subscriptions')
    .insert({
      customer_phone: customerPhone,
      customer_name: customerName,
      customer_email: customerEmail,
      delivery_address: deliveryAddress,
      items, // [{slug, name, unit, quantity}] — no price stored, see migration comment
      discount_pct: discountPct,
      frequency_days: frequencyDays,
      status: 'active',
      next_order_date: addDaysISODate(frequencyDays),
      last_order_id: firstOrderId || null,
    })
    .select()
    .single();

  if (error) throw new Error(`Supabase insert (subscription) failed: ${error.message}`);
  console.log(`[SUBSCRIPTIONS] Subscription ${data.id} created for ${customerPhone}`);
  return data;
}

/**
 * All subscriptions due for renewal today or earlier (status = active).
 * Used by the daily renewal cron.
 */
async function getDueSubscriptions() {
  const { data, error } = await db()
    .from('subscriptions')
    .select('*')
    .eq('status', 'active')
    .lte('next_order_date', todayISODate());

  if (error) { console.error('[SUBSCRIPTIONS] getDueSubscriptions error:', error.message); return []; }
  return data || [];
}

/**
 * Find a customer's active (or paused) subscription by phone, for the
 * PAUSE/RESUME/CANCEL keyword commands. Assumes at most one live
 * subscription per phone number — fine for the v1 scope.
 */
async function getSubscriptionByPhone(customerPhone) {
  const { data, error } = await db()
    .from('subscriptions')
    .select('*')
    .eq('customer_phone', customerPhone)
    .in('status', ['active', 'paused'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) { console.error('[SUBSCRIPTIONS] getSubscriptionByPhone error:', error.message); return null; }
  return data;
}

async function setSubscriptionStatus(id, status) {
  const { error } = await db()
    .from('subscriptions')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(`Supabase update (subscription status) failed: ${error.message}`);
}

/**
 * Resume a paused subscription. Pushes next_order_date forward from today
 * (not from whenever it was paused) so resuming doesn't immediately trigger
 * a same-day renewal charge.
 */
async function resumeSubscription(id, frequencyDays) {
  const { error } = await db()
    .from('subscriptions')
    .update({ status: 'active', next_order_date: addDaysISODate(frequencyDays), updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(`Supabase update (subscription resume) failed: ${error.message}`);
}

/**
 * Record that a renewal cycle was processed — advances next_order_date and
 * stamps the new order's id. Called by the renewal cron after a successful
 * charge attempt (payment link created, not necessarily paid yet).
 */
async function markRenewalProcessed(id, { orderId, frequencyDays }) {
  const { error } = await db()
    .from('subscriptions')
    .update({
      last_order_id: orderId,
      next_order_date: addDaysISODate(frequencyDays),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw new Error(`Supabase update (subscription renewal) failed: ${error.message}`);
}

/**
 * Attach a subscription_id to the order that was just created for this
 * renewal cycle — separate call rather than extending saveOrder's shared
 * signature, since subscription tagging is the only caller that needs it.
 */
async function attachSubscriptionToOrder(orderId, subscriptionId) {
  const { error } = await db()
    .from('orders')
    .update({ subscription_id: subscriptionId })
    .eq('order_id', orderId);
  if (error) console.error('[SUBSCRIPTIONS] attachSubscriptionToOrder error:', error.message);
}

module.exports = {
  createSubscription,
  getDueSubscriptions,
  getSubscriptionByPhone,
  setSubscriptionStatus,
  resumeSubscription,
  markRenewalProcessed,
  attachSubscriptionToOrder,
};
