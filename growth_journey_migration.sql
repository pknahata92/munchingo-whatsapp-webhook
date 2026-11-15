-- Growth journey (15 Nov 2026). Run in Supabase BEFORE pushing growth-journey (SQL editor). Safe to run twice; adds columns only.
-- Order-linked WhatsApp journey: reminder consent, last inbound time, campaign tag on broadcasts, typed chat waits.

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

-- Read-back: should return 7 rows.
select table_name, column_name, data_type
from information_schema.columns
where (table_name = 'contacts' and column_name in ('last_inbound_at', 'consent_reminder', 'journey_declined_at', 'last_complaint_at'))
   or (table_name = 'marketing_sends' and column_name = 'campaign')
   or (table_name = 'suggestion_waits' and column_name in ('kind', 'order_id'))
order by table_name, column_name;
