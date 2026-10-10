'use strict';

/**
 * Everything that happens after a payment is confirmed, apart from the existing
 * "order confirmed" WhatsApp template: GST invoice -> customer email (+PDF) -> owner
 * email (+PDF) -> WhatsApp invoice -> Zoho Books. Every step is isolated: a failure in
 * one is logged and never blocks the others or the webhook's 200 response.
 */

const wa = require('./whatsapp');

async function step(label, fn) {
  try { return await fn(); } catch (err) { console.error(`[INVOICE] ${label} failed:`, err.response?.data ? JSON.stringify(err.response.data) : err.message); return null; }
}

async function processPaidOrder({ order, phone }) {
  const { issueInvoice } = require('./invoice');
  const { markInvoice } = require('./database');
  const mailer = require('./mailer');

  // 1. Invoice (needs invoices_migration.sql; if it hasn't run we skip and carry on)
  const issued = await step('generate', () => issueInvoice(order));
  const invoice = issued?.invoice || null;
  const pdf = issued?.pdf || null;
  if (!invoice) console.warn(`[INVOICE] skipped for ${order.order_id} (see error above)`);

  // 2. Customer email
  if (order.customer_email) {
    const ok = await step('customer email', () => mailer.sendCustomerConfirmationEmail({ order, invoice, pdf }).then(() => true));
    if (ok && invoice) await markInvoice(order.order_id, { email_sent_at: new Date().toISOString() });
  }

  // 3. The ONE owner email per paid order (pack list, address, gift message, invoice PDF). Switch off with OWNER_ORDER_ALERT=off.
  if (process.env.NOTIFY_EMAIL) await step('owner email', () => mailer.sendOwnerPaidEmail({ order, invoice, pdf }));

  // 4. WhatsApp invoice: THE one WhatsApp message a customer gets for a paid order (it already says
  //    'payment confirmed'). If it can't be sent the caller falls back to the order-confirmed template.
  //    Only after the document template is approved by Meta and
  //    INVOICE_WA_TEMPLATE is set on Render (name: munchingo_invoice).
  let waSent = false;
  if (invoice && pdf && phone && process.env.INVOICE_WA_TEMPLATE) {
    const sent = await step('whatsapp invoice', async () => {
      const filename = `Munchingo-Invoice-${invoice.invoiceNo.replace(/\//g, '-')}.pdf`;
      const mediaId = await wa.uploadMedia(pdf, 'application/pdf', filename);
      await wa.sendDocumentTemplate(phone, process.env.INVOICE_WA_TEMPLATE, 'en', { mediaId, filename },
        [order.customer_name || 'there', invoice.invoiceNo, order.order_id, (invoice.totalPaise / 100).toFixed(2)]);
      return true;
    });
    if (sent) { waSent = true; await markInvoice(order.order_id, { wa_sent_at: new Date().toISOString() }); }
  }

  // 5. Accounting
  if (invoice) {
    const zoho = await step('zoho books sync', () => require('./zohoBooks').syncPaidOrder({ invoice, order }));
    if (zoho?.invoiceId) await markInvoice(order.order_id, { zoho_invoice_id: zoho.invoiceId, zoho_synced_at: new Date().toISOString() });
  }
  return { invoice, waSent };
}

module.exports = { processPaidOrder };
