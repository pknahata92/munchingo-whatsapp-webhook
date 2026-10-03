'use strict';

/**
 * Single source of truth for every refund / cancellation / claim / delivery-failure
 * WhatsApp template. The same objects drive:
 *   - sending (sendScenario below)
 *   - submission to Meta (scripts/submit-refund-templates.js)
 *   - the human-readable doc (Munchingo Design Files/whatsapp_refund_templates.md)
 *
 * All are UTILITY (transactional, tied to an existing order). Keep copy free of
 * promotional language or Meta will recategorise them as Marketing.
 * Meta rules baked in: variables numbered in order, never first/last in the body,
 * no newlines inside a variable value, body <= 1024 chars.
 *
 * `trigger` says what fires it today: 'auto' = wired in the backend, 'manual' =
 * sent by the owner via sendScenario() (no webhook exists for that event).
 */

const wa = require('./whatsapp');
const { HI } = require('./refundTemplatesHi');
const { getLang } = require('./langPrefs');

const SIGN = '\n\n— Team Munchingo';
const BANK = 'within 5–7 working days, depending on your bank';

const TEMPLATES = [
  // ── A. Refund lifecycle ─────────────────────────────────────────────────────
  {
    key: 'refund_full',
    name: 'munchingo_refund_processed_full',
    trigger: 'auto', // refund.processed webhook, full amount
    when: 'Razorpay full refund processed (order auto-cancelled).',
    params: ['customer_name', 'order_id', 'amount'],
    example: ['Aarav', 'MNG-4821-0310', '518'],
    body:
      'Hi {{1}}, your refund for order {{2}} has been processed.\n\n' +
      '*Refunded:* ₹{{3}}\n*Order status:* Cancelled\n\n' +
      `The amount reaches your original payment method ${BANK}. ` +
      "If it hasn't arrived after that, reply here and we'll help trace it." + SIGN,
  },
  {
    key: 'refund_partial',
    name: 'munchingo_refund_processed_partial',
    trigger: 'auto', // refund.processed webhook, partial amount
    when: 'Razorpay partial refund processed (damaged item, goodwill, price fix).',
    params: ['customer_name', 'amount', 'order_id', 'reason'],
    example: ['Aarav', '259', 'MNG-4821-0310', 'one box arrived damaged'],
    body:
      "Hi {{1}}, we've refunded ₹{{2}} for order {{3}}.\n\n" +
      '*Reason:* {{4}}\n\n' +
      `The rest of your order is unaffected. The refund reaches your original payment method ${BANK}. ` +
      'Questions? Just reply here.' + SIGN,
  },
  {
    key: 'refund_initiated',
    name: 'munchingo_refund_initiated',
    trigger: 'manual',
    when: 'You have started a refund and want to reassure the customer before the bank credits it.',
    params: ['customer_name', 'amount', 'order_id'],
    example: ['Aarav', '518', 'MNG-4821-0310'],
    body:
      "Hi {{1}}, we've started a refund of ₹{{2}} for order {{3}}.\n\n" +
      "You'll get another message from us once it's processed. Most refunds complete " +
      `${BANK}.` + SIGN,
  },
  {
    key: 'refund_followup_arn',
    name: 'munchingo_refund_bank_reference',
    trigger: 'manual',
    when: 'Customer says the refund has not arrived after 5-7 days; share the bank reference (Razorpay refund -> acquirer_data.arn).',
    params: ['customer_name', 'amount', 'order_id', 'arn'],
    example: ['Aarav', '518', 'MNG-4821-0310', '74012345678901'],
    body:
      'Hi {{1}}, an update on your refund of ₹{{2}} for order {{3}}.\n\n' +
      'Your bank reference number (ARN) is {{4}}. Share it with your bank if the amount ' +
      "hasn't shown up yet — some banks take up to 10 working days.\n\n" +
      "Still nothing after that? Reply here and we'll escalate it for you." + SIGN,
  },
  {
    key: 'refund_failed',
    name: 'munchingo_refund_needs_attention',
    trigger: 'manual', // refund.failed event is not subscribed yet
    when: 'Refund bounced (closed card/account, UPI handle gone). Do NOT ask for bank details in chat.',
    params: ['customer_name', 'amount', 'order_id', 'reason'],
    example: ['Aarav', '518', 'MNG-4821-0310', 'the original card or account is closed'],
    body:
      "Hi {{1}}, your refund of ₹{{2}} for order {{3}} couldn't be credited because {{4}}.\n\n" +
      "Your money is safe with us. Please reply here and our team will arrange the refund another way. " +
      'Please do not share card, OTP or bank passwords in this chat.' + SIGN,
  },

  // ── B. Cancellations ───────────────────────────────────────────────────────
  {
    key: 'cancel_by_customer',
    name: 'munchingo_order_cancelled_refund',
    trigger: 'manual',
    when: 'Customer asked to cancel a PAID order before dispatch. Send when you cancel; the auto "refund processed" message follows later (skip refund_initiated to avoid three messages).',
    params: ['customer_name', 'order_id', 'amount'],
    example: ['Aarav', 'MNG-4821-0310', '518'],
    body:
      'Hi {{1}}, as requested, order {{2}} has been cancelled before dispatch.\n\n' +
      '*Refund amount:* ₹{{3}}\n\n' +
      `We've started the refund to your original payment method. It should arrive ${BANK}.` + SIGN,
  },
  {
    key: 'cancel_by_us',
    name: 'munchingo_order_cancelled_by_us',
    trigger: 'manual',
    when: 'You cancel: out of stock, pincode not serviceable, unverifiable address, batch issue.',
    params: ['customer_name', 'order_id', 'reason', 'amount'],
    example: ['Aarav', 'MNG-4821-0310', 'the item went out of stock', '518'],
    body:
      "Hi {{1}}, we're sorry — we couldn't fulfil order {{2}} because {{3}}.\n\n" +
      `We've cancelled it and started a full refund of ₹{{4}} to your original payment method (${BANK}).\n\n` +
      "Sorry for the trouble. Reply here if you'd like help placing the order again." + SIGN,
  },
  {
    key: 'duplicate_payment',
    name: 'munchingo_duplicate_payment_refund',
    trigger: 'manual',
    when: 'Customer paid the same link twice; confirmed order stays, the extra payment is refunded.',
    params: ['customer_name', 'order_id', 'amount'],
    example: ['Aarav', 'MNG-4821-0310', '518'],
    body:
      'Hi {{1}}, we noticed you were charged twice for order {{2}}.\n\n' +
      "We've refunded the extra payment of ₹{{3}}. Your order itself is confirmed and unaffected.\n\n" +
      `The refund reaches your original payment method ${BANK}.` + SIGN,
  },
  {
    key: 'late_payment',
    name: 'munchingo_late_payment_refund',
    trigger: 'manual',
    when: 'Payment landed on an order that was already cancelled or whose link had expired (known gap in the handoff).',
    params: ['customer_name', 'amount', 'order_id'],
    example: ['Aarav', '518', 'MNG-4821-0310'],
    body:
      'Hi {{1}}, we received a payment of ₹{{2}} for order {{3}} after the order had been ' +
      'cancelled or its payment link had expired, so we have refunded it in full.\n\n' +
      `It reaches your original payment method ${BANK}. ` +
      "If you still want the order, reply here and we'll set it up again." + SIGN,
  },

  // ── C. Damaged / wrong / stale claims (terms.html: photo within 48h of delivery) ──
  {
    key: 'claim_received',
    name: 'munchingo_claim_received',
    trigger: 'manual',
    when: 'Customer reports damage / wrong item / stale cookies; acknowledge and ask for the photo.',
    params: ['customer_name', 'order_id'],
    example: ['Aarav', 'MNG-4821-0310'],
    body:
      "Hi {{1}}, we've received your concern about order {{2}} and we're sorry about it.\n\n" +
      'Please reply with a clear photo of the issue (and of the outer box if it arrived damaged). ' +
      'We aim to resolve it within 24 hours of receiving the photo.' + SIGN,
  },
  {
    key: 'claim_need_photo',
    name: 'munchingo_claim_need_photo',
    trigger: 'manual',
    when: 'Claim has no photo or the photo is unclear.',
    params: ['customer_name', 'order_id', 'what_to_photograph'],
    example: ['Aarav', 'MNG-4821-0310', 'the damaged cookies and the outer box'],
    body:
      'Hi {{1}}, to resolve your concern about order {{2}} we need a clear photo of {{3}}.\n\n' +
      "Please reply with it here and we'll act as soon as it arrives. " +
      'Concerns raised within 48 hours of delivery can be fully covered.' + SIGN,
  },
  {
    key: 'claim_replacement',
    name: 'munchingo_claim_approved_replacement',
    trigger: 'manual',
    when: 'Claim approved, replacement chosen.',
    params: ['customer_name', 'order_id', 'item'],
    example: ['Aarav', 'MNG-4821-0310', '1 x Atta Kesari box'],
    body:
      "Hi {{1}}, thank you for the photo — we're sorry about order {{2}}.\n\n" +
      "We're sending a replacement for {{3}} at no cost to you. " +
      "We'll share tracking details as soon as it ships." + SIGN,
  },
  {
    key: 'claim_refund',
    name: 'munchingo_claim_approved_refund',
    trigger: 'manual',
    when: 'Claim approved, refund chosen. Issue the refund in Razorpay right after; the auto message then confirms it.',
    params: ['customer_name', 'order_id', 'amount', 'item'],
    example: ['Aarav', 'MNG-4821-0310', '259', '1 x Atta Kesari box'],
    body:
      "Hi {{1}}, thank you for the photo — we're sorry about order {{2}}.\n\n" +
      "We've approved a refund of ₹{{3}} for {{4}}. " +
      "You'll get a confirmation message here once it has been processed." + SIGN,
  },
  {
    key: 'claim_declined',
    name: 'munchingo_claim_not_eligible',
    trigger: 'manual',
    when: 'Outside 48h, opened pack with no defect, taste preference, no evidence. Be kind, cite the real reason.',
    params: ['customer_name', 'order_id', 'reason'],
    example: ['Aarav', 'MNG-4821-0310', 'the concern was raised more than 48 hours after delivery'],
    body:
      'Hi {{1}}, thanks for writing to us about order {{2}}.\n\n' +
      "After reviewing it, we're unable to approve a refund or replacement because {{3}}.\n\n" +
      'Our policy covers items that arrive damaged, wrong or stale, reported with a photo within 48 hours of delivery. ' +
      "If you think we've got this wrong, reply here and our Grievance Officer will look at it again." + SIGN,
  },
  {
    key: 'replacement_shipped',
    name: 'munchingo_replacement_dispatched',
    trigger: 'manual',
    when: 'Replacement parcel handed to Delhivery.',
    params: ['customer_name', 'order_id', 'courier', 'awb', 'tracking_url'],
    example: ['Aarav', 'MNG-4821-0310', 'Delhivery', '1234567890123', 'https://www.delhivery.com/track/package/1234567890123'],
    body:
      'Hi {{1}}, your replacement for order {{2}} is on its way.\n\n' +
      '*Courier:* {{3}}\n*Tracking ID:* {{4}}\n\n' +
      'Track it here: {{5}}\n\n' +
      'Any issues? Just reply here.' + SIGN,
  },

  // ── D. Delivery failures ───────────────────────────────────────────────────
  {
    key: 'delivery_delay',
    name: 'munchingo_delivery_delay_notice',
    trigger: 'manual',
    when: 'Parcel is late (courier delay, weather, strike). Offers cancel-for-refund so it is a real option, not a stall.',
    params: ['customer_name', 'order_id', 'reason', 'new_date'],
    example: ['Aarav', 'MNG-4821-0310', 'a courier delay in your area', '14 Oct'],
    body:
      "Hi {{1}}, a quick update on order {{2}}: it's running late because of {{3}}.\n\n" +
      "The new expected delivery date is {{4}}. We're sorry for the wait.\n\n" +
      "If you'd rather cancel, reply *CANCEL* and we'll refund you in full." + SIGN,
  },
  {
    key: 'delivery_failed',
    name: 'munchingo_delivery_attempt_failed',
    trigger: 'manual',
    when: 'Courier attempt failed (nobody home, address incomplete, phone unreachable). Parcel not yet RTO.',
    params: ['customer_name', 'order_id', 'reason'],
    example: ['Aarav', 'MNG-4821-0310', 'no one was available at the address'],
    body:
      "Hi {{1}}, the courier couldn't deliver order {{2}} because {{3}}.\n\n" +
      'Reply *REDELIVER* (with any address correction) and we will arrange another attempt, ' +
      "or reply *REFUND* to cancel — we'll confirm the refund amount in our next message." + SIGN,
  },
  {
    key: 'returned_to_us',
    name: 'munchingo_order_returned_to_us',
    trigger: 'manual',
    when: 'Parcel came back to Bikaner (RTO) after failed attempts.',
    params: ['customer_name', 'order_id'],
    example: ['Aarav', 'MNG-4821-0310'],
    body:
      'Hi {{1}}, order {{2}} has been returned to us after delivery attempts did not succeed.\n\n' +
      'Reply here and tell us what you prefer: we can re-ship it to an address you confirm, ' +
      "or refund you. We'll confirm the refund amount before processing it." + SIGN,
  },
  {
    key: 'shipment_lost',
    name: 'munchingo_shipment_lost',
    trigger: 'manual',
    when: 'Courier confirms the parcel is lost (Delhivery ticket). Always the customer\'s choice.',
    params: ['customer_name', 'order_id', 'awb', 'amount'],
    example: ['Aarav', 'MNG-4821-0310', '1234567890123', '518'],
    body:
      "Hi {{1}}, we're sorry — the courier has been unable to locate order {{2}} (tracking ID {{3}}).\n\n" +
      "We'll make it right at no cost to you. Reply *RESHIP* for a free replacement, " +
      'or *REFUND* for a full refund of ₹{{4}}.' + SIGN,
  },
  // ── E. Order confirmation (replaces the live v1, which promised 24h dispatch + tracking) ──
  {
    key: 'order_confirmed',
    name: 'munchingo_order_confirmed_v2',
    trigger: 'auto', // payment_link.paid; server.js reads ORDER_CONFIRMED_TEMPLATE, switch it to this name once Meta approves
    when: 'Payment received. Promises dispatch within 48 hours of payment (never less) and NO tracking/delivery date.',
    params: ['customer_name', 'order_id', 'items', 'amount'],
    example: ['Aarav', 'MNG-4821-0310', '2x Atta Kesari, 1x Atta Original', '518'],
    body:
      'Hi {{1}}, payment received! \u2705\n\nYour Munchingo order is confirmed.\n\n' +
      '*Order ID:* {{2}}\n*Items:* {{3}}\n*Amount Paid:* \u20B9{{4}}\n\n' +
      'We pack and dispatch every order within 48 hours of payment. Delivery time after that depends on your location and the courier. ' +
      "We'll message you if anything changes.\n\nThank you for choosing pure ghee, no compromise. \u{1F64F}" + SIGN.replace('\n\n', '\n'),
  },
];

