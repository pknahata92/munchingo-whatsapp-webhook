'use strict';
// J6 reorder reminder (growth journey, 16 Nov 2026). Spec §6.1 (J6 row, "J6 cart", "J6 skips anyone who"), words §11.
// One marketing nudge, about when the box is probably running low, timed by the size of the last delivered order:
// 2 boxes or fewer: day 21; 3-4: day 28; 5 or more: day 35 (IST calendar days after delivery), and never more than 30 days late.
// Stall and fair contacts: 21 days after their stall day. Only to contacts whose yes names the nudge (contacts.coversReminders).
// The cart is reorderCart.cartLink (two of the favourite + one untried Flavor in stock; sold-out never in it; a Set opens Build a
// box). Every send has the picture header Meta approved with the template (a send without it is rejected).
// Once per order: each order is claimed on its timeline (reorder_reminder, unique per order) before anything is sent; a send
// Meta refused gets ONE retry, after the 48 h cool-off (reorder_reminder_retry). Every send is logged in marketing_sends with
// campaign j6:<order id> or j6:stall:<day>, so the shared cap (utils/marketingCap.js) counts it.
// The contact wrote in the last 23 h: the window is open, so the same words go as a picture with a caption (ruling R24).
// Runs only with JOURNEY_J6_ENABLED=1, never in quiet hours. GET /internal/reorders (handleRequest) is called by pg_cron at 16:00
// IST (scheduling_setup.sql).   Tests: scripts/reorders-test.js
const crypto = require('crypto');
const { slotFor, isQuietHours } = require('./marketingCap');
const { coversReminders } = require('./contacts');
const { cartLink, SLUGS } = require('./reorderCart');
const deliveryArea = require('./deliveryArea');
const { flavoursFor, normPhone, FLAVOURS } = require('./reviews');
const { boxesBySlug } = require('./inventory');
const { reorderImage } = require('./journeyMedia');

const DAY = 86_400_000, HOUR = 3_600_000, IST_MS = 5.5 * HOUR;
const REORDER_DAYS = { small: 21, mid: 28, large: 35 };   // 2 boxes or fewer / 3-4 / 5 or more
const STALL_DAYS = 21;
const OVERDUE_DAYS = 30;           // no nudge more than 30 days after it fell due
const COMPLAINT_DAYS = 30;         // Something wasn't right: no marketing for 30 days
const WINDOW_MS = 23 * HOUR;       // Meta's window is 24 h; an hour of margin
const LOOKBACK_DAYS = 120;         // paid orders read per run (the newest delivered one decides; older ones say what was tried)
const MAX_ROWS = 1000;             // one Supabase page: a full page could hide a newer order, so the run refuses
const BARE_FROM = 15 * 60 + 30, BARE_UNTIL = 18 * 60;   // a bare (pg_cron) call is accepted 15:30-18:00 IST
const SITE = 'https://munchingo.com/';
const UTM_CAMPAIGN = 'j6_reorder';
const UTM = `utm_source=whatsapp&utm_medium=journey&utm_campaign=${UTM_CAMPAIGN}`;
const TEMPLATE = { try: 'munchingo_reorder_try', same: 'munchingo_reorder_same', freeform: 'freeform_j6' };
const EVENT = { first: 'reorder_reminder', retry: 'reorder_reminder_retry' };
const J6 = new Set(Object.values(TEMPLATE));
const NAME = Object.fromEntries(FLAVOURS);   // 'atta-kesari' -> 'Atta Kesari'
const STALL_SLUG = { original: 'atta-original', kesari: 'atta-kesari', ajwain: 'atta-ajwain', lite: 'atta-lite-sugar' };   // stall page mix keys
const SOURCE_DAY = /^(stall|fair):(\d{4}-\d{2}-\d{2})$/;
const TEST_ORDER = /^MNG-TEST/i;

// The two approved template bodies (Documents/WhatsApp_Templates_Growth_15Nov2026.md, spec §11), word for word. Used only as the
// caption when the window is open (R24); the templates themselves live at Meta. A Hindi copy is a new key here, not new code.
const REPLIES = {
  en: {
    try: (first, boxes, flavor) => `Hi ${first}, Prashant from Munchingo. Your ${boxes} boxes are probably running low by now. Same as last time, with one ${flavor} to try? It's ready below. Reply STOP to stop these.`,
    same: (first, boxes) => `Hi ${first}, Prashant from Munchingo. Your ${boxes} boxes are probably running low by now. Same as last time? It's ready below. Reply STOP to stop these.`,
  },
};

