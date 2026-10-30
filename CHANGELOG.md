# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/)
(0.x: minor versions may contain breaking changes).

## [Unreleased]

### Added

- The demo is hosted at https://bayarkit.sasateguh.com, built from `examples/demo/Dockerfile` (non-root, read-only
  file system). A fourth scenario sends the genuine paid callback of another, cheaper order: only the match on
  reference and amount refuses it.
- `@bayarkit/paddle` and `Bayarkit\Gateways\Paddle`: Paddle Billing, for selling abroad with Paddle as merchant of
  record. One-time transactions sent tax-inclusive, `Paddle-Signature` webhooks, refunds. Paddle has no MYR: the
  adapter charges in one configured currency (USD by default). Measured on the sandbox: card payments paid and
  declined, real signed webhooks (retries re-signed), full and partial refunds. The price is sent with its quantity
  fixed at 1, because the checkout otherwise lets the buyer pick 1 to 100.
- `@bayarkit/paypal` and `Bayarkit\Gateways\PayPal`: PayPal Orders v2. `capturePayment` captures an approved order
  (safe to retry); `getPayment` only reads, and an order is paid only when its capture is `COMPLETED`. Webhooks are
  verified by PayPal's `verify-webhook-signature`. Refunds. Measured on the sandbox: a sandbox buyer approving, captures
  in USD and MYR (JPY, a currency the account did not hold, stayed `PENDING`), real webhooks verified, full and partial
  refunds.
- Refunds, an optional capability: `refundPayment({ paymentId, amount })` returns a `RefundRecord` (`pending`,
  `succeeded`, `failed`, `unknown`); an amount above what is left is refused before any request
  (`checkRefundAmount`). PHP: `Bayarkit\Refunds`, `RefundInput`, `RefundRecord`. The conformance suite runs its refund
  cases only for adapters that implement it. No existing adapter changes.
- `verifyCallback` may return a Promise (a gateway that verifies by an API call); `confirmPayment` awaits it, and a
  rejected Promise is `gateway_error`, not `invalid_signature`. Synchronous adapters are unchanged.
- `GatewayInfo.currency`: the currency an adapter charges in, which `confirmPayment` expects when the order names
  none (MYR when absent).
- `@bayarkit/testing`: `startFakePaddle` and `startFakePayPal`, and `bayarkit-fake paddle` / `bayarkit-fake paypal`.
  The control API gains `POST /approve/<id>` (PayPal: the buyer approves, nothing captured).

### Changed

- Every README (the repository, the PHP package and each npm package) ends with a "Need help installing?" section in
  English and Malay, generated from one file, `docs/support.json`, by `node tools/rujukan.mjs skills`. It replaces the
  "Work with Sasa Teguh" section and names three contacts: the contact page, admin@sasateguh.com and WhatsApp. The
  generator refuses a config that names another contact, a price or a ranking claim; `"enabled": false` removes the
  section everywhere.
- Demo: a new look in light and dark themes (switched with a link, no JavaScript) and self-hosted fonts. The
  simulated payment page is drawn as a taped "fake gateway" panel apart from the demo, each check on the order page
  shows a drawn mark and its state in words, and 404 / 503 are pages with a way back.
- `scripts/demo-webkit.py` also checks the demo at 1440 px, the theme switch, that the install offer stays in the flow
  of every page without covering a button, form or the simulated gateway, and that WebKit has not crashed 8 s after
  loading. The README pictures (`docs/demo/`) show the new look.

### Fixed

- Demo: on the order page, checks that did not run were moved off screen by the skip link's style.

- Demo memory: each rotated set of fakes now uses its own HTTP agent, closed with the set. Global `fetch` kept a
  connection pool for every port it had seen (~1.7 MB per 1 000 checkouts). Smoke setups accept an optional `fetch`.

## [0.2.2] - 2026-10-27

### Changed

- Package descriptions on npm say what each adapter does for Node.js and TypeScript (create payments, verify callbacks,
  confirm with a fresh status query), and every package carries the `nodejs` keyword. No code changes.

## [0.2.1] - 2026-10-27

Billplz measured on its sandbox.

### Changed

- Evidence: `@bayarkit/billplz` is now `measured` (www.billplz-sandbox.com, 27 Oct 2026): a paid and a failed payment
  through the simulator, with the real server-to-server callback and the redirect both verified by the adapter. Changing
  one field fails the X Signature. A failed payment still sends a callback (`paid=false`, `state=due`), and neither the
  callback nor the redirect carries `reference_1`: find the order by the bill id (see `examples/web-standard`).
- `@bayarkit/testing`: the Billplz fake upper-cases the collection and payer name from creation on, as the sandbox does,
  and keeps `paid_at` (`null` until paid) on create and get.

