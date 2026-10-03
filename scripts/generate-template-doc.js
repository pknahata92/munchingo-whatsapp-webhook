'use strict';
// Regenerates "Munchingo Design Files/whatsapp_refund_templates.md" from utils/refundTemplates.js
const fs = require('fs'); const path = require('path');
const { TEMPLATES, validate } = require('../utils/refundTemplates');
const problems = validate(); if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
const groups = [
  ['A', 'Refund lifecycle', ['refund_full','refund_partial','refund_initiated','refund_followup_arn','refund_failed']],
  ['B', 'Cancellations & payment mix-ups', ['cancel_by_customer','cancel_by_us','duplicate_payment','late_payment']],
  ['C', 'Damaged / wrong / stale claims', ['claim_received','claim_need_photo','claim_replacement','claim_refund','claim_declined','replacement_shipped']],
  ['D', 'Delivery failures', ['delivery_delay','delivery_failed','returned_to_us','shipment_lost']],
  ['E', 'Order confirmation v2 (48-hour dispatch)', ['order_confirmed']],
];
let o = `# Munchingo WhatsApp Refund, Claim & Delivery-Failure Templates

*Generated from \`webhook-backend/utils/refundTemplates.js\` (source of truth — edit there, then run \`node scripts/generate-template-doc.js\`). "Auto" = wired in the backend; "Manual" = you send it with \`sendScenario()\`.*

All ${TEMPLATES.length} are **UTILITY**, language \`en\`, prepaid-only (no COD). **Dispatch promise = within 48 hours of payment, never less** (decided 2026-10-03). Claims follow the terms page: photo within 48h of delivery, resolution aimed within 24h, no returns for taste or opened packs.

## How to submit
\`\`\`bash
cd "Munchingo Design Files/webhook-backend"
node scripts/submit-refund-templates.js            # dry run, validates all
node scripts/submit-refund-templates.js --submit   # sends to Meta (needs WABA_ID + WHATSAPP_TOKEN in .env)
\`\`\`
Or paste each body by hand in WhatsApp Manager → Message Templates, using the *example values* below.

**After \`munchingo_order_confirmed_v2\` is approved:** set \`ORDER_CONFIRMED_TEMPLATE=munchingo_order_confirmed_v2\` in Render's environment. Until then the old v1 (24h promise) keeps sending — do not switch early or customers get no WhatsApp confirmation.

## Language choice
On a customer's first WhatsApp chat the bot asks **English / हिन्दी** once and stores it (table \`customer_prefs\`, run \`customer_prefs_migration.sql\` in Supabase). Every template then sends in that language (Hindi falls back to English if the Hindi version isn't approved yet). Customers who never chat first (website checkout) get English. Reply keywords stay English (CANCEL / REDELIVER / REFUND / RESHIP). When sending a **Hindi** template manually, write the free-text values (reason, item, new_date, what_to_photograph) in Hindi.

## Scenario map
| Situation | Template |
|---|---|
| Payment received | \`order_confirmed\` (v2) — **auto** |
| You refund in Razorpay (full / partial) | \`refund_full\` / \`refund_partial\` — **auto** |
| Customer asks to cancel a paid order | \`cancel_by_customer\`, then refund in Razorpay |
| You cancel (stock, pincode, address) | \`cancel_by_us\`, then refund |
| Customer paid twice | \`duplicate_payment\` |
| Payment arrived after cancel/expiry | \`late_payment\` |
| Damage / wrong / stale reported | \`claim_received\` → (\`claim_need_photo\`) → \`claim_replacement\` / \`claim_refund\` / \`claim_declined\` |
| Replacement ships | \`replacement_shipped\` |
| Refund not showing after 5–7 days | \`refund_followup_arn\` |
| Refund bounced | \`refund_failed\` |
| Parcel late / attempt failed / returned / lost | \`delivery_delay\` / \`delivery_failed\` / \`returned_to_us\` / \`shipment_lost\` |
| Subscription renewal refund | \`refund_full\` / \`refund_partial\` |
| Gift order | same templates, to the **payer**, never the gift recipient |
| Coupon order | amount = what was actually paid after discount |

`;
for (const [l, t, keys] of groups) {
  o += `## ${l}. ${t}\n\n`;
  for (const k of keys) {
    const x = TEMPLATES.find((z) => z.key === k);
    o += `### \`${x.name}\`  ·  ${x.trigger.toUpperCase()}\n*When:* ${x.when}\n\n\`\`\`\n${x.body}\n\`\`\`\n*Variables / examples:* ${x.params.map((p, i) => `{{${i + 1}}} ${p} = \`${x.example[i]}\``).join(' · ')}\n\n**हिन्दी (\`hi\`)** — same name, same variables:\n\n\`\`\`\n${x.hi.body}\n\`\`\`\n*हिन्दी examples:* ${x.params.map((p, i) => `{{${i + 1}}} \`${x.hi.example[i]}\``).join(' · ')}\n\n`;
  }
}
o += `## Not templated on purpose
- **Chargeback / dispute** — internal; handle in Razorpay, message the customer personally.
- **Payment failed / link expired** — already handled by free-text messages in server.js.
- **Other languages** — only en + hi.

## Known gaps (backend, not copy)
- Razorpay \`refund.failed\` / \`refund.created\` events are not subscribed, so \`refund_failed\` / \`refund_initiated\` are manual.
- The real ARN is at \`refund.acquirer_data.arn\` in the refund.processed payload; not yet passed through.
- No template promises tracking or a delivery date.
`;
fs.writeFileSync(path.join(__dirname, '../../whatsapp_refund_templates.md'), o);
console.log('wrote doc,', o.length, 'chars');
