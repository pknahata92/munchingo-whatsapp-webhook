'use strict';

/**
 * Channel sync: the Meta catalogue and Google Merchant Center follow the admin's stock and prices.
 * - nudge(reason) after every stock or price change and paid order: 3 s later, push only the items that changed.
 * - startSweep(): every 15 min (first run 3 min after boot) read both channels back and push wherever they differ.
 * - Each channel is off, test (Original only) or all; every channel starts off, even with its key set. Only the owner switches it.
 * - Nothing is pushed until stock and prices are loaded: a guess would put the whole catalogue out of stock.
 * - Alerts: one email per episode after 3 failures in a row, or a mismatch older than 30 min. The admin shows a failed try at once.
 * State is JSON in stock_settings key channel_sync. Nothing here throws into a caller, except setMode's validation.
 */
const { SLUGS, META_IDS, GOOGLE_OFFER_IDS, publicState, sameState, priceUnsynced } = require('./channels/shape');

const KEY = 'channel_sync';
const DEBOUNCE_MS = 3000, FIRST_SWEEP_MS = 180000, SWEEP_MS = 900000, REPUSH_MS = 20 * 60000, ALERT_MS = 30 * 60000, ALERT_FAILS = 3;
const CHANNELS = { meta: { label: 'Meta', ids: META_IDS }, google: { label: 'Google', ids: GOOGLE_OFFER_IDS } };
const MODES = ['off', 'test', 'all'];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);   // never an inherited name such as constructor or __proto__

