-- Growth journey (15 Nov 2026). Run in Supabase BEFORE pushing growth-journey (SQL editor). Safe to run twice; adds columns and indexes only.
-- Order-linked WhatsApp journey: reminder consent, last inbound time, campaign tag on broadcasts, typed chat waits, one tap per order.

-- contacts: when they last wrote to us, the separate yes for the running-low nudge, and the two "leave me alone" marks.
alter table contacts add column if not exists last_inbound_at timestamptz;
alter table contacts add column if not exists consent_reminder boolean not null default false;   -- the 80 existing contacts start at false
alter table contacts add column if not exists journey_declined_at timestamptz;
alter table contacts add column if not exists last_complaint_at timestamptz;

-- marketing_sends: which campaign a send belonged to (batch_YYMMDD, j6_reorder, ...).
alter table marketing_sends add column if not exists campaign text;
create index if not exists marketing_sends_template_campaign_idx on marketing_sends (template, campaign);

-- suggestion_waits: one table now holds several kinds of "waiting for their next message", optionally tied to an order.
alter table suggestion_waits add column if not exists kind text not null default 'suggestion';
alter table suggestion_waits add column if not exists order_id text;

-- order_events: one journey_tap per order (utils/journey.js claims the first check-in tap with claimOrderEvent, which only
-- returns false on a unique-index clash; without this a second Loved it would get a second cart link). Nothing writes
-- journey_tap before this push, so there are no duplicates to trip it.
create unique index if not exists order_events_journey_tap_once on order_events (order_id, event) where event = 'journey_tap';

-- order_events: one J6 reorder reminder per order, and at most one retry after Meta refused it (utils/reorders.js claims each with
-- claimOrderEvent before sending; without this index the claim always succeeds and two overlapping runs could both send).
-- Nothing writes these events before this push, so there are no duplicates to trip it.
create unique index if not exists order_events_reorder_once on order_events (order_id, event) where event in ('reorder_reminder', 'reorder_reminder_retry');

-- Read-back: should return 9 rows (the 7 columns, and the journey_tap and reorder indexes with their definitions).
select table_name::text as table_name, column_name::text as column_name, data_type::text as data_type
from information_schema.columns
where (table_name = 'contacts' and column_name in ('last_inbound_at', 'consent_reminder', 'journey_declined_at', 'last_complaint_at'))
   or (table_name = 'marketing_sends' and column_name = 'campaign')
   or (table_name = 'suggestion_waits' and column_name in ('kind', 'order_id'))
union all
select tablename::text, indexname::text, indexdef::text
from pg_indexes
where tablename = 'order_events' and indexname in ('order_events_journey_tap_once', 'order_events_reorder_once')
order by 1, 2;
