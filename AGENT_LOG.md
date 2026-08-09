AGENT LOG

This repo is edited by two separate Claude chat sessions that do not share context or memory with each other. This file exists so both sessions can see what the other one did, since a silent overwrite already happened once (see the 2026-08-08 entries below).

RULE: before editing server.js, routes/, handlers/, or utils/, read this file top to bottom. After committing a change, add a new entry at the TOP with today's date, what you changed, which files, and why. Keep entries short.

====================================================================

2026-08-09 -- Claude session (website stock/sold-out flag)

Follow-up to the ordering-experience audit: the website's checkout
(routes/checkout.js + utils/catalog.js) had zero stock concept -- a
customer could pay for a flavour that's actually out of stock, since
utils/catalog.js is a static price table with no availability check at all.
Confirmed with Prashant this is website-only: WhatsApp's native catalog
ordering flow already reflects stock status set in Meta Commerce Manager
(separate system, CATALOG_ID), so nothing needed there.

- utils/catalog.js: new SOLD_OUT_SLUGS array (empty by default) + new
  isAvailable(slug) export. Handles gift sets correctly: Full Range needs
  all 4 base flavours in stock, Trio needs whichever 3 flavour tokens are
  encoded in its slug suffix (matched via hyphen-bounded regex since
  "lite-sugar" itself contains a hyphen -- verified this doesn't
  false-positive/negative with a manual test). To mark a flavour sold out:
  add its slug here and redeploy; remove to restock.
- routes/checkout.js: normaliseItems() now returns {items} or {error}
  instead of null-or-array, so a sold-out item gets a specific customer-
  facing message ("X is currently sold out") instead of the generic
  "item not recognised" error. This is the check that actually blocks a
  tampered/stale request -- the website UI (separate repo) only controls
  what's shown before that.

Website side (munchingo-website repo, not this one): js/cart.js got a
matching SOLD_OUT_SLUGS list (must be kept in sync with this one) that
greys out Add-to-Bag buttons and disables the specific flavour checkbox in
gifting.html's Trio picker. Verified in-browser with a temporary test copy
(Kesari marked sold out): checkbox correctly disabled+unchecked, button
correctly shows "Sold Out" and is disabled, Full Range set button also
correctly blocked. Test files deleted after verification, nothing left in
the repo.

2026-08-09 -- Claude session (GST display + daily packing digest + audit fixes)

GST (GSTIN 06AIIPN5005C2ZP, 5% rate on HSN 1905 post the Sept 2025 GST 2.0
revision, confirmed with Prashant against the actual GST certificate and
FSSAI license in Munchingo Docs/):
- utils/mailer.js: new gstBreakupHtml() helper, inserted into sendOrderEmail
  and sendCustomerConfirmationEmail right after the totals table.
- handlers/messageHandler.js: sendPriceList(), handleOrderMessage()'s order
  receipt, and completeAddressCollection()'s payment-link message now state
  the 5% GST breakup / GSTIN.
(Website side — checkout.html, cart.html, footer GSTIN/FSSAI on all pages —
done in the munchingo-website repo, not this one.)

Daily packing-list digest (new):
- utils/database.js: new getOrdersPaidSince(sinceISO, untilISO), filtering
  on `updated_at`. markOrderPaid() now explicitly sets updated_at (it didn't
  before) since this query depends on it.
- utils/mailer.js: new sendDailyDigestEmail({orders, windowLabel}) — product
  quantity totals (for pulling stock) + per-order cards (name, phone, items,
  address) for labels.
- server.js: new GET /internal/daily-digest, secret-protected via a new
  DIGEST_SECRET env var (timing-safe compare, same pattern as the Meta
  signature check). Pulls orders paid in the last 24h and emails the digest.
- .github/workflows/daily-digest.yml: new scheduled GitHub Action, fires
  daily at 08:00 IST via curl to the endpoint. Chose this over an in-process
  timer because this service runs on Render's free tier and can spin down
  between requests — a setInterval isn't guaranteed to fire at a wall-clock
  time. Needs DIGEST_SECRET set as both a Render env var and a GitHub Actions
  repo secret (same value) — Prashant to do both, not yet done as of this
  commit, so the endpoint will 503 until DIGEST_SECRET exists in Render.
- .env.example: documented DIGEST_SECRET.

