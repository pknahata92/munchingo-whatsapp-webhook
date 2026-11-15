'use strict';
// Broadcasts (8 Nov 2026). Sends ONE Meta-approved marketing template to everyone who said yes to WhatsApp updates
// (contacts.consent_marketing = true; STOP sets it false). Run by hand from GitHub Actions > Broadcast, in this order:
//   dry  -> counts only, sends nothing
//   test -> sends to OWNER_PHONE only, so Prashant sees the real message
//   send -> needs expect=<the dry-run count>, so nothing goes out that was not counted first
// OWNER_PHONE is on every send, first, as the live check (Prashant, 8 Nov). sources=stall,fair limits it to people who
// signed up at those places (contacts.first_source / last_source), e.g. a review ask only to people who bought.
// Rules (cap, cool-off, retry once, template + campaign, quiet hours) are in utils/marketingCap.js.
// Every real send is logged in marketing_sends (marketing_sends_migration.sql): nobody gets the same template twice even
// if the job is re-run, and nobody gets more than CAP marketing messages in 30 days (the sign-up promise: "a few a month").
// One segment only (spec §6.4, ruling R35, 16 Nov 2026): every run, any template or mode, leaves out a contact whose newest paid order
// went outside the delivery area (deliveryArea.inArea, which follows DELIVERY_NATIONWIDE) and anyone who complained in the last 30 days.
// A contact with no paid order is kept, as before (no pincode is guessed), and counted as no_paid_order. The owner is exempt (live check).
// J7 fresh-batch alert (growth A7, 16 Nov 2026): template=munchingo_fresh_batch with lots=<the new lot codes> and image=<the batch ticket
// picture>. Refused, in every mode, until each lot is the one packing takes for its Flavor (inventory.packingNext, the Packed step's own
// rule), so "Every box going out from today is from this batch" is true when it goes. Words: [first name, bake date, Flavors]; quick
// reply j7_remind (index 0, utils/journey.js stores the reminder yes) and the shop link (index 1) with utm_campaign=batch_<YYMMDD>. The
// last of the 3 monthly slots is left to a J6 reminder due now or within the week, while J6 is on (saved_for_reorder, ruling R34).
// Tests: scripts/broadcast-test.js

const { CAP, CAP_DAYS, slotFor, slotsLeft, isQuietHours } = require('./marketingCap');   // the cap, cool-off, retry-once and duplicate rules live there
const deliveryArea = require('./deliveryArea');
const lotRules = require('./lots');
const { FLAVOURS } = require('./reviews');
const GAP_MS = 1100;
const SKIP_NAMES = /kaamke/i;   // Prashant's own test sign-up (3 Nov)
const MODES = ['dry', 'test', 'send'];