for (const t of TEMPLATES) {
  const h = HI[t.key];
  t.hi = h ? { body: h.body, example: h.example || t.example } : null;
}

const BY_KEY = Object.fromEntries(TEMPLATES.map((t) => [t.key, t]));

/** Build the data → ordered params array for a scenario; throws if a field is missing. */
function buildParams(tpl, data) {
  return tpl.params.map((field) => {
    const v = data[field];
    if (v === undefined || v === null || String(v).trim() === '') {
      throw new Error(`Template ${tpl.name}: missing field "${field}"`);
    }
    // Meta rejects newlines / tabs / 4+ consecutive spaces inside a variable.
    return String(v).replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim();
  });
}

/**
 * Send one scenario's template in the customer's language (stored choice, or
 * pass `lang` explicitly). A Hindi send that fails (template not approved yet,
 * etc.) retries in English; if English fails too this throws so the caller can
 * fall back (free text inside the 24h window, then email, then an owner alert).
 * NB: free-text values (reason, item, new_date...) must already be in the
 * language you send in.
 */
async function sendScenario(to, key, data, lang) {
  const tpl = BY_KEY[key];
  if (!tpl) throw new Error(`Unknown refund template key: ${key}`);
  const chosen = lang || (await getLang(to));
  const params = buildParams(tpl, data);
  if (chosen === 'hi' && tpl.hi) {
    try {
      return await wa.sendTemplate(to, tpl.name, 'hi', params);
    } catch (err) {
      console.warn(`[REFUND] Hindi template ${tpl.name} failed (${err.message}) — retrying in English`);
    }
  }
  return wa.sendTemplate(to, tpl.name, 'en', params);
}

