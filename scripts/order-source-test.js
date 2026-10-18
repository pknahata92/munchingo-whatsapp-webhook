'use strict';
// Order source tag: what the buyer says ("How did you hear about us?") plus first-touch UTM and referrer.   node scripts/order-source-test.js
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const { cleanSource, labelSource, isNetwork } = require('../utils/orderSource');

// 1. A complete, valid tag is kept as sent (trimmed).
let s = cleanSource({ how: 'instagram', utm: { source: 'instagram', medium: 'social', campaign: 'launch' }, ref: 'https://www.instagram.com/munchingo.india/?x=1', landed: '/atta-original' });
ok(s.how === 'instagram', 'keeps a listed answer');
ok(s.utm && s.utm.source === 'instagram' && s.utm.medium === 'social' && s.utm.campaign === 'launch', 'keeps clean utm fields');
ok(s.ref === 'www.instagram.com', 'reduces the referrer to its host');
ok(s.landed === '/atta-original', 'keeps a clean landing path');

// 2. An answer that is not on the list is dropped, never stored as typed.
s = cleanSource({ how: 'my cousin Raju' });
ok(s.how === undefined, 'drops an unlisted answer');

// 3. Markup and junk in utm values are dropped (the value is shown in admin and email).
s = cleanSource({ utm: { source: '<script>alert(1)</script>', medium: 'social', campaign: 'a b' } });
ok(!s.utm || s.utm.source === undefined, 'drops a utm value containing markup');
ok(s.utm && s.utm.medium === 'social', 'keeps the clean utm sibling');

// 4. Over-long utm values are cut to 60 characters, not rejected.
s = cleanSource({ utm: { campaign: 'a'.repeat(100) } });
ok(s.utm && s.utm.campaign.length === 60, 'cuts a long utm value to 60');

// 5. Anything that is not an object gives an empty tag, and an order never fails because of it.
for (const bad of [undefined, null, 'instagram', 42, [], true]) ok(JSON.stringify(cleanSource(bad)) === '{}', 'non-object input gives {}: ' + JSON.stringify(bad));
ok(JSON.stringify(cleanSource({})) === '{}', 'empty object gives {}');

// 6. A bad referrer or landing path is dropped.
s = cleanSource({ ref: 'javascript:alert(1)', landed: 'http://evil.example/x' });
ok(s.ref === undefined, 'drops a non-http referrer');
ok(s.landed === undefined, 'drops a landing value that is not a site path');

// 7. Labels for the admin and the owner email.
ok(labelSource({ how: 'friend_family' }) === 'Friend or family', 'label for friend_family');
ok(labelSource({ how: 'instagram', utm: { source: 'instagram', medium: 'social' } }) === 'Instagram (utm instagram / social)', 'label with utm');
ok(labelSource({ utm: { source: 'newsletter' } }) === 'utm newsletter', 'label with only utm');
ok(labelSource({}) === '' && labelSource(undefined) === '', 'no tag, no label');

// 8. Network orders (people who know Prashant) are separated from strangers.
ok(isNetwork({ how: 'friend_family' }) === true, 'friend_family is network');
ok(isNetwork({ how: 'prashant' }) === true, 'prashant is network');
ok(isNetwork({ how: 'instagram' }) === false, 'instagram is not network');
ok(isNetwork({}) === false, 'unknown is not network');

// 9. The admin order card carries the label and the network flag (shapeOrder is pure).
const { shapeOrder } = require('../utils/adminActions');
const baseOrder = { order_id: 'MNG-T-1', status: 'paid', payment_id: 'pay_1', customer_name: 'Asha', customer_phone: '919999900001', total: 700, items: [], created_at: '2026-10-19T10:00:00Z', updated_at: '2026-10-19T10:05:00Z' };
let card = shapeOrder({ ...baseOrder, delivery_address: { raw: '1 Road', source: { how: 'friend_family', utm: { source: 'whatsapp' } } } }, null, []);
ok(card.source === 'Friend or family (utm whatsapp)', 'admin card shows the source label');
ok(card.source_network === true, 'admin card flags a network order');
card = shapeOrder({ ...baseOrder, delivery_address: { raw: '1 Road' } }, null, []);
ok(card.source === '' && card.source_network === false, 'admin card with no source is empty, not an error');

// 10. The owner email shows a Source row only when there is a tag.
const { ownerPaidHtml } = require('../utils/emailTemplates');
const withSrc = ownerPaidHtml({ order: { ...baseOrder, delivery_address: { raw: '1 Road', source: { how: 'instagram' } } }, invoice: null });
const noSrc = ownerPaidHtml({ order: { ...baseOrder, delivery_address: { raw: '1 Road' } }, invoice: null });
ok(/Source/.test(withSrc) && /Instagram/.test(withSrc), 'owner email shows the Source row');
ok(!/>Source</.test(noSrc), 'owner email has no Source row without a tag');
const evil = ownerPaidHtml({ order: { ...baseOrder, delivery_address: { raw: '1 Road', source: { how: 'instagram', utm: { source: '<b>x</b>' } } } }, invoice: null });
ok(!/<b>x<\/b>/.test(evil), 'owner email never prints raw markup from a utm value');

// 11. attachSource: what the checkout route calls to put the tag on the order's address data.
const { attachSource } = require('../utils/orderSource');
let parts = { state: 'Haryana', city: 'Faridabad', pincode: '121007' };
attachSource(parts, { how: 'google', utm: { source: 'google' } });
ok(parts.source && parts.source.how === 'google' && parts.source.utm.source === 'google', 'attachSource adds a clean tag');
ok(parts.state === 'Haryana' && parts.pincode === '121007', 'attachSource leaves the other address parts alone');
parts = { state: 'Haryana' };
attachSource(parts, { how: 'not on the list', utm: { source: '<x>' } });
ok(!('source' in parts), 'attachSource adds nothing when nothing is valid');
parts = {};
attachSource(parts, undefined);
ok(JSON.stringify(parts) === '{}', 'attachSource with no input leaves parts untouched');
ok(attachSource({ a: 1 }, { how: 'other' }).source.how === 'other', 'attachSource returns the parts object');

console.log(`order-source: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
