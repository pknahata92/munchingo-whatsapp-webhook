// Customer emails: one real photo per email, line thumbnails, truthful shipping.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'x';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'x';
delete process.env.EMAIL_IMAGE_BASE;
const T = require('../utils/emailTemplates');
const shipping = require('../utils/shipping');

let fail = 0;
const ok = (c, msg) => { if (!c) { fail++; console.log('FAIL ' + msg); } else console.log('ok   ' + msg); };
const count = (s, sub) => s.split(sub).length - 1;

const orig = { productName: 'Atta Original', quantity: 2, item_price: 259, slug: 'atta-original' };
const order = { order_id: 'MUN-1', customer_name: 'Asha Rao', items: [orig], total: 518, created_at: new Date().toISOString() };
const hero = (k) => `https://munchingo.com/images/email-hero-${k}.jpg`;

ok(T.HEROES && ['confirmed', 'packed', 'shipped', 'delivered', 'review', 'range'].every((k) => T.HEROES[k] && T.HEROES[k].src === hero(k) && T.HEROES[k].alt), 'HEROES has six entries with src and alt');

const ALTS = {
  confirmed: 'The four Munchingo packs with a bowl of atta biscuits',
  packed: 'An Atta Original pack on a red background with Munchingo tissue paper',
  shipped: 'An Atta Ajwain pack wrapped in Munchingo tissue paper',
  delivered: 'Three blue jars of atta biscuits lined with Munchingo tissue paper',
  review: 'A Munchingo pack with its tear strip pulled open',
  range: 'The four Munchingo packs on a red background with candles',
};
for (const [k, a] of Object.entries(ALTS)) ok(T.HEROES[k].alt === a, `hero ${k} alt is exactly "${a}"`);

const cases = {
  confirmed: T.customerConfirmationHtml({ order }),
  packed: T.packedHtml({ order }),
  shipped: T.shippedHtml({ order, carrier: 'Delhivery', awb: '123', trackUrl: 'https://x.test/t' }),
  delivered: T.deliveredHtml({ order }),
  review: T.reviewRequestHtml({ order, url: 'https://x.test/r' }),
  range: T.paymentReminderHtml({ customerName: 'Asha', orderId: 'MUN-1', items: [orig], total: 518, paymentUrl: 'https://x.test/p' }),
  range2: T.subscriptionRenewalHtml({ customerName: 'Asha', orderId: 'MUN-1', items: [orig], discountPct: 10, total: 466, paymentUrl: 'https://x.test/p' }),
};
for (const [k, html] of Object.entries(cases)) {
  const key = k === 'range2' ? 'range' : k;
  ok(count(html, hero(key)) === 1, `${k} email has its hero exactly once`);
}
const refund = T.refundHtml({ customerName: 'Asha', orderId: 'MUN-1', amount: 100, isFull: false });
ok(!refund.includes('email-hero-') && !/\/images\/email-/.test(refund), 'refund has no hero and no product image');
ok(!T.ownerPaidHtml({ order, invoice: null }).includes('email-hero-'), 'ownerPaidHtml has no hero');
ok(!T.dailySummaryHtml({ dayLabel: 'Today', orders: [] }).includes('email-hero-'), 'dailySummaryHtml has no hero');

// hero sits directly under the header, before the title
const c = cases.confirmed;
ok(c.indexOf(hero('confirmed')) > c.indexOf('logo-gold-v2.png') && c.indexOf(hero('confirmed')) < c.indexOf('font-size:31px'), 'hero is under the logo and above the title');
ok(/<img src="[^"]*email-hero-confirmed\.jpg" width="600" alt="[^"]+" style="display:block;width:100%;height:auto;border:0;">/.test(c), 'hero markup: width 600, full width, no border');

// thumbnails
const sum = (items, extra = {}) => T.summaryTable({ items, totalRupees: 518, ...extra });
const s1 = sum([orig]);
ok(s1.includes('<img') && s1.includes('email-original.jpg') && s1.includes('width="56"') && s1.includes('<img src="https://munchingo.com/images/email-original.jpg" width="56" alt=""') && s1.includes('border-radius:8px'), 'Original line has a 56px thumbnail');
ok(sum([{ productName: 'Full Range Set', quantity: 1, item_price: 999, slug: 'full-range-set' }]).includes('email-set.jpg'), 'a Set line uses email-set.jpg');
ok(!sum([shipping.shippingItem(49)]).includes('<img'), 'a shipping line has no image');
let noSlug; try { noSlug = sum([{ productName: 'Old thing', quantity: 1, item_price: 100 }]); } catch (e) { noSlug = null; }
ok(noSlug !== null && !noSlug.includes('<img'), 'an item with no slug renders without an image');
let legacy; try { legacy = sum([{ product_retailer_id: 'abc123', quantity: 1, item_price: 100, slug: 'not-a-real-slug' }]); } catch (e) { legacy = null; }
ok(legacy !== null && !legacy.includes('<img'), 'an unknown slug renders without an image');
ok(typeof T.thumbFor === 'function' && T.thumbFor(orig) === 'https://munchingo.com/images/email-original.jpg' && T.thumbFor({ slug: 'zzz' }) === null && T.thumbFor(shipping.shippingItem(49)) === null, 'thumbFor returns url or null');

