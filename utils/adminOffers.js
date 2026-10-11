'use strict';

/**
 * Owner-only stock-up tiers (admin > Coupons > Stock-up tiers): "spend at least ₹X on single boxes, save ₹Y", applied
 * automatically at checkout by utils/offers.js. Gift sets never count. Needs offers_migration.sql; the screen says so if missing.
 * Sanity limits: spend ₹600-20,000, saving at most 20% of the spend, one tier per spend amount.
 */
const db = require('./database');
const { AdminError } = require('./adminActions');
const { parseDate } = require('./adminCoupons');

const NEEDS_MIGRATION = 'Stock-up tiers need offers_migration.sql to be run in Supabase first.';
const LIMITS = { minSpend: 600, maxSpend: 20000, maxShare: 0.2, maxPercent: 20, maxCap: 1000 };

function status(t, now = Date.now()) {
  if (!t.active) return 'paused';
  if (t.starts_at && Date.parse(t.starts_at) > now) return 'scheduled';
  if (t.ends_at && Date.parse(t.ends_at) < now) return 'expired';
  return 'live';
}
const shape = (t) => ({ id: t.id, min: Number(t.min_singles), off: t.discount == null ? null : Number(t.discount), pct: t.percent == null ? null : Number(t.percent), cap: t.max_discount == null ? null : Number(t.max_discount), label: t.label || '', startsAt: t.starts_at || null, endsAt: t.ends_at || null, active: !!t.active, status: status(t) });
const whole = (v, label, min, max) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new AdminError(`${label} must be a whole number of rupees between ${min} and ${max}.`); return n; };
function refreshCheckout() { try { require('./offers').invalidate(); } catch (_) {} }

async function list() {
  if (!(await db.offersReady().catch(() => false))) return { ready: false, tiers: [], note: NEEDS_MIGRATION };
  return { ready: true, tiers: (await db.listSpendTiers()).map(shape) };
}

async function create(input, actor) {
  if (!(await db.offersReady().catch(() => false))) throw new AdminError(NEEDS_MIGRATION, 409);
  const i = input || {};
  const min = whole(i.min, 'The spend', LIMITS.minSpend, LIMITS.maxSpend);
  // A percentage tier ("10% off over ₹1,500, up to ₹300") or a flat one ("spend ₹2,000, save ₹200").
  const isPct = i.percent !== undefined && i.percent !== null && i.percent !== '';
  let off = null, percent = null, cap = null;
  if (isPct) {
    percent = whole(i.percent, 'The percentage', 1, LIMITS.maxPercent);
    cap = whole(i.cap, 'The highest saving (cap)', 1, LIMITS.maxCap);
  } else {
    off = whole(i.off, 'The saving', 1, Math.floor(min * LIMITS.maxShare));
  }
  const rows = await db.listSpendTiers();
  if (rows.some((t) => Number(t.min_singles) === min)) throw new AdminError(`There is already a tier at ₹${min}. Change or delete that one.`, 409);
  const startsAt = parseDate(i.startsAt, 'The start date', false);
  const endsAt = parseDate(i.endsAt, 'The end date', true);
  if (startsAt && endsAt && Date.parse(startsAt) >= Date.parse(endsAt)) throw new AdminError('The start date must be before the end date.');
  const saved = await db.insertSpendTier({ min_singles: min, discount: off, percent, max_discount: cap, label: String(i.label || '').trim().slice(0, 60) || null, starts_at: startsAt, ends_at: endsAt, active: true, created_by: actor && actor.email ? actor.email : null });
  refreshCheckout();
  console.log(`[ADMIN] tier ₹${min} → ${isPct ? percent + '% (cap ₹' + cap + ')' : '₹' + off} off created by ${actor && actor.email}`);
  return { tier: shape(saved) };
}

async function update(id, patch, actor) {
  const rows = await db.listSpendTiers();
  const t = rows.find((x) => String(x.id) === String(id));
  if (!t) throw new AdminError('No such tier.', 404);
  const p = patch || {};
  const f = {};
  if (p.active !== undefined) f.active = !!p.active;
  if (p.startsAt !== undefined) f.starts_at = parseDate(p.startsAt, 'The start date', false);
  if (p.endsAt !== undefined) f.ends_at = parseDate(p.endsAt, 'The end date', true);
  const min = p.min !== undefined ? whole(p.min, 'The spend', LIMITS.minSpend, LIMITS.maxSpend) : Number(t.min_singles);
  if (p.min !== undefined) {
    if (rows.some((x) => String(x.id) !== String(t.id) && Number(x.min_singles) === min)) throw new AdminError(`There is already a tier at ₹${min}.`, 409);
    f.min_singles = min;
  }
  if (p.off !== undefined) {
    if (t.percent != null) throw new AdminError('This is a percentage tier. Change the percentage or the cap instead.');
    f.discount = whole(p.off, 'The saving', 1, Math.floor(min * LIMITS.maxShare));
  }
  if (p.percent !== undefined) {
    if (t.percent == null) throw new AdminError('This is a flat tier. Change the saving instead.');
    f.percent = whole(p.percent, 'The percentage', 1, LIMITS.maxPercent);
  }
  if (p.cap !== undefined) {
    if (t.percent == null) throw new AdminError('Only a percentage tier has a cap.');
    f.max_discount = whole(p.cap, 'The highest saving (cap)', 1, LIMITS.maxCap);
  }
  const s = f.starts_at !== undefined ? f.starts_at : t.starts_at;
  const e = f.ends_at !== undefined ? f.ends_at : t.ends_at;
  if (s && e && Date.parse(s) >= Date.parse(e)) throw new AdminError('The start date must be before the end date.');
  if (!Object.keys(f).length) throw new AdminError('Nothing to change.');
  const saved = await db.updateSpendTier(t.id, f);
  refreshCheckout();
  console.log(`[ADMIN] tier ${t.id} changed by ${actor && actor.email}: ${JSON.stringify(f)}`);
  return { tier: shape(saved) };
}

async function remove(id, actor) {
  await db.deleteSpendTier(id);
  refreshCheckout();
  console.log(`[ADMIN] tier ${id} deleted by ${actor && actor.email}`);
  return {};
}

module.exports = { list, create, update, remove, LIMITS };
