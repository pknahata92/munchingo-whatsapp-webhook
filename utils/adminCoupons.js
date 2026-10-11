'use strict';

/**
 * Owner-only coupon manager (admin > Coupons). Creates and manages rows in the existing `coupons` table that
 * utils/coupons.js already validates at checkout, so a code made here works on the website immediately.
 *
 * What a coupon can be set to: percent or flat rupees off, an optional rupee cap on a percentage, a minimum order,
 * "only orders that include the Trio / the Full Range set", a total-use cap, a per-customer cap, a start and an expiry
 * date, and (personal codes) one phone number. The note, start date, phone lock and "created by" need
 * coupons_admin_migration.sql; without it plain codes still work and the screen says what is missing.
 *
 * Sanity limits stop a typo from giving the shop away: percent 1-60, flat Rs 1-2,000, minimum order up to Rs 20,000.
 * The discount applies to the whole order total, as everywhere in the checkout.
 */

const crypto = require('crypto');
const db = require('./database');
const { AdminError } = require('./adminActions');

const SCOPES = [
  { slug: '', label: 'Any order' },
  { slug: 'trio-gift-set', label: 'Orders that include a Trio Gift Set' },
  { slug: 'full-range-set', label: 'Orders that include the Full Range Gift Set' },
  { slug: 'singles-only', label: 'Single boxes only (not gift sets)' },
];
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O/1/I so a code can be read out over the phone
const LIMITS = { percentMax: 60, flatMax: 2000, minOrderMax: 20000 };

const rupee = (n) => '₹' + Number(n).toLocaleString('en-IN');
const istDate = (iso) => new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });

function randomCode(prefix) {
  let tail = '';
  for (let i = 0; i < 5; i++) tail += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${prefix}-${tail}`;
}
async function generateCode(prefixRaw) {
  const prefix = String(prefixRaw || 'MUN').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'MUN';
  for (let i = 0; i < 8; i++) {
    const code = randomCode(prefix);
    if (!(await db.getCoupon(code))) return code;
  }
  throw new AdminError('Could not make a unique code. Try again.', 500);
}

function normaliseCode(raw) {
  const code = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9][A-Z0-9-]{2,23}$/.test(code)) throw new AdminError('A code is 3 to 24 characters: letters, numbers and dashes only.');
  return code;
}
function num(v, label, { min = 0, max = Infinity, int = false, optional = false } = {}) {
  if (v === '' || v == null) { if (optional) return null; throw new AdminError(`${label} is required.`); }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) throw new AdminError(`${label} must be ${int ? 'a whole number ' : 'a number '}between ${min} and ${max}.`);
  return n;
}
function normalisePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) d = '91' + d;
  if (!/^91[6-9]\d{9}$/.test(d)) throw new AdminError('The customer phone must be a 10-digit Indian mobile number.');
  return d;
}
// 'YYYY-MM-DD' (or a full ISO string) read as India time; expiry runs to the end of that day.
function parseDate(v, label, endOfDay) {
  if (v === '' || v == null) return null;
  const s = String(v).trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T${endOfDay ? '23:59:59' : '00:00:00'}+05:30` : s;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new AdminError(`${label} is not a valid date.`);
  return new Date(t).toISOString();
}

function status(c, now = Date.now()) {
  if (!c.active) return 'paused';
  if (c.starts_at && Date.parse(c.starts_at) > now) return 'scheduled';
  if (c.expires_at && Date.parse(c.expires_at) < now) return 'expired';
  if (c.max_uses != null && (c.uses_count || 0) >= c.max_uses) return 'used_up';
  return 'live';
}

function benefit(c) {
  return c.type === 'percent'
    ? `${Number(c.value)}% off${c.max_discount_amount != null ? ` (up to ${rupee(c.max_discount_amount)})` : ''}`
    : `${rupee(c.value)} off`;
}
function scopeLabel(slug) { const s = SCOPES.find((x) => x.slug === (slug || '')); return s ? s.label : slug; }
function conditions(c) {
  const out = [];
  if (Number(c.min_order_value) > 0) out.push(`orders of ${rupee(c.min_order_value)} or more`);
  if (c.scope_slug === 'singles-only') out.push('not on gift sets');
  else if (c.scope_slug) out.push(scopeLabel(c.scope_slug).toLowerCase());
  if (c.max_uses === 1) out.push('single use');
  else {
    if (c.max_uses_per_customer != null) out.push(c.max_uses_per_customer === 1 ? 'one use per customer' : `${c.max_uses_per_customer} uses per customer`);
    if (c.max_uses != null) out.push(`first ${c.max_uses} uses`);
  }
  if (c.starts_at) out.push(`from ${istDate(c.starts_at)}`);
  if (c.expires_at) out.push(`valid till ${istDate(c.expires_at)}`);
  if (c.allowed_phone) out.push('only for one customer');
  return out;
}