/** Pairs of [placeholder count in body, params length] must agree — checked in tests/CI. */
function validate() {
  const problems = [];
  for (const t of TEMPLATES) {
    const nums = [...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
    const max = Math.max(0, ...nums);
    if (max !== t.params.length) problems.push(`${t.name}: body has ${max} vars, params has ${t.params.length}`);
    if (t.example.length !== t.params.length) problems.push(`${t.name}: example count mismatch`);
    for (let i = 1; i <= max; i++) if (!nums.includes(i)) problems.push(`${t.name}: variable {{${i}}} missing`);
    if (/^\{\{\d+\}\}|\{\{\d+\}\}\s*$/.test(t.body)) problems.push(`${t.name}: variable at start/end of body`);
    if (/\{\{\d+\}\}\{\{\d+\}\}/.test(t.body)) problems.push(`${t.name}: adjacent variables`);
    if (t.body.length > 1024) problems.push(`${t.name}: body ${t.body.length} > 1024 chars`);
    if (!/^[a-z0-9_]{1,512}$/.test(t.name)) problems.push(`${t.name}: invalid name`);
  }
  for (const t of TEMPLATES) {
    if (!t.hi) { problems.push(`${t.name}: missing Hindi`); continue; }
    const en = [...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])).join(',');
    const hi = [...t.hi.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])).join(',');
    if (en !== hi) problems.push(`${t.name}: Hindi variables (${hi}) differ from English (${en})`);
    if (/^\{\{\d+\}\}|\{\{\d+\}\}\s*$/.test(t.hi.body)) problems.push(`${t.name}: Hindi variable at start/end`);
    if (t.hi.body.length > 1024) problems.push(`${t.name}: Hindi body too long`);
    if (t.hi.example.length !== t.params.length) problems.push(`${t.name}: Hindi example count mismatch`);
    if (!/[\u0900-\u097F]/.test(t.hi.body)) problems.push(`${t.name}: Hindi body has no Devanagari`);
  }
  const names = TEMPLATES.map((t) => t.name);
  if (new Set(names).size !== names.length) problems.push('duplicate template names');
  return problems;
}

module.exports = { TEMPLATES, BY_KEY, sendScenario, buildParams, validate };
