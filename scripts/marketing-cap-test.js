'use strict';
// One shared marketing gate (15 Nov 2026): cap, cool-off, retry once, quiet hours, template + campaign.
//   node scripts/marketing-cap-test.js
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const cap = require('../utils/marketingCap');
const H = 3_600_000, DAY = 24 * H, NOW = Date.parse('2026-11-20T06:30:00Z'); // 12:00 IST
const P = '919000000001', T = 'munchingo_fresh_batch', C = 'batch_261120';
const S = (template, campaign = null, ageH = 1) => ({ phone: P, template, campaign, status: 'sent', error: null, sent_at: new Date(NOW - ageH * H).toISOString() });
const F131049 = (at, template = T, campaign = C) => ({ phone: P, template, campaign, status: 'failed', error: '131049 healthy ecosystem', sent_at: new Date(at).toISOString() });

ok(cap.CAP === 3 && cap.CAP_DAYS === 30 && cap.COOL_OFF_MS === 48 * H, 'constants');
ok(cap.slotFor({ phone: P, sends: [], nowMs: NOW, template: T }) === 'ok', 'nobody sent: ok');
ok(cap.slotFor({ phone: P, sends: [S('munchingo_fresh_batch', 'batch_261120')], nowMs: NOW, template: 'munchingo_fresh_batch', campaign: 'batch_261127' }) === 'ok', 'same template, new campaign is allowed');
ok(cap.slotFor({ phone: P, sends: [S('munchingo_fresh_batch', 'batch_261120')], nowMs: NOW, template: 'munchingo_fresh_batch', campaign: 'batch_261120' }) === 'already_sent', 'same template + campaign is refused');
ok(cap.slotFor({ phone: P, sends: [S(T)], nowMs: NOW, template: T }) === 'already_sent', 'null campaign matches null (legacy rule)');
ok(cap.slotFor({ phone: P, sends: [S(T, C)], nowMs: NOW, template: T }) === 'ok', 'null campaign does not match a named campaign');
ok(cap.slotFor({ phone: P, sends: [S(T, null)], nowMs: NOW, template: T, campaign: C }) === 'ok', 'a named campaign does not match a null one');
ok(cap.slotFor({ phone: P, sends: [{ ...S(T), campaign: undefined }], nowMs: NOW, template: T, campaign: '' }) === 'already_sent', 'undefined and empty campaign both mean null');
ok(cap.slotFor({ phone: '919000000002', sends: [S(T)], nowMs: NOW, template: T }) === 'ok', "another person's sends do not count");
ok(cap.slotFor({ phone: '+91 90000 00001', sends: [S(T)], nowMs: NOW, template: T }) === 'already_sent', 'phones match on digits');

ok(cap.slotFor({ phone: P, sends: [F131049(NOW - 3 * H, 'other', 'x')], nowMs: NOW, template: T, campaign: C }) === 'cooling_off', '131049 3 h ago cools off any template');
ok(cap.slotFor({ phone: P, sends: [F131049(NOW - 49 * H)], nowMs: NOW, template: T, campaign: C }) === 'ok', 'after 48 h one 131049 can be retried');
ok(cap.slotFor({ phone: P, sends: [{ ...F131049(NOW - 3 * H), error: '131026 undeliverable' }], nowMs: NOW, template: T, campaign: C }) === 'ok', 'other failures are not held');
ok(cap.slotFor({ phone: P, sends: [F131049(NOW - 30 * H), F131049(NOW - 10 * H)], nowMs: NOW, template: T, campaign: C }) === 'cooling_off', 'two failures inside 48 h are cooling_off, not blocked_twice');
ok(cap.slotFor({ phone: P, sends: [F131049(NOW - 72 * H), F131049(NOW - 60 * H)], nowMs: NOW, template: T, campaign: C }) === 'blocked_twice', 'retried at most once after 131049');
ok(cap.slotFor({ phone: P, sends: [F131049(NOW - 72 * H), F131049(NOW - 60 * H, T, 'other')], nowMs: NOW, template: T, campaign: C }) === 'ok', 'two failures for different campaigns are not blocked_twice');

ok(cap.slotFor({ phone: P, sends: [S('a', null, 24), S('b', null, 48), S('c', null, 72)], nowMs: NOW, template: 'd' }) === 'over_cap', 'three sends in 30 days is the cap');
ok(cap.slotFor({ phone: P, sends: [S('a'), S('b')], nowMs: NOW, template: 'd' }) === 'ok', 'two sends is under the cap');
ok(cap.slotFor({ phone: P, sends: [S('a', null, 31 * 24), S('b', null, 40 * 24), S('c', null, 50 * 24)], nowMs: NOW, template: 'd' }) === 'ok', 'sends older than 30 days do not count');
ok(cap.slotFor({ phone: P, sends: [S('a'), S('b'), { ...S('c'), status: 'failed', error: '131026' }], nowMs: NOW, template: 'd' }) === 'ok', 'failed sends do not count against the cap');

ok(cap.isQuietHours(Date.parse('2026-11-20T16:00:00Z')) === true && cap.isQuietHours(Date.parse('2026-11-20T03:30:00Z')) === false, '21:30 IST quiet, 09:00 IST not');
ok(cap.isQuietHours(Date.parse('2026-11-20T15:30:00Z')) === true, '21:00 IST is quiet');
ok(cap.isQuietHours(Date.parse('2026-11-20T15:29:00Z')) === false, '20:59 IST is not quiet');
ok(cap.isQuietHours(Date.parse('2026-11-20T03:29:00Z')) === true, '08:59 IST is quiet');
ok(cap.isQuietHours(Date.parse('2026-11-20T18:30:00Z')) === true, 'midnight IST is quiet');

// slotsLeft (growth A7): how many of the 3 a month are still free (J6 wins the last one over a batch alert)
const left = (sends) => (typeof cap.slotsLeft === 'function' ? cap.slotsLeft({ phone: P, sends, nowMs: NOW }) : 'missing');
ok(left([]) === 3, 'slotsLeft: nobody sent: 3');
ok(left([S('a', null, 5 * 24), S('b', null, 10 * 24)]) === 1, 'slotsLeft: two sends this month: 1 left');
ok(left([S('a', null, 31 * 24), S('b', null, 10 * 24), { ...S('c'), status: 'failed', error: '131049 x' }, { ...S('d'), phone: '919000000002' }]) === 2, 'slotsLeft: only `sent` rows of this person in the last 30 days count');
ok(left([S('a'), S('b'), S('c'), S('d')]) === 0, 'slotsLeft: never below 0');

console.log(`marketing-cap-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