function shareText(c, lang) {
  const off = benefit(c);
  const min = Number(c.min_order_value) > 0 ? ` on orders of ${rupee(c.min_order_value)} or more` : '';
  const scope = c.scope_slug === 'singles-only' ? ' (single boxes, not gift sets)' : c.scope_slug ? ` (orders with the ${scopeLabel(c.scope_slug).replace(/^Orders that include (a |the )?/i, '')})` : '';
  const till = c.expires_at ? ` Valid till ${istDate(c.expires_at)}.` : '';
  const once = c.max_uses_per_customer === 1 ? ' One use per customer.' : '';
  const mine = c.allowed_phone ? ' This code is just for you.' : '';
  if (lang === 'hi') {
    const offHi = c.type === 'percent' ? `${Number(c.value)}% की छूट${c.max_discount_amount != null ? ` (अधिकतम ${rupee(c.max_discount_amount)})` : ''}` : `${rupee(c.value)} की छूट`;
    const minHi = Number(c.min_order_value) > 0 ? ` (${rupee(c.min_order_value)} या उससे ऊपर के ऑर्डर पर)` : '';
    const setHi = c.scope_slug === 'singles-only' ? ' (सिर्फ़ अलग-अलग डिब्बों पर, गिफ़्ट सेट पर नहीं)' : '';
    return `🍪 Munchingo: munchingo.com पर चेकआउट में कोड ${c.code} लगाएँ और ${offHi} पाएँ${minHi}${setHi}.${c.expires_at ? ` ${istDate(c.expires_at)} तक मान्य.` : ''}${c.max_uses_per_customer === 1 ? ' हर ग्राहक के लिए एक बार.' : ''}${c.allowed_phone ? ' यह कोड सिर्फ़ आपके लिए है.' : ''}`;
  }
  return `🍪 Munchingo: use code ${c.code} at checkout on munchingo.com for ${off}${min}${scope}.${till}${once}${mine}`;
}

function shape(c, red) {
  const r = red || { count: 0, given: 0, customers: 0 };
  return {
    code: c.code, status: status(c), active: !!c.active, type: c.type, value: Number(c.value),
    maxDiscount: c.max_discount_amount == null ? null : Number(c.max_discount_amount), minOrder: Number(c.min_order_value || 0),
    scope: c.scope_slug || '', scopeLabel: scopeLabel(c.scope_slug), maxUses: c.max_uses == null ? null : Number(c.max_uses),
    uses: Number(c.uses_count || 0), perCustomer: c.max_uses_per_customer == null ? null : Number(c.max_uses_per_customer),
    startsAt: c.starts_at || null, expiresAt: c.expires_at || null, phone: c.allowed_phone || '', note: c.note || '', createdBy: c.created_by || '',
    createdAt: c.created_at, benefit: benefit(c), conditions: conditions(c),
    redeemed: r.count, discountGiven: r.given, customers: r.customers,
    shareEn: shareText(c, 'en'), shareHi: shareText(c, 'hi'),
  };
}

async function list() {
  const [rows, reds, ready] = await Promise.all([db.listCoupons(), db.listCouponRedemptions().catch(() => []), db.couponColumnsReady().catch(() => false)]);
  const agg = {};
  for (const r of reds) {
    const a = agg[r.coupon_code] || (agg[r.coupon_code] = { count: 0, given: 0, phones: new Set() });
    a.count++; a.given += Number(r.discount_amount || 0); a.phones.add(r.customer_phone);
  }
  return {
    ready,
    coupons: rows.map((c) => { const a = agg[c.code]; return shape(c, a ? { count: a.count, given: a.given, customers: a.phones.size } : null); }),
    scopes: SCOPES, limits: LIMITS,
  };
}

// Validates the form and builds the row. Used by create and by edit (edit passes the existing row to merge over).
function buildRow(input, existing) {
  const i = input || {};
  const type = i.type != null ? String(i.type) : existing.type;
  if (!['percent', 'flat'].includes(type)) throw new AdminError('Choose percent off or a flat rupee amount.');
  const value = i.value != null ? num(i.value, 'The discount', { min: 1, max: type === 'percent' ? LIMITS.percentMax : LIMITS.flatMax, int: type === 'flat' }) : Number(existing.value);
  const maxDiscount = type === 'percent'
    ? (i.maxDiscount !== undefined ? num(i.maxDiscount, 'The maximum discount', { min: 1, max: LIMITS.flatMax, optional: true }) : existing.max_discount_amount)
    : null;
  const row = {
    type, value, max_discount_amount: maxDiscount == null ? null : maxDiscount,
    min_order_value: i.minOrder !== undefined ? num(i.minOrder, 'The minimum order', { min: 0, max: LIMITS.minOrderMax }) : Number(existing.min_order_value || 0),
    scope_slug: i.scope !== undefined ? (SCOPES.some((s) => s.slug === (i.scope || '')) ? (i.scope || null) : (() => { throw new AdminError('That "applies to" choice is not valid.'); })()) : (existing.scope_slug || null),
    max_uses: i.maxUses !== undefined ? num(i.maxUses, 'The total uses', { min: 1, max: 100000, int: true, optional: true }) : existing.max_uses,
    max_uses_per_customer: i.perCustomer !== undefined ? num(i.perCustomer, 'Uses per customer', { min: 1, max: 1000, int: true, optional: true }) : (existing.max_uses_per_customer == null ? 1 : existing.max_uses_per_customer),
  };
  const extras = {};
  if (i.startsAt !== undefined) extras.starts_at = parseDate(i.startsAt, 'The start date', false);
  if (i.expiresAt !== undefined) row.expires_at = parseDate(i.expiresAt, 'The expiry date', true);
  if (i.phone !== undefined) extras.allowed_phone = i.phone === '' || i.phone == null ? null : normalisePhone(i.phone);
  if (i.note !== undefined) extras.note = String(i.note || '').trim().slice(0, 200) || null;
  if (row.expires_at && Date.parse(row.expires_at) < Date.now() && (i.expiresAt !== undefined)) throw new AdminError('That expiry date has already passed.');
  const start = extras.starts_at !== undefined ? extras.starts_at : (existing && existing.starts_at);
  const end = row.expires_at !== undefined ? row.expires_at : (existing && existing.expires_at);
  if (start && end && Date.parse(start) >= Date.parse(end)) throw new AdminError('The start date must be before the expiry date.');
  return { row, extras };
}

