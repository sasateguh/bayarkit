# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/)
(0.x: minor versions may contain breaking changes).

## [Unreleased]

### Added

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
- `@bayarkit/2c2p`: 2C2P PGW Payment API v4.x (Payment Token + Payment Inquiry), from the official docs (not yet
  measured): HS256 JWT with node:crypto (secret key used as ASCII text, any `alg` but HS256 refused), all three
  official JWT test vectors reproduced, backend notification verified, the unsigned frontend return never trusted,
  decimal ringgit converted to sen without rounding. `startFake2C2P` in `@bayarkit/testing`.
