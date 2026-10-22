'use strict';
// Review tables and database helpers: the migration has every table, column and allowed value the review feature relies on,
// and utils/database.js exports every helper.   node scripts/reviews-db-test.js
const fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const sqlFile = path.join(__dirname, '..', 'reviews_migration.sql');
const sql = fs.existsSync(sqlFile) ? fs.readFileSync(sqlFile, 'utf8').replace(/\s+/g, ' ') : '';
ok(!!sql, 'reviews_migration.sql exists');
ok(/create table if not exists reviews\b/i.test(sql), 'reviews table');
for (const col of ['order_id text unique not null', 'customer_phone text not null', 'ratings jsonb not null', 'comment text', 'display_name text', 'city text',
  'consent_publish boolean not null default false', 'network boolean not null default false', 'founding_taster boolean not null default false',
  "status text not null default 'new'", 'hidden_reason text', 'moderated_by text', 'moderated_at timestamptz', 'created_at timestamptz']) {
  ok(sql.toLowerCase().includes(col.toLowerCase()), 'reviews has: ' + col);
}
ok(/check \(status in \('new','published','hidden'\)\)/.test(sql.replace(/\s*,\s*/g, ',')), "status allows exactly new, published, hidden");
ok(/check \(hidden_reason in \('abusive','personal_data','off_topic','no_consent'\)\)/.test(sql.replace(/\s*,\s*/g, ',')), 'hidden_reason allows exactly the four fixed reasons');
ok(/create table if not exists founding_tasters\b/i.test(sql), 'founding_tasters table');
for (const col of ['phone text primary key', 'name text', 'first_order_id text', 'note text', 'added_at timestamptz']) ok(sql.toLowerCase().includes(col), 'founding_tasters has: ' + col);
ok(/alter table orders add column if not exists known_to_us boolean not null default false/i.test(sql), 'orders.known_to_us column');
ok(/alter table reviews enable row level security/i.test(sql) && /alter table founding_tasters enable row level security/i.test(sql), 'row level security on both tables');

const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'database.js'), 'utf8');
const exportsLine = (dbSrc.match(/module\.exports\s*=\s*\{([\s\S]*?)\};/) || ['', ''])[1];
for (const fn of ['insertReview', 'getReviewByOrder', 'listReviews', 'updateReview', 'listFoundingTasters', 'setFoundingTasters', 'listDeliveredOrders', 'setKnownToUs']) {
  ok(new RegExp('\\b' + fn + '\\b').test(exportsLine) && new RegExp('async function ' + fn + '\\(').test(dbSrc), 'database.js defines and exports ' + fn);
}
const devSrc = fs.readFileSync(path.join(__dirname, 'admin-dev.js'), 'utf8');
for (const fn of ['insertReview', 'getReviewByOrder', 'listReviews', 'updateReview', 'listFoundingTasters', 'setFoundingTasters', 'listDeliveredOrders', 'setKnownToUs']) {
  ok(new RegExp('\\b' + fn + ':').test(devSrc), 'practice copy stubs ' + fn);
}
console.log(`reviews-db-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