const NEEDS_MIGRATION = 'Notes, start dates and "only for this phone" need coupons_admin_migration.sql to be run in Supabase first. Run it, or leave those fields empty.';

async function create(input, actor) {
  const code = input && String(input.code || '').trim() ? normaliseCode(input.code) : await generateCode(input && input.prefix);
  if (await db.getCoupon(code)) throw new AdminError(`The code ${code} already exists. Pick another or leave the code empty to generate one.`, 409);
  const inp = input || {};
  if (!['percent', 'flat'].includes(String(inp.type))) throw new AdminError('Choose percent off or a flat rupee amount.');
  if (inp.value === undefined || inp.value === null || inp.value === '') throw new AdminError('Enter the discount (a percentage, or rupees).');
  const { row, extras } = buildRow({ maxUses: null, ...inp }, { type: undefined });
  const ready = await db.couponColumnsReady().catch(() => false);
  const wantsExtras = Object.values(extras).some((v) => v != null);
  if (wantsExtras && !ready) throw new AdminError(NEEDS_MIGRATION, 409);
  const toInsert = { code, active: true, ...row, ...(ready ? { ...extras, created_by: actor && actor.email ? actor.email : null } : {}) };
  let saved;
  try { saved = await db.insertCoupon(toInsert); }
  catch (e) { throw new AdminError('Could not save the coupon: ' + e.message, 500); }
  console.log(`[ADMIN] coupon ${code} created by ${actor && actor.email}: ${benefit(saved)}`);
  return { coupon: shape(saved) };
}

async function update(codeRaw, patch, actor) {
  const code = normaliseCode(codeRaw);
  const existing = await db.getCoupon(code);
  if (!existing) throw new AdminError('No such coupon.', 404);
  const fields = {};
  if (patch.active !== undefined) fields.active = !!patch.active;
  const editKeys = ['value', 'maxDiscount', 'minOrder', 'scope', 'maxUses', 'perCustomer', 'startsAt', 'expiresAt', 'phone', 'note', 'type'];
  if (editKeys.some((k) => patch[k] !== undefined)) {
    const { row, extras } = buildRow(patch, existing);
    const ready = await db.couponColumnsReady().catch(() => false);
    if (Object.values(extras).some((v) => v != null) && !ready) throw new AdminError(NEEDS_MIGRATION, 409);
    const changed = {};
    for (const k of Object.keys(patch)) {
      const map = { value: 'value', maxDiscount: 'max_discount_amount', minOrder: 'min_order_value', scope: 'scope_slug', maxUses: 'max_uses', perCustomer: 'max_uses_per_customer', expiresAt: 'expires_at', type: 'type' };
      if (map[k]) changed[map[k]] = row[map[k]];
    }
    if (patch.type !== undefined) changed.max_discount_amount = row.max_discount_amount == null ? null : row.max_discount_amount;
    Object.assign(fields, changed);
    if (ready) Object.assign(fields, extras);
  }
  if (!Object.keys(fields).length) throw new AdminError('Nothing to change.');
  let saved;
  try { saved = await db.updateCouponRow(code, fields); }
  catch (e) { throw new AdminError('Could not save the change: ' + e.message, 500); }
  console.log(`[ADMIN] coupon ${code} updated by ${actor && actor.email}: ${Object.keys(fields).join(', ')}`);
  return { coupon: shape(saved) };
}

async function remove(codeRaw, actor) {
  const code = normaliseCode(codeRaw);
  const existing = await db.getCoupon(code);
  if (!existing) throw new AdminError('No such coupon.', 404);
  if ((existing.uses_count || 0) > 0 || (await db.countCouponRedemptions(code)) > 0) throw new AdminError('This code has been used, so it is kept for the records. Pause it instead.', 409);
  await db.deleteCouponRow(code);
  console.log(`[ADMIN] coupon ${code} deleted by ${actor && actor.email}`);
  return { code };
}

module.exports = { list, create, update, remove, generateCode, status, shape, shareText, SCOPES, LIMITS };
