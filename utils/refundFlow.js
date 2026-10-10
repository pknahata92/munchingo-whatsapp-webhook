'use strict';

/**
 * Every refund (started from our /internal/refund endpoint OR from the Razorpay dashboard) ends here, via
 * Razorpay's refund.processed webhook. Steps, each isolated so one failure never blocks the others:
 *   1. work out full vs part (against what has already been refunded on the order)
 *   2. close the order if it is now fully refunded
 *   3. GST credit note: number + PDF + stored (idempotent per Razorpay refund id)
 *   4. Zoho Books: credit note + refund entry
 *   5. tell the customer (WhatsApp template -> free text -> email), reason-aware
 *   6. one email to the owner with the credit note PDF
 */

async function step(label, fn) {
  try { return await fn(); } catch (err) { console.error(`[REFUND] ${label} failed:`, err.response?.data ? JSON.stringify(err.response.data) : err.message); return null; }
}

async function processRefund({ order, refund }) {
  const db = require('./database');
  const { issueCreditNote } = require('./creditNote');
  const { notifyRefund } = require('./refunds');
  const { reasonOf } = require('./refundReasons');

  const refundId = refund.id;
  const amountPaise = Number(refund.amount);
  const amountRupees = Math.round(amountPaise / 100);
  const reasonCode = refund.notes?.reason_code || 'other';
  const reasonNote = refund.notes?.note || '';

  // Idempotency: Razorpay retries webhooks; one refund id = one credit note = one customer message.
  let already = null;
  try { already = await db.getCreditNoteByRefund(refundId); } catch (e) { /* table not created yet: carry on without credit notes */ }
  if (already) { console.log(`[REFUND] Duplicate webhook for ${refundId} - ignoring`); return { duplicate: true }; }

  const invoice = await step('invoice lookup', () => db.getInvoiceByOrder(order.order_id));
  let refundedBefore = 0;
  try { refundedBefore = (await db.getCreditNotesByOrder(order.order_id)).reduce((n, c) => n + c.amount_paise, 0); } catch (e) { /* no table yet */ }
  const orderTotalPaise = invoice ? invoice.total_paise : Math.round(Number(order.total) * 100);
  const isFull = refundedBefore + amountPaise >= orderTotalPaise;

  if (isFull && order.status === 'cancelled' && !invoice) { console.log(`[REFUND] ${order.order_id} already closed - ignoring duplicate`); return { duplicate: true }; }
  if (isFull) await step('close order', () => db.markOrderRefunded(order.order_id));
  console.log(`[REFUND] ${order.order_id}: Rs ${amountRupees} (${isFull ? 'completes full refund' : 'partial'}), reason ${reasonCode}, ${refundId}`);

  // 3 + 4: tax paperwork (needs invoices_migration.sql + credit_notes_migration.sql; skipped cleanly otherwise)
  let issued = null;
  if (invoice) {
    issued = await step('credit note', () => issueCreditNote({ invoice: invoice.data, amountPaise, refundId, paymentId: refund.payment_id, reasonCode, reasonNote }));
    if (issued && issued.created) {
      const z = await step('zoho credit note', () => require('./zohoBooks').syncCreditNote({ creditNote: issued.creditNote }));
      if (z && z.creditNoteId) await db.markCreditNote(issued.creditNote.creditNoteNo, { zoho_credit_note_id: z.creditNoteId, zoho_synced_at: new Date().toISOString() });
    }
  } else {
    console.warn(`[REFUND] credit note skipped for ${order.order_id}: no invoice on file`);
  }

  // 5: customer
  await step('customer notice', () => notifyRefund(order, amountRupees, isFull, { reasonCode, reasonNote }));

  // 6: owner
  if (process.env.NOTIFY_EMAIL) {
    await step('owner email', () => require('./mailer').sendOwnerRefundEmail({
      order, refund: { id: refundId, amountRupees, isFull, reason: reasonOf(reasonCode).label, note: reasonNote },
      creditNote: issued && issued.creditNote, pdf: issued && issued.pdf,
    }));
  }
  return { duplicate: false, isFull, creditNoteNo: issued && issued.creditNote.creditNoteNo };
}

module.exports = { processRefund };
