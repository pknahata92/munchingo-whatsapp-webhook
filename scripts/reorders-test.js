'use strict';
// J6 reorder reminder (growth journey, 16 Nov 2026): a consented NCR buyer gets one marketing nudge when their box is probably
// running low (2 boxes or fewer: day 21; 3-4: day 28; 5 or more: day 35), with a pre-filled cart and a picture header. Stall and
// fair contacts get it 21 days after their stall day. Every skip in the brief has its own test; Review Focus 5 is pinned at the end.
//   node scripts/reorders-test.js
const fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const show = (x) => JSON.stringify(x);
const eq = (a, b, m) => ok(show(a) === show(b), `${m} (got ${show(a)}, want ${show(b)})`);

const r = require('../utils/reorders');

const DAY = 86_400_000, HOUR = 3_600_000;
const NOW = Date.parse('2026-11-16T10:30:00Z');   // 16:00 IST, 16 Nov (the pg_cron time)
const iso = (ms) => new Date(ms).toISOString();
const ASHA = '919810000001', RAVI = '919810000002', OID = 'MNG-AAAA-1111';
const ALL = new Set(['atta-original', 'atta-kesari', 'atta-ajwain', 'atta-lite-sugar']);
const UTM = 'utm_source=whatsapp&utm_medium=journey&utm_campaign=j6_reorder';
const IMG = (slug) => 'https://munchingo.com/media/' + (slug ? `reorder-${slug}.jpg` : 'reorder-all.jpg');
const TRY_WORDS = (n, b, f) => `Hi ${n}, Prashant from Munchingo. Your ${b} boxes are probably running low by now. Same as last time, with one ${f} to try? It's ready below. Reply STOP to stop these.`;
const SAME_WORDS = (n, b) => `Hi ${n}, Prashant from Munchingo. Your ${b} boxes are probably running low by now. Same as last time? It's ready below. Reply STOP to stop these.`;

const order = (over = {}) => ({
  order_id: OID, customer_phone: ASHA, customer_name: 'Asha Rao', status: 'paid', coupon_code: null,
  created_at: iso(NOW - 25 * DAY), delivered_at: iso(NOW - 21 * DAY),
  items: [{ slug: 'atta-original', name: 'Atta Original', quantity: 2 }],
  delivery_address: { raw: 'B-2, Model Town, Delhi, Delhi - 110009', pincode: '110009' },
  ...over,
});
const contact = (over = {}) => ({ phone: ASHA, name: 'Asha', first_source: 'checkout:2026-10-20', last_source: 'checkout:2026-10-20', consent_marketing: true, consent_reminder: true, last_inbound_at: null, last_complaint_at: null, ...over });
const ravi = (over = {}) => ({ phone: RAVI, name: 'Ravi Kumar', first_source: 'stall:2026-11-01', last_source: 'stall:2026-11-01', consent_marketing: true, consent_reminder: true, last_inbound_at: null, last_complaint_at: null, ...over });
const input = (over = {}) => ({ orders: [order()], contacts: [contact()], sends: [], eventsByOrder: {}, subscriptionPhones: [], stallOrders: [], inStock: ALL, nowMs: NOW, ...over });
const due = (over) => r.dueReorders(input(over));
const plan = (over) => r.planReorders(input(over));
const sentRow = (over = {}) => ({ phone: ASHA, template: 'munchingo_reorder_try', campaign: 'j6:' + OID, status: 'sent', error: null, sent_at: iso(NOW - 2 * DAY), ...over });

// ── 1. who is due, and with what ──
let d = due();
eq(d.length, 1, 'a 2-box NCR order delivered 21 days ago, reminder consent: due');
eq(d[0] && d[0].template, 'munchingo_reorder_try', 'with an untried Flavor in stock: the try template');
eq(d[0] && d[0].params, ['Asha', '2', 'Atta Kesari'], 'params: first name, boxes, the try Flavor\'s display name');
eq(d[0] && d[0].campaign, 'j6:MNG-AAAA-1111', 'campaign j6:<order id>');
eq(d[0] && d[0].orderId, OID, 'orderId is the order');
eq(d[0] && d[0].claimId, OID, 'a web order is claimed by its order id');
eq(d[0] && d[0].phone, ASHA, 'sent to the consented number');
eq(d[0] && d[0].first, 'Asha', 'first name from the order');
eq(d[0] && d[0].boxes, 2, 'boxes in that order');
eq(d[0] && d[0].urlSuffix, 'cart?add=atta-original:2,atta-kesari&' + UTM, 'urlSuffix: two of the favourite plus the try, j6_reorder utm');
eq(d[0] && d[0].header, { type: 'image', link: IMG('atta-original') }, 'image header: the favourite\'s reorder picture');

eq(due({ orders: [order({ delivered_at: iso(NOW - 20 * DAY) })] }).length, 0, 'the same order at day 20: not due');
eq(due({ orders: [order({ delivered_at: iso(NOW - 21 * DAY + 2 * HOUR) })] }).length, 1, 'delivered at 18:00 IST 21 days back: due at 16:00 (IST calendar days, not hours)');
const four = [{ slug: 'atta-original', quantity: 2 }, { slug: 'atta-kesari', quantity: 2 }];
d = due({ orders: [order({ items: four, delivered_at: iso(NOW - 28 * DAY) })] });
eq(d.length, 1, 'a 4-box order is due at day 28');
eq(d[0] && d[0].params, ['Asha', '4', 'Atta Ajwain'], 'a 4-box order: boxes 4, the first untried Flavor');
eq(due({ orders: [order({ items: four, delivered_at: iso(NOW - 27 * DAY) })] }).length, 0, 'a 4-box order at day 27: not due');
eq(due({ orders: [order({ items: [{ slug: 'atta-original', quantity: 3 }], delivered_at: iso(NOW - 28 * DAY) })] }).length, 1, 'a 3-box order is mid: due at day 28');
const five = [{ slug: 'full-range-set', quantity: 1 }, { slug: 'atta-kesari', quantity: 1 }];
eq(due({ orders: [order({ items: five, delivered_at: iso(NOW - 34 * DAY) })] }).length, 0, 'a 5-box order at day 34: not due');
eq(due({ orders: [order({ items: five, delivered_at: iso(NOW - 35 * DAY) })] }).length, 1, 'a 5-box order is due at day 35');
eq(r.REORDER_DAYS, { small: 21, mid: 28, large: 35 }, 'REORDER_DAYS');
eq(due({ orders: [order({ delivered_at: iso(NOW - 51 * DAY) })] }).length, 1, '30 days overdue: still due');
eq(due({ orders: [order({ delivered_at: iso(NOW - 52 * DAY) })] }).length, 0, 'more than 30 days overdue: not sent');

