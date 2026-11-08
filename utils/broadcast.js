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
/** "mr. gaurav sharma" -> "Gaurav"; "~" or "KaamKe." -> "there". */
function firstName(name) {
  const w = String(name || '').trim().replace(/^(mr|mrs|ms|dr)\.?\s+/i, '').split(/\s+/)[0] || '';
  return /^[a-z][a-z'-]*$/i.test(w) ? w[0].toUpperCase() + w.slice(1).toLowerCase() : 'there';
}

async function audience(template, sources) {
  const { db, now, ownerPhone } = D();
  const since = new Date(now() - CAP_DAYS * 86_400_000).toISOString();
  const [contacts, sends] = await Promise.all([db.listMarketingContacts(), db.listMarketingSends({ sinceIso: since, template })]);
  const sent = sends.filter((s) => s.status === 'sent');
  const done = new Set(sent.filter((s) => s.template === template).map((s) => digits(s.phone)));
  const recent = {};
  for (const s of sent) if (s.sent_at >= since) recent[digits(s.phone)] = (recent[digits(s.phone)] || 0) + 1;
  const owner = ownerPhone();
  const out = { list: [], already_sent: 0, over_cap: 0, skipped: 0 };
  const seen = new Set([owner]);
  if (owner) { if (done.has(owner)) out.already_sent++; else out.list.push({ phone: owner, first: 'Prashant' }); }
  const fromSource = (c) => !sources.length || sources.some((x) => [c.first_source, c.last_source].some((v) => String(v || '').startsWith(x)));
  for (const c of contacts) {
    const p = digits(c.phone);
    if (c.consent_marketing !== true || !p || seen.has(p) || !fromSource(c)) continue;
    seen.add(p);
    if (SKIP_NAMES.test(c.name || '')) { out.skipped++; continue; }
    if (done.has(p)) { out.already_sent++; continue; }
    if ((recent[p] || 0) >= CAP) { out.over_cap++; continue; }
    out.list.push({ phone: p, first: firstName(c.name) });
  }
  return out;
}

/** { template, lang, mode, video, expect, sources } -> counts only, never phone numbers. */
async function run({ template, lang = 'en', mode = 'dry', video = '', expect, sources = '' } = {}) {
  if (!/^[a-z0-9_]{1,512}$/.test(String(template || ''))) return { ok: false, error: 'template must be the approved template name (lowercase letters, numbers, _).' };
  if (!MODES.includes(mode)) return { ok: false, error: `mode must be one of ${MODES.join(', ')}.` };
  if (video && !/^https:\/\/\S+$/.test(video)) return { ok: false, error: 'video must be an https link to an .mp4.' };
  if (!/^[a-z0-9:,\- ]*$/i.test(String(sources))) return { ok: false, error: 'sources must look like stall,fair or stall:2026-11-06.' };
  const src = String(sources).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const { db, wa, wait, ownerPhone } = D();
  const header = video ? { type: 'video', link: video } : null;
  const a = await audience(template, src);
  const counts = { already_sent: a.already_sent, over_cap: a.over_cap, skipped: a.skipped, to_send: a.list.length };

  if (mode === 'dry') return { ok: true, mode, template, ...counts };

  if (mode === 'test') {
    const owner = ownerPhone();
    if (!owner) return { ok: false, error: 'OWNER_PHONE is not set on Render.' };
    try { await wa.sendTemplateWithHeader(owner, template, lang, header, ['Prashant']); return { ok: true, mode, template, sent: 1, ...counts }; }
    catch (e) { return { ok: false, mode, error: 'WhatsApp refused the test: ' + metaError(e) }; }
  }

  if (String(expect) !== String(a.list.length)) {
    return { ok: false, mode, ...counts, error: `send needs expect=${a.list.length} (the number a dry run would send right now).` };
  }
  let sent = 0, failed = 0;
  for (const p of a.list) {
    let status = 'sent', error = null;
    try { await wa.sendTemplateWithHeader(p.phone, template, lang, header, [p.first]); sent++; }
    catch (e) { status = 'failed'; error = metaError(e).slice(0, 300); failed++; }
    try { await db.insertMarketingSend({ phone: p.phone, template, status, error }); }
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

module.exports = { run, firstName, setDeps, CAP, CAP_DAYS };