## [0.2.0] - 2026-10-27

Three gateways measured on their sandboxes, and a security fix in `@bayarkit/bayarcash` that the measurement found.

### Security

- `@bayarkit/bayarcash`: the check that a transaction belongs to your portal never ran. The API secret key covers every
  portal in a Bayarcash account, so a correctly signed return or callback from another portal could confirm your order
  when the order numbers matched. The adapter looked for `portal_key` on the transaction; the sandbox shows the portal
  only by name (`portal`). It now compares that name with the name of your configured portal key (`GET /portals`, read
  once) and refuses anything else with `FOREIGN_PORTAL`. Give each portal in an account a unique name.

### Changed

- `@bayarkit/bayarcash`: `getPayment` also takes the payment intent id that `createPayment` returns (`pi_…`). An unpaid
  intent reads as `pending`; a paid one is read through its transaction. Before, it answered HTTP 404.
- Evidence: Bayarcash and Stripe are now `measured`. toyyibPay's status query was measured again with and without
  `userSecretKey`.
- `@bayarkit/testing`: the toyyibPay fake empties only the payer fields without `userSecretKey` (the sandbox keeps the
  fee); the Bayarcash fake answers with the measured shapes (201 for intents, `portal` by name, `GET /payment-intents/{id}`).

### Added

- Gotchas: a wrong toyyibPay secret key looks like an unpaid bill; Bayarcash portals share one secret; a Bayarcash checkout
  id is an intent, not a transaction; a failed Stripe FPX payment sends no Checkout event; Stripe's error below RM2.00
  names the payment method types, not the amount.

## [0.1.0] - 2026-10-27

First release: `@bayarkit/core`, `@bayarkit/testing`, fourteen gateway adapters on npm, and `bayarkit/bayarkit`
(PHP/Laravel: toyyibPay and CHIP).

### Added

- `@bayarkit/core`: the `Gateway` interface, `confirmPayment` (signature → fresh gateway query → exact reference,
  amount and currency match), `readCallback` (fields + raw body + headers, so both body-signed and header-signed
  gateways verify; JSON, url-encoded, multipart), integer-sen money helpers.
- `@bayarkit/core`: `checkoutResponse(payment, label?)` sends the customer to pay — a 303 redirect, or, for
  gateways that take a POSTed form (`CreatedPayment.form`: iPay88, eGHL, Fiuu), an HTML-escaped self-submitting page
  with a visible button, `no-store`, `noindex` and a hash-pinned CSP. `autoPostHtml` and the `PaymentForm` type are
  exported; iPay88's own `autoPostHtml`/`IPay88Form` now point at them.
- `@bayarkit/testing`: fake toyyibPay, Bayarcash and CHIP servers, and the conformance suite every adapter runs.
- `bayarkit-fake` CLI in `@bayarkit/testing`: any fake as a standalone server with an HTTP control API, for tests in
  other languages (no vitest needed; vitest is now an optional peer).
- `@bayarkit/toyyibpay`: measured on the toyyibPay sandbox (10 October 2026).
- `@bayarkit/bayarcash`: Bayarcash API v3, from the official docs and PHP SDK (not yet measured).
- `@bayarkit/billplz`: Billplz API V3 Bills with X Signature verification of both the callback and the redirect
  query, from the official docs and WooCommerce plugin (not yet measured); reproduces all three official X Signature
  test vectors. `startFakeBillplz` in `@bayarkit/testing`.
