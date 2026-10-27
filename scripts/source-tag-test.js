'use strict';
// The website's first-touch source capture (munchingo-website/js/source-tag.js), pure functions only.   node scripts/source-tag-test.js
const path = require('path');
const fs = require('fs');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const SITE = process.env.SITE_DIR || path.resolve(__dirname, '../../../munchingo-website');   // SITE_DIR like the other website tests
const file = path.join(SITE, 'js/source-tag.js');
if (!fs.existsSync(file)) { console.log('FAIL: missing ' + file); process.exit(1); }
const { parse, merge, payload } = require(file);
const DAY = 864e5, NOW = Date.parse('2026-10-19T10:00:00Z');

// 1. UTM tags on the landing URL.
let t = parse('?utm_source=instagram&utm_medium=social&utm_campaign=launch', '', '/atta-original', 'munchingo.com');
ok(t && t.utm.source === 'instagram' && t.utm.medium === 'social' && t.utm.campaign === 'launch', 'reads utm_source, utm_medium and utm_campaign');
ok(t && t.landed === '/atta-original', 'keeps the landing path without the query');

// 2. An outside referrer is kept as a host only.
t = parse('', 'https://l.instagram.com/?u=https%3A%2F%2Fmunchingo.com&e=abc', '/', 'munchingo.com');
ok(t && t.ref === 'l.instagram.com' && !t.utm, 'keeps only the referrer host');

// 3. Our own site as referrer, or a direct visit, is not a source.
ok(parse('', 'https://munchingo.com/cart', '/', 'munchingo.com') === null, 'own-site referrer is ignored');
ok(parse('', 'https://www.munchingo.com/cart', '/', 'munchingo.com') === null, 'www own-site referrer is ignored');
ok(parse('', '', '/', 'munchingo.com') === null, 'a direct visit gives no touch');
ok(parse('?foo=bar', '', '/', 'munchingo.com') === null, 'unrelated query params give no touch');

// 4. Long values are cut to 60.
t = parse('?utm_source=' + 'a'.repeat(100), '', '/', 'munchingo.com');
ok(t && t.utm.source.length === 60, 'cuts a long utm value to 60');

// 5. First touch wins for 30 days, then the newer one replaces it.
const first = { utm: { source: 'instagram' }, t: NOW - 5 * DAY };
const later = { utm: { source: 'google' } };
ok(merge(first, later, NOW).utm.source === 'instagram', 'first touch wins inside 30 days');
ok(merge({ ...first, t: NOW - 31 * DAY }, later, NOW).utm.source === 'google', 'an expired first touch is replaced');
ok(merge(null, later, NOW).utm.source === 'google' && merge(null, later, NOW).t === NOW, 'stores a touch when none exists, stamped with now');
ok(merge(first, null, NOW) === first, 'no new touch keeps the old one');
ok(merge(null, null, NOW) === null, 'nothing and nothing stays nothing');

// 6. The payload for checkout: the buyer's answer plus the touch. Empty stays empty.
let p = payload({ utm: { source: 'instagram' }, ref: 'l.instagram.com', landed: '/', t: NOW }, 'instagram');
ok(p.how === 'instagram' && p.utm.source === 'instagram' && p.ref === 'l.instagram.com' && p.landed === '/', 'payload carries answer and touch');
ok(p.t === undefined, 'payload leaves the timestamp out');
p = payload(null, 'friend_family');
ok(p.how === 'friend_family' && Object.keys(p).length === 1, 'payload with only an answer');
p = payload({ utm: { source: 'x' } }, '');
ok(p.how === undefined && p.utm.source === 'x', 'payload with only a touch');
ok(JSON.stringify(payload(null, '')) === '{}', 'payload with nothing is {}');

console.log(`source-tag: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
