# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/)
(0.x: minor versions may contain breaking changes).

## [Unreleased]

### Added

- `examples/demo` (`npm run demo`): every adapter against its fake, BM + EN, no browser JavaScript; pay / unpaid
  signed callback / forged callback, with each `confirmPayment` check shown. Tested for all gateways in vitest and on
  WebKit iPhone 13 (`scripts/demo-webkit.py`).

### Fixed

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
- `php/` — `bayarkit/bayarkit` for PHP 8.2+ and Laravel 11/12: the core interface, `Confirm::payment`, `Checkout`,
  toyyibPay (measured) and CHIP (docs) adapters, a service provider configured from `.env`, `Callback::from($request)`,
  `Checkout::response()`, `php artisan bayarkit:chip-public-key`. Tested against the same `bayarkit-fake` gateways as
  the TypeScript adapters (`scripts/php-gate.sh`, in the gate), plus phpstan level 8. `scripts/php-compat.sh` proves
  the composer promises: PHP 8.2 with the lowest dependencies (Laravel 11) and PHP 8.4 with the newest (Laravel 12).
- `@bayarkit/core`: `checkoutResponse(payment, label?)` sends the customer to pay — a 303 redirect, or, for
  gateways that take a POSTed form (`CreatedPayment.form`: iPay88, eGHL, Fiuu), an HTML-escaped self-submitting page
  with a visible button, `no-store`, `noindex` and a hash-pinned CSP. `autoPostHtml` and the `PaymentForm` type are
  exported; iPay88's own `autoPostHtml`/`IPay88Form` now point at them.
- `bayarkit-fake` CLI in `@bayarkit/testing`: any fake as a standalone server with an HTTP control API, for tests in
  other languages (no vitest needed; vitest is now an optional peer).
- `@bayarkit/core`: the `Gateway` interface, `confirmPayment` (signature → fresh gateway query → exact reference,
  amount and currency match), `readCallback` (fields + raw body + headers, so both body-signed and header-signed
  gateways verify; JSON, url-encoded, multipart), integer-sen money helpers.
- `@bayarkit/toyyibpay`: measured on the toyyibPay sandbox (10 October 2026).
- `@bayarkit/bayarcash`: Bayarcash API v3, from the official docs and PHP SDK (not yet measured).
- `@bayarkit/testing`: fake toyyibPay and Bayarcash servers, and the conformance suite every adapter runs.
- `@bayarkit/billplz`: Billplz API V3 Bills with X Signature verification of both the callback and the redirect
  query, from the official docs and WooCommerce plugin (not yet measured); reproduces all three official X Signature
  test vectors. `startFakeBillplz` in `@bayarkit/testing`.
- `@bayarkit/stripe`: Stripe (Malaysia) Checkout Sessions over raw REST, card + FPX in MYR, from the official docs
  (not yet measured): pins `Stripe-Version: 2026-09-30.endive` and sends `allowed_payment_method_types[]` (endive
  rejects `payment_method_types` with 400); webhooks verified like stripe-node (`${t}.${rawBody}`, every `v1`, 300 s
  tolerance). `@bayarkit/testing` gains `startFakeStripe`.
- `@bayarkit/chip`: CHIP Collect, from the official OpenAPI (not yet measured): RSA `X-Signature` checked over the
  raw callback body, `fetchPublicKey()` (decodes CHIP's JSON-encoded PEM), callback URLs with a port refused before
  calling CHIP, optional `environment` guard against test purchases confirming live orders.
- `@bayarkit/testing`: fake toyyibPay, Bayarcash and CHIP servers, and the conformance suite every adapter runs.
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
