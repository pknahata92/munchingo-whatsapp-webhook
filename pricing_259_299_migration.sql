-- Prices and offers for the Pack of 2 flow (25 Oct 2026). Run in the Supabase SQL editor WHEN the backend with this change is live
-- (it is safe to run twice). Until it runs, the site keeps charging whatever product_prices holds today.
--
-- 1. Web prices: Original and Ajwain Rs 259, Kesari and Sugar-Lite Rs 299; the printed MRP (300 / 350) stays as the struck-through price.
--    Trio Rs 799 (workbook v14), Full Range unchanged at Rs 999.
insert into product_prices (slug, price, mrp, updated_by) values
  ('atta-original',   259, 300, 'pricing_259_299_migration'),
  ('atta-ajwain',     259, 300, 'pricing_259_299_migration'),
  ('atta-kesari',     299, 350, 'pricing_259_299_migration'),
  ('atta-lite-sugar', 299, 350, 'pricing_259_299_migration'),
  ('trio-gift-set',   799, null, 'pricing_259_299_migration'),
  ('full-range-set',  999, null, 'pricing_259_299_migration')
on conflict (slug) do update set price = excluded.price, mrp = excluded.mrp, updated_by = excluded.updated_by, updated_at = now();

-- 2. Retire the percentage offers: the Rs 259/299 web price is already about 14% below MRP.
--    The stock-up tiers are paused (not deleted) and FOUNDING10 is switched off; the codes stay on file in the admin.
update spend_tiers set active = false where active;
update coupons set active = false where upper(code) = 'FOUNDING10';

-- Read-back: expect 6 prices, no active tiers, FOUNDING10 inactive.
select slug, price, mrp from product_prices order by slug;
select count(*) as active_tiers from spend_tiers where active;
select code, active from coupons where upper(code) = 'FOUNDING10';