// The newest delivered order decides.
d = due({ orders: [order({ order_id: 'MNG-OLD1-0101', created_at: iso(NOW - 60 * DAY), delivered_at: iso(NOW - 56 * DAY) }), order()] });
eq(d.map((x) => x.campaign), ['j6:MNG-AAAA-1111'], 'two delivered orders: only the newest, once');

// The template without a try.
const everything = [{ slug: 'atta-original', quantity: 2 }, { slug: 'atta-kesari', quantity: 1 }, { slug: 'atta-ajwain', quantity: 1 }, { slug: 'atta-lite-sugar', quantity: 1 }];
d = due({ orders: [order({ items: everything, delivered_at: iso(NOW - 35 * DAY) })] });
eq(d[0] && d[0].template, 'munchingo_reorder_same', 'every Flavor tried: the same template');
eq(d[0] && d[0].params, ['Asha', '5'], 'same template params: first name, boxes');
eq(d[0] && d[0].urlSuffix, 'cart?add=atta-original:2,atta-kesari:1,atta-ajwain:1,atta-lite-sugar:1&' + UTM, 'and the last order again as the cart');
d = due({ orders: [order({ items: [{ slug: 'full-range-set', quantity: 1 }], delivered_at: iso(NOW - 28 * DAY) })] });
eq(d[0] && d[0].template, 'munchingo_reorder_same', 'a Set last time: the same template (no try)');
eq(d[0] && d[0].urlSuffix, 'build-a-box?' + UTM, 'a Set last time: the Build a box link (R20)');
eq(d[0] && d[0].params, ['Asha', '4'], 'a Full Range Set counts 4 boxes');
d = due({ orders: [order({ customer_name: '~' })], contacts: [contact({ name: 'mr. asha' })] });
eq(d[0] && d[0].first, 'Asha', 'an unusable order name falls back to the contact\'s name');
d = due({ orders: [order({ customer_name: '' })], contacts: [contact({ name: '' })] });
eq(d[0] && d[0].params[0], 'there', 'no usable name at all: "there"');
d = due({ orders: [order({ customer_phone: '9810000001' })], contacts: [contact({ phone: '+91 98100 00001' })] });
eq(d.length === 1 && d[0].phone, ASHA, 'phones match on the last 10 digits, sent as 91 + 10 digits');
eq(due({ orders: [order({ order_id: 'MNG-TEST-0001' })] }).length, 0, 'test orders are never reminded');
eq(due({ orders: [order({ delivered_at: null })] }).length, 0, 'not delivered yet: nothing');
let p = plan({ orders: [order({ items: [{ slug: 'atta-original', quantity: 1 }] })] });
eq([p.due.length, p.skipped.too_small], [0, 1], 'skip: a 1-box order (never "Your 1 boxes"), reason too_small');
p = plan({ orders: [order({ items: [{ slug: 'atta-original', quantity: 1 }, { slug: 'shipping', quantity: 1 }] })] });
eq([p.due.length, p.skipped.too_small], [0, 1], 'the shipping line is not a box: still too_small');
p = plan({ orders: [order({ items: [{ slug: 'full-range-set', quantity: 1 }], delivered_at: iso(NOW - 28 * DAY) })], inStock: new Set() });
eq([p.due.length, p.skipped.sold_out], [0, 1], 'R25: a Set whose Flavors are all sold out: held (sold_out)');