const FRESH_BATCH = 'munchingo_fresh_batch';
const J7_REMIND = 'j7_remind';      // the quick reply utils/journey.js handleTap routes (ruling R10)
const DAY = 86_400_000;
const COMPLAINT_DAYS = 30;          // "Something wasn't right": no marketing for 30 days (as utils/reorders.js)
const J6_AHEAD_DAYS = 7;            // a J6 due within the week keeps the last monthly slot
const TEST_ORDER = /^MNG-TEST/i;
const NAME = Object.fromEntries(FLAVOURS);            // 'atta-ajwain' -> 'Atta Ajwain'
const PACK_ORDER = Object.keys(lotRules.LETTERS);     // Original, Kesari, Ajwain, Sugar-Lite: the order Flavors are named in
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// The words filled into the approved template ({{2}} the bake date, {{3}} the Flavors). A Hindi copy is a new key here, not new code.
const REPLIES = {
  en: {
    date: (iso) => `${parseInt(iso.slice(8, 10), 10)} ${MONTHS_EN[parseInt(iso.slice(5, 7), 10) - 1]}`,   // '2026-11-20' -> '20 November'
    flavours: (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`),
  },
};

let deps = null;
function setDeps(d) { deps = d; } // tests only
function D() {
  if (deps) return deps;
  return {
    db: require('./database'), wa: require('./whatsapp'), now: () => Date.now(),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)), ownerPhone: () => String(process.env.OWNER_PHONE || '').replace(/\D/g, ''),
    packingNext: () => require('./inventory').instance().packingNext(),
    reorderInput: (ms) => require('./reorders').loadInput(ms),
  };
}

const digits = (p) => String(p || '').replace(/\D/g, '');
const last10 = (p) => digits(p).slice(-10);
const at = (v) => Date.parse(v) || 0;

// Delivery results (8 Nov 2026): WhatsApp accepts a send, then reports delivered / read / failed a few seconds later on
// the webhook. For messages this module sent, the last few results are kept IN MEMORY only (no phone numbers, nothing
// written to the database) and shown on the next run, so a silent failure is seen before a big send.
const sentIds = new Map();   // WhatsApp message id -> template
const recent = [];
const RECENT_MAX = 20;
function resetStatuses() { sentIds.clear(); recent.length = 0; }   // tests only
function remember(res, template) {
  const id = res && res.messages && res.messages[0] && res.messages[0].id;
  if (id) { sentIds.set(id, template); if (sentIds.size > 500) sentIds.delete(sentIds.keys().next().value); }
  return id || null;
}
/** Called by the webhook for every status; keeps only results for broadcast messages. */
function noteStatus(s) {
  if (!s) return;
  const e = (s.errors && s.errors[0]) || {};
  // A send Meta accepted and then dropped (e.g. 131049) is marked failed in the log: it can be sent again and does not
  // count against the monthly cap. Checked for every failed status, so it still works after a server restart.
  if (s.status === 'failed' && s.id) {
    Promise.resolve().then(() => D().db.markMarketingSendFailed(s.id, `${e.code || ''} ${e.title || ''}`.trim().slice(0, 300)))
      .catch((err) => console.error('[BROADCAST] could not mark a failed send:', err.message));
  }
  if (!sentIds.has(s.id)) return;
  recent.unshift({ template: sentIds.get(s.id), status: s.status, code: e.code || null,
    reason: [e.title, e.message, e.error_data && e.error_data.details].filter(Boolean).join(' | ') || null, at: new Date(D().now()).toISOString() });
  recent.length = Math.min(recent.length, RECENT_MAX);
}
/** "mr. gaurav sharma" -> "Gaurav"; "~" or "KaamKe." -> "there". */
function firstName(name) {
  const w = String(name || '').trim().replace(/^(mr|mrs|ms|dr)\.?\s+/i, '').split(/\s+/)[0] || '';
  return /^[a-z][a-z'-]*$/i.test(w) ? w[0].toUpperCase() + w.slice(1).toLowerCase() : 'there';
}

/** The lots named for a fresh-batch alert, against the lot packing takes now for each Flavor (packingNext).
 *  -> { error } | { baked, flavours, campaign } (campaign: the default batch_<YYMMDD of the bake date>). */
async function batchFor(codes, lang) {
  const next = await D().packingNext();
  const same = (a, b) => a === b || a.toUpperCase() === b.toUpperCase();
  const picked = new Map();   // slug -> its packing lot
  for (const code of codes) {
    const slugs = Object.keys(next).filter((s) => next[s] && same(code, String(next[s].lot_code)));
    if (!slugs.length) {
      const slug = (lotRules.parseCode(code.toUpperCase()) || {}).slug;
      if (!slug) return { error: `${code} is not a lot being packed (codes look like MNGO-261120-01).` };
      const name = NAME[slug] || slug, cur = next[slug];
      return { error: `${code} is not the lot being packed for ${name} yet (${cur ? `packing takes ${cur.lot_code}` : `no ${name} lot can be packed now`}).` };
    }
    for (const s of slugs) picked.set(s, next[s]);
  }
  const slugs = [...picked.keys()].sort((a, b) => PACK_ORDER.indexOf(a) - PACK_ORDER.indexOf(b));
  const undated = slugs.find((s) => !picked.get(s).bake_date);
  if (undated) return { error: `Lot ${picked.get(undated).lot_code} has no bake date in Stock: add it before a fresh-batch alert.` };
  const days = [...new Set(slugs.map((s) => String(picked.get(s).bake_date).slice(0, 10)))].sort();
  if (days.length > 1) return { error: `These lots were baked on different days (${days.map(REPLIES.en.date).join(', ')}): send one alert per bake date.` };
  const R = REPLIES[lang] || REPLIES.en, day = days[0];
  return { baked: R.date(day), flavours: R.flavours(slugs.map((s) => NAME[s] || s)), campaign: `batch_${day.slice(2, 4)}${day.slice(5, 7)}${day.slice(8, 10)}` };
}

/** The segment on top of the shared gate (the owner, the live check, is exempt).
 *  -> { error } | { before(c), hasOrder(c), saveForReorder(phone, sends) }
 *  before: 'complaint' (one in the last 30 days) or 'outside_area' (the newest paid order went outside deliveryArea; no paid order stays
 *  in: "Delivering in Delhi NCR for now"), else null; every broadcast (R35). saveForReorder: the J7 alert only (withJ6), one slot left
 *  and a J6 due now or within 7 days, while J6 is on (R34). */
async function segmentRules(nowMs, withJ6) {
  const { db, reorderInput } = D();
  const newest = new Map();   // last 10 digits -> newest paid order (test orders are not where anyone lives)
  for (const o of await db.listPaidOrderAddresses()) {
    const k = last10(o.customer_phone);
    if (k.length < 10 || TEST_ORDER.test(String(o.order_id || ''))) continue;
    const cur = newest.get(k);
    if (!cur || at(o.created_at) >= at(cur.created_at)) newest.set(k, o);
  }
  const reorders = require('./reorders');
  const j6 = new Set();
  if (withJ6 && reorders.enabled()) {   // with J6 off no reminder will take the slot, so none is kept for one
    const input = await reorderInput(nowMs);
    if (input.blocked) return { error: input.blocked };
    for (const ms of [nowMs, nowMs + J6_AHEAD_DAYS * DAY]) for (const d of reorders.dueReorders({ ...input, nowMs: ms })) j6.add(last10(d.phone));
  }
  const PIN = /^[1-9]\d{5}$/;
  return {
    before(c) {
      if (c.last_complaint_at && nowMs - at(c.last_complaint_at) < COMPLAINT_DAYS * DAY) return 'complaint';
      const o = newest.get(last10(c.phone)), a = (o && o.delivery_address) || {};
      const pin = o ? [a.pincode, deliveryArea.pinIn(a.raw || '')].map((x) => String(x || '').trim()).find((x) => PIN.test(x)) : null;
      return pin && !deliveryArea.inArea(pin) ? 'outside_area' : null;
    },
    hasOrder: (c) => newest.has(last10(c.phone)),
    saveForReorder: (phone, sends) => j6.has(last10(phone)) && slotsLeft({ phone, sends, nowMs }) === 1,
  };
}

async function audience(template, sources, exclude = [], campaign = null, seg = null) {
  const { db, now, ownerPhone } = D();
  const nowMs = now();
  const [contacts, sends] = await Promise.all([db.listMarketingContacts(), db.listMarketingSends({ sinceIso: new Date(nowMs - CAP_DAYS * 86_400_000).toISOString(), template })]);
  const byPhone = new Map();
  for (const s of sends) { const k = digits(s.phone); if (!byPhone.has(k)) byPhone.set(k, []); byPhone.get(k).push(s); }
  const gate = (p) => slotFor({ phone: p, sends: byPhone.get(p) || [], nowMs, template, campaign });
  const owner = ownerPhone();
  const out = { list: [], already_sent: 0, over_cap: 0, skipped: 0, cooling_off: 0, blocked_twice: 0, complaint: 0, outside_area: 0, saved_for_reorder: 0, no_paid_order: 0 };
  const seen = new Set([owner]);
  const verdict = (p) => { const v = gate(p); if (v !== 'ok') out[v]++; return v === 'ok'; };
  // The owner is the live check on every send. Changed 15 Nov 2026: he used to be skipped on any non-ok verdict; now he is skipped
  // ONLY for already_sent and cooling_off, and never for over_cap or blocked_twice.
  if (owner) { const v = gate(owner); if (v === 'already_sent' || v === 'cooling_off') out[v]++; else out.list.push({ phone: owner, first: 'Prashant' }); }
  const has = (c, list) => list.some((x) => [c.first_source, c.last_source].some((v) => String(v || '').startsWith(x)));
  const fromSource = (c) => (!sources.length || has(c, sources)) && !(exclude.length && has(c, exclude));
  for (const c of contacts) {
    const p = digits(c.phone);
    if (c.consent_marketing !== true || !p || seen.has(p) || !fromSource(c)) continue;
    seen.add(p);
    if (SKIP_NAMES.test(c.name || '')) { out.skipped++; continue; }
    const why = seg && seg.before(c);
    if (why) { out[why]++; continue; }
    if (!verdict(p)) continue;
    if (seg && seg.saveForReorder(p, byPhone.get(p) || [])) { out.saved_for_reorder++; continue; }
    if (seg && !seg.hasOrder(c)) out.no_paid_order++;   // of to_send: no paid order, so the area is not known (kept, R35)
    out.list.push({ phone: p, first: firstName(c.name) });
  }
  return out;
}

/** { template, lang, mode, video | image, expect, sources, exclude, campaign, lots } -> counts only, never phone numbers. */
async function run({ template, lang = 'en', mode = 'dry', video = '', image = '', expect, sources = '', exclude = '', campaign = '', lots = '' } = {}) {
  if (!/^[a-z0-9_]{1,512}$/.test(String(template || ''))) return { ok: false, error: 'template must be the approved template name (lowercase letters, numbers, _).' };
  if (!MODES.includes(mode)) return { ok: false, error: `mode must be one of ${MODES.join(', ')}.` };
  if (video && !/^https:\/\/\S+$/.test(video)) return { ok: false, error: 'video must be an https link to an .mp4.' };
  if (image && !/^https:\/\/\S+$/.test(image)) return { ok: false, error: 'image must be an https link to a .jpg or .png.' };
  if (video && image) return { ok: false, error: 'a template has one header: send a video or an image, not both.' };
  if (!/^[a-z0-9:,\- ]*$/i.test(String(sources))) return { ok: false, error: 'sources must look like stall,fair or stall:2026-11-06.' };
  if (!/^[a-z0-9:,\- ]*$/i.test(String(exclude))) return { ok: false, error: 'exclude must look like stall,fair.' };
  if (!/^[a-z0-9_]{0,64}$/.test(String(campaign || ''))) return { ok: false, error: 'campaign must be lowercase letters, numbers, _ (for example batch_261120).' };
  if (!/^[A-Za-z0-9 ,._\/-]{0,300}$/.test(String(lots || ''))) return { ok: false, error: 'lots must be lot codes separated by commas, e.g. MNGO-261120-01,MNGA-261120-01.' };
  const codes = [...new Set(String(lots || '').split(',').map((x) => x.trim()).filter(Boolean))];
  const isFresh = template === FRESH_BATCH;
  if (codes.length && !isFresh) return { ok: false, error: `lots= is only for the fresh-batch template (${FRESH_BATCH}).` };
  if (isFresh && !codes.length) return { ok: false, error: 'A fresh-batch alert needs lots=<the new lot codes>, e.g. MNGO-261120-01,MNGA-261120-01.' };
  if (isFresh && !image) return { ok: false, error: 'A fresh-batch alert needs the batch ticket picture (image=https://…).' };   // R13: every send has its picture header
  if (mode === 'send' && isQuietHours(D().now())) return { ok: false, error: 'Quiet hours (21:00-09:00 IST): send after 9 AM.' };
  const list = (v) => String(v).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const src = list(sources), exc = list(exclude);
  const { db, wa, wait, ownerPhone, now } = D();
  const batch = isFresh ? await batchFor(codes, lang) : null;
  if (batch && batch.error) return { ok: false, error: batch.error };
  const header = video ? { type: 'video', link: video } : image ? { type: 'image', link: image } : null;
  const camp = String(campaign || '') || (batch && batch.campaign) || null;
  const seg = await segmentRules(now(), !!batch);
  if (seg.error) return { ok: false, error: seg.error };
  const a = await audience(template, src, exc, camp, seg);
  const counts = { already_sent: a.already_sent, over_cap: a.over_cap, skipped: a.skipped, cooling_off: a.cooling_off, blocked_twice: a.blocked_twice,
    complaint: a.complaint, outside_area: a.outside_area, ...(batch ? { saved_for_reorder: a.saved_for_reorder } : {}), no_paid_order: a.no_paid_order, to_send: a.list.length, recent: recent.slice() };
  const about = batch ? { campaign: camp, baked: batch.baked, flavours: batch.flavours } : {};
  // J7: the three words, the reminder quick reply (index 0) and the shop link (index 1); any other broadcast: the first name only
  const deliver = (to, first) => (batch
    ? wa.sendMarketingTemplate(to, template, lang, [first, batch.baked, batch.flavours], { quickReplies: [J7_REMIND], urlIndex: 1, urlSuffix: `shop?utm_source=whatsapp&utm_medium=broadcast&utm_campaign=${camp}`, header })
    : wa.sendMarketingTemplate(to, template, lang, [first], { header }));

  if (mode === 'dry') return { ok: true, mode, template, ...about, ...counts };

  if (mode === 'test') {
    const owner = ownerPhone();
    if (!owner) return { ok: false, error: 'OWNER_PHONE is not set on Render.' };
    try { remember(await deliver(owner, 'Prashant'), template); return { ok: true, mode, template, ...about, sent: 1, ...counts }; }
    catch (e) { return { ok: false, mode, error: 'WhatsApp refused the test: ' + metaError(e) }; }
  }

  if (String(expect) !== String(a.list.length)) {
    return { ok: false, mode, ...counts, error: `send needs expect=${a.list.length} (the number a dry run would send right now).` };
  }
  let sent = 0, failed = 0;
  for (const p of a.list) {
    let status = 'sent', error = null, waId = null;
    try { waId = remember(await deliver(p.phone, p.first), template); sent++; }
    catch (e) { status = 'failed'; error = metaError(e).slice(0, 300); failed++; }
    try { await db.insertMarketingSend({ phone: p.phone, template, campaign: camp, status, error, wa_message_id: waId }); }
    catch (e) { console.error('[BROADCAST] could not log a send:', e.message); }
    await wait(GAP_MS);
  }
  console.log(`[BROADCAST] ${template}: sent ${sent}, failed ${failed}`);
  return { ok: true, mode, template, ...about, sent, failed, ...counts };
}

function metaError(e) {
  const m = e && e.response && e.response.data && e.response.data.error;
  return m ? `${m.code || ''} ${m.message || ''} ${(m.error_data && m.error_data.details) || ''}`.trim() : String((e && e.message) || e);
}

module.exports = { run, firstName, noteStatus, resetStatuses, setDeps, CAP, CAP_DAYS, FRESH_BATCH, REPLIES };
