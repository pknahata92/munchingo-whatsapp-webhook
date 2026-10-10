'use strict';

/**
 * The situations you will actually meet, each with an internal label (owner emails, credit note),
 * and a customer-facing phrase that completes "…because ___" in the WhatsApp message.
 * `template` picks the already-approved WhatsApp template used for a FULL refund of that situation.
 */
const REASONS = {
  out_of_stock:       { label: 'Out of stock',            text: 'the item went out of stock',                       template: 'cancel_by_us' },
  unserviceable:      { label: 'Delivery not possible',   text: 'we could not deliver to your address',             template: 'cancel_by_us' },
  delivery_failed:    { label: 'Delivery failed',         text: 'the parcel could not be delivered',                template: 'refund_full' },
  damaged:            { label: 'Damaged in transit',      text: 'a box arrived damaged',                            template: 'refund_full' },
  quality_issue:      { label: 'Quality issue',           text: 'there was a quality issue with your box',          template: 'refund_full' },
  customer_cancelled: { label: 'Cancelled by customer',   text: 'you asked us to cancel',                           template: 'cancel_by_customer' },
  duplicate_payment:  { label: 'Duplicate payment',       text: 'the payment was made twice',                       template: 'refund_full' },
  other:              { label: 'Other',                   text: 'an adjustment to your order',                      template: 'refund_full' },
};

const reasonOf = (code) => REASONS[code] || REASONS.other;

module.exports = { REASONS, reasonOf };
