'use strict';
// On/off env flags, read one way (A8 fix wave, 16 Nov 2026): on only for 1 or true, any case, spaces around ignored; anything else
// (blank, 0, false, yes, ...) is off. JOURNEY_J3_ENABLED (utils/reviews.js), JOURNEY_J6_ENABLED (utils/reorders.js) and
// MM_API_ENABLED (utils/whatsapp.js) use it. Tests: scripts/flags-test.js
const isOn = (v) => /^(1|true)$/i.test(String(v == null ? '' : v).trim());
const flagOn = (name) => isOn(process.env[name]);

module.exports = { isOn, flagOn };
