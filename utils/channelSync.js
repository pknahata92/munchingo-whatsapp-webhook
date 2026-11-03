'use strict';

/**
 * Channel sync: the Meta catalogue and Google Merchant Center follow the admin's stock and prices.
 * - nudge(reason) after every stock or price change and paid order: 3 s later, push only the items that changed.
 * - startSweep(): every 15 min (first run 3 min after boot) read both channels back and push wherever they differ.
 * - Each channel is off, test (Original only) or all; every channel starts off, even with its key set. Only the owner switches it.
 * - Nothing is pushed until stock and prices are loaded: a guess would put the whole catalogue out of stock.
 * - Alerts: one email per episode after 3 failures in a row, or a mismatch older than 30 min.
 * State is JSON in stock_settings key channel_sync. Nothing here throws into a caller, except setMode's validation.
 */
const { SLUGS, META_IDS, GOOGLE_OFFER_IDS, publicState, sameState } = require('./channels/shape');

const KEY = 'channel_sync';
const DEBOUNCE_MS = 3000, FIRST_SWEEP_MS = 180000, SWEEP_MS = 900000, REPUSH_MS = 20 * 60000, ALERT_MS = 30 * 60000, ALERT_FAILS = 3;
const CHANNELS = { meta: { label: 'Meta', ids: META_IDS }, google: { label: 'Google', ids: GOOGLE_OFFER_IDS } };
const MODES = ['off', 'test', 'all'];

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
const info = (m) => { try { dep('log').info(`[CHANNELS] ${m}`); } catch (_) { /* logging never breaks a run */ } };
const oops = (m, e) => { try { dep('log').error(`[CHANNELS] ${m}: ${errText(e)}`); } catch (_) { /* as above */ } };
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

// Every change of state goes through this queue, so a run, a mode switch and a setup never overwrite each other.
let tail = Promise.resolve();
const serial = (fn) => { const p = tail.then(fn); tail = p.then(() => {}, () => {}); return p; };