// ---- dependencies: the real ones are built on first use, once; setDeps (tests, practice admin) puts some in their place ----
async function dbLoad() {
  const { data, error } = await require('./database').client().from('stock_settings').select('value').eq('key', KEY).maybeSingle();
  if (error) throw new Error(error.message);
  return data && data.value ? JSON.parse(data.value) : null;
}
async function dbSave(state) {
  const { error } = await require('./database').client().from('stock_settings').upsert({ key: KEY, value: JSON.stringify(state) });
  if (error) throw new Error(error.message);
}
const MAKERS = {
  meta: () => require('./channels/meta').client(),
  google: () => require('./channels/google').client(),     // one instance: its access-token cache lives in it
  load: () => dbLoad,
  save: () => dbSave,
  stock: () => require('./stock'),
  prices: () => require('./prices'),
  isAvailable: () => require('./catalog').isAvailable,
  mail: () => (alert) => require('./mailer').sendChannelSyncAlert(alert),
  now: () => Date.now,
  setTimer: () => (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
  log: () => ({ info: (m) => console.log(m), error: (m) => console.error(m) }),
  runOnce: () => runCore,                                  // the run itself, unserialised (tests replace it)
};
const real = {};
let over = {};
const dep = (k) => (k in over ? over[k] : (real[k] = real[k] || MAKERS[k]()));

// Only the message is ever logged (the clients already scrub tokens out of it), never an error object.
const errText = (e) => String((e && e.message) || e || 'unknown error').slice(0, 200);
// The same message in the owner's words: the client's "meta: " or "google: <slug>: " comes off here, at the source (it stays in the log).
function plain(e) {
  let m = String((e && e.message) || e || 'unknown error').replace(/^(meta|google): /, '');
  const slug = SLUGS.find((x) => m.startsWith(`${x}: `));
  if (slug) m = m.slice(slug.length + 2);
  return m.slice(0, 200);
}
const failText = (ch, kind, msg) => `${CHANNELS[ch].label} ${kind === 'read' ? 'could not be read' : 'did not accept the change'}: ${msg || 'no reason given'}`;
const info = (m) => { try { dep('log').info(`[CHANNELS] ${m}`); } catch (_) { /* logging never breaks a run */ } };
const oops = (m, e) => { try { dep('log').error(`[CHANNELS] ${m}: ${errText(e)}`); } catch (_) { /* as above */ } };
const iso = (ms) => { if (ms == null) return null; const d = new Date(ms); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

// Every change of state goes through this queue, so a run, a mode switch and a setup never overwrite each other.
let tail = Promise.resolve();
const serial = (fn) => { const p = tail.then(fn); tail = p.then(() => {}, () => {}); return p; };

// ---- state ----
// Per item: want, pushed, shown (null = not found), pushedAt, fails, lastError + errorKind ('read' | 'push'), failing (the latest
// try failed), mismatchSince, alertedAt. Times are ms.
const blank = () => ({ meta: { mode: 'off', items: {} }, google: { mode: 'off', source: null, names: {}, missing: [], items: {} } });
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// A malformed saved row never breaks status() or a run: entries that are not objects are dropped (the next read rebuilds them),
// and times that are not numbers are ignored.
function normalise(saved) {
  const s = blank();
  Object.keys(CHANNELS).forEach((ch) => {
    const c = Object.assign(s[ch], isObj(saved) && isObj(saved[ch]) ? saved[ch] : {});
    if (!MODES.includes(c.mode)) c.mode = 'off';
    const items = isObj(c.items) ? c.items : {};
    c.items = {};
    Object.keys(items).forEach((slug) => {
      const it = items[slug];
      if (!isObj(it)) return;
      ['pushedAt', 'mismatchSince', 'alertedAt'].forEach((k) => { if (k in it && !Number.isFinite(it[k])) delete it[k]; });
      ['want', 'pushed'].forEach((k) => { if (k in it && !isObj(it[k])) delete it[k]; });
      if ('shown' in it && it.shown !== null && !isObj(it.shown)) delete it.shown;
      if ('fails' in it && !Number.isFinite(it.fails)) it.fails = 0;
      c.items[slug] = it;
    });
    if ('checkedAt' in c && !Number.isFinite(c.checkedAt)) delete c.checkedAt;
  });
  if (!isObj(s.google.names)) s.google.names = {};
  if (!Array.isArray(s.google.missing)) s.google.missing = [];
  if (typeof s.google.source !== 'string' || !s.google.source) s.google.source = null;
  return s;
}
let last = null;     // the state as last read or written, for status() when the database is out
async function loadState() { last = normalise(await dep('load')()); return last; }
async function saveState(state) { await dep('save')(state); last = state; }

// ---- pure decisions ----
const managed = (mode) => (mode === 'all' ? SLUGS : mode === 'test' ? ['atta-original'] : []);
const differs = (want, had) => !had || !sameState(want, had);
const matches = (it) => it.shown != null && !!it.want && sameState(it.want, it.shown);
const configured = (ch) => { try { return !!dep(ch).configured(); } catch (e) { return false; } };
const usable = (ch, c) => configured(ch) && c.mode !== 'off' && (ch !== 'google' || !!c.source);
const nameOf = (slug) => require('./catalog').nameForSlug(slug) || slug;
const money = (st) => (st.price == null ? ' with no price' : ` at Rs ${st.price}${st.mrp != null ? ` (MRP ${st.mrp})` : ''}`);
const summary = (st, withPrice) => `${st.availability || 'nothing'}${withPrice ? money(st) : ''}`;

// No MRP: the channel's own price is left alone, so one that differs from the web price is reported (Ruling 15).
const priceOff = (it) => isObj(it.shown) && isObj(it.want) && priceUnsynced(it.want, it.shown);

// The one problem an item has, or null: not found in the channel, failing 3 times, mismatched for over 30 min, or a price left behind.
function problemFor(ch, slug, it, t) {
  const L = CHANNELS[ch].label; const name = nameOf(slug);
  let text = null;
  if (it.shown === null) text = `not found in ${L}: ${CHANNELS[ch].ids[slug]}`;
  else if ((it.fails || 0) >= ALERT_FAILS) text = failText(ch, it.errorKind, it.lastError);
  else if (it.shown && it.want && !matches(it) && it.mismatchSince != null && t - it.mismatchSince > ALERT_MS) {
    const withPrice = it.want.mrp != null && (it.want.price !== it.shown.price || it.want.mrp !== it.shown.mrp);
    text = `${name} shows ${summary(it.shown, withPrice)}; the admin says ${summary(it.want, withPrice)}`;
  } else if (priceOff(it)) text = `${name}: price not synced (no MRP above the web price). Set the price by hand in Commerce Manager and the Google sheet.`;
  return text && { slug, name, text };
}
const alertDue = (it, t) => !it.alertedAt && ((it.fails || 0) >= ALERT_FAILS || (it.mismatchSince != null && t - it.mismatchSince > ALERT_MS) || priceOff(it));

// Rule 4 for one item after a read-back (shown == null: not found). Returns whether to push it.
function afterRead(it, shown, want, t) {
  if (it.shown === null && shown != null) { delete it.mismatchSince; delete it.alertedAt; }   // found again (set up again): a new episode
  it.shown = shown == null ? null : shown;
  delete it.failing;                                        // this read worked
  if (shown != null && sameState(want, shown)) {
    it.pushed = want; it.fails = 0;
    delete it.mismatchSince; delete it.lastError; delete it.errorKind;
    if (!priceUnsynced(want, shown)) delete it.alertedAt;   // a price left behind stays one episode: one email, not one per run
    return false;
  }
  if (it.mismatchSince == null) it.mismatchSince = t;
  if (shown == null) return false;                          // reported, never created
  return differs(want, it.pushed) || it.pushedAt == null || t - it.pushedAt > REPUSH_MS;
}

// Which items of a batch landed. Google stops at the first failed item and names it; any other failure fails the whole batch.
function outcome(slugs, e) {
  const m = /^google: ([a-z-]+): /.exec(errText(e));
  const at = m ? slugs.indexOf(m[1]) : -1;
  return at < 0 ? { done: [], failed: slugs } : { done: slugs.slice(0, at), failed: [slugs[at]] };
}

// ---- one run ----
// Returns the slugs that failed.
async function pushItems(ch, c, slugs, want, t, res, reason) {
  slugs.forEach((slug) => { if (want[slug].mrp == null) info(`${ch}: price not synced: no MRP (${slug})`); });
  const items = slugs.map((slug) => ({ slug, state: want[slug] }));
  let done = slugs, failed = [], err = null;
  try { await (ch === 'google' ? dep(ch).push(items, { source: c.source, names: c.names }) : dep(ch).push(items)); }
  catch (e) { err = e; ({ done, failed } = outcome(slugs, e)); }
  done.forEach((slug) => { const it = c.items[slug]; it.pushed = want[slug]; it.pushedAt = t; delete it.failing; if (it.mismatchSince == null) it.mismatchSince = t; });
  if (done.length) info(`${ch}: pushed ${done.map((s) => `${s} (${want[s].availability})`).join(', ')}${reason ? ` after ${reason}` : ''}`);
  res.pushed.push(...done);
  if (err) countFailure(ch, c, failed, err, res, 'push');
  return failed;
}
// kind 'read' or 'push': the owner is told which (a refused read is not a refused change).
function countFailure(ch, c, slugs, e, res, kind) {
  const msg = plain(e);
  slugs.forEach((slug) => { const it = c.items[slug]; it.fails = (it.fails || 0) + 1; it.lastError = msg; it.errorKind = kind; it.failing = true; });
  res.errors.push(failText(ch, kind, msg));
  oops(`${ch}: ${kind} failed`, e);
}
async function alertNew(ch, c, slugs, t) {
  const due = slugs.filter((slug) => alertDue(c.items[slug], t)).map((slug) => problemFor(ch, slug, c.items[slug], t)).filter(Boolean);
  if (!due.length) return;
  try {
    await dep('mail')({ channel: ch, problems: due });
    due.forEach((p) => { c.items[p.slug].alertedAt = t; });
    info(`${ch}: alert sent (${due.map((p) => p.slug).join(', ')})`);
  } catch (e) { oops(`${ch}: could not send the alert, will try again next run`, e); }
}
// force (Test with Original): push the managed items first, whatever the channel shows, then read back. A product known to be
// missing (not found, or no Google name) is never pushed. A refused push is not read back: a matching read would hide the refusal.
async function syncChannel(ch, c, want, { readBack, reason, force }, res) {
  const t = dep('now')(); const slugs = managed(c.mode);
  slugs.forEach((slug) => { c.items[slug] = Object.assign(c.items[slug] || {}, { want: want[slug] }); });
  if (force) {
    const first = slugs.filter((slug) => c.items[slug].shown !== null && (ch !== 'google' || !!c.names[slug]));
    if (first.length && (await pushItems(ch, c, first, want, t, res, reason)).length) { await alertNew(ch, c, slugs, t); return; }
  }
  let todo = [];
  if (!readBack) todo = slugs.filter((slug) => c.items[slug].shown !== null && differs(want[slug], c.items[slug].pushed));
  else {
    let shown = null;
    try { shown = await (ch === 'google' ? dep(ch).read(slugs, c.names) : dep(ch).read(slugs)); }
    catch (e) { countFailure(ch, c, slugs, e, res, 'read'); }
    if (shown) { c.checkedAt = t; todo = slugs.filter((slug) => afterRead(c.items[slug], shown[slug], want[slug], t)); }
  }
  if (todo.length) await pushItems(ch, c, todo, want, t, res, reason);
  await alertNew(ch, c, slugs, t);
}
let skipNoted = false;   // "skipped" is logged once per episode, not on every nudge
async function runCore({ readBack = false, reason = '', force = null } = {}) {
  let state;
  try { state = await loadState(); } catch (e) { oops('could not read the saved state; nothing pushed', e); return { skipped: 'state not loaded' }; }
  const res = {}; Object.keys(CHANNELS).forEach((ch) => { res[ch] = { pushed: [], errors: [] }; });
  const inUse = Object.keys(CHANNELS).filter((ch) => usable(ch, state[ch]));
  if (!inUse.length) return res;                            // nothing switched on: no stock or price refresh, nothing saved
  const stock = dep('stock'); const prices = dep('prices');
  try { await Promise.all([stock.refresh(), prices.refresh()]); } catch (e) { oops('could not refresh stock or prices', e); }
  if (stock.soldOutSlugs() == null || !prices.isOn()) {
    if (!skipNoted) { skipNoted = true; info('skipped: stock or prices not loaded'); }
    return { skipped: 'stock or prices not loaded' };
  }
  skipNoted = false;
  const want = publicState({ isAvailable: dep('isAvailable'), prices: prices.current() });
  for (const ch of inUse) {
    try { await syncChannel(ch, state[ch], want, { readBack, reason, force: force === ch }, res[ch]); }
    catch (e) { res[ch].errors.push(`Could not check ${CHANNELS[ch].label} just now. Try again.`); oops(`${ch}: run failed`, e); }
  }
  try { await saveState(state); } catch (e) { oops('could not save the state', e); }
  return res;
}
// A run's failures in the owner's words, for the toast after Test with Original, Switch on all four or Check now.
const SKIPPED = {
  'stock or prices not loaded': 'Nothing was sent or checked: the stock or prices could not be read just now. Try again in a minute.',
  'state not loaded': 'Nothing was sent or checked: the saved Meta and Google settings could not be read just now. Try again.',
  'run failed': 'Nothing was sent or checked: something went wrong. Try again.',
};
function runErrors(run) {
  if (!run) return [];
  if (run.skipped) return [SKIPPED[run.skipped] || SKIPPED['run failed']];
  return Object.keys(CHANNELS).reduce((all, ch) => all.concat((run[ch] && run[ch].errors) || []), []);
}

// ---- the public calls ----
function runOnce(opts = {}) {
  return serial(() => dep('runOnce')(opts)).catch((e) => { oops('run failed', e); return { skipped: 'run failed' }; });
}
const sweepOnce = () => runOnce({ readBack: true, reason: 'sweep' });
// The owner's Check now: a sweep, then the status with that run's failures in plain words (errors).
async function checkNow() { const run = await sweepOnce(); return Object.assign(await status(), { errors: runErrors(run) }); }

// The first nudge opens a 3 s window; later nudges ride along. A nudge while a run is going queues one more run, never more.
let armed = false, queued = false, reasons = new Set();
function flush() {
  armed = false;
  if (queued) return;          // a run is already waiting behind the current one: it will read the newest stock
  queued = true;
  serial(() => { queued = false; const reason = [...reasons].join(', '); reasons = new Set(); return dep('runOnce')({ readBack: false, reason }); })
    .catch((e) => oops('run after a change failed', e));
}
function nudge(reason) {
  try {
    reasons.add(String(reason || 'change'));
    if (armed) return;
    armed = true;
    dep('setTimer')(flush, DEBOUNCE_MS);
  } catch (e) { armed = false; oops('nudge', e); }
}

let sweeping = false;
function startSweep() {
  if (sweeping) return;
  sweeping = true;
  const arm = (ms) => { try { dep('setTimer')(tick, ms); } catch (e) { oops('could not set the sweep timer', e); } };
  const tick = async () => { try { await sweepOnce(); } finally { arm(SWEEP_MS); } };
  arm(FIRST_SWEEP_MS);
}

// why: token not set, not set up, switched off, problem, last try failed (error says what), waiting for <Channel> to update, matches.
// testPassed (Switch on all four): test mode, Original matches, and its last push went through before the last read-back.
function channelStatus(ch, c, t) {
  const L = CHANNELS[ch].label;
  const slugs = usable(ch, c) ? managed(c.mode) : [];
  const problems = slugs.map((slug) => problemFor(ch, slug, c.items[slug] || {}, t)).filter(Boolean);
  const failing = slugs.map((slug) => c.items[slug] || {}).find((it) => it.failing);
  const why = !configured(ch) ? 'token not set' : ch === 'google' && !c.source ? 'not set up' : c.mode === 'off' ? 'switched off'
    : problems.length ? 'problem' : failing ? 'last try failed' : slugs.some((slug) => !matches(c.items[slug] || {})) ? `waiting for ${L} to update` : 'matches';
  const orig = c.items['atta-original'] || {};
  const testPassed = why === 'matches' && c.mode === 'test' && orig.pushedAt != null && c.checkedAt != null && orig.pushedAt <= c.checkedAt && !orig.fails;
  const items = {};
  Object.keys(c.items).forEach((slug) => {
    const it = c.items[slug];
    items[slug] = { want: it.want || null, pushed: it.pushed || null, shown: it.shown, pushedAt: iso(it.pushedAt), fails: it.fails || 0, lastError: it.lastError || null };
  });
  return { on: slugs.length > 0, mode: c.mode, why, error: failing ? failText(ch, failing.errorKind, failing.lastError) : null, checkedAt: iso(c.checkedAt),
    problems, missing: ch === 'google' ? (c.missing || []).slice() : [], testPassed, items };
}
async function status() {
  let state;
  try { state = await loadState(); } catch (e) { oops('status: could not read the saved state', e); state = last || blank(); }
  const t = dep('now')();
  return { meta: channelStatus('meta', state.meta, t), google: channelStatus('google', state.google, t) };
}

const actorEmail = (a) => (typeof a === 'string' ? a : (a && (a.email || a.name)) || null);
// Resolves with status() plus errors: what the run after the switch could not do, in plain words.
async function setMode(channel, mode, actor) {
  if (typeof channel !== 'string' || !own(CHANNELS, channel)) throw new Error('Choose meta or google');
  if (!MODES.includes(mode)) throw new Error('Choose off, test or all');
  let saved = false;
  try {
    await serial(async () => {
      const state = await loadState(); const c = state[channel];
      if (c.mode !== mode) Object.values(c.items).forEach((it) => { delete it.mismatchSince; delete it.alertedAt; delete it.lastError; delete it.errorKind; delete it.failing; it.fails = 0; });
      Object.assign(c, { mode, modeBy: actorEmail(actor), modeAt: iso(dep('now')()) });
      await saveState(state);
      saved = true;
      info(`${channel}: mode ${mode} (by ${c.modeBy || 'unknown'})`);
    });
  } catch (e) { oops(`${channel}: could not switch to ${mode}`, e); }
  // Test with Original pushes Original once even when the channel already shows it (that proves it takes updates), then reads back.
  const run = saved && mode !== 'off' ? await runOnce({ readBack: true, reason: 'mode', force: mode === 'test' ? channel : null }) : null;
  return Object.assign(await status(), { errors: runErrors(run) });
}

// One setup at a time: a second call while one runs gets the same promise. A failure comes back as { error, steps done }, never thrown.
// Safe to run again: the names are found afresh, so a fixed offer id starts syncing; with Google on, it reads back straight away.
let setupRun = null;
function setupGoogle(actor) {
  if (!setupRun) {
    let readAfter = false;
    setupRun = serial(async () => {
      const r = await dep('google').setup();
      try {
        const state = await loadState();
        Object.assign(state.google, { source: r.source, names: r.names || {}, missing: r.missing || [], setupBy: actorEmail(actor), setupAt: iso(dep('now')()) });
        await saveState(state);
        readAfter = state.google.mode !== 'off';
        info(`google: set up (${Object.keys(r.names || {}).length} products found)`);
        return r;
      } catch (e) { oops('google: could not save the setup', e); return { ...r, error: errText(e) }; }
    }).catch((e) => { oops('google: setup failed', e); return { registered: false, source: null, names: {}, missing: [], steps: e && Array.isArray(e.steps) ? e.steps : [], error: errText(e) }; })
      .then(async (r) => { if (readAfter) await runOnce({ readBack: true, reason: 'set-up' }); return r; })
      .finally(() => { setupRun = null; });
  }
  return setupRun;
}

// Tests and the practice admin only: d replaces some dependencies (the rest stay real); setDeps(null) goes back to the real ones.
function setDeps(d) {
  over = Object.assign({}, d || {});
  tail = Promise.resolve(); armed = false; queued = false; reasons = new Set(); sweeping = false; setupRun = null; last = null; skipNoted = false;
}

module.exports = { setDeps, nudge, runOnce, sweepOnce, checkNow, startSweep, status, setMode, setupGoogle };