- `@bayarkit/chip`: CHIP Collect, from the official OpenAPI (not yet measured): RSA `X-Signature` checked over the
  raw callback body, `fetchPublicKey()` (decodes CHIP's JSON-encoded PEM), callback URLs with a port refused before
  calling CHIP, a required `environment` that refuses a purchase from the other mode.
- `@bayarkit/stripe`: Stripe (Malaysia) Checkout Sessions over raw REST, card + FPX in MYR, from the official docs
  (not yet measured): pins `Stripe-Version: 2026-09-30.endive` and sends `allowed_payment_method_types[]` (endive
  rejects `payment_method_types` with 400); webhooks verified like stripe-node (`${t}.${rawBody}`, every `v1`, 300 s
  tolerance). `@bayarkit/testing` gains `startFakeStripe`.
- `@bayarkit/hitpay`: HitPay Payment Requests, from the official docs, OpenAPI and PHP SDK (not yet measured): sen ↔
  ringgit at the edge; BOTH callback schemes verified as separate paths with separate salts (event webhook
  `Hitpay-Signature` over the RAW body with the webhook salt; legacy per-request `hmac` over sorted key+value fields
  with the API salt); re-serialised JSON is refused. `startFakeHitPay` in `@bayarkit/testing`.
- `@bayarkit/2c2p`: 2C2P PGW Payment API v4.x (Payment Token + Payment Inquiry), from the official docs (not yet
  measured): HS256 JWT with node:crypto (secret key used as ASCII text, any `alg` but HS256 refused), all three
  official JWT test vectors reproduced, backend notification verified, the unsigned frontend return never trusted,
  decimal ringgit converted to sen without rounding. `startFake2C2P` in `@bayarkit/testing`.
- `@bayarkit/senangpay`: senangPay on the DOKU platform (Checkout API), from the official DOKU Malaysia API Reference
  (not yet measured): `Signature: HMACSHA256=` over Client-Id, Request-Timestamp, path and the base64 SHA-256 digest of
  the RAW body, per the written rules and the Java/Ruby samples (the Python/Node `Digest:` form is refused);
  notifications verified over the merchant's notification path; sen ↔ ringgit only at the edge. `startFakeSenangPay` in
  `@bayarkit/testing`.
- `@bayarkit/curlec`: Razorpay Curlec, from the official docs (not yet measured): Payment Links (hosted page) whose
  `getPayment` reports the order's state, `createOrder` for Standard Checkout; webhooks verified over the RAW body with
  the webhook secret (the official Node sample's `JSON.stringify(parsed)` fails), Payment Link and Checkout callbacks
  with the key secret; all five official test vectors reproduced. `startFakeCurlec` in `@bayarkit/testing`.
- `@bayarkit/gkash`: Gkash host-to-host checkout + transaction query, from the official docs, WooCommerce plugin and
  gkashmy SDKs (not yet measured): SHA-512 over the whole upper-cased string (AMT keeps the leading zero, `0.10` →
  `010`), every official test vector reproduced, the signed checkout response verified, the unsigned query checked
  against the cart id asked for, only status `88` is paid; DOC's own callback example (wrong CID) is refused.
  `startFakeGkash` in `@bayarkit/testing`.
- `@bayarkit/ipay88`: iPay88 Malaysia (OPSG, now NTT DATA Payment Services), from the official public tools on the
  gateway host (no developer docs are public; not yet measured): HMAC-SHA512 keyed with the MerchantKey over a message
  that also starts with it, all three official HMAC vectors reproduced, every "." and "," stripped from the signed
  amount (the official tool strips only the first of each); the checkout is a form POST (`form` + `html`, not a
  redirect); re-query through `enquiry.asp` where only the exact text `00` is paid; `BACKEND_ACK` = `RECEIVEOK`.
  `startFakeIPay88` in `@bayarkit/testing`.
- `@bayarkit/xendit`: Xendit (Malaysia) Payment Sessions plus the v3 payment request lookup, from the official docs (not
  yet measured): Basic auth, the key prefix picks test or live; amounts in ringgit at the API, sen at the interface.
  Webhooks carry NO signature, only a static `x-callback-token`, compared in constant time before the RAW body is
  parsed; `confirmPayment`'s fresh GET is the real protection. Reads `payment_session.*` and `payment.*` events.
  `startFakeXendit` in `@bayarkit/testing`.
- `@bayarkit/fiuu`: Fiuu (formerly Razer Merchant Services / MOLPay) hosted payment page, from the official API spec
  PDF v13.97, WooCommerce plugin and PHP SDK (not yet measured): `vcode` standard or extended (config flag; the official
  vector reproduced), callback `skey` double MD5 over the strings exactly as posted (`RM` → `MYR` afterwards), requery
  q_by_tid / q_by_oid with the answer's `VrfKey` checked, one request per `getPayment` (never polled). Ids carry the
  order, amount and `tranID` because Fiuu has no create API and every requery hashes the amount. `startFakeFiuu` in
  `@bayarkit/testing`.
- `@bayarkit/eghl`: eGHL (ADAPTIS e-Commerce), from the official public code only (no public API guide; not yet
  measured): GET/POST redirect to `payment.aspx` with the SALE HashValue, callbacks verified with the 10-field
  HashValue2 of the eGHL_HASH class (the official Omnipay vector reproduced; the shorter Magento/OpenCart variants are
  refused), status from a signed QUERY that repeats the original amount, sen ↔ ringgit at the edge.
  `startFakeEghl` in `@bayarkit/testing`.
- `php/` — `bayarkit/bayarkit` for PHP 8.2+ and Laravel 11/12: the core interface, `Confirm::payment`, `Checkout`,
  toyyibPay (measured) and CHIP (docs) adapters, a service provider configured from `.env`, `Callback::from($request)`,
  `Checkout::response()`, `php artisan bayarkit:chip-public-key`. Tested against the same `bayarkit-fake` gateways as
  the TypeScript adapters (`scripts/php-gate.sh`, in the gate), plus phpstan level 8. `scripts/php-compat.sh` proves
  the composer promises: PHP 8.2 with the lowest dependencies (Laravel 11) and PHP 8.4 with the newest (Laravel 12).
- Every package has a generated README (EN + BM: install, the same quick start, the gateway's sourced traps, a link
  to its spec) and full npm metadata (repository with directory, homepage, bugs, keywords, provenance), from the root
  `package.json` and the registry; `rujukan skills --check` keeps all 16 from drifting.
- `docs/demo/demo.png` + `demo.ms.png` in the READMEs, regenerated from the running demo by `scripts/demo-shot.py`.
- Issue forms (bug, gateway request; secrets warned against) and a pull-request checklist from CONTRIBUTING.
- `examples/demo` (`npm run demo`): every adapter against its fake, BM + EN, no browser JavaScript; pay / unpaid
  signed callback / forged callback, with each `confirmPayment` check shown. Tested for all gateways in vitest and on
  WebKit iPhone 13 (`scripts/demo-webkit.py`).
- `examples/web-standard`: checkout and callback handlers that take any `Gateway`; its test runs them unchanged against the fake of every gateway. The README testing snippet runs as written in the suite.
- Release tooling: `.github/workflows/release.yml` publishes every package on a `v*` tag through npm Trusted Publishing with provenance; `scripts/release-check.mjs` (in the gate) keeps all packages on one version with exact internal dependencies.

### Fixed before release

Found by the toyyibPay sandbox measurement, the daily docs check and independent AI review rounds; each fix has a test
that failed first.
- CHIP (both twins): `environment` is required and a purchase that does not state `is_test` is refused, so a test
  payment does not confirm a live order: pass `environment: 'test' | 'live'` (`CHIP_ENV` in PHP).
- Gkash: references are upper-case only (`[A-Z0-9._-]`); Gkash's signature does not cover letter case, so
  a lower-case reference is refused.
- senangPay: compares `payment.amount` when the retrieve carries it.
- demo: memory bound holds under parallel load (100 at once), and a failing rotation cools down and answers 503.
- Billplz: a bill from ANOTHER collection of the same account is refused (`FOREIGN_COLLECTION`; the X Signature
  key is account-wide), and a paid bill is compared on `paid_amount`, the money received.
- Bayarcash: a transaction reported for another portal is refused (`FOREIGN_PORTAL`).
- toyyibPay, Bayarcash: `verifyCallback` no longer throws on a missing body; the conformance suite now feeds every
  adapter `{}`, nulls and array values.
- `confirmPayment` (both twins): a `verifyCallback` that throws is a `gateway_error` (a bug or a broken key, not a
  forgery); unknown errors are named by class, never quoted.
- TS/PHP parity: numbers are read as the decimal text JavaScript writes for them (`1.005` → 101 in
  both, on PHP 8.2/8.3/8.4 alike), ASCII whitespace only, `Text::of` = ECMAScript `Number::toString`. A randomised
  differential of 20,030 inputs finds 0 differences.
- From an independent review (no false "paid" path found; every fix has a test from the reviewer's scenario):
  PHP reads gateway JSON like the TS twin (`true` is not status "1"), never throws from `verifyCallback` or
  `Confirm::payment`, caps `toSen` at a safe integer (both twins), works on Laravel 11 with any timeout and wraps
  Guzzle transfer errors; the demo survives malformed requests, caps memory, uses relative redirects and one choice
  per order; `rujukan` runs through a symlink.
- `toSen` parses ringgit strings as exact decimals ("10.505" → 1051, not 1050 through a float) and refuses
  `"1e3"`, `".5"`, `"+10"`; `toRinggit` uses integer arithmetic. The TS and PHP twins now share
  `packages/core/test/money-vectors.json`.
- toyyibPay (TS + PHP): `getPayment` sends the owner's `userSecretKey`. toyyibPay's API reference (changed 23 Oct 2026)
  now empties the fee (`transactionCharge`) and payer fields without it, and returns nothing for another account's key,
  so a bill code from someone else's account can never read as paid. Not yet measured on the sandbox.
- `rujukan`: links to a page's own site are made relative before fingerprinting; Curlec and HitPay flipping absolute ↔
  relative links raised five false "changed" alerts with identical text.
- `@bayarkit/testing`: the Billplz and Gkash fakes' `tamper()` changed `fields` but left `rawBody` with the original,
  valid signature — a callback that cannot exist. The conformance suite now requires every fake's form/JSON body to say
  what its fields say, tampered or not.

[0.2.2]: https://github.com/sasateguh/bayarkit/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/sasateguh/bayarkit/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/sasateguh/bayarkit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sasateguh/bayarkit/releases/tag/v0.1.0
