-- Munchingo gift note — run once in the Supabase SQL editor.
-- Optional free-text note a gifter can leave on an order (e.g. "Happy
-- Diwali, love Priya"), surfaced to Prashant in the immediate owner
-- notification email and the daily packing-list digest so it's actually
-- seen while packing, not just stored.

alter table orders add column if not exists gift_note text;
