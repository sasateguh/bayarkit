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
- `@bayarkit/billplz`: Billplz API V3 Bills with X Signature verification of both the callback and the redirect
  query, from the official docs and WooCommerce plugin (not yet measured); reproduces all three official X Signature
  test vectors. `startFakeBillplz` in `@bayarkit/testing`.