// ── 2. the skips, one line each ──
eq(due({ contacts: [contact({ consent_reminder: false })] }).length, 0, 'skip: consent does not cover reminders (consent_reminder false)');
eq(due({ contacts: [] }).length, 0, 'skip: no contact at all');
eq(due({ contacts: [contact({ consent_marketing: false })] }).length, 0, 'skip: STOP (consent_marketing false)');
eq(due({ orders: [order(), order({ order_id: 'MNG-NEW1-1511', created_at: iso(NOW - 1 * DAY), delivered_at: null })] }).length, 0, 'skip: ordered again after that delivery (on its way)');
eq(due({ orders: [order(), order({ order_id: 'MNG-NEW1-0811', created_at: iso(NOW - 20 * DAY), delivered_at: iso(NOW - 17 * DAY) })] }).length, 0, 'skip: ordered again and delivered (the new one is not due yet)');
eq(due({ orders: [order(), order({ order_id: 'MNG-MID1-2310', created_at: iso(NOW - 24 * DAY), delivered_at: null })] }).length, 0, 'skip: a newer order placed before that delivery is still on its way');
eq(due({ subscriptionPhones: ['+91 98100 00001'] }).length, 0, 'skip: active subscriber');
eq(due({ orders: [order({ delivery_address: { raw: 'B-2, Model Town, Delhi - 110009', pincode: '110009', recipientName: 'Meera', recipientPhone: '919811111111' } })] }).length, 0, 'skip: gift order (recipientPhone set)');
eq(due({ orders: [order({ delivery_address: { raw: 'C-4, Malviya Nagar, Jaipur - 302001', pincode: '302001' } })] }).length, 0, 'skip: pincode 302001 (outside the delivery area)');
eq(due({ orders: [order({ delivery_address: { raw: 'C-4, Malviya Nagar, Jaipur, Rajasthan - 302001' } })] }).length, 0, 'skip: no pincode field, 302001 read from the address');
eq(due({ orders: [order({ delivery_address: { raw: 'B-2, Model Town, Delhi - 110009' } })] }).length, 1, 'no pincode field, 110009 read from the address: due');
eq(due({ orders: [order({ delivery_address: {} })] }).length, 0, 'skip: no address at all (not a known NCR address)');
eq(due({ contacts: [contact({ last_complaint_at: iso(NOW - 10 * DAY) })] }).length, 0, 'skip: last_complaint_at 10 days ago');
eq(due({ contacts: [contact({ last_complaint_at: iso(NOW - 31 * DAY) })] }).length, 1, 'a complaint 31 days ago no longer blocks');
eq(due({ orders: [order({ coupon_code: 'MUNCH-5M7W' })] }).length, 0, 'skip: MUNCH-5M7W coupon (the 15% card)');
eq(due({ orders: [order({ coupon_code: 'FOUNDING10' })] }).length, 1, 'another coupon does not skip');
const recent = (n) => Array.from({ length: n }, (_, i) => sentRow({ template: 'munchingo_fresh_batch', campaign: 'batch_2611' + i, sent_at: iso(NOW - (i + 1) * DAY) }));
eq(due({ sends: recent(3) }).length, 0, 'skip: slotFor over_cap (3 marketing sends in 30 days)');
eq(due({ sends: recent(2) }).length, 1, 'two sends in 30 days: one slot left, due');
eq(due({ sends: [sentRow({ template: 'munchingo_fresh_batch', campaign: 'batch_261110', status: 'failed', error: '131049 healthy ecosystem', sent_at: iso(NOW - 10 * HOUR) })] }).length, 0, 'skip: slotFor cooling_off (131049 in the last 48 h)');
eq(due({ sends: [sentRow()] }).length, 0, 'skip: slotFor already_sent (same template, same campaign)');
eq(due({ sends: [sentRow({ template: 'munchingo_reorder_same' })] }).length, 0, 'skip: already sent for this order with the OTHER J6 template (stock changed between runs)');
eq(due({ sends: [sentRow({ template: 'freeform_j6' })] }).length, 0, 'skip: already sent for this order in the open window (freeform_j6)');
eq(due({ sends: [sentRow({ campaign: 'j6:MNG-OLD1-0101' })] }).length, 1, 'a J6 for an older order does not block this one');
const f131 = (h) => sentRow({ status: 'failed', error: '131049 healthy ecosystem', sent_at: iso(NOW - h * HOUR) });
eq(due({ sends: [f131(100), f131(80)] }).length, 0, 'skip: slotFor blocked_twice (two 131049 failures for this campaign)');
eq(due({ sends: [sentRow({ status: 'failed', error: '132001 template', sent_at: iso(NOW - 4 * DAY) }), sentRow({ template: 'munchingo_reorder_same', status: 'failed', error: '131026 x', sent_at: iso(NOW - 3 * DAY) })] }).length, 0, 'any two failed J6 tries for one campaign: no third');
const claimed = { [OID]: [{ order_id: OID, event: 'reorder_reminder', created_at: iso(NOW - 3 * DAY) }] };
eq(due({ eventsByOrder: claimed }).length, 0, 'already claimed for this order and nothing failed: not again');
d = due({ eventsByOrder: claimed, sends: [f131(72)] });
eq(d.length === 1 && d[0].retry, true, 'claimed, then a 131049 failure 72 h ago: one retry (retry flag set)');
eq(due({ eventsByOrder: claimed, sends: [f131(20)] }).length, 0, 'the retry waits 48 h after a 131049');
eq(due({ eventsByOrder: { [OID]: [...claimed[OID], { order_id: OID, event: 'reorder_reminder_retry', created_at: iso(NOW - DAY) }] }, sends: [f131(100)] }).length, 0, 'the retry is spent: never a third');
eq(due().length && due()[0].retry, false, 'a first send is not a retry');
eq(due({ orders: [order({ known_to_us: true, delivery_address: { raw: 'x - 110009', pincode: '110009', source: 'network' } })] }).length, 1, 'network orders are NOT skipped (controller, 15 Nov)');

