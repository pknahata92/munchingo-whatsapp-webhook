'use strict';
// One shared marketing gate (15 Nov 2026). Broadcasts, the J6 reorder job and the J7 batch alerts all ask this module
// "may this person get this marketing message now?", so the promise made at sign-up ("at most 3 a month") has one owner.
//   - already_sent: a `sent` row with the same template AND the same campaign (null matches only null: the old rule)
//   - cooling_off: a 131049 failure for ANY marketing template in the last 48 h (Meta: wait at least 24); checked first, so a failure inside 48 h is always cooling_off
//   - blocked_twice: once 48 h have passed, two or more 131049 failures for this template + campaign (retry at most once)
//   - over_cap: 3 or more `sent` rows in the last 30 days, any template
// Quiet hours: no marketing send 21:00-08:59 IST. Tests: scripts/marketing-cap-test.js
const CAP = 3, CAP_DAYS = 30, COOL_OFF_MS = 48 * 3_600_000;
const IST_MS = 5.5 * 3_600_000;

const digits = (p) => String(p || '').replace(/\D/g, '');
const camp = (c) => (c == null || c === '' ? null : String(c));
const is131049 = (s) => s.status === 'failed' && /^131049\b/.test(String(s.error || ''));
const at = (s) => Date.parse(s.sent_at) || 0;

/** -> 'ok' | 'already_sent' | 'blocked_twice' | 'cooling_off' | 'over_cap' */
function slotFor({ phone, sends = [], nowMs, template, campaign = null }) {
  const p = digits(phone), c = camp(campaign);
  const mine = sends.filter((s) => digits(s.phone) === p);
  if (mine.some((s) => s.status === 'sent' && s.template === template && camp(s.campaign) === c)) return 'already_sent';
  const failed = mine.filter(is131049);
  if (failed.some((s) => at(s) >= nowMs - COOL_OFF_MS)) return 'cooling_off';
  if (failed.filter((s) => s.template === template && camp(s.campaign) === c).length >= 2) return 'blocked_twice';
  if (mine.filter((s) => s.status === 'sent' && at(s) >= nowMs - CAP_DAYS * 86_400_000).length >= CAP) return 'over_cap';
  return 'ok';
}

/** True from 21:00 to 08:59 IST. */
function isQuietHours(nowMs) {
  const h = new Date(nowMs + IST_MS).getUTCHours();
  return h >= 21 || h < 9;
}

module.exports = { CAP, CAP_DAYS, COOL_OFF_MS, slotFor, isQuietHours };