// ---- state ----
const blank = () => ({ meta: { mode: 'off', items: {} }, google: { mode: 'off', source: null, names: {}, items: {} } });
function normalise(saved) {
  const s = blank();
  Object.keys(CHANNELS).forEach((ch) => {
    const c = Object.assign(s[ch], (saved && saved[ch]) || {});
    if (!MODES.includes(c.mode)) c.mode = 'off';
    if (!c.items || typeof c.items !== 'object') c.items = {};
  });
  s.google.names = s.google.names || {};
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

// The one problem an item has, or null: not found in the channel, failing, or mismatched for over 30 min.
function problemFor(ch, slug, it, t) {
  const L = CHANNELS[ch].label; const name = nameOf(slug);
  let text = null;
  if (it.shown === null) text = `not found in ${L}: ${CHANNELS[ch].ids[slug]}`;
  else if ((it.fails || 0) >= ALERT_FAILS) text = `${L} did not accept the change: ${String(it.lastError || '').replace(/^(meta|google): /, '')}`;
  else if (it.shown && it.want && !matches(it) && it.mismatchSince != null && t - it.mismatchSince > ALERT_MS) {
    const withPrice = it.want.mrp != null && (it.want.price !== it.shown.price || it.want.mrp !== it.shown.mrp);
    text = `${name} shows ${summary(it.shown, withPrice)}; the admin says ${summary(it.want, withPrice)}`;
  }
  return text && { slug, name, text };
}
const alertDue = (it, t) => !it.alertedAt && ((it.fails || 0) >= ALERT_FAILS || (it.mismatchSince != null && t - it.mismatchSince > ALERT_MS));

// Rule 4 for one item after a read-back (shown == null: not found). Returns whether to push it.
function afterRead(it, shown, want, t) {
  it.shown = shown == null ? null : shown;
  if (shown != null && sameState(want, shown)) {
    it.pushed = want; it.fails = 0;
    delete it.mismatchSince; delete it.alertedAt; delete it.lastError;
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
async function pushItems(ch, c, slugs, want, t, res, reason) {
  slugs.forEach((slug) => { if (want[slug].mrp == null) info(`${ch}: price not synced: no MRP (${slug})`); });
  const items = slugs.map((slug) => ({ slug, state: want[slug] }));
  let done = slugs, failed = [], err = null;
  try { await (ch === 'google' ? dep(ch).push(items, { source: c.source, names: c.names }) : dep(ch).push(items)); }
  catch (e) { err = e; ({ done, failed } = outcome(slugs, e)); }
  done.forEach((slug) => { const it = c.items[slug]; it.pushed = want[slug]; it.pushedAt = t; if (it.mismatchSince == null) it.mismatchSince = t; });
  if (done.length) info(`${ch}: pushed ${done.map((s) => `${s} (${want[s].availability})`).join(', ')}${reason ? ` after ${reason}` : ''}`);
  res.pushed.push(...done);
  if (err) countFailure(ch, c, failed, err, res, 'push failed');
}
function countFailure(ch, c, slugs, e, res, what) {
  const msg = errText(e);
  slugs.forEach((slug) => { const it = c.items[slug]; it.fails = (it.fails || 0) + 1; it.lastError = msg; });
  res.errors.push(msg);
  oops(`${ch}: ${what}`, e);
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
async function syncChannel(ch, c, want, readBack, res, reason) {
  const t = dep('now')(); const slugs = managed(c.mode);
  slugs.forEach((slug) => { c.items[slug] = Object.assign(c.items[slug] || {}, { want: want[slug] }); });
  let todo = [];
  if (!readBack) todo = slugs.filter((slug) => c.items[slug].shown !== null && differs(want[slug], c.items[slug].pushed));
  else {
    let shown = null;
    try { shown = await (ch === 'google' ? dep(ch).read(slugs, c.names) : dep(ch).read(slugs)); }
    catch (e) { countFailure(ch, c, slugs, e, res, 'read failed'); }
    if (shown) { c.checkedAt = t; todo = slugs.filter((slug) => afterRead(c.items[slug], shown[slug], want[slug], t)); }
  }
  if (todo.length) await pushItems(ch, c, todo, want, t, res, reason);
  await alertNew(ch, c, slugs, t);
}
async function runCore({ readBack = false, reason = '' } = {}) {
  const stock = dep('stock'); const prices = dep('prices');
  try { await Promise.all([stock.refresh(), prices.refresh()]); } catch (e) { oops('could not refresh stock or prices', e); }
  if (stock.soldOutSlugs() == null || !prices.isOn()) return { skipped: 'stock or prices not loaded' };
  const want = publicState({ isAvailable: dep('isAvailable'), prices: prices.current() });
  let state;
  try { state = await loadState(); } catch (e) { oops('could not read the saved state; nothing pushed', e); return { skipped: 'state not loaded' }; }
  const res = {}; let used = false;
  for (const ch of Object.keys(CHANNELS)) {
    res[ch] = { pushed: [], errors: [] };
    if (!usable(ch, state[ch])) continue;
    used = true;
    try { await syncChannel(ch, state[ch], want, readBack, res[ch], reason); } catch (e) { res[ch].errors.push(errText(e)); oops(`${ch}: run failed`, e); }
  }
  if (used) { try { await saveState(state); } catch (e) { oops('could not save the state', e); } }
  return res;
}

// ---- the public calls ----
function runOnce(opts = {}) {
  return serial(() => dep('runOnce')(opts)).catch((e) => { oops('run failed', e); return { skipped: 'run failed' }; });
}
const sweepOnce = () => runOnce({ readBack: true, reason: 'sweep' });

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

function channelStatus(ch, c, t) {
  const L = CHANNELS[ch].label;
  const slugs = usable(ch, c) ? managed(c.mode) : [];
  const problems = slugs.map((slug) => problemFor(ch, slug, c.items[slug] || {}, t)).filter(Boolean);
  const why = !configured(ch) ? 'token not set' : ch === 'google' && !c.source ? 'not set up' : c.mode === 'off' ? 'switched off'
    : problems.length ? 'problem' : slugs.some((slug) => !matches(c.items[slug] || {})) ? `waiting for ${L} to update` : 'matches';
  const items = {};
  Object.keys(c.items).forEach((slug) => {
    const it = c.items[slug];
    items[slug] = { want: it.want || null, pushed: it.pushed || null, shown: it.shown, pushedAt: iso(it.pushedAt), fails: it.fails || 0, lastError: it.lastError || null };
  });
  return { on: slugs.length > 0, mode: c.mode, why, checkedAt: iso(c.checkedAt), problems, items };
}
async function status() {
  let state;
  try { state = await loadState(); } catch (e) { oops('status: could not read the saved state', e); state = last || blank(); }
  const t = dep('now')();
  return { meta: channelStatus('meta', state.meta, t), google: channelStatus('google', state.google, t) };
}

const actorEmail = (a) => (typeof a === 'string' ? a : (a && (a.email || a.name)) || null);
async function setMode(channel, mode, actor) {
  if (!CHANNELS[channel]) throw new Error('Choose meta or google');
  if (!MODES.includes(mode)) throw new Error('Choose off, test or all');
  let saved = false;
  try {
    await serial(async () => {
      const state = await loadState(); const c = state[channel];
      if (c.mode !== mode) Object.values(c.items).forEach((it) => { delete it.mismatchSince; delete it.alertedAt; delete it.lastError; it.fails = 0; });
      Object.assign(c, { mode, modeBy: actorEmail(actor), modeAt: iso(dep('now')()) });
      await saveState(state);
      saved = true;
      info(`${channel}: mode ${mode} (by ${c.modeBy || 'unknown'})`);
    });
  } catch (e) { oops(`${channel}: could not switch to ${mode}`, e); }
  if (saved && mode !== 'off') await runOnce({ readBack: true, reason: 'mode' });
  return status();
}

// One setup at a time: a second call while one runs gets the same promise. A failure comes back as { error }, never thrown.
let setupRun = null;
function setupGoogle(actor) {
  if (!setupRun) {
    setupRun = serial(async () => {
      const r = await dep('google').setup();
      try {
        const state = await loadState();
        Object.assign(state.google, { source: r.source, names: r.names || {}, missing: r.missing || [], setupBy: actorEmail(actor), setupAt: iso(dep('now')()) });
        await saveState(state);
        info(`google: set up (${Object.keys(r.names || {}).length} products found)`);
        return r;
      } catch (e) { oops('google: could not save the setup', e); return { ...r, error: errText(e) }; }
    }).catch((e) => { oops('google: setup failed', e); return { registered: false, source: null, names: {}, missing: [], steps: [], error: errText(e) }; })
      .finally(() => { setupRun = null; });
  }
  return setupRun;
}

// Tests and the practice admin only: d replaces some dependencies (the rest stay real); setDeps(null) goes back to the real ones.
function setDeps(d) {
  over = Object.assign({}, d || {});
  tail = Promise.resolve(); armed = false; queued = false; reasons = new Set(); sweeping = false; setupRun = null; last = null;
}

module.exports = { setDeps, nudge, runOnce, sweepOnce, startSweep, status, setMode, setupGoogle };
