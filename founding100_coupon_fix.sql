-- Founding 100 promo clean-up. Run in the Supabase SQL editor (owner), then read the result of the SELECT.
-- 1. The promise to customers is 100 uses; the row said 200. The old Rs 499 minimum is stale (3 boxes is already Rs 777).
update coupons set max_uses = 100, min_order_value = 0 where code = 'FOUNDING10';

-- 2. Read it back. expires_at must be AFTER the end of the promo window (it was set to "60 days from the first migration run").
--    If it is too early, extend it, for example:
--      update coupons set expires_at = '2026-12-31T18:29:59Z' where code = 'FOUNDING10';
select code, type, value, max_discount_amount, min_order_value, max_uses, uses_count, max_uses_per_customer, expires_at, active
from coupons where code = 'FOUNDING10';
