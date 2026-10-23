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
- `@bayarkit/chip`: CHIP Collect, from the official OpenAPI (not yet measured): RSA `X-Signature` checked over the
  raw callback body, `fetchPublicKey()` (decodes CHIP's JSON-encoded PEM), callback URLs with a port refused before
  calling CHIP, optional `environment` guard against test purchases confirming live orders.
- `@bayarkit/testing`: fake toyyibPay, Bayarcash and CHIP servers, and the conformance suite every adapter runs.
