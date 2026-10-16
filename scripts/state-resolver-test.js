'use strict';
// Buyer state recognition and the pincode fallback (stand-ins for Delhivery/India Post).   node scripts/state-resolver-test.js
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 're_test';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const { normaliseState, parseAddress, buildInvoice } = require('../utils/invoice');
const sr = require('../utils/stateResolver');
(async () => {
  const code = (s) => (normaliseState(s) || {}).code || '';
  for (const [typed, c] of [['Haryana', '06'], ['HR', '06'], ['hr', '06'], ['Delhi', '07'], ['New Delhi', '07'], ['NCT Delhi', '07'], ['Delhi NCR', '07'],
    ['UP', '09'], ['U.P.', '09'], ['Uttar Pradesh', '09'], ['Uttarpradesh', '09'], ['Tamilnadu', '33'], ['Tamil Nadu', '33'], ['MH', '27'],
    ['Chattisgarh', '22'], ['Telengana', '36'], ['Jammu & Kashmir', '01'], ['West Bengal', '19'], ['Orissa', '21'], ['GJ', '24'], ['Karnataka', '29']]) {
    ok(code(typed) === c, `"${typed}" -> ${c} (got ${code(typed) || 'nothing'})`);
  }
  for (const bad of ['', '   ', 'India', 'Mumbai City', 'xx', null, undefined]) ok(!normaliseState(bad), `"${bad}" is not a state`);

  // pincode fallback
  const calls = [];
  sr.setLookup(async (pin) => { calls.push(pin); return { 110059: 'Delhi', 171009: 'Himachal Pradesh', 400607: 'Maharashtra', 999999: 'Atlantis' }[pin] || ''; });
  ok((await sr.stateFromPincode('110059')) === 'Delhi', 'pincode 110059 -> Delhi');
  ok((await sr.stateFromPincode('999999')) === '', 'a state name we do not recognise is rejected');
  ok((await sr.stateFromPincode('12')) === '' && !calls.includes('12'), 'a bad pincode is not even looked up');

  let p = await sr.fixParts({ state: 'Delhi NCR', city: 'x', pincode: '110059' });
  ok(p.state === 'Delhi NCR', 'a recognised state is left exactly as typed');
  p = await sr.fixParts({ state: 'Dilli', city: 'x', pincode: '110059' });
  ok(p.state === 'Delhi', 'an unrecognised state is filled in from the pincode');
  p = await sr.fixParts({ state: '', pincode: '171009' }); ok(p.state === 'Himachal Pradesh', 'a blank state is filled in from the pincode');
  p = await sr.fixParts({ state: 'zzz', pincode: '000000' }); ok(p.state === 'zzz', 'no pincode match: nothing is invented');

  // the order that went missing in Zoho: state not recognised, pincode known
  const order = { order_id: 'MNG-TEST-1610', status: 'paid', delivery_address: { raw: 'Plot 5, Some Colony, Near Metro Station', state: 'NCR', pincode: '110059' }, items: [{ productName: 'Atta Original', quantity: 3, item_price: 300 }], total: 900, customer_name: 'T', customer_phone: '919999900001' };
  const before = buildInvoice(order, { invoiceNo: 'MUN/26-27/9999', issuedAt: new Date() });
  ok(before.buyer.stateCode === '' && before.supplyType === 'inter', 'before the fix: no state code, inter-state (this is what Zoho refused)');
  let saved = null;
  const fixed = await sr.withResolvedState(order, async (id, addr) => { saved = { id, addr }; });
  const after = buildInvoice(fixed, { invoiceNo: 'MUN/26-27/9999', issuedAt: new Date() });
  ok(after.buyer.stateCode === '07' && after.supplyType === 'inter', 'after the fix: Delhi (07), correctly inter-state');
  ok(saved && saved.id === 'MNG-TEST-1610' && saved.addr.state === 'Delhi' && saved.addr.raw === order.delivery_address.raw, 'the fixed address is saved and the typed text is kept');
  const hr = { ...order, delivery_address: { raw: 'x, Faridabad, Haryana - 121007', state: 'Hariyana', pincode: '121007' } };
  sr.setLookup(async () => 'Haryana');
  const hrFixed = await sr.withResolvedState(hr);
  ok(buildInvoice(hrFixed, { invoiceNo: 'X', issuedAt: new Date() }).supplyType === 'intra', 'a Haryana buyer with a misspelt state is now correctly CGST+SGST, not IGST');
  const same = await sr.withResolvedState(fixed, async () => { throw new Error('should not save'); });
  ok(same === fixed, 'already-recognised state: order returned untouched, nothing saved');
  sr.setLookup(async () => '');
  const unresolved = await sr.withResolvedState(order); ok(unresolved === order, 'unresolvable: order returned unchanged, no crash');
  sr.setLookup(async () => { throw new Error('network down'); });
  ok((await sr.stateFromPincode('110059')) === '', 'lookup failure returns empty and never throws');

  console.log(`state resolver: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
