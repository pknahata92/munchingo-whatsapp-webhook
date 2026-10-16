'use strict';
// Server Purchase carries the browser/device identifiers (fbp, fbc, IP, user agent) and a hashed external id.
const assert = require('assert');
const tr = require('../utils/serverTracking');
let n = 0; const ok = (c, m) => { assert(c, m); n++; };
const req = (ip, ua) => ({ ip, get: (h) => (h.toLowerCase() === 'user-agent' ? ua : undefined) });

// cleanTrack: valid values pass, junk is dropped
let t = tr.cleanTrack({ fbp: 'fb.1.1760000000000.123456789', fbc: 'fb.1.1760000000000.IwAR0abcDEF_123-xyz' }, req('203.0.113.7', 'Mozilla/5.0 (iPhone)'));
ok(t.fbp === 'fb.1.1760000000000.123456789' && t.fbc.startsWith('fb.1.') && t.ip === '203.0.113.7' && t.ua === 'Mozilla/5.0 (iPhone)', 'valid values kept');
t = tr.cleanTrack({ fbp: '<script>alert(1)</script>', fbc: 'x'.repeat(500) }, req('::ffff:198.51.100.2', 'UA'));
ok(!t.fbp && !t.fbc, 'bad fbp/fbc dropped'); ok(t.ip === '198.51.100.2', 'IPv4-mapped IPv6 cleaned');
t = tr.cleanTrack(undefined, req('', ''));
ok(Object.keys(t).length === 0, 'nothing to keep -> empty');
t = tr.cleanTrack({ fbp: 'fb.1.1760000000000.123456789' }, req('203.0.113.7', 'U'.repeat(1000)));
ok(t.ua.length === 300, 'user agent capped');

// buildMetaBody uses it
const base = { order_id: 'MNG-TEST-1710', total: 859, customer_name: 'Asha Rao', customer_email: 'a@x.com', customer_phone: '919876543210',
  items: [{ productName: 'Atta Original', quantity: 1, item_price: 259 }], created_at: new Date().toISOString(),
  delivery_address: { raw: '1 Road, Delhi, Delhi - 110001', city: 'Delhi', state: 'Delhi', pincode: '110001' } };
let ud = tr.buildMetaBody(base).data[0].user_data;
ok(!ud.fbp && !ud.client_ip_address && !ud.client_user_agent, 'old orders without device ids still build');
ok(Array.isArray(ud.external_id) && /^[0-9a-f]{64}$/.test(ud.external_id[0]), 'external_id is a sha256');
ud = tr.buildMetaBody({ ...base, delivery_address: { ...base.delivery_address, track: { fbp: 'fb.1.1760000000000.123456789', fbc: 'fb.1.1760000000000.IwAR0abcDEF_123-xyz', ip: '203.0.113.7', ua: 'Mozilla/5.0' } } }).data[0].user_data;
ok(ud.fbp && ud.fbc && ud.client_ip_address === '203.0.113.7' && ud.client_user_agent === 'Mozilla/5.0', 'device ids sent');
ok(ud.client_ip_address === '203.0.113.7' && !/^[0-9a-f]{64}$/.test(ud.client_ip_address), 'IP and user agent are NOT hashed (Meta requires raw)');
ok(/^[0-9a-f]{64}$/.test(ud.em[0]) && /^[0-9a-f]{64}$/.test(ud.ph[0]), 'email and phone still hashed');
console.log(`tracking-quality-test: ${n} checks passed`);
