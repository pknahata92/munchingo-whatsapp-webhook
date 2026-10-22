'use strict';
// Review requests: signed link, flavours per order, submission checks, who is due, sending, and the public form API.
//   node scripts/reviews-test.js
process.env.REVIEW_LINK_SECRET = 'test-secret';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

(async () => {
  const r = require('../utils/reviews');

  // ── Task 2: signed link ──
  const t = r.signToken('MNG-AB12-2210');
  ok(r.readToken(t) === 'MNG-AB12-2210', 'a signed link reads back as its order');
  const flip = t.slice(0, -2) + (t.slice(-2, -1) === 'A' ? 'B' : 'A') + t.slice(-1);
  ok(r.readToken(flip) === null, 'changing one character breaks the link');
  const other = r.signToken('MNG-ZZ99-0101');
  ok(r.readToken(other) !== 'MNG-AB12-2210', "another order's link never reads as this order");
  ok(r.readToken('') === null && r.readToken('nonsense') === null && r.readToken(null) === null, 'junk links read as nothing');
  { const keep = process.env.REVIEW_LINK_SECRET; delete process.env.REVIEW_LINK_SECRET; let threw = false; try { r.signToken('X'); } catch (e) { threw = true; } ok(threw, 'signing without REVIEW_LINK_SECRET throws'); process.env.REVIEW_LINK_SECRET = keep; }

  // ── Task 2: flavours per order (gift sets opened up) ──
  const slugs = (o) => r.flavoursFor(o).map((f) => f.slug).join(',');
  ok(slugs({ items: [{ slug: 'trio-gift-set-kesari-lite-sugar-original', quantity: 1 }] }) === 'atta-original,atta-kesari,atta-lite-sugar', 'a Trio becomes its three flavours, in the fixed order (' + slugs({ items: [{ slug: 'trio-gift-set-kesari-lite-sugar-original', quantity: 1 }] }) + ')');
  ok(slugs({ items: [{ slug: 'full-range-set', quantity: 1 }] }) === 'atta-original,atta-kesari,atta-lite-sugar,atta-ajwain', 'a Full Range set becomes all four flavours');
  ok(slugs({ items: [{ slug: 'atta-original', quantity: 2 }] }) === 'atta-original', 'two boxes of one flavour is one row');
  ok(r.flavoursFor({ items: [{ slug: 'atta-lite-sugar', quantity: 1 }] })[0].name === 'Atta Sugar-Lite', 'rows carry the product name');

  // ── Task 2: submission checks ──
  const order = { order_id: 'MNG-AB12-2210', customer_name: 'Riya Kapoor', customer_phone: '919810000001', items: [{ slug: 'trio-gift-set-kesari-lite-sugar-original', quantity: 1 }], delivery_address: { raw: 'Flat 2, Bandra, Mumbai, Maharashtra - 400050', city: 'Mumbai', state: 'Maharashtra' } };
  const good = { ratings: { 'atta-original': 5, 'atta-kesari': 4, 'atta-lite-sugar': 3 }, comment: 'Lovely', showAs: 'name', consent: true };
  let v = r.validateSubmission(order, good);
  ok(v.ok && v.row.order_id === 'MNG-AB12-2210' && v.row.ratings['atta-kesari'] === 4 && v.row.display_name === 'Riya' && v.row.city === 'Mumbai' && v.row.consent_publish === true && v.row.customer_phone === '919810000001', 'a complete review is accepted with first name and city (' + JSON.stringify(v.row || v) + ')');
  v = r.validateSubmission(order, { ...good, ratings: { 'atta-original': 5, 'atta-kesari': 4 } });
  ok(!v.ok && v.status === 400 && /Please rate every flavor/.test(v.error), 'a missing flavour is refused');
  v = r.validateSubmission(order, { ...good, ratings: { ...good.ratings, 'atta-ajwain': 5 } });
  ok(!v.ok && v.status === 400, 'a flavour not in the order is refused');
  for (const bad of [0, 6, 4.5, '5', null]) { v = r.validateSubmission(order, { ...good, ratings: { ...good.ratings, 'atta-original': bad } }); ok(!v.ok && v.status === 400, 'rating ' + JSON.stringify(bad) + ' is refused'); }
  v = r.validateSubmission(order, { ...good, comment: 'x'.repeat(501) });
  ok(!v.ok && v.status === 400, 'a comment over 500 characters is refused');
  v = r.validateSubmission(order, { ...good, comment: '  ' + 'y'.repeat(500) + '  ' });
  ok(v.ok && v.row.comment.length === 500, 'the limit counts after trimming');
  v = r.validateSubmission(order, { ...good, showAs: 'anonymous' });
  ok(v.ok && v.row.display_name === 'Anonymous buyer' && v.row.city === '', 'anonymous hides name and city');
  v = r.validateSubmission(order, { ...good, consent: false });
  ok(v.ok && v.row.consent_publish === false, 'no tick means no consent to publish');
  v = r.validateSubmission(order, { ...good, comment: '<b>hi</b>' });
  ok(v.ok && v.row.comment === '<b>hi</b>', 'the comment is stored as typed (escaping happens wherever it is shown)');
  ok(r.cityOf({ delivery_address: { raw: 'House 4, Sector 9, Gurugram, Haryana - 122001' } }) === 'Gurugram', 'city from the address text when there is no city field');
  ok(r.firstName({ customer_name: '  aarav  mehta ' }) === 'Aarav', 'first name, trimmed and capitalised');

  // ── Task 3: who is due (pure) ──
  const NOW = Date.parse('2026-11-01T05:30:00Z'), DAY = 86400000;
  const ago = (d) => new Date(NOW - d * DAY).toISOString();
  const mk = (id, extra = {}) => ({ order_id: id, status: 'paid', customer_name: 'Riya Kapoor', customer_phone: '91981000' + id.slice(-4), customer_email: 'riya@example.com', delivered_at: ago(4), items: [{ slug: 'atta-original', quantity: 3 }], ...extra });
  const ev = (name, daysAgo) => ({ event: name, created_at: ago(daysAgo) });
  const due = (orders, eventsByOrder = {}, tasters = []) => r.dueRequests({ orders, eventsByOrder, tasters, now: NOW });
  const kinds = (list) => list.map((d) => d.order.order_id + ':' + d.kind + (d.founders ? ':F' : '')).join(',');
  ok(kinds(due([mk('MNG-A-0001', { delivered_at: ago(3) })])) === '', 'delivered 3 days ago: not yet');
  ok(kinds(due([mk('MNG-A-0002', { delivered_at: ago(4) })])) === 'MNG-A-0002:ask', 'delivered 4 days ago: ask');
  ok(kinds(due([mk('MNG-A-0003', { delivered_at: ago(9) })], { 'MNG-A-0003': [ev('review_requested', 5)] })) === '', 'asked 5 days ago: no reminder yet');
  ok(kinds(due([mk('MNG-A-0004', { delivered_at: ago(10) })], { 'MNG-A-0004': [ev('review_requested', 6)] })) === 'MNG-A-0004:reminder', 'asked 6 days ago, no review: reminder');
  ok(kinds(due([mk('MNG-A-0005', { delivered_at: ago(14) })], { 'MNG-A-0005': [ev('review_requested', 10), ev('review_reminded', 4)] })) === '', 'already reminded: nothing more');
  ok(kinds(due([mk('MNG-A-0006', { delivered_at: ago(14) })], { 'MNG-A-0006': [ev('review_requested', 10), ev('review_received', 8)] })) === '', 'review in: no reminder');
  ok(kinds(due([mk('MNG-A-0007', { delivered_at: ago(20) })])) === 'MNG-A-0007:ask', 'backfill: an old delivery never asked gets the ask, not the reminder');
  ok(kinds(due([mk('MNG-A-0007', { delivered_at: ago(20) })], { 'MNG-A-0007': [ev('review_requested', 1)] })) === '', 'backfill: the day after the ask, nothing');
  ok(kinds(due([mk('MNG-A-0008', { status: 'cancelled' }), mk('MNG-TEST-1001'), mk('MNG-A-0009', { delivered_at: null }), mk('MNG-A-0010', { customer_phone: '' })])) === '', 'cancelled, test, undelivered and phone-less orders are never asked');
  const p = '919810000123';
  ok(kinds(due([mk('MNG-A-0011', { customer_phone: p, delivered_at: ago(30) }), mk('MNG-A-0012', { customer_phone: p, delivered_at: ago(5) })], { 'MNG-A-0011': [ev('review_requested', 12), ev('review_reminded', 6)] })) === '', 'same phone asked 12 days ago for another order: no new ask');
  ok(kinds(due([mk('MNG-A-0013', { customer_phone: p, delivered_at: ago(45) }), mk('MNG-A-0014', { customer_phone: p, delivered_at: ago(5) })], { 'MNG-A-0013': [ev('review_requested', 31), ev('review_received', 30)] })) === 'MNG-A-0014:ask', 'same phone asked 31 days ago: ask again');
  ok(due([mk('MNG-A-0015', { customer_phone: p, delivered_at: ago(9) }), mk('MNG-A-0016', { customer_phone: p, delivered_at: ago(5) })]).length === 1, 'two due orders for one phone in the same run: only one ask');
  ok(kinds(due([mk('MNG-A-0017', { customer_phone: '919810000001' })], {}, [{ phone: '9810000001' }])) === 'MNG-A-0017:ask:F', 'founding taster stored without 91 matches an order phone with 91');
  ok(kinds(due([mk('MNG-A-0018', { customer_phone: '9810000002' })], {}, [{ phone: '919810000002' }])) === 'MNG-A-0018:ask:F', 'and the other way round');
  ok(kinds(due([mk('MNG-A-0019', { customer_phone: '919810000003', delivered_at: ago(12) })], { 'MNG-A-0019': [ev('review_requested', 7)] }, [{ phone: '919810000003' }])) === 'MNG-A-0019:reminder', "a founding taster's reminder is the standard one");

  // ── Final review fixes: who is due ──
  // (1) the founders message goes once per phone, ever
  ok(kinds(due([mk('MNG-B-0001', { customer_phone: p, delivered_at: ago(60) }), mk('MNG-B-0002', { customer_phone: p, delivered_at: ago(5) })], { 'MNG-B-0001': [{ ...ev('review_requested', 56), meta: { founders: true } }, ev('review_received', 50)] }, [{ phone: p }])) === 'MNG-B-0002:ask', "a founding taster's later order gets the standard ask, not the founders message again");
  // (3) WhatsApp-catalog orders carry product_retailer_id, not slug
  ok(slugs({ items: [{ product_retailer_id: 'w2w5ynf2m5', productName: 'Munchingo Atta Kesari', quantity: 3 }] }) === 'atta-kesari', 'a WhatsApp catalog order (retailer id, no slug) still gets its flavour rows');
  ok(slugs({ items: [{ product_retailer_id: '91slwpjdqq', quantity: 1 }, { product_retailer_id: '97q9r5q5q3', quantity: 2 }] }) === 'atta-original,atta-ajwain', 'catalog ids for Original and Ajwain');
  ok(kinds(due([mk('MNG-B-0003', { items: [{ product_retailer_id: 'unknown', quantity: 1 }] })])) === '', 'an order with no recognisable flavour is never asked');
  v = r.validateSubmission({ ...order, items: [] }, { ratings: {}, showAs: 'name', consent: true });
  ok(!v.ok && v.status === 400, 'a review with nothing to rate is refused');

  // ── Task 3: sending (claim first, strict reads) ──
  const sent = [], mails = [], logged = [];
  let waThrows = false, store = [], readThrows = false, claimThrows = false, tasterRows = [{ phone: '919810000777' }];
  const byName = async (name, ids) => { if (readThrows) throw new Error('db down'); return logged.filter((e) => e.event === name && ids.includes(e.order_id)); };
  r.setDeps({
    now: () => NOW,
    db: {
      listDeliveredOrders: async () => store,
      listFoundingTasters: async () => tasterRows,
      listOrderEventsByName: byName,
      claimOrderEvent: async (e) => { if (claimThrows) throw new Error('db down'); if (logged.some((x) => x.order_id === e.order_id && x.event === e.event)) return false; logged.push({ ...e, created_at: new Date(NOW).toISOString() }); return true; },
      logOrderEvent: async (e) => { logged.push({ ...e, created_at: new Date(NOW).toISOString() }); },
    },
    wa: { sendTemplateWithUrlButton: async (...a) => { if (waThrows) throw new Error('template not approved'); sent.push(a); } },
    mail: { sendReviewRequestEmail: async (a) => { mails.push(a); } },
  });
  store = [mk('MNG-S-0001', { customer_phone: '919810000777', customer_name: 'tara singh' }), mk('MNG-S-0002', { customer_phone: '919810000888', customer_email: null })];
  delete process.env.REVIEW_REQUESTS_ENABLED;
  let res = await r.sweepRequests();
  ok(res.disabled === true && sent.length === 0 && mails.length === 0, 'kill switch off: nothing sent');
  process.env.REVIEW_REQUESTS_ENABLED = '1';
  tasterRows = [];
  res = await r.sweepRequests();
  ok(res.blocked && sent.length === 0, 'the founding tasters list is not saved yet: nothing is sent (founders would get the standard message)');
  tasterRows = [{ phone: '919810000777' }];
  res = await r.sweepRequests();
  const f = sent.find((a) => a[0] === '919810000777'), s2 = sent.find((a) => a[0] === '919810000888');
  ok(f && f[1] === 'munchingo_review_founders' && f[2] === 'en' && f[3][0] === 'Tara' && f[3][1] === 'MNG-S-0001' && r.readToken(f[4]) === 'MNG-S-0001', 'founding taster gets the founders template, English, first name, order id, signed link');
  ok(s2 && s2[1] === 'munchingo_review_request' && s2[2] === 'en', 'everyone else gets the standard template in English');
  ok(sent.every((a) => a[2] === 'en'), 'never Hindi');
  ok(mails.length === 1 && mails[0].order.order_id === 'MNG-S-0001' && mails[0].founders === true && /review\?t=/.test(mails[0].url), 'email only where there is an address, with the founders flag and the link');
  ok(res.asked === 2 && res.failed === 0, 'two asks counted (' + JSON.stringify(res) + ')');
  ok(logged.filter((e) => e.event === 'review_requested').length === 2 && logged.filter((e) => e.event === 'review_requested').every((e) => e.actor_name === 'System' && e.meta && 'founders' in e.meta), 'each ask is claimed on the order timeline first, by System, with the founders flag');
  res = await r.sweepRequests();
  ok(sent.length === 2 && res.asked === 0, 'the next run sends nothing again');
  waThrows = true; sent.length = 0; mails.length = 0;
  store = [mk('MNG-S-0003', { customer_phone: '919810000999' })];
  res = await r.sweepRequests();
  const e3 = logged.find((e) => e.order_id === 'MNG-S-0003' && e.event === 'review_request_result');
  ok(mails.length === 1 && res.failed === 1 && e3 && e3.meta.wa === 'failed' && e3.meta.email === 'sent', 'WhatsApp fails: email still goes, failure counted and recorded');
  waThrows = false; res = await r.sweepRequests();
  ok(sent.length === 0 && res.asked === 0, 'a failed WhatsApp is not retried the next day (the ask is claimed once)');
  // (5) a buyer the owner removed from the tasters list is not treated as one; the saved list is not "empty"
  tasterRows = [{ phone: '919810000555', removed: true }]; sent.length = 0;
  store = [mk('MNG-S-0005', { customer_phone: '919810000555' })];
  res = await r.sweepRequests();
  ok(!res.blocked && sent.length === 1 && sent[0][1] === 'munchingo_review_request', 'a removed taster gets the standard ask, and a saved list with only removed people does not block the run');
  tasterRows = [{ phone: '919810000777' }];
  // (2) a database read that fails must not look like "never asked"
  store = [mk('MNG-S-0004', { customer_phone: '919810000444' })]; sent.length = 0; readThrows = true;
  let threw = false; try { await r.sweepRequests(); } catch (e) { threw = true; }
  ok(threw && sent.length === 0, 'the timeline cannot be read: the run stops and sends nothing');
  readThrows = false; claimThrows = true; threw = false;
  try { await r.sweepRequests(); } catch (e) { threw = true; }
  ok(threw && sent.length === 0, 'the ask cannot be recorded: the run stops before sending');
  claimThrows = false;
  logged.push({ order_id: 'MNG-S-0004', event: 'review_requested', created_at: new Date(NOW).toISOString(), meta: { founders: false } });
  store = [mk('MNG-S-0004', { customer_phone: '919810000444' })];
  const fake = logged.pop();   // another run claimed it between this run's read and its claim
  const realClaim = r._deps().db.claimOrderEvent;
  r._deps().db.claimOrderEvent = async (e) => { logged.push(fake); return false; };
  res = await r.sweepRequests();
  r._deps().db.claimOrderEvent = realClaim;
  ok(sent.length === 0 && res.asked === 0, 'an overlapping run that already claimed the order: no second message');

  // ── Task 4: public form and submit ──
  process.env.GOOGLE_REVIEW_URL = 'https://g.page/r/CThPt_VWhjZkEAI/review';
  const saved = [], alerts = [], tl = [];
  const ordersById = {
    'MNG-F-0001': { order_id: 'MNG-F-0001', status: 'paid', customer_name: 'Neha Jain', customer_phone: '919810000101', customer_email: 'neha@example.com', delivery_address: { raw: 'A-1, Civil Lines, Jaipur, Rajasthan - 302006', source: { how: 'friend_family' } }, items: [{ slug: 'trio-gift-set-kesari-lite-sugar-original', quantity: 1 }] },
    'MNG-F-0002': { order_id: 'MNG-F-0002', status: 'paid', customer_name: 'Om Taster', customer_phone: '919810000777', delivery_address: { raw: 'B-2, Model Town, Delhi, Delhi - 110009' }, items: [{ slug: 'atta-kesari', quantity: 3 }] },
    'MNG-F-0003': { order_id: 'MNG-F-0003', status: 'paid', customer_name: 'Old Friend', customer_phone: '919810000102', known_to_us: true, delivery_address: { raw: 'C-3, Sector 5, Noida, UP - 201301' }, items: [{ slug: 'atta-ajwain', quantity: 3 }] },
  };
  r.setDeps({
    now: () => NOW,
    db: {
      getOrder: async (id) => ordersById[id] || null,
      getReviewByOrder: async (id) => saved.find((x) => x.order_id === id) || null,
      insertReview: async (row) => { if (saved.some((x) => x.order_id === row.order_id)) throw new Error('duplicate'); saved.push(row); return { id: saved.length }; },
      listFoundingTasters: async () => [{ phone: '9810000777' }],
      logOrderEvent: async (e) => { tl.push(e); },
    },
    mail: { sendFeedbackAlert: async (a) => { alerts.push(a); } },
  });
  let g = await r.getForm('not-a-real-token');
  ok(g.status === 404, 'a bad link: 404');
  g = await r.getForm(r.signToken('MNG-UNKNOWN-0000'));
  ok(g.status === 404, 'a well-signed link to an order that does not exist: 404');
  g = await r.getForm(r.signToken('MNG-F-0001'));
  ok(g.status === 200 && g.body.first === 'Neha' && g.body.flavours.map((x) => x.slug).join(',') === 'atta-original,atta-kesari,atta-lite-sugar' && g.body.reviewed === false, 'the form gets first name and the flavours received');
  const bodyText = JSON.stringify(g.body);
  ok(!/919810000101|Civil Lines|neha@example|customer_phone|address|email/i.test(bodyText), 'the form never sees phone, address or email (' + bodyText + ')');
  let sres = await r.submit(r.signToken('MNG-F-0001'), { ratings: { 'atta-original': 5, 'atta-kesari': 1, 'atta-lite-sugar': 4 }, comment: 'Kesari too sweet', showAs: 'name', consent: true });
  ok(sres.status === 201 && sres.body.googleUrl === process.env.GOOGLE_REVIEW_URL, 'first submit: saved, and the Google link comes back for everyone (even with a 1-star rating)');
  ok(saved[0].network === true && saved[0].founding_taster === false && saved[0].status === 'new', 'a "Friend or family" order is marked network; status starts new');
  ok(alerts.length === 1 && /MNG-F-0001/.test(JSON.stringify(alerts[0])), 'a rating of 2 or below emails the owner once, with the order');
  ok(tl.some((e) => e.event === 'review_received' && e.order_id === 'MNG-F-0001'), 'the review is on the order timeline');
  sres = await r.submit(r.signToken('MNG-F-0001'), { ratings: { 'atta-original': 5, 'atta-kesari': 5, 'atta-lite-sugar': 5 }, showAs: 'name', consent: true });
  ok(sres.status === 409 && /Thanks, we have your review/.test(sres.body.error) && saved.length === 1, 'a second submit is refused and changes nothing');
  ok((await r.getForm(r.signToken('MNG-F-0001'))).body.reviewed === true, 'after a review the form says so');
  sres = await r.submit(r.signToken('MNG-F-0002'), { ratings: { 'atta-kesari': 5 }, showAs: 'anonymous', consent: false });
  ok(sres.status === 201 && saved[1].founding_taster === true && saved[1].network === false && alerts.length === 1, 'a founding taster is marked as one (phone saved without 91 still matches); 5 stars sends no alert');
  sres = await r.submit(r.signToken('MNG-F-0003'), { ratings: { 'atta-ajwain': 4 }, showAs: 'name', consent: true });
  ok(sres.status === 201 && saved[2].network === true, 'an order the owner marked "known to us" is marked network');
  sres = await r.submit(r.signToken('MNG-F-0002') + 'x', { ratings: {} });
  ok(sres.status === 404, 'submit with a broken link: 404');
  sres = await r.submit(r.signToken('MNG-F-0001').replace(/.$/, ''), {});
  ok(sres.status === 404, 'submit with a truncated link: 404');
  const routeSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'reviews.js'), 'utf8');
  ok(/router\.get\('\/api\/review\/:token', rateLimit\(\{ windowMs: 60_000, max: 20 \}\)/.test(routeSrc) && /router\.post\('\/api\/review\/:token', rateLimit\(\{ windowMs: 60_000, max: 5 \}\)/.test(routeSrc), 'both review routes are rate limited (20 and 5 a minute)');
  const serverSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  ok(/routes\/reviews/.test(serverSrc) && /\/internal\/review-requests/.test(serverSrc), 'server mounts the review routes and the daily job endpoint');
  const wf = require('fs').readFileSync(require('path').join(__dirname, '..', '.github', 'workflows', 'review-requests.yml'), 'utf8');
  ok(/cron: '30 5 \* \* \*'/.test(wf) && /internal\/review-requests\?secret=\$\{\{ secrets\.DIGEST_SECRET \}\}/.test(wf), 'the daily job runs at 11:00 IST with the secret');

  console.log(`reviews-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
