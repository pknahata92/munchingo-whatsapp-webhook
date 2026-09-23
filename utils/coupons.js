'use strict';
const { createClient } = require('@supabase/supabase-js');

// Same lazy-client pattern as utils/database.js — service role key, never
// the anon key, since coupon validation touches usage counts that must not
// be tamperable from a browser.
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

/**
 * Validate a coupon code against the current cart and customer, WITHOUT
 * recording a redemption. Used both by the live "Apply" check in
 * checkout.html and again server-side at final order submission — always
 * re-validate at submission too, since time may have passed between the
 * two calls (a cap could fill up, a code could expire) and the client's
 * earlier "valid" response is never trusted on its own.
 *
 * @param {string} code
 * @param {{ cartSlugs: string[], realTotal: number, customerPhone: string }} ctx
 * @returns {{ ok: true, coupon: object, discountAmount: number, finalTotal: number } | { ok: false, error: string }}
 */
async function validateCoupon(code, { cartSlugs, realTotal, customerPhone }) {
  const normalisedCode = String(code || '').trim().toUpperCase();
  if (!normalisedCode) return { ok: false, error: 'Enter a promo code.' };

  const { data: coupon, error } = await db()
    .from('coupons')
    .select('*')
    .eq('code', normalisedCode)
    .maybeSingle();

  if (error) { console.error('[COUPONS] lookup error:', error.message); return { ok: false, error: 'Could not check that code right now. Please try again.' }; }
  if (!coupon || !coupon.active) return { ok: false, error: 'That code is not valid.' };

  if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
    return { ok: false, error: 'That code has expired.' };
  }
  if (coupon.max_uses != null && coupon.uses_count >= coupon.max_uses) {
    return { ok: false, error: 'That code has reached its usage limit.' };
  }
  if (realTotal < (coupon.min_order_value || 0)) {
    return { ok: false, error: `This code needs a minimum order of ₹${coupon.min_order_value}.` };
  }
  if (coupon.scope_slug) {
    // Exact match, OR prefix match for dynamic slugs like the Trio set
    // ("trio-gift-set-ajwain-kesari-original") — a plain .includes() check
    // would never match a scope_slug of 'trio-gift-set' since no real cart
    // slug is ever exactly that.
    const inScope = cartSlugs.some(
      (s) => s === coupon.scope_slug || s.startsWith(`${coupon.scope_slug}-`)
    );
    if (!inScope) {
      return { ok: false, error: `This code only applies to orders that include the ${coupon.scope_slug.replace(/-/g, ' ')}.` };
    }
  }

  if (coupon.max_uses_per_customer != null && customerPhone) {
    const { count, error: redemptionError } = await db()
      .from('coupon_redemptions')
      .select('id', { count: 'exact', head: true })
      .eq('coupon_code', normalisedCode)
      .eq('customer_phone', customerPhone);
    if (redemptionError) { console.error('[COUPONS] redemption count error:', redemptionError.message); return { ok: false, error: 'Could not check that code right now. Please try again.' }; }
    if ((count || 0) >= coupon.max_uses_per_customer) {
      return { ok: false, error: 'You\'ve already used this code.' };
    }
  }

  let discountAmount;
  if (coupon.type === 'percent') {
    discountAmount = Math.round(realTotal * (coupon.value / 100));
    // Cap keeps a percentage code from giving away too much on a big order —
    // e.g. FOUNDING10 is 10% off with a ₹100 ceiling, so it stays a genuine
    // 10% on small first orders but tapers off (not a flat ₹100) above ~₹1,000.
    if (coupon.max_discount_amount != null) {
      discountAmount = Math.min(discountAmount, coupon.max_discount_amount);
    }
  } else {
    discountAmount = Math.round(coupon.value);
  }
  // Never let a discount exceed the order total or push it negative.
  discountAmount = Math.max(0, Math.min(discountAmount, realTotal));

  return { ok: true, coupon, discountAmount, finalTotal: realTotal - discountAmount };
}

/**
 * Record a successful redemption after the order is actually created —
 * called once, at the point checkout.js has committed to charging this
 * amount, not at the earlier "Apply" preview check.
 */
async function recordCouponRedemption({ code, customerPhone, orderId, discountAmount }) {
  const normalisedCode = String(code).trim().toUpperCase();

  const { error: insertError } = await db()
    .from('coupon_redemptions')
    .insert({
      coupon_code: normalisedCode,
      customer_phone: customerPhone,
      order_id: orderId,
      discount_amount: discountAmount,
    });
  if (insertError) { console.error('[COUPONS] redemption insert failed:', insertError.message); return; }

  // Best-effort counter bump for quick "how many left" glances in the table
  // itself — coupon_redemptions rows remain the source of truth for the
  // per-customer cap above, so a missed increment here (e.g. a rare race
  // under concurrent redemptions) doesn't let anyone bypass a real limit.
  const { data: current } = await db().from('coupons').select('uses_count').eq('code', normalisedCode).maybeSingle();
  if (current) {
    await db().from('coupons').update({ uses_count: (current.uses_count || 0) + 1 }).eq('code', normalisedCode);
  }
}

module.exports = { validateCoupon, recordCouponRedemption };
