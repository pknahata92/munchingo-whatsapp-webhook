-- Contacts (25 Oct 2026). Run in the Supabase SQL editor BEFORE pushing the code that uses it. Safe to run twice.
-- People who messaged us a sign-up keyword (e.g. FAIR from the stall QR). consent_marketing: null = not answered,
-- true = tapped "Yes, keep me posted", false = tapped "No thanks" or sent STOP. Only true may receive marketing.

create table if not exists contacts (
  phone              text primary key,                   -- WhatsApp number, digits with country code
  name               text,                               -- WhatsApp profile name
  first_source       text not null,                      -- e.g. fair:2026-10-25 (keyword and IST day of the first sign-up)
  last_source        text,
  consent_marketing  boolean,
  consent_at         timestamptz,
  consent_text       text,                               -- the exact question they answered, or 'STOP'
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists contacts_first_source_idx on contacts (first_source);
alter table contacts enable row level security;          -- no public policies: only the backend's service key can read it
