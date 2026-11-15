'use strict';
// WhatsApp catalogue order (handleOrderMessage): shipping line in the receipt, the saved shipping row, the 2-box minimum. No live calls.   node scripts/catalog-order-test.js
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

(async () => {
  const sent = [], saved = [];
  stub('../utils/whatsapp', new Proxy({
    sendText: async (to, text) => { sent.push({ kind: 'text', to, text }); },
    sendButtons: async (to, text) => { sent.push({ kind: 'buttons', to, text }); },
    sendFlow: async () => { sent.push({ kind: 'flow' }); },
  }, { get: (t, k) => t[k] || (async () => {}) }));
  stub('../utils/mailer', new Proxy({}, { get: () => async () => {} }));
  stub('../utils/database', new Proxy({ saveOrder: async (o) => { saved.push(o); } }, { get: (t, k) => t[k] || (async () => null) }));
  stub('../utils/razorpay', new Proxy({}, { get: () => async () => { throw new Error('Razorpay must not be called'); } }));
  const h = require('../handlers/messageHandler');
  const order = (qty, price = 259) => ({ currency: 'INR', product_items: [{ product_retailer_id: '91slwpjdqq', quantity: qty, item_price: price, currency: 'INR' }] });
  const reset = () => { sent.length = 0; saved.length = 0; };

  // (a) 2 boxes, Rs 518 of goods: Rs 49 shipping
  reset();
  let threw = null;
  try { await h.handleOrderMessage('919876543210', order(2), 'Asha'); } catch (e) { threw = e; }
  ok(!threw, '2-box order must not throw: ' + (threw && threw.message));
  const receipt = sent.find((s) => s.kind === 'text' && /Order Received/.test(s.text));
  ok(receipt && /Shipping — ₹49 \(free from ₹777\)/.test(receipt.text), 'receipt has the Rs 49 shipping line');
  ok(receipt && /Total: ₹567/.test(receipt.text), 'receipt total is 518 + 49 = 567');
  ok(saved.length === 1 && saved[0].total === 567, 'order saved with total 567');
  ok(saved[0] && saved[0].items.some((i) => i.slug === 'shipping' && i.item_price === 49), 'saved items include the shipping row');

  // (b) 3 boxes, Rs 777: free shipping, no shipping line
  reset(); threw = null;
  try { await h.handleOrderMessage('919876543210', order(3), 'Asha'); } catch (e) { threw = e; }
  ok(!threw, '3-box order must not throw: ' + (threw && threw.message));
  const r2 = sent.find((s) => s.kind === 'text' && /Order Received/.test(s.text));
  ok(r2 && !/Shipping/.test(r2.text), 'no shipping line at or over Rs 777');
  ok(saved.length === 1 && saved[0].total === 777 && !saved[0].items.some((i) => i.slug === 'shipping'), 'saved at 777 with no shipping row');

  // (c) 1 box: below the 2-box minimum, nothing saved, buttons asking to add more
  reset(); threw = null;
  try { await h.handleOrderMessage('919876543210', order(1), 'Asha'); } catch (e) { threw = e; }
  ok(!threw, '1-box order must not throw: ' + (threw && threw.message));
  ok(saved.length === 0, '1-box order is not saved');
  ok(sent.some((s) => s.kind === 'buttons' && /minimum order is \*2 boxes\*/.test(s.text)), '1-box order gets the 2-box minimum message');
  ok(!sent.some((s) => /Order Received/.test(s.text || '')), '1-box order gets no receipt');

  console.log(`catalog-order-test: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
