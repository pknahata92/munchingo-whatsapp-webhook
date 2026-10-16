'use strict';

/**
 * Customer phone numbers, stored as digits with the country code (919988992024). Domestic only: Indian mobiles.
 *   9988992024, +919988992024, 919988992024, 099889 92024  ->  919988992024  (10 digits after 91, first digit 6-9)
 * Anything else is invalid, however long. (Before 17 Oct the server only checked "at least 12 digits", so a 14-digit string passed.)
 */
function normalisePhone(rawPhone) {
  let digits = String(rawPhone || '').replace(/\D/g, '');
  if (digits.length === 10) digits = '91' + digits;      // no country code: India
  return digits;
}

const isIndianPhone = (d) => /^91[6-9]\d{9}$/.test(String(d || ''));
/** Raw text -> true only for a valid Indian mobile. */
const isValidPhone = (raw) => isIndianPhone(normalisePhone(raw));

module.exports = { normalisePhone, isIndianPhone, isValidPhone };
