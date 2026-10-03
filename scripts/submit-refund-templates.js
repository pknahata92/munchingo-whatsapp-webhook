'use strict';
/**
 * Submit the refund/claim/delivery templates in utils/refundTemplates.js to Meta.
 *
 *   node scripts/submit-refund-templates.js            # DRY RUN: validates + prints payloads
 *   node scripts/submit-refund-templates.js --submit   # really POSTs to Meta (needs WABA_ID + WHATSAPP_TOKEN)
 *   node scripts/submit-refund-templates.js --submit --only munchingo_refund_processed_full
 *
 * Submitting is outward-facing (Meta reviews + caches the copy) so dry-run is the default.
 * Names that already exist are reported and skipped by Meta (error 2388023 duplicate).
 */
require('dotenv').config();
const axios = require('axios');
const { TEMPLATES, validate } = require('../utils/refundTemplates');

const submit = process.argv.includes('--submit');
const onlyIdx = process.argv.indexOf('--only');
const only = onlyIdx > -1 ? process.argv[onlyIdx + 1] : null;

// One entry per (template, language): WhatsApp keys templates by name + language.
const ENTRIES = TEMPLATES.flatMap((t) => [
  { ...t, lang: 'en' },
  { ...t, lang: 'hi', body: t.hi.body, example: t.hi.example },
]);

function payload(t) {
  return {
    name: t.name,
    language: t.lang,
    category: 'UTILITY',
    components: [{
      type: 'BODY',
      text: t.body,
      example: { body_text: [t.example.map(String)] },
    }],
  };
}

(async () => {
  const problems = validate();
  if (problems.length) { console.error('Validation failed:\n - ' + problems.join('\n - ')); process.exit(1); }
  const list = ENTRIES.filter((t) => !only || t.name === only);
  console.log(`${list.length} template(s) (English + Hindi) validated OK${submit ? '' : ' (dry run — pass --submit to send)'}\n`);

  for (const t of list) {
    if (!submit) { console.log(`--- ${t.name} [${t.lang}] [${t.trigger}]\n${t.body}\n`); continue; }
    try {
      const r = await axios.post(
        `https://graph.facebook.com/v21.0/${process.env.WABA_ID}/message_templates`,
        payload(t),
        { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
      );
      console.log(`SUBMITTED ${t.name} (${t.lang}) → id ${r.data.id}, status ${r.data.status}, category ${r.data.category}`);
    } catch (e) {
      console.error(`FAILED ${t.name} (${t.lang}):`, JSON.stringify(e.response?.data?.error || e.message));
    }
  }
})();
