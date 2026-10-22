-- Reviews (23 Oct 2026). Run in the Supabase SQL editor BEFORE pushing the code that uses it. Safe to run twice.
-- One review per order: a star rating per flavour the buyer received plus one optional comment. Nothing is shown on the
-- website until the owner publishes it; a review is hidden only for one of four fixed reasons, never for a low rating.

create table if not exists reviews (
  id               bigserial primary key,
  order_id         text unique not null,
  customer_phone   text not null,
  ratings          jsonb not null,                                  -- {"atta-original": 5, "atta-kesari": 4}; gift sets are opened up into flavours
  comment          text,                                            -- plain text, escaped wherever it is shown
  display_name     text,                                            -- first name, or "Anonymous buyer"
  city             text,
  consent_publish  boolean not null default false,                  -- the buyer ticked "You can show my review on munchingo.com"
  network          boolean not null default false,                  -- friend or family of the founder (labelled when shown)
  founding_taster  boolean not null default false,                  -- gets new products free (labelled when shown)
  status           text not null default 'new' check (status in ('new','published','hidden')),
  hidden_reason    text check (hidden_reason in ('abusive','personal_data','off_topic','no_consent')),
  moderated_by     text,
  moderated_at     timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists reviews_created_idx on reviews (created_at desc);
alter table reviews enable row level security;                      -- no public policies: only the backend's service key can read it

-- The first buyers (orders paid 11 to 17 Oct 2026): every future launch reaches them first, free.
create table if not exists founding_tasters (
  phone           text primary key,                                  -- digits with the 91 prefix
  name            text,
  first_order_id  text,
  note            text,
  added_at        timestamptz not null default now()
);
alter table founding_tasters enable row level security;

-- Owner's toggle for orders placed before the "How did you hear about us?" question existed (19 Oct 2026).
alter table orders add column if not exists known_to_us boolean not null default false;
