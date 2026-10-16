'use strict';
// withBuyerState: gives Zoho a state for an invoice issued without one, without touching the issued invoice.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'x';
const assert = require('assert');
const { withBuyerState } = require('../utils/adminActions');
const { setLookup } = require('../utils/stateResolver');
let n = 0; const ok = (c, m) => { assert(c, m); n++; };
const inv = (supplyType) => ({ supplyType, placeOfSupply: '—', buyer: { name: 'H N', state: 'Xyz', stateCode: '' } });
const ord = (da) => ({ order_id: 'MNG-T', delivery_address: da });
(async () => {
  setLookup(async (pin) => (pin === '110001' ? 'Delhi' : pin === '122001' ? 'Haryana' : ''));
  const a = inv('inter'); const before = JSON.stringify(a);
  const r = await withBuyerState(a, ord({ raw: '12 Road, Xyz 110001', pincode: '110001', state: 'Xyz' }));
  ok(r.buyer.stateCode === '07' && /Delhi/.test(r.placeOfSupply), 'state from pincode');
  ok(JSON.stringify(a) === before, 'issued invoice not mutated');
  const b = await withBuyerState(inv('inter'), ord({ raw: 'x', pincode: '999999', state: 'Maharashtra' }));
  ok(b.buyer.stateCode === '27', 'state from edited address wins');
  const keep = { supplyType: 'inter', buyer: { stateCode: '09' } };
  ok((await withBuyerState(keep, ord({}))) === keep, 'already has a code: untouched');
  let e; try { await withBuyerState(inv('inter'), ord({ raw: 'x', pincode: '999999', state: 'Xyz' })); } catch (x) { e = x; }
  ok(e && /not recognised/.test(e.message) && e.status === 409, 'unresolvable: clear error');
  e = null; try { await withBuyerState(inv('inter'), ord({ raw: 'x', pincode: '122001', state: 'Xyz' })); } catch (x) { e = x; }
  ok(e && /Haryana/.test(e.message) && /CA/.test(e.message), 'Haryana buyer charged IGST: refused');
  e = null; try { await withBuyerState(inv('intra'), ord({ raw: 'x', pincode: '110001', state: 'Xyz' })); } catch (x) { e = x; }
  ok(e && /CGST/.test(e.message), 'non-Haryana charged CGST+SGST: refused');
  console.log(`zoho-state-retry-test: ${n} checks passed`);
})().catch((x) => { console.error('FAIL', x.message); process.exit(1); });
