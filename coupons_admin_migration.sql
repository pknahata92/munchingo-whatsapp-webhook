-- Coupon manager (admin > Coupons): note, start date, "only for this phone", who created it.
-- Safe to run more than once. Run it in the Supabase SQL editor. The Coupons screen works without it for plain codes
-- (percent or flat, cap, minimum order, usage limits, expiry); this migration only enables the four extras below, and
-- the screen says so if it is missing. Nothing else in the shop depends on it.
alter table coupons add column if not exists note          text;          -- what the code is for ("apology for Hera", "Instagram giveaway")
alter table coupons add column if not exists created_by    text;          -- admin email that made it
alter table coupons add column if not exists starts_at     timestamptz;   -- not valid before this moment (null = valid now)
alter table coupons add column if not exists allowed_phone text;          -- personal code: only this customer's number (91XXXXXXXXXX) can use it

-- Read-back: expect 4 rows.
select column_name from information_schema.columns
 where table_name = 'coupons' and column_name in ('note','created_by','starts_at','allowed_phone') order by column_name;