// ── 3. stall and fair contacts ──
const STALL_DAY = Date.parse('2026-11-22T10:30:00Z');   // 16:00 IST, 22 Nov
d = due({ orders: [], contacts: [ravi()], nowMs: STALL_DAY });
eq(d.length, 1, 'stall:2026-11-01 with reminder consent: due on 22 Nov');
eq(d[0] && d[0].template, 'munchingo_reorder_same', 'stall: the same template');
eq(d[0] && d[0].params, ['Ravi', 'Munchingo'], 'stall params: first name, "Munchingo"');
eq(d[0] && d[0].campaign, 'j6:stall:2026-11-01', 'stall campaign j6:stall:<day>');
eq(d[0] && d[0].orderId, null, 'stall: no order id');
eq(d[0] && d[0].header, { type: 'image', link: IMG(null) }, 'stall: the all-Flavors picture');
eq(d[0] && d[0].urlSuffix, 'shop?' + UTM, 'stall without recorded lines: the shop link');
eq(d[0] && d[0].claimId, 'j6:stall:2026-11-01:9810000002', 'stall: claimed as j6:stall:<day>:<last 10 digits>');
eq(due({ orders: [], contacts: [ravi()], nowMs: STALL_DAY - DAY }).length, 0, 'stall contact on 21 Nov: not due');
eq(due({ orders: [], contacts: [ravi()], nowMs: STALL_DAY + 30 * DAY }).length, 1, 'stall: 30 days overdue still due');
eq(due({ orders: [], contacts: [ravi()], nowMs: STALL_DAY + 31 * DAY }).length, 0, 'stall: more than 30 days overdue: not sent');
p = plan({ orders: [], contacts: [ravi({ first_source: 'fair:2026-11-01', last_source: 'fair:2026-11-01' })], nowMs: STALL_DAY });
eq([p.due.length, p.skipped.no_purchase], [0, 1], 'R27: fair:<day> with no stall sale linked to the phone: skipped (no_purchase)');
eq(due({ orders: [], contacts: [ravi({ consent_reminder: false })], nowMs: STALL_DAY }).length, 0, 'stall skip: consent does not cover reminders');
eq(due({ orders: [], contacts: [ravi({ first_source: 'join:2026-11-01', last_source: 'join:2026-11-01' })], nowMs: STALL_DAY }).length, 0, 'a JOIN contact with no order is not a stall buyer');
const line = (mix, hamper = false) => ({ item: Object.keys(mix)[0], name: 'x', price: 200, hamper, mix });
const sale = (lines, day = '2026-11-01') => ({ contact_phone: RAVI, day, sold_at: day + 'T09:30:00Z', lines });
d = due({ orders: [], contacts: [ravi({ first_source: 'fair:2026-11-01', last_source: 'fair:2026-11-01' })], stallOrders: [sale([line({ kesari: 2 })])], nowMs: STALL_DAY });
eq(d.map((x) => [x.campaign, x.urlSuffix]), [['j6:stall:2026-11-01', 'cart?add=atta-kesari:2&' + UTM]], 'R27: fair:<day> with a stall sale linked: due, cart from the sale');
p = plan({ orders: [order({ customer_phone: RAVI, order_id: 'MNG-RAVI-2410', created_at: iso(STALL_DAY - 32 * DAY), delivered_at: iso(STALL_DAY - 28 * DAY) })], contacts: [ravi({ first_source: 'checkout:2026-10-20', last_source: 'fair:2026-11-01' })], nowMs: STALL_DAY });
eq(p.due.map((x) => x.campaign), ['j6:MNG-RAVI-2410'], 'R27: a FAIR scan without a purchase does not count as ordering again (the web nudge goes)');
d = due({ orders: [], contacts: [ravi()], stallOrders: [sale([line({ kesari: 2 }), line({ lite: 1 })])], nowMs: STALL_DAY });
eq(d[0] && d[0].urlSuffix, 'cart?add=atta-kesari:2,atta-lite-sugar:1&' + UTM, 'stall lines on record: their Flavors as the cart');
d = due({ orders: [], contacts: [ravi()], stallOrders: [sale([line({ kesari: 2 }), line({ lite: 1 })])], inStock: new Set(['atta-lite-sugar', 'atta-original']), nowMs: STALL_DAY });
eq(d[0] && d[0].urlSuffix, 'cart?add=atta-lite-sugar:2&' + UTM, 'stall: a sold-out Flavor is left out, and the 1-box cart is topped up to 2 of the in-stock favourite');
d = due({ orders: [], contacts: [ravi()], stallOrders: [sale([line({ original: 1 })])], nowMs: STALL_DAY });
eq(d[0] && d[0].urlSuffix, 'cart?add=atta-original:2&' + UTM, 'stall: a 1-box sale is topped up to 2 boxes');
d = due({ orders: [], contacts: [ravi()], stallOrders: [sale([line({ original: 1 }), line({ kesari: 1 })])], nowMs: STALL_DAY });
eq(d[0] && d[0].urlSuffix, 'cart?add=atta-original:1,atta-kesari:1&' + UTM, 'stall: 2 boxes already: no top-up');
d = due({ orders: [], contacts: [ravi()], stallOrders: [sale([line({ kesari: 1 }), line({ lite: 2 })])], inStock: new Set(['atta-kesari', 'atta-original']), nowMs: STALL_DAY });
eq(d[0] && d[0].urlSuffix, 'cart?add=atta-kesari:2&' + UTM, 'stall: the favourite that is topped up is the in-stock one');
p = plan({ orders: [], contacts: [ravi()], stallOrders: [sale([line({ kesari: 2 }), line({ lite: 1 })])], inStock: new Set(['atta-original', 'atta-ajwain']), nowMs: STALL_DAY });
eq([p.due.length, p.skipped.sold_out], [0, 1], 'R25: no Flavor from the stall sale in stock: held (sold_out), not the shop link');
p = plan({ orders: [], contacts: [ravi()], stallOrders: [sale([line({ original: 1, kesari: 1, ajwain: 1 }, true)])], inStock: new Set(['atta-lite-sugar']), nowMs: STALL_DAY });
eq([p.due.length, p.skipped.sold_out], [0, 1], 'R25: a hamper whose Flavors are all sold out: held');
d = due({ orders: [], contacts: [ravi()], stallOrders: [sale([line({ original: 1, kesari: 1, ajwain: 1 }, true)])], inStock: new Set(['atta-ajwain']), nowMs: STALL_DAY });
eq(d[0] && d[0].urlSuffix, 'build-a-box?' + UTM, 'a hamper with one of its Flavors in stock: Build a box');
d = due({ orders: [], contacts: [ravi()], stallOrders: [sale([line({ original: 1, kesari: 1, ajwain: 1 }, true)])], nowMs: STALL_DAY });
eq(d[0] && d[0].urlSuffix, 'build-a-box?' + UTM, 'stall hamper: Build a box, never the hamper as singles');
p = plan({ orders: [], contacts: [ravi()], stallOrders: [sale([line({ kesari: 2 })])], inStock: new Set(), nowMs: STALL_DAY });
eq([p.due.length, p.skipped.sold_out], [0, 1], 'R25: stall, nothing in stock: held (sold_out)');
p = plan({ orders: [], contacts: [ravi()], inStock: new Set(), nowMs: STALL_DAY });
eq([p.due.length, p.skipped.sold_out], [0, 1], 'R25: stall with no lines and nothing in stock at all: held, not the shop link');
d = due({ orders: [], contacts: [ravi()], stallOrders: [sale([line({ kesari: 2 })], '2026-10-20')], nowMs: STALL_DAY });
eq(d[0] && d[0].urlSuffix, 'shop?' + UTM, 'stall lines from another day are not used');
const webRavi = (over) => order({ order_id: 'MNG-RAVI-0511', customer_phone: RAVI, customer_name: 'Ravi Kumar', ...over });
d = due({ orders: [webRavi({ created_at: iso(STALL_DAY - 3 * DAY), delivered_at: null })], contacts: [ravi()], nowMs: STALL_DAY });
eq(d.length, 0, 'stall skip: ordered on the web after the stall day');
d = due({ orders: [webRavi({ created_at: iso(STALL_DAY - 32 * DAY), delivered_at: iso(STALL_DAY - 28 * DAY) })], contacts: [ravi()], nowMs: STALL_DAY });
eq(d.map((x) => x.campaign), ['j6:stall:2026-11-01'], 'a web order delivered BEFORE the stall day: the stall nudge only (one per phone)');
d = due({ orders: [webRavi({ created_at: iso(STALL_DAY - 25 * DAY), delivered_at: iso(STALL_DAY - 21 * DAY) })], contacts: [ravi({ first_source: 'stall:2026-10-20', last_source: 'stall:2026-10-20' })], nowMs: STALL_DAY });
eq(d.map((x) => x.campaign), ['j6:MNG-RAVI-0511'], 'a web order delivered AFTER the stall day: the web nudge only');
eq(due({ orders: [], contacts: [ravi(), ravi({ phone: '9810000002' })], nowMs: STALL_DAY }).length, 1, 'the same number stored twice (two formats): one nudge');
eq(due({ orders: [], contacts: [ravi()], subscriptionPhones: [RAVI], nowMs: STALL_DAY }).length, 0, 'stall skip: active subscriber');
eq(due({ orders: [], contacts: [ravi({ last_complaint_at: iso(STALL_DAY - 10 * DAY) })], nowMs: STALL_DAY }).length, 0, 'stall skip: complaint in the last 30 days');
eq(due({ orders: [], contacts: [ravi()], sends: [sentRow({ phone: RAVI, template: 'munchingo_reorder_same', campaign: 'j6:stall:2026-11-01' })], nowMs: STALL_DAY }).length, 0, 'stall skip: already sent for that stall day');
const SCLAIM = 'j6:stall:2026-11-01:9810000002';
eq(due({ orders: [], contacts: [ravi()], eventsByOrder: { [SCLAIM]: [{ order_id: SCLAIM, event: 'reorder_reminder' }] }, nowMs: STALL_DAY }).length, 0, 'stall: claimed and no failure on record (say the log write failed): not again');
d = due({ orders: [], contacts: [ravi()], eventsByOrder: { [SCLAIM]: [{ order_id: SCLAIM, event: 'reorder_reminder' }] }, sends: [sentRow({ phone: RAVI, template: 'munchingo_reorder_same', campaign: 'j6:stall:2026-11-01', status: 'failed', error: '131049 x', sent_at: iso(STALL_DAY - 3 * DAY) })], nowMs: STALL_DAY });
eq(d.length === 1 && d[0].retry, true, 'stall: claimed, then refused 72 h ago: one retry');