// WhatsApp-catalogue lines: a retailer id with no slug still gets its Flavor thumbnail
const cat = { product_retailer_id: '91slwpjdqq', productName: 'Atta Original', quantity: 1, item_price: 259 };
ok(T.thumbFor(cat) === 'https://munchingo.com/images/email-original.jpg' && sum([cat]).includes('email-original.jpg'), 'a catalogue item with product_retailer_id and no slug gets its thumbnail in the email');

// renewal email: shows exactly what was saved and charged (V4 fix 1)
const renewItems = [orig, shipping.shippingItem(49)];
const rnw = T.subscriptionRenewalHtml({ customerName: 'Asha', orderId: 'MUN-R', items: renewItems, discountPct: 5, discountRupees: 26, total: 541, paymentUrl: 'https://x.test/p' });
ok(/Shipping charges[\s\S]*?&#8377;49</.test(rnw), 'renewal email shows "Shipping charges" with the saved Rs 49');
ok(/Discount[\s\S]*?&minus; &#8377;26</.test(rnw), 'renewal email shows the discount row');
ok(rnw.includes('Total (after 5% subscriber discount)') && /Total \(after 5% subscriber discount\)[\s\S]*?&#8377;541</.test(rnw), 'renewal email total is the charged Rs 541');
ok(518 + 49 - 26 === 541, 'renewal rows add up to the charged total');
const rnwFree = T.subscriptionRenewalHtml({ customerName: 'Asha', orderId: 'MUN-R', items: [{ ...orig, quantity: 3, item_price: 259 }], discountPct: 5, discountRupees: 39, total: 738, paymentUrl: 'https://x.test/p' });
ok(!/shipping/i.test(rnwFree), 'renewal at/over the free threshold has no shipping words');

// truthful shipping
const withShip = T.customerConfirmationHtml({ order: { ...order, items: [orig, shipping.shippingItem(49)], total: 567 }, invoice: { cgstPaise: 1, sgstPaise: 1, igstPaise: 0, invoiceNo: 'I1' } });
const noShip = T.customerConfirmationHtml({ order, invoice: { cgstPaise: 1, sgstPaise: 1, igstPaise: 0, invoiceNo: 'I1' } });
ok(!withShip.includes('Free shipping') && withShip.includes('Shipping charges'), 'order with shipping line: shipping row, no "Free shipping"');
const noShipGst = (noShip.match(/Includes GST \(5%\)[^<]*/) || [''])[0];
ok(noShipGst.startsWith('Includes GST (5%): ') && !/shipping/i.test(noShipGst), 'order without shipping line: GST line has no shipping words');
const ship59 = T.summaryTable({ items: [orig, shipping.shippingItem(59)], totalRupees: 577, gstAmount: 100 });
ok(/Shipping charges[\s\S]*?&#8377;59</.test(ship59), 'shipping row shows the saved fee (Rs 59), read from the order');
ok(!ship59.includes('Free shipping'), 'shipping row at Rs 59: no "Free shipping" text');
const gstOnly = T.summaryTable({ items: [orig], totalRupees: 518, gstAmount: 100 });
const gstLine = (gstOnly.match(/Includes GST \(5%\)[^<]*/) || [''])[0];
ok(gstLine === 'Includes GST (5%): &#8377;1.00', 'no shipping row: GST line is exactly "Includes GST (5%): ₹1.00"');
ok(!/shipping/i.test(gstOnly), 'no shipping row: summary table has no shipping words at all');

// image base override read at render time
process.env.EMAIL_IMAGE_BASE = 'file:///tmp/imgs/';
ok(T.customerConfirmationHtml({ order }).includes('file:///tmp/imgs/email-hero-confirmed.jpg'), 'EMAIL_IMAGE_BASE overrides the image base at render time');
delete process.env.EMAIL_IMAGE_BASE;

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