let deps = null;
function setDeps(d) { deps = d; } // tests only
function D() {
  if (deps) return deps;
  return {
    db: require('./database'), wa: require('./whatsapp'), now: () => Date.now(),
    inStock: async () => {   // the same sold-out list the shop uses (as utils/journey.js)
      const stock = require('./stock');
      try { await stock.ensureFresh(); } catch (e) { console.error('[REORDERS] stock refresh failed, using the last known list:', e.message); }
      const catalog = require('./catalog');
      return new Set(SLUGS.filter((s) => catalog.isAvailable(s)));
    },
    lang: (phone) => require('./langPrefs').getStoredLang(phone),
  };
}
const enabled = () => /^(1|true|yes)$/i.test(String(process.env.JOURNEY_J6_ENABLED || ''));

const last10 = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };
const istDay = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const daysFrom = (fromDay, toDay) => Math.round((Date.parse(toDay) - Date.parse(fromDay)) / DAY);
const at = (v) => Date.parse(v) || 0;
/** "Asha Rao" -> "Asha"; "mr. gaurav" -> "Gaurav"; "~" or "" -> "" (so the next name is tried). As broadcast.js firstName. */
function firstName(name) {
  const w = String(name || '').trim().replace(/^(mr|mrs|ms|dr)\.?\s+/i, '').split(/\s+/)[0] || '';
  return /^[a-z][a-z'-]*$/i.test(w) ? w[0].toUpperCase() + w.slice(1).toLowerCase() : '';
}
// A WhatsApp catalog line stores Meta's retailer id instead of the slug; flavoursFor knows the mapping (as reorderCart.js).
const withSlug = (it) => (it && !it.slug ? { ...it, slug: (flavoursFor({ items: [it] })[0] || {}).slug } : it);
const boxesOf = (order) => Object.values(boxesBySlug(((order && order.items) || []).map(withSlug))).reduce((a, b) => a + b, 0);
const daysFor = (boxes) => (boxes <= 2 ? REORDER_DAYS.small : boxes <= 4 ? REORDER_DAYS.mid : REORDER_DAYS.large);
const complainedRecently = (c, nowMs) => !!(c && c.last_complaint_at) && nowMs - at(c.last_complaint_at) < COMPLAINT_DAYS * DAY;

/** The latest stall or fair day for this contact: its stall:/fair: sources and any stall sale linked to the phone. */
function stallDayOf(c, sales) {
  const days = [c && c.first_source, c && c.last_source].map((s) => (String(s || '').match(SOURCE_DAY) || [])[2]).filter(Boolean);
  for (const s of sales || []) if (/^\d{4}-\d{2}-\d{2}$/.test(String(s.day || ''))) days.push(s.day);
  return days.sort().pop() || null;
}

/** The stall sale's Flavors as the "same as last time" cart. Sold-out Flavors left out; a hamper opens Build a box (never the
 *  hamper as singles, R20); nothing to put in the bag opens the shop. */
function stallCart(lines, inStock) {
  const has = (s) => !!inStock && inStock.has(s);
  if (!SLUGS.some(has)) return `shop?${UTM}`;
  if (lines.some((l) => l && l.hamper)) return `build-a-box?${UTM}`;
  const boxes = {};
  for (const l of lines) for (const [k, n] of Object.entries((l && l.mix) || {})) if (STALL_SLUG[k] && n > 0) boxes[STALL_SLUG[k]] = (boxes[STALL_SLUG[k]] || 0) + n;
  const parts = SLUGS.filter((s) => has(s) && boxes[s] > 0).map((s) => `${s}:${boxes[s]}`);
  return parts.length ? `cart?add=${parts.join(',')}&${UTM}` : `shop?${UTM}`;
}

/** The shared gate, with every J6 wording (try, same, the free-form picture) counted as ONE message per campaign: a rerun after
 *  the stock changed (try -> same) or the window opened is still already_sent. Two failed tries for one campaign: no third. */
function gate(key, sends, nowMs, campaign) {
  const mine = sends.filter((s) => last10(s.phone) === key).map((s) => ({ ...s, phone: key, template: J6.has(s.template) ? 'j6' : s.template }));
  const v = slotFor({ phone: key, sends: mine, nowMs, template: 'j6', campaign });
  if (v !== 'ok') return v;
  return mine.filter((s) => s.template === 'j6' && s.campaign === campaign && s.status === 'failed').length >= 2 ? 'blocked_twice' : 'ok';
}
const failedBefore = (key, sends, campaign) => sends.some((s) => last10(s.phone) === key && J6.has(s.template) && s.campaign === campaign && s.status === 'failed');

/** Pure. Who is due now, and every skip counted by reason: { due: [...], skipped: { reason: n }, checked }. */
function planReorders({ orders = [], contacts = [], sends = [], eventsByOrder = {}, subscriptionPhones = [], stallOrders = [], inStock, nowMs }) {
  const today = istDay(nowMs);
  const skipped = {};
  const skip = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
  const due = [];
  let checked = 0;

  const contactBy = new Map();
  for (const c of contacts) { const k = last10(c && c.phone); if (k && !contactBy.has(k)) contactBy.set(k, c); }
  const subs = new Set(subscriptionPhones.map(last10).filter(Boolean));
  const ordersBy = new Map();
  for (const o of orders) {
    const k = last10(o && o.customer_phone);
    if (!k || o.status !== 'paid' || TEST_ORDER.test(String(o.order_id || '')) || !boxesOf(o)) continue;
    if (!ordersBy.has(k)) ordersBy.set(k, []);
    ordersBy.get(k).push(o);
  }
  const salesBy = new Map();
  for (const s of stallOrders) { const k = last10(s && s.contact_phone); if (!k) continue; if (!salesBy.has(k)) salesBy.set(k, []); salesBy.get(k).push(s); }

  // ── web buyers: the newest delivered order per phone ──
  for (const [key, list] of ordersBy) {
    const delivered = list.filter((o) => o.delivered_at).sort((a, b) => at(b.delivered_at) - at(a.delivered_at));
    if (!delivered.length) continue;   // nothing has arrived yet
    checked++;
    const ref = delivered[0];
    const c = contactBy.get(key);
    const boxes = boxesOf(ref);
    const deliveredDay = istDay(at(ref.delivered_at));
    const since = daysFrom(deliveredDay, today), wait = daysFor(boxes);
    if (since < wait) { skip('not_due'); continue; }
    if (since > wait + OVERDUE_DAYS) { skip('too_late'); continue; }
    if (!coversReminders(c)) { skip('no_reminder_consent'); continue; }
    // Ordered again: a paid order placed after that delivery, a newer one still on its way, or a stall sale after it.
    const again = list.some((o) => o !== ref && (at(o.created_at) > at(ref.delivered_at) || (!o.delivered_at && at(o.created_at) > at(ref.created_at))));
    const stallDay = stallDayOf(c, salesBy.get(key));
    if (again || (stallDay && stallDay > deliveredDay)) { skip('ordered_again'); continue; }
    if (subs.has(key)) { skip('subscriber'); continue; }
    const a = ref.delivery_address || {};
    if (a.recipientPhone) { skip('gift'); continue; }
    if (!deliveryArea.inArea(a.pincode || deliveryArea.pinIn(a.raw || ''))) { skip('outside_area'); continue; }
    if (complainedRecently(c, nowMs)) { skip('complaint'); continue; }
    if (/^MUNCH-/i.test(String(ref.coupon_code || ''))) { skip('card_coupon'); continue; }
    const campaign = 'j6:' + ref.order_id;
    const v = gate(key, sends, nowMs, campaign);
    if (v !== 'ok') { skip(v); continue; }
    const claimedAs = new Set((eventsByOrder[ref.order_id] || []).map((e) => e.event));
    if (claimedAs.has(EVENT.retry)) { skip('already_sent'); continue; }
    // Claimed before: retry only when that try is on record as failed (a claim with no log row might have gone: never twice).
    const retry = claimedAs.has(EVENT.first);
    if (retry && !failedBefore(key, sends, campaign)) { skip('already_sent'); continue; }
    const history = [ref, ...list.filter((o) => o !== ref).sort((x, y) => at(y.created_at) - at(x.created_at))];
    const cart = cartLink({ orders: history, inStock, campaign: UTM_CAMPAIGN, medium: 'journey' });
    const first = firstName(ref.customer_name) || firstName(c.name) || 'there';
    const tryName = cart.trySlug ? NAME[cart.trySlug] : null;
    due.push({
      phone: normPhone(c.phone), first, boxes,
      template: tryName ? TEMPLATE.try : TEMPLATE.same,
      params: tryName ? [first, String(boxes), tryName] : [first, String(boxes)],
      urlSuffix: cart.path, header: { type: 'image', link: reorderImage(cart.favSlug) },
      campaign, orderId: ref.order_id, retry, lastInboundAt: c.last_inbound_at || null,
    });
  }

  // ── stall and fair contacts: 21 days after the stall day ──
  const seen = new Set();   // one row per number, even if it is stored twice in two formats
  for (const c of contacts) {
    const key = last10(c && c.phone);
    const day = key && !seen.has(key) && stallDayOf(c, salesBy.get(key));
    if (!day) continue;
    seen.add(key);
    checked++;
    const since = daysFrom(day, today);
    if (since < STALL_DAYS) { skip('not_due'); continue; }
    if (since > STALL_DAYS + OVERDUE_DAYS) { skip('too_late'); continue; }
    if (!coversReminders(c)) { skip('no_reminder_consent'); continue; }
    // A web order placed on or after the stall day, or delivered on or after it: the web nudge (or none) covers that phone.
    if ((ordersBy.get(key) || []).some((o) => istDay(at(o.created_at)) >= day || (o.delivered_at && istDay(at(o.delivered_at)) >= day))) { skip('ordered_again'); continue; }
    if (subs.has(key)) { skip('subscriber'); continue; }
    if (complainedRecently(c, nowMs)) { skip('complaint'); continue; }
    const campaign = 'j6:stall:' + day;
    const v = gate(key, sends, nowMs, campaign);
    if (v !== 'ok') { skip(v); continue; }
    const lines = (salesBy.get(key) || []).filter((s) => s.day === day).flatMap((s) => s.lines || []);
    const first = firstName(c.name) || 'there';
    due.push({
      phone: normPhone(c.phone), first, boxes: null,
      template: TEMPLATE.same, params: [first, 'Munchingo'],
      urlSuffix: lines.length ? stallCart(lines, inStock) : `shop?${UTM}`, header: { type: 'image', link: reorderImage(null) },
      campaign, orderId: null, retry: false, lastInboundAt: c.last_inbound_at || null,
    });
  }
  return { due, skipped, checked };
}

/** Pure: the list of due reminders (planReorders without the counts). */
const dueReorders = (input) => planReorders(input).due;

function metaError(e) {   // as broadcast.js: Meta's code first, so marketingCap's 131049 rule can read it
  const m = e && e.response && e.response.data && e.response.data.error;
  return m ? `${m.code || ''} ${m.message || ''} ${(m.error_data && m.error_data.details) || ''}`.trim() : String((e && e.message) || e);
}

async function caption(item) {
  let R = REPLIES.en;
  try { R = REPLIES[await D().lang(item.phone)] || REPLIES.en; } catch (e) { /* English */ }
  const words = item.template === TEMPLATE.try ? R.try(...item.params) : R.same(...item.params);
  return `${words}\n\n${SITE}${item.urlSuffix}`;
}

/** The daily job. -> { disabled } | { quiet } | { blocked } | { checked, sent, skipped, failed, reasons } (counts only). */
async function sweepReorders() {
  if (!enabled()) return { disabled: true };
  const { db, wa, now } = D();
  const nowMs = now();
  if (isQuietHours(nowMs)) return { quiet: true };
  const since = new Date(nowMs - LOOKBACK_DAYS * DAY).toISOString();
  const [orders, contacts, sends, subscriptionPhones, stallOrders] = await Promise.all([
    db.getPaidOrdersUpdatedSince(since), db.listMarketingContacts(), db.listMarketingSends(), db.listActiveSubscriptionPhones(), db.listStallOrdersWithPhone(since),
  ]);
  if (orders.length >= MAX_ROWS) return { blocked: `${orders.length} paid orders in ${LOOKBACK_DAYS} days fill one page: the reorder job needs paging before it can run safely.` };
  const ids = orders.filter((o) => o.delivered_at).map((o) => o.order_id);
  const eventsByOrder = {};
  for (const name of Object.values(EVENT)) {
    for (const e of ids.length ? await db.listOrderEventsByName(name, ids) : []) (eventsByOrder[e.order_id] = eventsByOrder[e.order_id] || []).push(e);
  }
  const inStock = await D().inStock();
  const p = planReorders({ orders, contacts, sends, eventsByOrder, subscriptionPhones, stallOrders, inStock, nowMs });
  const reasons = { ...p.skipped };
  const res = { checked: p.checked, sent: 0, skipped: Object.values(reasons).reduce((a, b) => a + b, 0), failed: 0, reasons };
  for (const item of p.due) {
    if (item.orderId) {
      let claimed = false;
      try { claimed = await db.claimOrderEvent({ actor_name: 'System', order_id: item.orderId, event: item.retry ? EVENT.retry : EVENT.first, meta: { campaign: item.campaign } }); }
      catch (e) { console.error(`[REORDERS] could not claim ${item.orderId}, not sending:`, e.message); res.failed++; continue; }
      if (!claimed) { res.skipped++; reasons.claimed_elsewhere = (reasons.claimed_elsewhere || 0) + 1; continue; }   // another run has it
    }
    const open = !!item.lastInboundAt && nowMs - at(item.lastInboundAt) < WINDOW_MS;
    const template = open ? TEMPLATE.freeform : item.template;
    let status = 'sent', error = null, waId = null;
    try {
      const out = open
        ? await wa.sendImage(item.phone, item.header.link, await caption(item))
        : await wa.sendTemplateWithButtons(item.phone, item.template, 'en', item.params, { urlSuffix: item.urlSuffix, urlIndex: 0, header: item.header });
      waId = (out && out.messages && out.messages[0] && out.messages[0].id) || null;
      res.sent++;
    } catch (e) {
      status = 'failed'; error = metaError(e).slice(0, 300); res.failed++;
      console.error(`[REORDERS] ${template} for ${item.campaign} failed:`, error);
    }
    try { await db.insertMarketingSend({ phone: item.phone, template, status, error, wa_message_id: waId, campaign: item.campaign }); }
    catch (e) { console.error('[REORDERS] could not log a send:', e.message); }
  }
  console.log(`[REORDERS] checked ${res.checked}, sent ${res.sent}, skipped ${res.skipped}, failed ${res.failed}`);
  return res;
}

/** GET /internal/reorders, the /internal/daily-digest guard: with DIGEST_SECRET it always runs (and may be re-run: each order is
 *  claimed, R2); without it only a bare call between 15:30 and 18:00 IST, once a day (claimDigestDay('reorders-<IST day>')).
 *  -> { status, body? } */
async function handleRequest({ query = {} } = {}) {
  const secret = process.env.DIGEST_SECRET;
  const given = Buffer.from(String(query.secret || '')), expected = Buffer.from(secret || '');
  const withSecret = !!secret && expected.length === given.length && crypto.timingSafeEqual(expected, given);
  const { db, now } = D();
  const nowMs = now();
  if (!withSecret) {
    const ist = new Date(nowMs + IST_MS);
    const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    if (query.secret || minutes < BARE_FROM || minutes > BARE_UNTIL) return { status: secret ? 403 : 503 };
  }
  if (!enabled()) return { status: 200, body: { ok: true, disabled: true } };   // the day is not spent while the flag is off
  const day = 'reorders-' + istDay(nowMs);
  if (!withSecret && !(await db.claimDigestDay(day))) return { status: 200, body: { ok: true, day, skipped: 'already ran today' } };
  try {
    return { status: 200, body: { ok: true, ...(await sweepReorders()) } };
  } catch (e) {
    console.error('[REORDERS] sweep failed:', e.message);
    if (!withSecret) { try { await db.releaseDigestDay(day); } catch (e2) { console.error('[REORDERS] could not release the day:', e2.message); } }   // let a retry run
    return { status: 500, body: { ok: false, error: e.message } };
  }
}

module.exports = { REORDER_DAYS, STALL_DAYS, TEMPLATE, EVENT, REPLIES, dueReorders, planReorders, sweepReorders, handleRequest, setDeps };
