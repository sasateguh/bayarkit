# bayarkit

One TypeScript interface for Malaysian payment gateways, and the safe way to confirm a payment.
Write your checkout once; switch gateways by changing one line.

[Bahasa Melayu](README.ms.md)

> **Status:** pre-release (0.1.0), not on npm yet. Nine gateways, with more planned below.

## Why

- **Switching gateways should not mean rewriting checkout.** Every adapter implements the same `Gateway` interface:
  `createPayment`, `getPayment`, `verifyCallback`.
- **Confirming a payment is where shops lose money.** `confirmPayment` does all three checks every time: the callback
  signature, a fresh query to the gateway (a valid signature can be replayed), and an exact match on reference, amount
  and currency.
- **Sandboxes do not always behave like their docs.** The toyyibPay adapter and its fake follow what the sandbox
  actually returned, not what the reference says (table below). Each adapter states where its behaviour comes from.
- **Test without real money.** `@bayarkit/testing` ships fake gateways and a conformance suite that every adapter must
  pass.

## Gateways

<!-- gateways:table (generated from gateways/registry.json by `node tools/rujukan.mjs skills`) -->
| Gateway                          | Package               | Evidence                                                                                                                             |
| -------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| toyyibPay                        | `@bayarkit/toyyibpay` | Measured on the sandbox, 10 Oct 2026, including a real test-bank FPX payment                                                         |
| Bayarcash (also behind BCL.my)   | `@bayarkit/bayarcash` | Official API v3 docs and PHP SDK; not yet measured on the sandbox                                                                    |
| Billplz                          | `@bayarkit/billplz`   | Official API docs (V3 Bills, X Signature test vectors) and the official WooCommerce plugin; not yet measured on the sandbox          |
| CHIP (CHIP Collect)              | `@bayarkit/chip`      | Official CHIP Collect OpenAPI; not yet measured in test mode                                                                         |
| Stripe (Malaysia): card + FPX    | `@bayarkit/stripe`    | Official docs (Checkout Sessions, API `2026-09-30.endive`) and stripe-node's webhook check; not yet measured in test mode            |
| senangPay (on the DOKU platform) | `@bayarkit/senangpay` | Official DOKU Malaysia API Reference (Checkout, `HMACSHA256=` Signature) and the senangPay DOKU FAQ; not yet measured on the sandbox |
| 2C2P (PGW Payment API v4.x)      | `@bayarkit/2c2p`      | Official developer docs (Payment Token + HS256 JWT, three official JWT test vectors); not yet measured on the sandbox                |
| Razorpay Curlec                  | `@bayarkit/curlec`    | Official docs (Payment Links + Orders, three signatures, all five official test vectors); not yet measured in test mode              |
| HitPay                           | `@bayarkit/hitpay`    | Official docs (OpenAPI, Payment Requests, both webhook signatures) and official PHP SDK; not yet measured on the sandbox             |
<!-- /gateways:table -->

Planned next: the gateways listed in [gateways/README.md](gateways/README.md). An adapter is listed as _measured_ only after the
conformance suite has run against that gateway's sandbox.

Amounts are always integer **sen** (`1050` = RM10.50), so nothing compares floating-point ringgit.

## Quick start

```ts
import { confirmPayment, readCallback } from '@bayarkit/core'
import { toyyibpay } from '@bayarkit/toyyibpay'

const gateway = toyyibpay({ secretKey, categoryCode, environment: 'sandbox' })

// 1. Checkout: one reference per attempt, then redirect the customer.
const payment = await gateway.createPayment({
  reference: 'ORD1001',
  amount: 1050,
  description: 'Order 1001',
  customer: { name: 'Ali', email: 'ali@example.com' },
  returnUrl: 'https://shop.example/thank-you',
  callbackUrl: 'https://shop.example/api/payment/callback',
})
// redirect to payment.url

// 2. Callback: never mark an order paid from the callback body or the return URL alone.
const callback = await readCallback(request) // JSON, url-encoded or multipart (toyyibPay posts multipart)
const result = await confirmPayment(gateway, callback, { reference: 'ORD1001', amount: 1050 })
if (result.ok) {
  // mark the order paid (idempotently: gateways retry callbacks)
}
```

A complete checkout and callback with Web-standard handlers (Next.js, Hono, Bun, Deno) is in
[examples/web-standard/checkout.ts](examples/web-standard/checkout.ts). To use Bayarcash instead, replace the
`toyyibpay(...)` call with `bayarcash({ token, secretKey, portalKey, environment: 'sandbox' })`.

