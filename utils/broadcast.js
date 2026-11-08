'use strict';
// Broadcasts (8 Nov 2026). Sends ONE Meta-approved marketing template to everyone who said yes to WhatsApp updates
// (contacts.consent_marketing = true; STOP sets it false). Run by hand from GitHub Actions > Broadcast, in this order:
//   dry  -> counts only, sends nothing
//   test -> sends to OWNER_PHONE only, so Prashant sees the real message
//   send -> needs expect=<the dry-run count>, so nothing goes out that was not counted first
// OWNER_PHONE is on every send, first, as the live check (Prashant, 8 Nov). sources=stall,fair limits it to people who
// signed up at those places (contacts.first_source / last_source), e.g. a review ask only to people who bought.
// Every real send is logged in marketing_sends (marketing_sends_migration.sql): nobody gets the same template twice even
// if the job is re-run, and nobody gets more than CAP marketing messages in 30 days (the sign-up promise: "a few a month").
// Tests: scripts/broadcast-test.js

const CAP = 3, CAP_DAYS = 30, GAP_MS = 1100;
// Meta: after error 131049 (per-user marketing limit) do not resend to that person for at least 24 hours, or the block
// deepens. We wait 48, across all marketing templates.
const COOL_OFF_MS = 48 * 3_600_000;
const SKIP_NAMES = /kaamke/i;   // Prashant's own test sign-up (3 Nov)
const MODES = ['dry', 'test', 'send'];

let deps = null;
function setDeps(d) { deps = d; } // tests only
function D() {
  if (deps) return deps;
  return {
    db: require('./database'), wa: require('./whatsapp'), now: () => Date.now(),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)), ownerPhone: () => String(process.env.OWNER_PHONE || '').replace(/\D/g, ''),
  };
}

const digits = (p) => String(p || '').replace(/\D/g, '');

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

async function audience(template, sources, exclude = []) {
  const { db, now, ownerPhone } = D();
  const since = new Date(now() - CAP_DAYS * 86_400_000).toISOString();
  const [contacts, sends] = await Promise.all([db.listMarketingContacts(), db.listMarketingSends({ sinceIso: since, template })]);
  const sent = sends.filter((s) => s.status === 'sent');
  const coolSince = new Date(now() - COOL_OFF_MS).toISOString();
  const cooling = new Set(sends.filter((s) => s.status === 'failed' && /^131049\b/.test(String(s.error || '')) && s.sent_at >= coolSince).map((s) => digits(s.phone)));
  const done = new Set(sent.filter((s) => s.template === template).map((s) => digits(s.phone)));
  const recent = {};
  for (const s of sent) if (s.sent_at >= since) recent[digits(s.phone)] = (recent[digits(s.phone)] || 0) + 1;
  const owner = ownerPhone();
  const out = { list: [], already_sent: 0, over_cap: 0, skipped: 0, cooling_off: 0 };
  const seen = new Set([owner]);
  if (owner) { if (done.has(owner)) out.already_sent++; else if (cooling.has(owner)) out.cooling_off++; else out.list.push({ phone: owner, first: 'Prashant' }); }
  const has = (c, list) => list.some((x) => [c.first_source, c.last_source].some((v) => String(v || '').startsWith(x)));
  const fromSource = (c) => (!sources.length || has(c, sources)) && !(exclude.length && has(c, exclude));
  for (const c of contacts) {
    const p = digits(c.phone);
    if (c.consent_marketing !== true || !p || seen.has(p) || !fromSource(c)) continue;
    seen.add(p);
    if (SKIP_NAMES.test(c.name || '')) { out.skipped++; continue; }
    if (done.has(p)) { out.already_sent++; continue; }
    if (cooling.has(p)) { out.cooling_off++; continue; }
    if ((recent[p] || 0) >= CAP) { out.over_cap++; continue; }
    out.list.push({ phone: p, first: firstName(c.name) });
  }
  return out;
}

/** { template, lang, mode, video | image, expect, sources, exclude } -> counts only, never phone numbers. */
async function run({ template, lang = 'en', mode = 'dry', video = '', image = '', expect, sources = '', exclude = '' } = {}) {
  if (!/^[a-z0-9_]{1,512}$/.test(String(template || ''))) return { ok: false, error: 'template must be the approved template name (lowercase letters, numbers, _).' };
  if (!MODES.includes(mode)) return { ok: false, error: `mode must be one of ${MODES.join(', ')}.` };
  if (video && !/^https:\/\/\S+$/.test(video)) return { ok: false, error: 'video must be an https link to an .mp4.' };
  if (image && !/^https:\/\/\S+$/.test(image)) return { ok: false, error: 'image must be an https link to a .jpg or .png.' };
  if (video && image) return { ok: false, error: 'a template has one header: send a video or an image, not both.' };
  if (!/^[a-z0-9:,\- ]*$/i.test(String(sources))) return { ok: false, error: 'sources must look like stall,fair or stall:2026-11-06.' };
  if (!/^[a-z0-9:,\- ]*$/i.test(String(exclude))) return { ok: false, error: 'exclude must look like stall,fair.' };
  const list = (v) => String(v).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const src = list(sources), exc = list(exclude);
  const { db, wa, wait, ownerPhone } = D();
  const header = video ? { type: 'video', link: video } : image ? { type: 'image', link: image } : null;
  const a = await audience(template, src, exc);
  const counts = { already_sent: a.already_sent, over_cap: a.over_cap, skipped: a.skipped, cooling_off: a.cooling_off, to_send: a.list.length, recent: recent.slice() };

  if (mode === 'dry') return { ok: true, mode, template, ...counts };

  if (mode === 'test') {
    const owner = ownerPhone();
    if (!owner) return { ok: false, error: 'OWNER_PHONE is not set on Render.' };
    try { remember(await wa.sendTemplateWithHeader(owner, template, lang, header, ['Prashant']), template); return { ok: true, mode, template, sent: 1, ...counts }; }
    catch (e) { return { ok: false, mode, error: 'WhatsApp refused the test: ' + metaError(e) }; }
  }

  if (String(expect) !== String(a.list.length)) {
    return { ok: false, mode, ...counts, error: `send needs expect=${a.list.length} (the number a dry run would send right now).` };
  }
  let sent = 0, failed = 0;
  for (const p of a.list) {
    let status = 'sent', error = null, waId = null;
    try { waId = remember(await wa.sendTemplateWithHeader(p.phone, template, lang, header, [p.first]), template); sent++; }
    catch (e) { status = 'failed'; error = metaError(e).slice(0, 300); failed++; }
    try { await db.insertMarketingSend({ phone: p.phone, template, status, error, wa_message_id: waId }); }
    catch (e) { console.error('[BROADCAST] could not log a send:', e.message); }
    await wait(GAP_MS);
  }
  console.log(`[BROADCAST] ${template}: sent ${sent}, failed ${failed}`);
  return { ok: true, mode, template, sent, failed, ...counts };
}

function metaError(e) {
  const m = e && e.response && e.response.data && e.response.data.error;
  return m ? `${m.code || ''} ${m.message || ''} ${(m.error_data && m.error_data.details) || ''}`.trim() : String((e && e.message) || e);
}

module.exports = { run, firstName, noteStatus, resetStatuses, setDeps, CAP, CAP_DAYS };
