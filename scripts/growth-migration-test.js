'use strict';
// Growth journey migration (15 Nov 2026): the SQL file and the database helpers that need it.
//   node scripts/growth-migration-test.js
const fs = require('fs'), path = require('path');
process.env.SUPABASE_URL = 'x'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'x';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const file = path.join(__dirname, '..', 'growth_journey_migration.sql');
if (!fs.existsSync(file)) { console.log('FAIL: growth_journey_migration.sql is missing'); process.exit(1); }
const sql = fs.readFileSync(file, 'utf8');
const code = sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n').toLowerCase();

const cols = [
  ['contacts', 'last_inbound_at'], ['contacts', 'consent_reminder'], ['contacts', 'journey_declined_at'], ['contacts', 'last_complaint_at'],
  ['marketing_sends', 'campaign'], ['suggestion_waits', 'kind'], ['suggestion_waits', 'order_id'],
];
for (const [t, c] of cols) {
  ok(new RegExp(`alter table ${t}[^;]*add column if not exists ${c}\\b`).test(code), `${t}.${c} added with add column if not exists`);
}
ok(/consent_reminder\s+boolean not null default false/.test(code), 'consent_reminder boolean not null default false');
ok(/kind\s+text not null default 'suggestion'/.test(code), "kind text not null default 'suggestion'");
ok(/create index if not exists marketing_sends_template_campaign_idx on marketing_sends \(template, campaign\)/.test(code), 'template/campaign index');
ok(/run in supabase before pushing growth-journey/i.test(sql), 'header says run before pushing');
ok(!/\b(drop|delete|update)\b/.test(code), 'no drop, delete or update');
const last = code.trim().split(';').filter((s) => s.trim()).pop();
ok(/^\s*select/.test(last) && /information_schema\.columns/.test(last), 'ends with an information_schema read-back select');
for (const [, c] of cols) ok(last.includes(`'${c}'`), `read-back lists ${c}`);

const d = require('../utils/database');
for (const f of ['touchInbound', 'listStallOrdersWithPhone', 'listActiveSubscriptionPhones', 'setSuggestionWait', 'getSuggestionWait', 'listMarketingContacts', 'listMarketingSends']) {
  ok(typeof d[f] === 'function', `database.${f} exported`);
}
const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'database.js'), 'utf8');
ok(/async function setSuggestionWait\(phone, at, kind = 'suggestion', orderId = null\)/.test(src), 'setSuggestionWait signature');
ok(/listMarketingContacts[\s\S]{0,400}consent_reminder, last_inbound_at, consent_at, consent_text, journey_declined_at, last_complaint_at/.test(src), 'listMarketingContacts columns');
ok(/marketing_sends'\)\.select\('phone, template, status, error, sent_at, campaign, wa_message_id'\)/.test(src), 'listMarketingSends columns');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