For CHIP, use `chip({ secretKey, brandId, publicKey })`. CHIP has one host: a test-mode secret key makes test
purchases. Callbacks are signed with CHIP's RSA key over the raw body, so read them with `readCallback` (not a parsed
body). Get the public key once with `await chip({ secretKey, brandId }).fetchPublicKey()` (same secret key), store it,
and pass it as `publicKey`; without it every callback is refused. CHIP rejects a `callbackUrl` with a port, even `:443`.

## What `confirmPayment` checks

| Step                              | Rejects                                                        | Result              |
| --------------------------------- | -------------------------------------------------------------- | ------------------- |
| Callback signature                | forged or altered callbacks                                    | `invalid_signature` |
| Fresh query to the gateway        | replayed callbacks, callbacks sent before payment, leaked keys | `not_paid`          |
| Reference, amount (sen), currency | a real payment for another order or another amount             | `mismatch`          |
| Gateway unreachable               | — (you retry later)                                            | `gateway_error`     |

## toyyibPay: docs vs the sandbox

Measured on `dev.toyyibpay.com`, 10 October 2026:

| Thing                     | Docs               | Sandbox                                                                                                   |
| ------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------- |
| Response body             | JSON               | prefixed with tabs, sent as `text/html`                                                                   |
| Bill with no transactions | `[]`               | the text `No data found!`                                                                                 |
| `getCategoryDetails`      | `[{categoryName}]` | `{CategoryName}`                                                                                          |
| createBill errors         | not documented     | `[KEY-DID-NOT-EXIST-OR-USER-IS-NOT-ACTIVE]`, `[CATEGORY-NOT-MATCH]`, or JSON `{"status":"error","msg":…}` |
| `billExpiryDate`          | format only        | read in Malaysia time                                                                                     |
| Minimum amount            | "more than RM1.00" | RM1.00 itself is accepted                                                                                 |
| Callback body             | form post          | `multipart/form-data`                                                                                     |

## Gateway knowledge that stays current

Adapters are half of it. The other half is knowing what each gateway's official documentation says today:
- [`gateways/registry.json`](gateways/registry.json) lists every Malaysian gateway bayarkit knows about, with its
  official documentation and official SDK code as sources.
- Each researched gateway has a spec (`gateways/<id>/spec.md`) with an official source next to every fact, and a list
  of traps: places where the docs, the official SDK or the official AI skill are wrong or out of date.
- `node tools/rujukan.mjs check` fingerprints every source daily and reports when one changes, so the spec, the fake and
  the adapter are re-read against the new docs. A source must contain words it declares (`mustContain`), so a docs page
  that turns into a JavaScript shell or a login wall fails loudly instead of being "watched".
- `skills/<id>/SKILL.md` are generated from the same data for AI coding agents, and point at runnable, tested code.

Coverage, generated: [gateways/README.md](gateways/README.md). Only fingerprints are stored here; the documentation
itself belongs to each gateway.

## Testing your own code

```ts
import { startFakeToyyibPay } from '@bayarkit/testing'

const fake = await startFakeToyyibPay({ secretKey: 's', categoryCode: 'c' })
const gateway = toyyibpay({ secretKey: 's', categoryCode: 'c', environment: 'sandbox', baseUrl: fake.url })
const payment = await gateway.createPayment(order)
fake.markPaid(payment.id)
await yourCallbackHandler(fake.callbackFor(payment.id)) // signed exactly like the real gateway
```

### Tests in other languages (PHP/Laravel, Python, Go)

`npx bayarkit-fake <gateway>` runs one fake gateway as a server and prints one JSON line
with its `url` and a `control` URL. Point your app at `url`, then drive it over HTTP: `POST <control>/paid/<id>` marks a
payment paid, `GET <control>/callback/<id>` returns the exact signed callback (`/tampered` for a forged one) to post to
your callback route. It does not need vitest.

## Adding a gateway

Write an adapter and a fake, then make them pass `gatewayConformance` from `@bayarkit/testing`.
See [CONTRIBUTING.md](CONTRIBUTING.md).

## How this was built

bayarkit was built with AI coding assistance (Claude Code) under the direction of its author, Muhammad Aiman.

The evidence that it works is meant to be checkable:
- The adapters come from the author's own systems: toyyibPay from an ERP checkout that was tested end to end against
  the toyyibPay sandbox (10 October 2026); Bayarcash from a SaaS checkout, written from the official docs and not yet
  run against the sandbox.
- The test suite, run with `npm run gate`, runs offline against the fakes, and installs the packed packages into an
  empty project before passing.
- Each adapter's `info.evidence` says whether it was measured on a sandbox or written from documentation only.

## License

MIT. See [LICENSE](LICENSE). Security issues: see [SECURITY.md](SECURITY.md).