// pure: the inputs are not changed
const pureIn = input({ contacts: [contact(), ravi()], stallOrders: [sale([line({ kesari: 2 })])], nowMs: STALL_DAY });
const before = show(pureIn);
r.dueReorders(pureIn);
eq(show(pureIn), before, 'dueReorders does not change its inputs');

// ── 4. the sweep (setDeps fakes) ──
let seq = 0;
function world({ orders = [order()], contacts = [contact()], sends = [], subs = [], stall = [], inStock = ALL, now = NOW } = {}) {
  const w = { t: now, sent: [], logged: [], claims: [], events: [], days: new Set(), released: [], sends: sends.slice(), failWith: null, reads: 0 };
  const db = {
    getPaidOrdersUpdatedSince: async () => { w.reads++; if (w.dbDown) throw new Error('db down'); return w.orders || orders; },
    listMarketingContacts: async () => contacts.filter((c) => c.consent_marketing === true),
    listMarketingSends: async () => w.sends.map((s) => ({ ...s })),
    listActiveSubscriptionPhones: async () => subs,
    listStallOrdersWithPhone: async () => stall,
    listOrderEventsByName: async (name, ids) => w.events.filter((e) => e.event === name && ids.includes(e.order_id)).map((e) => ({ ...e })),
    // Like Postgres with the unique index: one reorder_reminder (and one reorder_reminder_retry) per order.
    claimOrderEvent: async (ev) => { w.claims.push(ev); if (w.events.some((e) => e.order_id === ev.order_id && e.event === ev.event)) return false; w.events.push({ ...ev, created_at: iso(w.t) }); return true; },
    insertMarketingSend: async (row) => { if (w.logDown) throw new Error('log down'); w.logged.push(row); w.sends.push({ ...row, sent_at: iso(w.t) }); },
    claimDigestDay: async (day) => { if (w.days.has(day)) return false; w.days.add(day); return true; },
    releaseDigestDay: async (day) => { w.released.push(day); w.days.delete(day); },
  };
  const id = () => 'wamid.R' + (++seq);
  const wa = {
    sendMarketingTemplate: async (to, name, lang, params, opts) => { if (w.failWith) throw w.failWith; const m = id(); w.sent.push({ kind: 'template', to, name, lang, params, opts, id: m }); return { messages: [{ id: m }] }; },
    sendImage: async (to, link, caption) => { if (w.failWith) throw w.failWith; const m = id(); w.sent.push({ kind: 'image', to, link, caption, id: m }); return { messages: [{ id: m }] }; },
    sendText: async (to, text) => { w.sent.push({ kind: 'text', to, text }); return { messages: [{ id: id() }] }; },
  };
  r.setDeps({ db, wa, now: () => w.t, inStock: async () => w.stock || inStock, lang: async () => 'en' });
  return w;
}
const metaErr = (code, message) => Object.assign(new Error('Request failed'), { response: { data: { error: { code, message } } } });

