'use strict';
// Renders a sample invoice PDF + the customer email HTML locally for design QA.
//   node scripts/preview-invoice.js <outDir>
const fs = require('fs');
const path = require('path');
const { buildInvoice, renderInvoicePdf } = require('../utils/invoice');

const out = process.argv[2] || '.';
const order = {
  order_id: 'MNG-4821-1015', customer_name: 'Priya Sharma', customer_phone: '919876543210', customer_email: 'priya@example.com',
  items: [
    { productName: 'Atta Original', quantity: 2, item_price: 259, unit: '250g', slug: 'atta-original' },
    { productName: 'Atta Kesari', quantity: 1, item_price: 299, unit: '250g', slug: 'atta-kesari' },
    { productName: 'Atta Ajwain', quantity: 1, item_price: 259, unit: '250g', slug: 'atta-ajwain' },
  ],
  total: 1076 - 100, discount_amount: 100, coupon_code: 'FOUNDING10', payment_id: 'pay_QxAmPlE12345',
  delivery_address: { raw: 'Flat 12, Green Park Apartments, Dwarka Sector 6, New Delhi, Delhi - 110075' },
  gift_note: 'Happy Diwali, love Priya', created_at: new Date().toISOString(),
};
(async () => {
  const inv = buildInvoice(order, { invoiceNo: 'MUN/26-27/0001', issuedAt: new Date() });
  console.log(JSON.stringify({ total: inv.totalPaise, taxable: inv.taxablePaise, cgst: inv.cgstPaise, sgst: inv.sgstPaise, igst: inv.igstPaise, supply: inv.supplyType, words: inv.amountInWords }, null, 1));
  const sum = inv.taxablePaise + inv.cgstPaise + inv.sgstPaise + inv.igstPaise;
  if (sum !== inv.totalPaise) throw new Error(`Tax maths off: ${sum} != ${inv.totalPaise}`);
  fs.writeFileSync(path.join(out, 'sample-invoice-inter.pdf'), await renderInvoicePdf(inv));
  const intra = buildInvoice({ ...order, delivery_address: { raw: 'Plot 4, Sector 14, Faridabad, Haryana - 121007' } }, { invoiceNo: 'MUN/26-27/0002', issuedAt: new Date() });
  if (intra.supplyType !== 'intra' || intra.cgstPaise + intra.sgstPaise + intra.taxablePaise !== intra.totalPaise) throw new Error('intra maths off');
  fs.writeFileSync(path.join(out, 'sample-invoice-intra.pdf'), await renderInvoicePdf(intra));
  try {
    const t = require('../utils/emailTemplates');
    fs.writeFileSync(path.join(out, 'sample-confirmation.html'), t.customerConfirmationHtml({ order, invoice: inv }));
    fs.writeFileSync(path.join(out, 'sample-ownerpaid.html'), t.ownerPaidHtml({ order, invoice: inv }));
  } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  console.log('written to', out);
})().catch((e) => { console.error(e); process.exit(1); });
