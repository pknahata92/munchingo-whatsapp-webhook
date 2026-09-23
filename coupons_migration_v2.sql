-- Munchingo coupon system v2 — run this in the Supabase SQL editor.
-- Builds on coupons_migration.sql (already live in production). This one:
--   1. Adds a cap column so a PERCENT coupon can have a max rupee discount
--      (needed for FOUNDING10 — 10% off is only fair up to a point).
--   2. Retires FOUNDING100 (flat ₹100, min ₹999) in favour of FOUNDING10
--      (10% off up to ₹100, min ₹499) — see CLAUDE.md 2026-09-01 session log
--      for the reasoning: a flat ₹100 is ~19% off at the new, lower ₹499
--      MOV floor but only ~10% off at ₹999 — inconsistent. A percent-with-cap
--      code gives the same ~10% everywhere up to the point the cap binds
--      (~₹1,000), which is exactly where FOUNDING100's ₹100 was already
--      landing — so nothing changes for a ₹999+ order, only smaller ones
--      now get a fair (not inflated, not diluted) 10%.
--   3. Updates the Diwali code's dates for real, and adds a second festive
--      code for the Trio set (previously only the Full Range set had one).

-- ── 1. New column for capped percent discounts ─────────────────────────────
alter table coupons add column if not exists max_discount_amount numeric;
-- null = uncapped (a flat-type coupon never uses this column at all;
-- an uncapped percent coupon is unusual but not disallowed).

-- ── 2. Retire FOUNDING100, launch FOUNDING10 ────────────────────────────────
update coupons set active = false where code = 'FOUNDING100';

insert into coupons (code, type, value, min_order_value, scope_slug, max_uses, max_uses_per_customer, max_discount_amount, expires_at, active)
values
  ('FOUNDING10', 'percent', 10, 499, null, 200, 1, 100, now() + interval '60 days', true)
on conflict (code) do update set
  type = excluded.type,
  value = excluded.value,
  min_order_value = excluded.min_order_value,
  scope_slug = excluded.scope_slug,
  max_uses = excluded.max_uses,
  max_uses_per_customer = excluded.max_uses_per_customer,
  max_discount_amount = excluded.max_discount_amount,
  active = excluded.active;
  -- expires_at deliberately NOT overwritten on conflict, so re-running this
  -- script doesn't keep pushing the 60-day clock out if it's ever run twice.

-- ── 3. Festive codes — dates are an ESTIMATE for Diwali 2026 (~8 Nov 2026),
--      confirm against an actual calendar closer to the date before flipping
--      active to true. Both kept inactive by default, same as the original
--      DIWALI5FR seed, so nothing goes live by accident on migration day.
update coupons set
  expires_at = '2026-11-12T00:00:00Z'
where code = 'DIWALI5FR';

insert into coupons (code, type, value, min_order_value, scope_slug, max_uses, max_uses_per_customer, expires_at, active)
values
  ('DIWALI5TRIO', 'percent', 5, 0, 'trio-gift-set', null, 1, '2026-11-12T00:00:00Z', false)
on conflict (code) do nothing;

-- ── Sanity check — run after applying, expect FOUNDING100 inactive,
--    FOUNDING10 active, both Diwali codes inactive with the Nov 2026 date ──
-- select code, type, value, max_discount_amount, min_order_value, scope_slug, active, expires_at from coupons order by code;