Ordering-experience audit (full report given to Prashant, most findings
deferred as product decisions — cart→WhatsApp handoff losing gift-set
selections, non-India phone assumption, no stock/inventory concept, etc.
are NOT fixed, intentionally, pending Prashant's calls). Two findings fixed
now since they were factual corrections, not judgment calls:
- Removed the false "Cash on Delivery (select pincodes)" line from both
  payment-info replies in messageHandler.js (routeText's payment keyword
  reply and the faq_payment case) — there is no COD logic anywhere in the
  codebase; every order is prepaid-only via Razorpay. Saying otherwise to a
  customer right before they pay was a real, provable false claim.
- Fixed the bot's shelf-life claim from "30 days" (two locations:
  routeText's shelf/expiry keyword reply and the faq_shelf case) to "90
  days" — confirmed the true figure with Prashant (the website's
  contact.html FAQ said 6 months, the bot said 30 days; neither was right,
  fixed both to 90 in their respective repos).

2026-08-09 -- Claude session (fix: Flow send was failing, not a template issue)

Prashant tested a real order after the previous entry's deploy and got the
old free-text address prompt instead of the new Flow popup. Root cause was
NOT what it looked like (Flow needing a message template) -- confirmed via
Render logs, the actual error was:

  [WA] Send error: {"message":"(#131009) Parameter value is not valid",
  "code":131009,...,"details":"Parameter data in flow_action_payload for
  CTA flow must be of type dynamic_object."}

utils/whatsapp.js:sendFlow() was sending `flow_action_payload: { screen,
data: {} }` -- an explicit empty object for `data`. The Cloud API rejects
that outright; it wants the key omitted entirely when there's nothing to
prefill, not present-but-empty. Fixed: `data` is now only included in the
payload when a non-empty object is actually passed in. handleOrderMessage()
and the feedback-trigger call site don't pass `data` at all, so both now
send a clean `{screen: "..."}` payload with no `data` key.

The try/catch fallback (added in the same commit as the original bug) did
its job correctly here -- the customer still got a working free-text
prompt instead of silence, which is exactly why that fallback was worth
adding up front.

2026-08-09 -- Claude session (WhatsApp Flows: delivery details + feedback)

Prashant asked to replace free-text delivery-address collection with a
proper WhatsApp Flow, and to use Flows "to max capability" -- welcome
screen, delivery details, feedback. Built and published two Flows in
WhatsApp Manager (via Claude in Chrome, editing Flow JSON directly through
the Monaco editor's model API since simulated keystrokes triggered the
editor's bracket auto-close and corrupted the JSON):

- "Delivery Details" (flow ID 1699615387965702), two screens:
  WELCOME (context + Continue button) -> DELIVERY_DETAILS (full name,
  address line, city, state, pincode, optional email -- all TextInput,
  wrapped in a Form component so values pass through via ${form.*} into
  the completion payload). Published.
- "Feedback" (flow ID 1743198853381814), one screen: rating
  (RadioButtonsGroup: Excellent/Good/Okay/Poor) + optional comments
  (TextArea). Published.

Note: WhatsApp Manager's Flows publishing prerequisites (message quality /
business verification, mentioned in the empty-state banner) turned out not
to block this account -- both Flows published immediately with no gate.

Backend changes (utils/whatsapp.js, handlers/messageHandler.js,
utils/mailer.js):
- utils/whatsapp.js: new sendFlow(to, {flowId, bodyText, ctaText, screenId,
  headerText}) -- sends a `type: interactive, interactive.type: flow`
  message per the Cloud API flow-message spec.
- handlers/messageHandler.js: handleOrderMessage() now sends the Delivery
  Details flow instead of the free-text address prompt, with a try/catch
  fallback to the old free-text prompt if the flow send fails for any
  reason (e.g. flow gets unpublished later). The free-text address
  collection path in routeText() is left in place as a second fallback --
  if a customer just types their address instead of using the flow, it
  still works exactly as before.
- Extracted the address-save + payment-link generation logic (previously
  inline in routeText()) into a new completeAddressCollection() helper, now
  shared between the free-text path and the new Flow-completion path.
- New routeFlowReply(to, nfmReply, name), called from routeInteractive()
  whenever interactive.type === 'nfm_reply' (WhatsApp's message type for a
  completed Flow submission). WhatsApp doesn't indicate which flow was
  filled out in nfm_reply.name (always "flow"), so this dispatches based on
  which fields are present in the parsed response_json: address_line ->
  address collection, rating -> feedback.
- "feedback"/"review"/"rate ..." keyword in routeText() now sends the
  Feedback flow.
- utils/mailer.js: new sendFeedbackAlert({customerPhone, customerName,
  rating, comments}) -- emails NOTIFY_EMAIL, mirrors the existing
  sendHumanHandoffAlert pattern. Feedback is not yet persisted to Supabase
  (no table for it) -- email is the only record for now; flagged as a
  possible follow-up if Prashant wants historical feedback data.

Not yet live-tested end-to-end (Delivery Details flow's WELCOME->
DELIVERY_DETAILS navigation and the nfm_reply webhook handling specifically)
-- the original free-text order flow WAS tested live this session before
these changes (order MNG-BFVZ-0808). Recommend Prashant place one more real
test order through the flow before considering this fully verified.

2026-08-09 -- Claude session (Supabase RLS gap closed)

Prashant asked for a website security check. Checking the `orders` table in
Supabase (Table Editor > Policies) found Row Level Security completely
disabled with zero policies -- Supabase's own banner: "This table can be
accessed by anyone via the Data API as RLS is disabled." Every customer's
name, phone, address, and order/payment details were readable (and
writable) by anyone holding the project's anon key. The anon key itself was
confirmed NOT exposed anywhere on the live website (checked all HTML/JS),
but it lives in Render env vars and Supabase anon keys are designed to be
usable client-side by convention -- this was a real, if not yet actively
exploited, exposure.

Fix (can't just flip on RLS -- the backend authenticated with the anon key
and there were no policies, so enabling RLS as-is would have locked the
backend itself out and broken order saving in production):
- utils/database.js: switched the Supabase client from SUPABASE_ANON_KEY to
  SUPABASE_SERVICE_ROLE_KEY (bypasses RLS by design, server-side only,
  never sent to a browser).
- .env.example: replaced SUPABASE_ANON_KEY with SUPABASE_SERVICE_ROLE_KEY.
- Retrieved the legacy service_role key from Supabase Settings > API >
  Legacy anon, service_role API keys (Prashant's own dashboard session, via
  Claude in Chrome) and added SUPABASE_SERVICE_ROLE_KEY to Render's env
  vars -- pasted via OS clipboard, Claude never printed the raw key.
- SUPABASE_ANON_KEY was confirmed unused elsewhere in the codebase (grepped)
  so it can be removed from Render once this deploy is verified live and
  RLS is enabled -- left in place for now, harmless either way.

Sequencing matters here: RLS must NOT be enabled on `orders` until this
commit is live in production (otherwise the old anon-key code breaks
immediately). Enable RLS (Supabase > Database > Policies > orders > Enable
RLS, zero policies needed since only the service role touches it) only
after confirming this deploy's logs show clean order saves/reads.

CLOSED OUT same session: confirmed e1632e2 deployed clean, enabled RLS on
`orders` (zero policies -- Supabase UI confirms "No data will be returned
via the Data API as no RLS policies exist on this table", anon key now
fully locked out). Verified end-to-end with a REAL order placed by Prashant
through the WhatsApp native catalog: Render logs show `[DB] Order
MNG-BFVZ-0808 saved` and `[MAILER] Order notification sent` with zero
errors -- service role key + RLS-enabled table works correctly in
production. Removed the now-fully-unused SUPABASE_ANON_KEY from Render env
vars; redeployed clean. This security gap is fully closed.

2026-08-09 -- Claude session (human handoff notification fix)

Prashant flagged that the existing "connect to a human" intent
(handlers/messageHandler.js sendHumanHandoff, triggered by keywords like
"human"/"real person"/"talk to someone", also reachable via the faq_human
button) told the customer a team member would reach out, but the code that
was supposed to actually notify the team was a stub -- just a
console.log and a `// TODO: Add a Slack/email alert here`. Nobody was ever
actually notified.

Fixes:
- utils/mailer.js: added sendHumanHandoffAlert({customerPhone, customerName,
  message}) -- reuses the existing Resend setup to email NOTIFY_EMAIL with
  the customer's phone, name, and message text.
- handlers/messageHandler.js sendHumanHandoff(to, name, message): now also
  (a) WhatsApp-texts the owner directly at a new OWNER_PHONE env var with
  the customer's details, and (b) calls sendHumanHandoffAlert() for the
  email. Both wrapped in try/catch so a notification failure never blocks
  the customer-facing reply. Updated both call sites (routeText's keyword
  match, routeInteractive's faq_human case) to pass name/message through.
- .env.example: added OWNER_PHONE (owner's personal WhatsApp number, E.164
  no +). Optional -- if unset, owner is only notified by email, with a
  console.warn logged.
- Set OWNER_PHONE in Render (Prashant's personal WhatsApp number, given
  explicitly this session, not recorded here or in .env.example -- treat as
  private) via Claude in Chrome, saved -- triggered an env-var redeploy of
  the then-current commit before this code was pushed; code push follows in
  the same session, so the var is already live for it.

2026-08-09 -- Claude session (Meta follow-up: signature verification + WhatsApp template)

Closed out the two remaining open items from the previous entry below (both
needed Prashant's Meta account access), driven via Claude in Chrome on his
logged-in Meta session.

- META_APP_SECRET: retrieved from Meta Developer Portal > Munchingo API app
  (App ID 3526889110799161) > App Settings > Basic > App Secret (Prashant
  entered his own password at Meta's re-auth prompt, then copied the secret
  himself -- Claude never saw the raw value, only pasted it via OS clipboard
  into Render's env var value field). Added META_APP_SECRET in Render
  (munchingo-whatsapp-webhook > Environment), saved -- this triggered an
  automatic redeploy of the existing commit (9a760ee), verified live and
  clean in Render logs with no "META_APP_SECRET not set" warning. This
  activates the X-Hub-Signature-256 verification added in commit 7de70bd
  (previously failing open).

- WhatsApp "Payment Confirmed" template: discovered Prashant (or an earlier,
  unlogged session) had already created and gotten approval for a template
  named `munchingo_order_confirmed` in WhatsApp Manager (Utility category,
  English, status "Active" as of 4 Aug 2026) -- so no new template needed
  submitting. Its approved body (4 variables, {{1}}-{{4}}):
    Hi {{1}}, payment received! ✅
    Your Munchingo order is confirmed. 🍪
    *Order ID:* {{2}}
    *Items:* {{3}}
    *Amount Paid:* ₹{{4}}
    We'll dispatch within 24 hours and send you tracking details.
    Thank you for choosing pure ghee, no compromise. 🙏
    — Team Munchingo
  Code changes:
  - utils/whatsapp.js: added sendTemplate(to, templateName, languageCode,
    bodyParams) -- sends a `type: template` Cloud API message with body
    parameters, exported alongside the existing helpers.
  - server.js: in the payment_link.paid handler, replaced the free-text
    wa.sendText(...) "Payment Confirmed" message with
    wa.sendTemplate(phone, 'munchingo_order_confirmed', 'en', [customerName,
    orderId, itemsSummary, total]) wrapped in try/catch (logs on failure,
    doesn't block the email-confirmation path below it). This fixes the
    known bug: free-text messages to website-checkout customers were
    silently failing because those customers are outside WhatsApp's 24h
    session window; approved templates bypass that window.
  Assumption not independently verified against the Graph API: language code
  "en" for the template's "English" (not "English (US)") locale setting --
  standard Meta convention, but if template sends start failing with a
  language-mismatch error, check this first.

Both changes committed together. Prashant's explicit go-ahead obtained
immediately before `git push origin main` per this repo's standing rule.

2026-08-09 -- Claude session (Phase 9 ecosystem audit + fixes)

Did a full live verification pass (all 6 pages on munchingo.com, WhatsApp
cart deep link, a real end-to-end Razorpay test order) plus a code audit of
both this repo and munchingo-website/ for bugs and customer-experience gaps.
The real test order surfaced a genuine production bug (see below); the audit
surfaced a price-tampering vulnerability. Fixed what's fixable without
needing anything from Prashant beyond env vars; flagged what needs his
Meta/Razorpay account access.

Fixes in this repo:
- routes/checkout.js + new utils/catalog.js: item prices/order total were
  taken directly from the client's POST body with no server-side check --
  a customer could tamper with the request (devtools/curl) and pay any
  amount for real products. Now item_price is looked up server-side from a
  trusted slug->price catalog and total is recomputed from that; unknown
  slugs are rejected with a 400. Website UI unaffected (same slugs it
  already sends match the catalog).
- routes/checkout.js: added a lightweight in-memory rate limiter (new
  utils/rateLimit.js, no new dependency) on POST /api/checkout -- 5
  requests/minute/IP -- to blunt scripted abuse (spamming order creation,
  Razorpay API calls, owner-notification emails).
- server.js: removed the public, unauthenticated GET /test-email endpoint
  (leftover from an earlier debugging session, no longer needed now that
  the mailer path is proven working end-to-end).
- server.js: added Meta X-Hub-Signature-256 verification on POST /webhook
  (new META_APP_SECRET env var, added to .env.example). Without this,
  anyone who found the webhook URL could POST fabricated WhatsApp messages
  and the bot would act on them (fake orders, spam replies to arbitrary
  numbers). Fails OPEN with a one-time console warning if META_APP_SECRET
  isn't set yet (it isn't, as of this commit) so this doesn't break the live
  bot -- Prashant needs to add META_APP_SECRET (Meta Developer Portal > App
  Settings > Basic > App Secret) to Render for this to actually start
  verifying. Until then this is a known, logged, open gap, not a silent one.
- server.js: GET /payment-success now meta-refreshes to SITE_ORIGIN (falls
  back to https://munchingo.com) after 4 seconds, with a manual link too --
  previously customers were stranded on the raw onrender.com backend domain
  after paying. Per Prashant's explicit request this session.
- handlers/messageHandler.js (handleOrderMessage): saveOrder() is now called
  BEFORE the "order received, reply with your address" messages are sent,
  and returns an apologetic error message to the customer if it throws.
  Previously, a DB save failure was silently swallowed -- the customer was
  told everything was fine and asked for their address, but no order
  existed, so their address reply then fell through to generic keyword
  routing with zero indication anything had gone wrong.
- handlers/messageHandler.js (routeText address collection): added a sanity
  check before treating free text as a delivery address (must be >=12 chars
  and contain a digit). Previously any stray reply while an order was
  pending_address ("how much is shipping?") got silently saved as the
  address and a real payment link was generated for it.

*** KNOWN, CONFIRMED-INTENTIONAL BY PRASHANT: *** Razorpay is running on
TEST MODE keys (confirmed live during this session's real test order --
the payment link literally said "This payment link is created in Test
Mode"). Prashant confirmed this is deliberate -- he'll switch to live keys
once checkout.html is taken out of hidden-beta. Not a bug, don't "fix" it.

*** STILL OPEN, NOT FIXED THIS SESSION: *** the WhatsApp "Payment Confirmed"
free-form text message to website-checkout customers will almost always
silently fail to deliver -- confirmed live this session (Prashant got the
email confirmation but no WhatsApp message; Render logs showed the WA API
call succeeded but the async delivery status came back "failed"). This is
WhatsApp Business API's 24-hour session window rule: free-form text can only
be sent to a customer who messaged the bot number first within the last 24h,
which is essentially never true for a website-only customer. Real fix needs
a Meta-approved message template (bypasses the 24h window) -- requires
Meta Business Manager access and a decision on template wording/category
that Prashant needs to make; not something fixable in code alone.

Website fix (via Cloudflare dashboard, not this repo): www.munchingo.com was
returning a Cloudflare 522 (its CNAME pointed at the apex domain, but the
Pages project only had munchingo.com registered as a custom domain, so
Cloudflare's edge couldn't find a matching origin for the www hostname).
Added www.munchingo.com as a second custom domain on the munchingo-website
Pages project, which repointed its CNAME straight at
munchingo-website.pages.dev. Status was "Initializing" as of this session --
should self-resolve to Active within minutes since it's already on the same
zone.

Pushed with Prashant's explicit go-ahead: commit 7de70bd on origin/main.
Verified live via Render logs: clean deploy, "Your service is live",
no errors, correct commit deployed.

====================================================================

2026-08-08 -- Claude session (customer email confirmations, both channels)

Added optional customer-facing order-confirmation emails, sent at PAYMENT
CONFIRMATION time (inside the existing POST /razorpay-webhook payment_link.paid
handler) rather than at order-creation time, so we don't email someone who
abandoned checkout before paying. This single hook covers both channels
(website checkout and WhatsApp bot orders) since both converge on the same
webhook once a payment link is paid.

Files changed:
- utils/database.js: saveOrder() now accepts/stores customerEmail (nullable).
  Added updateOrderEmail(orderId, email) for the WhatsApp flow where the email
  is collected in a later message than the initial order.
- utils/mailer.js: added sendCustomerConfirmationEmail() — a customer-facing
  counterpart to the existing owner-facing sendOrderEmail(), same visual style.
- server.js: in the payment_link.paid handler, after markOrderPaid + the
  existing WhatsApp "Payment Confirmed" message, if existing.customer_email is
  set, call sendCustomerConfirmationEmail() wrapped in try/catch (non-blocking,
  same pattern as the owner email). Targeted addition only, no restructuring.
- routes/checkout.js: accepts optional `email` from the website checkout POST
  body, passes to saveOrder as customerEmail.
- handlers/messageHandler.js: the "please reply with your delivery address"
  prompt now also invites an optional email on its own line. The address-
  collection handler in routeText() regex-extracts an email if present,
  strips it from the address text, and calls updateOrderEmail(). No new order
  status was introduced -- avoided touching the pending_address/pending_payment/
  paid status flow entirely, since I have no visibility into whether `status`
  has a DB-level CHECK constraint or enum and didn't want to risk it.

*** DEPLOYMENT BLOCKER -- RESOLVED, commit pushed: ***
saveOrder()'s insert unconditionally includes a customer_email key (null when
not provided) on EVERY order-creation call, both channels. This required a
Supabase schema change first. Drove it via browser (Claude in Chrome, with
Prashant's explicit confirmation before running the DDL) in the Supabase SQL
editor for the Munchingo project (project ref rpjfkzskmjwqomyjbnvl):
`ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_email text;` -- verified
via information_schema.columns that customer_email (text, nullable) now
exists (16 columns total on orders). Then pushed commit 34c9da8 to
origin/main with Prashant's explicit go-ahead. Verified on the Render
dashboard: "Deploy live for 34c9da8" succeeded cleanly (Aug 8, 2026, 6:21 PM),
no crash. This feature is now live in production on both channels.

====================================================================

2026-08-08 -- Claude session (CLAUDE.md Phase 2: owner-notification email + .env.example)

Added the missing owner-notification email for website checkout orders (bug #2
in CLAUDE.md's known-bugs table): routes/checkout.js now imports
utils/mailer.js's sendOrderEmail() and calls it right after the payment link
is created and saved, wrapped in try/catch so a mailer failure can't break
checkout (mirrors the exact pattern already used in
handlers/messageHandler.js's handleOrderMessage()). File: routes/checkout.js.

Rewrote .env.example to list all 13 real env vars the code actually reads
(previously only had 5 -- WHATSAPP_TOKEN, PHONE_NUMBER_ID, WABA_ID, CATALOG_ID,
VERIFY_TOKEN, PORT). Added the Razorpay (3), Supabase (2), Resend (2), and
SITE_ORIGIN vars, grouped by which utils/ module reads them. File: .env.example.

Did not touch server.js, handlers/, or any other utils/ file. Did not push --
per CLAUDE.md Section 5.1 rule 6, waiting on Prashant's explicit go-ahead
immediately before `git push origin main` since this redeploys the live
production WhatsApp bot with no staging environment.

====================================================================

2026-08-08 -- Claude session B (website checkout integration)

Hardened utils/razorpay.js verifyWebhookSignature(). It threw an uncaught exception on a missing or malformed signature header, which crashed the whole Node process (website checkout AND the WhatsApp bot both went down until Render auto-restarted). Now wrapped in try/catch, returns false instead of throwing. File: utils/razorpay.js.

RESTORED routes/checkout.js and the server.js wiring (require plus CORS middleware plus app.use(checkoutRoutes)) after session A's commit 52a84ca ("feat: order status, cancel, resend link, failed/expired payment, allergens, returns, bulk orders") overwrote server.js wholesale and deleted the routes/ directory, silently breaking POST /api/checkout. Files: server.js, routes/checkout.js (recreated).

Built routes/checkout.js: adds POST /api/checkout so the website's hidden checkout.html can create an order plus Razorpay payment link, reusing the existing utils/razorpay.js and utils/database.js instead of duplicating them. Does not touch /razorpay-webhook -- that stays owned by session A's code. Files: routes/checkout.js (new), server.js.

Verified end-to-end via curl: POST /api/checkout returns a real Razorpay test-mode payment link. A full payment was completed and the webhook correctly marked the order paid and attempted a WhatsApp confirmation.

====================================================================

2026-08-08 -- Claude session A (WhatsApp bot / native ordering)

Commit b5101cf onward: Razorpay payment links plus webhook confirmation, Supabase order persistence, address collection flow.

Commit 24e1a5a: idempotent webhook (skip duplicate payment confirmations).

Commit 52a84ca: added payment_link.expired and payment.failed handling, order cancellation, resend payment link, order status lookup, allergen/return/bulk-order FAQ replies. NOTE: this commit's server.js rewrite unintentionally deleted routes/checkout.js and the /api/checkout wiring -- see session B's entry above for the fix. Pull main and read the top of this file before editing server.js again.