(async () => {
  const prevFlag = process.env.JOURNEY_J6_ENABLED, prevSecret = process.env.DIGEST_SECRET;
  delete process.env.DIGEST_SECRET;

  // loadInput (growth A7): what the sweep plans from, shared with the J7 batch alert (J6 wins the last slot over it)
  {
    const w0 = world();
    const inp = typeof r.loadInput === 'function' ? await r.loadInput(NOW) : {};
    eq(Object.keys(inp).sort(), ['contacts', 'eventsByOrder', 'inStock', 'nowMs', 'orders', 'sends', 'stallOrders', 'subscriptionPhones'], 'loadInput: everything planReorders reads');
    eq(inp.nowMs ? r.dueReorders(inp).map((x) => x.campaign) : [], ['j6:' + OID], 'loadInput feeds dueReorders: the one due order');
    eq(w0.sent.length + w0.claims.length + w0.logged.length, 0, 'loadInput only reads');
    world({ orders: Array.from({ length: 1000 }, (_, i) => order({ order_id: 'MNG-P-' + i })) });
    const full = typeof r.loadInput === 'function' ? await r.loadInput(NOW) : {};
    ok(/^1000 paid orders in 120 days fill one page/.test(full.blocked || ''), 'loadInput: a full page of orders is { blocked } (got ' + show(Object.keys(full)) + ')');
    process.env.JOURNEY_J6_ENABLED = '1';
    ok(typeof r.enabled === 'function' && r.enabled() === true, 'enabled() is exported and reads JOURNEY_J6_ENABLED');
    delete process.env.JOURNEY_J6_ENABLED;
    ok(typeof r.enabled === 'function' && r.enabled() === false, 'enabled() is false when the flag is unset');
  }

  // flag off
  delete process.env.JOURNEY_J6_ENABLED;
  let w = world();
  eq(await r.sweepReorders(), { disabled: true }, 'JOURNEY_J6_ENABLED unset: { disabled: true }');
  eq(w.sent.length + w.reads + w.claims.length, 0, 'flag off: nothing read, claimed or sent');
  process.env.JOURNEY_J6_ENABLED = '0';
  eq(await r.sweepReorders(), { disabled: true }, 'JOURNEY_J6_ENABLED=0: disabled');
  process.env.JOURNEY_J6_ENABLED = '1';

  // Review Focus 5: quiet hours
  w = world({ now: Date.parse('2026-11-16T16:00:00Z') });   // 21:30 IST
  eq(await r.sweepReorders(), { quiet: true }, 'RF5: at 21:30 IST the sweep returns { quiet: true }');
  eq(w.sent.length + w.claims.length + w.logged.length, 0, 'RF5: quiet hours: nothing claimed, sent or logged');
  w = world({ now: Date.parse('2026-11-16T03:00:00Z') });   // 08:30 IST
  eq(await r.sweepReorders(), { quiet: true }, 'quiet until 09:00 IST');

  // one template send, exactly
  w = world();
  let res = await r.sweepReorders();
  eq({ checked: res.checked, sent: res.sent, skipped: res.skipped, failed: res.failed }, { checked: 1, sent: 1, skipped: 0, failed: 0 }, 'one due order: { checked, sent, skipped, failed }');
  eq(w.claims.map((c) => [c.order_id, c.event]), [[OID, 'reorder_reminder']], 'the order is claimed (reorder_reminder) before sending');
  const t0 = w.sent[0] || {};
  eq([t0.kind, t0.to, t0.name, t0.lang, t0.params], ['template', ASHA, 'munchingo_reorder_try', 'en', ['Asha', '2', 'Atta Kesari']], 'the try template to Asha with her params');
  eq(t0.opts, { urlSuffix: 'cart?add=atta-original:2,atta-kesari&' + UTM, urlIndex: 0, header: { type: 'image', link: IMG('atta-original') } }, 'URL button 0 with the cart, the image header, no quick replies');
  eq(w.logged, [{ phone: ASHA, template: 'munchingo_reorder_try', status: 'sent', error: null, wa_message_id: t0.id, campaign: 'j6:' + OID }], 'logged in marketing_sends with the wamid and campaign');

  // Review Focus 5: two runs on the same day send once
  res = await r.sweepReorders();
  eq([w.sent.length, res.sent], [1, 0], 'RF5: a second run the same day sends nothing');
  w = world();
  const [a, b] = await Promise.all([r.sweepReorders(), r.sweepReorders()]);
  eq(w.sent.length, 1, 'RF5: two overlapping runs send once');
  eq(w.claims.length, 2, 'RF5: both runs tried to claim the order');
  eq([a.sent + b.sent, a.skipped + b.skipped], [1, 1], 'RF5: the second claim returned false and counts as skipped');

  // Review Focus 5: a sold-out favourite is never in the cart
  w = world({ orders: [order({ items: [{ slug: 'atta-original', quantity: 3 }, { slug: 'atta-kesari', quantity: 1 }], delivered_at: iso(NOW - 28 * DAY) })], inStock: new Set(['atta-kesari', 'atta-ajwain', 'atta-lite-sugar']) });
  await r.sweepReorders();
  const so = (w.sent[0] || {}).opts || {};
  ok(!/atta-original/.test(so.urlSuffix || 'atta-original'), 'RF5: the sold-out favourite (Original) is not in the cart: ' + so.urlSuffix);
  eq(so.urlSuffix, 'cart?add=atta-kesari:2,atta-ajwain&' + UTM, 'RF5: the next Flavor from that order stands in, plus the try');
  eq(so.header, { type: 'image', link: IMG('atta-kesari') }, 'RF5: and the picture follows the stand-in');
  p = plan({ inStock: new Set(['atta-kesari']) });
  eq([p.due.length, p.skipped.sold_out], [0, 1], 'R25: nothing from the last order in stock: held (sold_out), never "Same as last time" over another Flavor');
  w = world({ inStock: new Set(['atta-kesari']) });
  res = await r.sweepReorders();
  eq([w.sent.length, w.claims.length, res.reasons.sold_out], [0, 0, 1], 'R25: a held reminder is not claimed or sent');
  w.stock = ALL; w.t = NOW + DAY;
  await r.sweepReorders();
  eq([w.sent.length, (w.sent[0] || {}).name], [1, 'munchingo_reorder_try'], 'R25: checked again the next day: back in stock, it goes');

  // the window is open (they wrote in the last 23 h): free-form picture with the words and the link
  w = world({ contacts: [contact({ last_inbound_at: iso(NOW - 2 * HOUR) })] });
  res = await r.sweepReorders();
  const im = w.sent[0] || {};
  eq([w.sent.length, im.kind, im.to, im.link], [1, 'image', ASHA, IMG('atta-original')], 'window open: one picture message (wa.sendImage), no template');
  eq(im.caption, TRY_WORDS('Asha', '2', 'Atta Kesari') + '\n\nhttps://munchingo.com/cart?add=atta-original:2,atta-kesari&' + UTM, 'caption: the template words filled in, a blank line, the full link');
  eq(w.logged.map((l) => [l.template, l.campaign, l.status]), [['freeform_j6', 'j6:' + OID, 'sent']], 'logged as freeform_j6 with the same campaign');
  w = world({ contacts: [contact({ last_inbound_at: iso(NOW - 24 * HOUR) })] });
  await r.sweepReorders();
  eq((w.sent[0] || {}).kind, 'template', 'wrote 24 h ago: the window is treated as closed, template');
  w = world({ orders: [order({ items: everything, delivered_at: iso(NOW - 35 * DAY) })], contacts: [contact({ last_inbound_at: iso(NOW - HOUR) })] });
  await r.sweepReorders();
  eq((w.sent[0] || {}).caption, SAME_WORDS('Asha', '5') + '\n\nhttps://munchingo.com/cart?add=atta-original:2,atta-kesari:1,atta-ajwain:1,atta-lite-sugar:1&' + UTM, 'free-form same words when there is no try');
  eq(r.REPLIES.en.try('Asha', '2', 'Atta Kesari'), TRY_WORDS('Asha', '2', 'Atta Kesari'), 'REPLIES.en.try is the approved J6 body, verbatim');
  eq(r.REPLIES.en.same('Asha', '2'), SAME_WORDS('Asha', '2'), 'REPLIES.en.same is the approved reorder_same body, verbatim');

  // stall contact through the sweep
  w = world({ orders: [], contacts: [ravi()], now: STALL_DAY });
  res = await r.sweepReorders();
  const st = w.sent[0] || {};
  eq([st.name, st.params, st.opts && st.opts.header, st.opts && st.opts.urlSuffix], ['munchingo_reorder_same', ['Ravi', 'Munchingo'], { type: 'image', link: IMG(null) }, 'shop?' + UTM], 'stall: same template, [Ravi, Munchingo], reorder-all.jpg, shop link');
  eq(w.claims, [{ actor_name: 'System', order_id: 'j6:stall:2026-11-01:9810000002', event: 'reorder_reminder', meta: {} }], 'stall: claimed before sending (j6:stall:<day>:<last10>, meta {})');
  eq(w.logged.map((l) => l.campaign), ['j6:stall:2026-11-01'], 'stall: logged with j6:stall:<day>');
  await r.sweepReorders();
  eq(w.sent.length, 1, 'stall: a second run the same day sends nothing');
  w = world({ orders: [], contacts: [ravi()], now: STALL_DAY });
  const [sa, sb] = await Promise.all([r.sweepReorders(), r.sweepReorders()]);
  eq([w.sent.length, w.claims.length, sa.sent + sb.sent, sa.skipped + sb.skipped], [1, 2, 1, 1], 'stall: two overlapping runs send once (the second claim returns false)');
  w = world({ orders: [], contacts: [ravi()], now: STALL_DAY });
  w.logDown = true;
  await r.sweepReorders();
  w.logDown = false; w.t = STALL_DAY + DAY;
  await r.sweepReorders();
  eq(w.sent.length, 1, 'stall: the log write failed after a send: the next run does not send it again');

  // a failed send is logged, counted, and retried once after 48 h only for 131049
  w = world();
  w.failWith = metaErr(131049, 'This message was not delivered to maintain healthy ecosystem engagement.');
  res = await r.sweepReorders();
  eq([res.sent, res.failed], [0, 1], 'a refused send counts as failed');
  eq(w.logged.map((l) => [l.status, l.error, l.template, l.campaign, l.wa_message_id]), [['failed', '131049 This message was not delivered to maintain healthy ecosystem engagement.', 'munchingo_reorder_try', 'j6:' + OID, null]], 'and is logged failed with Meta\'s code first');
  w.failWith = null;
  w.t = NOW + DAY; res = await r.sweepReorders();
  eq(w.sent.length, 0, 'the next day (inside 48 h): no retry yet');
  w.t = NOW + 3 * DAY; res = await r.sweepReorders();
  eq([w.sent.length, w.claims.map((c) => c.event).pop()], [1, 'reorder_reminder_retry'], '72 h later: one retry, claimed as reorder_reminder_retry');
  w.t = NOW + 4 * DAY; await r.sweepReorders();
  eq(w.sent.length, 1, 'after the retry went: nothing more');

  // too many orders to read in one page: refuse rather than miss a reorder
  w = world();
  w.orders = Array.from({ length: 1000 }, (_, i) => order({ order_id: 'MNG-X' + i }));
  res = await r.sweepReorders();
  ok(res.blocked && w.sent.length === 0, 'a full 1000-row page of orders: blocked, nothing sent (' + show(res) + ')');

  // ── 5. the endpoint (same guard as /internal/daily-digest) ──
  const at = (hhmmIst) => Date.parse(`2026-11-16T${hhmmIst}:00+05:30`);
  w = world({ now: at('16:00') });
  let h = await r.handleRequest({ query: {} });
  eq([h.status, h.body && h.body.sent, [...w.days]], [200, 1, ['reorders-2026-11-16']], 'bare call at 16:00 IST: runs and claims the day');
  h = await r.handleRequest({ query: {} });
  eq([h.status, h.body && h.body.skipped, w.sent.length], [200, 'already ran today', 1], 'RF5: a second bare call that day: the day claim returns false, nothing sent');
  w = world({ now: at('15:29') });
  eq((await r.handleRequest({ query: {} })).status, 503, 'bare call before 15:30 IST, no secret set: 503');
  w = world({ now: at('18:01') });
  eq((await r.handleRequest({ query: {} })).status, 503, 'bare call after 18:00 IST: refused');
  eq(w.sent.length + w.days.size, 0, 'a refused call sends and claims nothing');
  w = world({ now: at('15:30') });
  eq((await r.handleRequest({ query: {} })).status, 200, '15:30 IST is inside the window');
  process.env.DIGEST_SECRET = 'right-secret';
  w = world({ now: at('12:00') });
  eq((await r.handleRequest({ query: {} })).status, 403, 'secret set, bare call outside the window: 403');
  eq((await r.handleRequest({ query: { secret: 'wrong' } })).status, 403, 'wrong secret: 403');
  w = world({ now: at('16:00') });
  eq((await r.handleRequest({ query: { secret: 'wrong-secret' } })).status, 403, 'wrong secret inside the window: still 403');
  w = world({ now: at('12:00') });
  h = await r.handleRequest({ query: { secret: 'right-secret' } });
  eq([h.status, h.body && h.body.sent, w.days.size], [200, 1, 0], 'with the secret at noon: runs, and skips the day claim (R2)');
  h = await r.handleRequest({ query: { secret: 'right-secret' } });
  eq([h.status, w.sent.length], [200, 1], 'a secret re-run is kept safe by the per-order claim');
  delete process.env.JOURNEY_J6_ENABLED;
  w = world({ now: at('16:00') });
  h = await r.handleRequest({ query: {} });
  eq([h.status, h.body && h.body.disabled, w.days.size], [200, true, 0], 'flag off: { disabled: true } and the day is not spent');
  process.env.JOURNEY_J6_ENABLED = '1';
  w = world({ now: at('16:00') });
  w.dbDown = true;
  h = await r.handleRequest({ query: {} });
  eq([h.status, w.released, w.days.size], [500, ['reorders-2026-11-16'], 0], 'a bare run that throws: 500 and the day is released for a retry');

  // ── 6. wiring ──
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok(/app\.get\('\/internal\/reorders'/.test(srv) && /require\('\.\/utils\/reorders'\)\.handleRequest\(\{ query: req\.query \}\)/.test(srv), 'server.js: GET /internal/reorders hands the query to reorders.handleRequest');
  const sched = fs.readFileSync(path.join(__dirname, '..', 'scheduling_setup.sql'), 'utf8');
  const CRON = "select cron.schedule('munchingo-reorders', '30 10 * * *', $$ select net.http_get(url := 'https://munchingo-whatsapp-webhook.onrender.com/internal/reorders', timeout_milliseconds := 120000); $$);";
  ok(sched.split('\n').some((l) => l === '-- ' + CRON), 'scheduling_setup.sql: the J6 pg_cron line, commented, exactly as in the brief');
  ok(!sched.split('\n').some((l) => l.trim() === CRON), 'the J6 job is not live in the file (it stays commented)');
  ok(/^-- .*owner.*runs it in Supabase/im.test(sched), 'a header line says the owner runs it in Supabase');
  const mig = fs.readFileSync(path.join(__dirname, '..', 'growth_journey_migration.sql'), 'utf8').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n').toLowerCase();
  ok(/create unique index if not exists order_events_reorder_once on order_events \(order_id, event\) where event in \('reorder_reminder', 'reorder_reminder_retry'\)/.test(mig), 'migration: one reorder_reminder (and one retry) per order, so the claim really is once');

  if (prevFlag === undefined) delete process.env.JOURNEY_J6_ENABLED; else process.env.JOURNEY_J6_ENABLED = prevFlag;
  if (prevSecret === undefined) delete process.env.DIGEST_SECRET; else process.env.DIGEST_SECRET = prevSecret;
  console.log(`reorders-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
