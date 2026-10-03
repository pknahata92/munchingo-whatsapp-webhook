-- Munchingo language preference — run once in the Supabase SQL editor.
-- One row per WhatsApp number: 'en' or 'hi'. Set when a customer taps
-- English / हिन्दी on their first chat. The backend treats a missing table or
-- any DB error as English, so running this late never breaks anything.

create table if not exists customer_prefs (
  phone      text primary key,
  lang       text not null default 'en' check (lang in ('en','hi')),
  updated_at timestamptz not null default now()
);

-- Same posture as orders: RLS on, no public policies; only the service role reads/writes.
alter table customer_prefs enable row level security;
