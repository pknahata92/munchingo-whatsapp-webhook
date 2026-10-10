'use strict';
/**
 * Submit the WhatsApp invoice template (PDF document header) to Meta.
 *
 *   node scripts/submit-invoice-template.js            # DRY RUN: prints the payload
 *   node scripts/submit-invoice-template.js --submit   # really submits (needs WABA_ID, WHATSAPP_TOKEN, META_APP_ID in .env)
 *
 * Meta needs a sample PDF to approve a document header; this renders a sample invoice and
 * uploads it through the Resumable Upload API to get the header handle. Submitting is
 * outward-facing (Meta reviews + caches the copy), so dry-run is the default.
 * Once status = APPROVED, set INVOICE_WA_TEMPLATE=munchingo_invoice on Render.
 */
require('dotenv').config();
const axios = require('axios');
const { buildInvoice, renderInvoicePdf } = require('../utils/invoice');

const submit = process.argv.includes('--submit');
const NAME = 'munchingo_invoice';
const BODY =
  'Hi {{1}}, your payment is confirmed. Your GST tax invoice {{2}} for order {{3}} (total ₹{{4}}) is attached as a PDF. ' +
  'Please keep it for your records.\n\n— Team Munchingo';

(async () => {
  const sample = buildInvoice({
    order_id: 'MNG-ABCD-1015', customer_name: 'Aarav', customer_phone: '919999999999',
    items: [{ productName: 'Atta Original', quantity: 2, item_price: 259, unit: '250g' }], discount_amount: 0,
    delivery_address: { raw: 'Sample address, New Delhi, Delhi - 110001' },
  }, { invoiceNo: 'MUN/26-27/0001', issuedAt: new Date() });
  const pdf = await renderInvoicePdf(sample);

  const payload = (handle) => ({
    name: NAME, language: 'en', category: 'UTILITY',
    components: [
      { type: 'HEADER', format: 'DOCUMENT', example: { header_handle: [handle] } },
      { type: 'BODY', text: BODY, example: { body_text: [['Aarav', 'MUN/26-27/0001', 'MNG-ABCD-1015', '518.00']] } },
    ],
  });

  if (!submit) { console.log('DRY RUN. Payload:\n' + JSON.stringify(payload('<uploaded-sample-handle>'), null, 2)); return; }

  const missing = ['WABA_ID', 'WHATSAPP_TOKEN', 'META_APP_ID'].filter((k) => !process.env[k]);
  if (missing.length) { console.error(`Missing in .env: ${missing.join(', ')}`); process.exit(1); }
  const tok = process.env.WHATSAPP_TOKEN;
  const g = 'https://graph.facebook.com/v21.0';

  const sess = await axios.post(`${g}/${process.env.META_APP_ID}/uploads`, null, {
    params: { file_length: pdf.length, file_type: 'application/pdf', file_name: 'sample-invoice.pdf', access_token: tok },
  });
  const up = await axios.post(`${g}/${sess.data.id}`, pdf, { headers: { Authorization: `OAuth ${tok}`, file_offset: '0', 'Content-Type': 'application/octet-stream' }, maxBodyLength: Infinity });
  const handle = up.data.h;

  try {
    const res = await axios.post(`${g}/${process.env.WABA_ID}/message_templates`, payload(handle), { headers: { Authorization: `Bearer ${tok}` } });
    console.log('Submitted:', res.data);
  } catch (err) {
    console.error('Meta rejected it:', JSON.stringify(err.response?.data || err.message));
    process.exit(1);
  }
})();
