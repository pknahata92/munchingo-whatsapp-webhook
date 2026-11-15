'use strict';
// One reading of the on/off env flags (A8 fix wave, 16 Nov 2026): JOURNEY_J3_ENABLED, JOURNEY_J6_ENABLED and MM_API_ENABLED are on
// only for 1 or true (any case, spaces around ignored). They used to differ: J3/J6 also took "yes" and did not trim; MM trimmed.
// J3's behaviour per value is in scripts/reviews-test.js.   node scripts/flags-test.js
const fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const VALUES = [['', false], ['0', false], ['false', false], ['no', false], ['yes', false], ['2', false], ['on', false], [' 1 ', true], ['TRUE', true], ['true', true], ['1', true], ['\t1\n', true], [' True ', true]];

const axios = require('axios');
const calls = [];
axios.post = async (url) => { calls.push(url); return { data: { messages: [{ id: 'wamid.F' }] } }; };   // never a live call
process.env.PHONE_NUMBER_ID = '111'; process.env.WHATSAPP_TOKEN = 'x';

(async () => {
  let flags;
  try { flags = require('../utils/flags'); } catch (e) { flags = null; }
  ok(flags && typeof flags.flagOn === 'function', 'utils/flags.js exports flagOn');
  if (!flags) { console.log(`flags-test: ${pass} passed, ${fail} failed`); process.exit(1); }

  for (const [v, on] of VALUES) {
    process.env.X_TEST_FLAG = v;
    ok(flags.flagOn('X_TEST_FLAG') === on, `flagOn(${JSON.stringify(v)}) is ${on}`);
  }
  delete process.env.X_TEST_FLAG;
  ok(flags.flagOn('X_TEST_FLAG') === false, 'an unset flag is off');

  // J6: utils/reorders.js enabled()
  const reorders = require('../utils/reorders');
  for (const [v, on] of VALUES) { process.env.JOURNEY_J6_ENABLED = v; ok(reorders.enabled() === on, `JOURNEY_J6_ENABLED=${JSON.stringify(v)}: J6 ${on ? 'on' : 'off'}`); }
  delete process.env.JOURNEY_J6_ENABLED;

  // MM: utils/whatsapp.js sends marketing templates to /marketing_messages only when the flag is on
  const wa = require('../utils/whatsapp');
  for (const [v, on] of VALUES) {
    process.env.MM_API_ENABLED = v; calls.length = 0;
    await wa.sendMarketingTemplate('91999', 't', 'en', ['a']);
    ok(calls.length === 1 && calls[0].endsWith(on ? '/marketing_messages' : '/messages'), `MM_API_ENABLED=${JSON.stringify(v)}: ${on ? 'Marketing Messages API' : 'Cloud API'} (got ${calls})`);
  }
  delete process.env.MM_API_ENABLED;

  // the three modules read their flag through the one helper, with no regex of their own left
  for (const [file, name] of [['reviews.js', 'JOURNEY_J3_ENABLED'], ['reorders.js', 'JOURNEY_J6_ENABLED'], ['whatsapp.js', 'MM_API_ENABLED']]) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'utils', file), 'utf8');
    ok(new RegExp(`flagOn\\('${name}'\\)`).test(src) && !new RegExp(`\\(1\\|true[^)]*\\)\\$/i\\.test\\(String\\(process\\.env\\.${name}`).test(src), `${file} reads ${name} with flagOn`);
  }

  console.log(`flags-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
