AGENT LOG

This repo is edited by two separate Claude chat sessions that do not share context or memory with each other. This file exists so both sessions can see what the other one did, since a silent overwrite already happened once (see the 2026-08-08 entries below).

RULE: before editing server.js, routes/, handlers/, or utils/, read this file top to bottom. After committing a change, add a new entry at the TOP with today's date, what you changed, which files, and why. Keep entries short.

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
