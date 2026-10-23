# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/)
(0.x: minor versions may contain breaking changes).

## [Unreleased]

### Added

- `@bayarkit/core`: the `Gateway` interface, `confirmPayment` (signature → fresh gateway query → exact reference,
  amount and currency match), `readCallback` (fields + raw body + headers, so both body-signed and header-signed
  gateways verify; JSON, url-encoded, multipart), integer-sen money helpers.
- `@bayarkit/toyyibpay`: measured on the toyyibPay sandbox (10 October 2026).
- `@bayarkit/bayarcash`: Bayarcash API v3, from the official docs and PHP SDK (not yet measured).
- `@bayarkit/testing`: fake toyyibPay and Bayarcash servers, and the conformance suite every adapter runs.
- `@bayarkit/stripe`: Stripe (Malaysia) Checkout Sessions over raw REST, card + FPX in MYR, from the official docs
  (not yet measured): pins `Stripe-Version: 2026-09-30.endive` and sends `allowed_payment_method_types[]` (endive
  rejects `payment_method_types` with 400); webhooks verified like stripe-node (`${t}.${rawBody}`, every `v1`, 300 s
  tolerance). `@bayarkit/testing` gains `startFakeStripe`.
