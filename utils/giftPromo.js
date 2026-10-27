'use strict';
// Gift set prices after Diwali (Prashant, 27 Oct 2026, from reports/Munchingo pricing structure review.md): Trio Rs 949,
// Full Range Rs 1,199. Until Diwali the sets keep selling at today's price (the admin Prices table, Rs 799 / Rs 999), shown
// on the site as a promotional brand offer with the coming price named. From SWITCH_AT the list price is charged
// automatically: nobody has to remember to change it. An admin price ABOVE the list price still wins after the switch.
// No strike-through or "save" figure is shown for sets: the list price has never been charged (see the review).
const SWITCH_AT = Date.parse('2026-11-09T00:00:00+05:30');     // the morning after Diwali (8 Nov 2026), IST
const LIST = { 'trio-gift-set': 949, 'full-range-set': 1199 };
const LABEL = 'Promotional brand offer until Diwali';

let clock = () => Date.now();
function setNow(fn) { clock = fn || (() => Date.now()); }     // tests only
const after = () => clock() >= SWITCH_AT;

/** The price to charge for a set (key 'trio-gift-set' or 'full-range-set'); other keys pass through unchanged. */
function effective(key, base) {
  if (!Object.prototype.hasOwnProperty.call(LIST, key)) return base;
  if (!after()) return base;
  return Math.max(Number(base) || 0, LIST[key]);
}
/** Promo details for the website while the offer runs, else null. */
function promoFor(key, base) {
  if (!Object.prototype.hasOwnProperty.call(LIST, key) || after() || !(Number(base) < LIST[key])) return null;
  return { label: LABEL, until: '2026-11-08', next: LIST[key], nextFrom: '2026-11-09' };
}

module.exports = { effective, promoFor, setNow, LIST, SWITCH_AT, LABEL };
