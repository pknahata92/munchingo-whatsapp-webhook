'use strict';
// Where we deliver (2 Nov 2026, Prashant): Delhi NCR only until boxes stop breaking in transit; NCR orders are delivered by hand.
// Set DELIVERY_NATIONWIDE=1 on Render to reopen all of India (no code change).   Tests: scripts/delivery-area-test.js

const NCR_PREFIXES = ['110', '121', '122', '201'];   // Delhi, Faridabad, Gurugram, Noida / Greater Noida / Ghaziabad
const MESSAGE = 'We’re delivering in Delhi NCR only.';

const nationwide = () => process.env.DELIVERY_NATIONWIDE === '1';

/** True when we deliver to this pincode right now. No valid pincode = not in the area (while NCR-only is on). */
function inArea(pin) {
  if (nationwide()) return true;
  const p = String(pin || '').trim();
  return /^[1-9][0-9]{5}$/.test(p) && NCR_PREFIXES.some((x) => p.startsWith(x));
}

/** The pincode in a typed address (the last 6-digit number that is not part of a longer one, e.g. a phone), or null. */
function pinIn(text) {
  const m = String(text || '').match(/(?<!\d)[1-9]\d{5}(?!\d)/g);
  return m ? m[m.length - 1] : null;
}

module.exports = { inArea, pinIn, nationwide, NCR_PREFIXES, MESSAGE };
