'use strict';
// The pincode decides the state: a recognised-but-wrong typed state is corrected from the pincode (it drives CGST/SGST vs IGST).
const assert = require('assert');
const { fixParts, setLookup } = require('../utils/stateResolver');
let n = 0; const ok = (c, m) => { assert(c, m); n++; };
const names = { '121007': 'Haryana', '400001': 'Maharashtra', '160017': 'Chandigarh', '110001': 'Delhi', '000000': '' };
setLookup(async (pin) => names[pin] || '');
(async () => {
  let p = await fixParts({ state: 'Maharashtra', city: 'Mumbai', pincode: '121007' });
  ok(p.state === 'Haryana', 'wrong typed state is replaced by the pincode state, got ' + p.state);
  ok(p.stateCorrectedFrom === 'Maharashtra', 'the correction is recorded');
  p = await fixParts({ state: 'Haryana', city: 'Faridabad', pincode: '121007' });
  ok(p.state === 'Haryana' && !p.stateCorrectedFrom, 'matching state is left alone');
  p = await fixParts({ state: 'HR', city: 'Faridabad', pincode: '121007' });
  ok(!p.stateCorrectedFrom, 'an abbreviation for the right state is not a correction');
  p = await fixParts({ state: 'zzz', pincode: '400001' });
  ok(p.state === 'Maharashtra', 'unrecognised state is still filled from the pincode');
  p = await fixParts({ state: 'Maharashtra', pincode: '000000' });
  ok(p.state === 'Maharashtra' && !p.stateCorrectedFrom, 'when the pincode lookup gives nothing, keep what was typed');
  p = await fixParts({ state: 'Punjab', pincode: '160017' });
  ok(p.state === 'Chandigarh', 'Chandigarh pincode overrides Punjab');
  p = await fixParts({ state: 'Haryana', pincode: '110001' });
  ok(p.state === 'Delhi', 'Delhi pincode overrides Haryana (the common NCR mix-up)');
  p = await fixParts({ state: 'Haryana', city: 'Faridabad' });
  ok(p.state === 'Haryana', 'no pincode: unchanged');
  console.log(`pincode-state-test: ${n} checks passed`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
