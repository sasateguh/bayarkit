# Airwallex — API contract (official sources only)

Researched 2026-10-23. **The docs are public.** Every docs page has a Markdown export (`<page>.md`), and there are two indexes: `https://www.airwallex.com/docs/llms.txt` and `https://www.airwallex.com/llms.txt`. The OpenAPI 3.1.0 spec is official and versioned, in `github.com/airwallex/airwallex-openapi` (MIT). The HTML API reference `https://www.airwallex.com/docs/api` is a JavaScript shell with a Cloudflare challenge script, so use the `.md` exports or the OpenAPI spec instead.
Official GitHub org: `github.com/airwallex`. There is no official PHP/Python server SDK. The only server SDK is `@airwallex/node-sdk` (npm, beta, MIT; its source is not in the GitHub org, so the published `dist/` tarball was read). `github.com/afu-it/*` not used.

Source keys:

| Key | Source |
|---|---|
| OA | https://raw.githubusercontent.com/airwallex/airwallex-openapi/HEAD/openapi/client-api/latest/airwallex-openapi-latest.json (OpenAPI 3.1.0, `info.version` 2026-08-21; cited by JSON path) |
| OAR | https://raw.githubusercontent.com/airwallex/airwallex-openapi/HEAD/README.md |
| WH | https://www.airwallex.com/docs/developer-tools/webhooks/listen-for-webhook-events.md |
| WO | https://www.airwallex.com/docs/developer-tools/webhooks/webhooks-overview.md |
| QS | https://www.airwallex.com/docs/payments/get-started/quickstart.md (HPP via PaymentIntent + Airwallex.js) |
| CS | https://www.airwallex.com/docs/payments/integration-options/web-checkout/checkout-session/quickstart.md (HPP via Checkout Session, no JS) |
| CSC | https://www.airwallex.com/docs/api/checkout/checkout_sessions/create.md |
| PI | https://www.airwallex.com/docs/payments/get-started/using-payments-intent-api.md |
| AI | https://www.airwallex.com/docs/developer-tools/ai-agent-payments-integration.md |
| AIG | https://www.airwallex.com/docs/developer-tools/ai-agent-instructions.md |
| ST | https://www.airwallex.com/docs/payments/reference/payment-statuses.md |
| PW | https://www.airwallex.com/docs/payments/reference/payments-webhooks.md |
| FPX | https://www.airwallex.com/docs/payments/payment-methods/apac/fpx.md |
| CUR | https://www.airwallex.com/docs/payments/reference/supported-currencies.md |
| SBX | https://www.airwallex.com/docs/developer-tools/sandbox-environment.md |
| SIM | https://www.airwallex.com/docs/developer-tools/sandbox-environment/payments/simulate-shopper-action.md |
| RL | https://www.airwallex.com/docs/developer-tools/api/rate-limits.md |
| RF | https://www.airwallex.com/docs/payments/payment-operations/manage-payments/refunds.md |
| CN | https://www.airwallex.com/docs/payments/payment-operations/manage-payments/cancellations.md |
| SDKD | https://www.airwallex.com/docs/developer-tools/sdks/server-side-sdks-(beta).md |
| NODE | npm `@airwallex/node-sdk@2.1.0-beta.5` → `package/dist/...` (official server SDK, beta) |
| MAG | https://raw.githubusercontent.com/airwallex/paymentacceptance-plugin-magento/HEAD/Model/Webhook/Webhook.php (official Magento plugin) |
| SFCC | https://raw.githubusercontent.com/airwallex/airwallex-salesforce-commerce-cloud-cartridge/HEAD/src/int_airwallex/cartridge/scripts/airwallex/util/signatureHelper.ts (+ `__tests__/signatureHelper.test.ts`) |

`X:n` = line n of the `.md` export or raw file, as fetched 2026-10-23.

## 1. Hosts and auth

| Fact | Value | Source |
|---|---|---|
| Production API | `https://api.airwallex.com` (paths `/api/v1/...`) | OA `servers[0]`; OAR "Base URLs"; AI:36 |
| Sandbox API | `https://api.sandbox.airwallex.com` | OA `servers[1]`; OAR; AI:36; SBX:36 |
| Sandbox (legacy name) | The Node SDK builds `https://api-${env}.airwallex.com` with default env `demo`, which gives `api-demo.airwallex.com`. The SFCC cartridge also hard-codes `https://api-demo.airwallex.com`. On 2026-10-23 both names resolved to the same IP and gave the same 403 to a dummy login. | NODE `dist/airwallex.core.js:44,72-77`; SFCC `scripts/constants/apiEndpoints.ts:7` |
| Sandbox model | A separate account at `www.sandbox.airwallex.com` (instant signup, no real money). It has its own Client ID and API key. Additional sandbox accounts must be named "New Business Sandbox" or "Sandbox Business", or KYB stays "In review". | SBX:3,11,19,31 |
| Login | `POST /api/v1/authentication/login` with headers `x-client-id`, `x-api-key` (both required) and optional `x-login-as` (account id for multi-account scoped keys). There is no body. | OA `paths./api/v1/authentication/login.post.parameters`; QS:31-34 |
| Login response | `{ "token": "...", "expires_at": "<ISO8601>" }` | OA same op `responses`; QS:39-43 |
| Token lifetime | OA op description: "valid for 30 minutes … Always refer to the `expires_at` field". `securitySchemes.BearerAuth`: "Tokens expire after a configurable duration". AI:34 says refresh from `expires_at`. NODE drops its cached token after **20 min**. | OA login description; OA `components.securitySchemes.BearerAuth`; AI:34; NODE `airwallex.core.js:35,88` |
| Use | `Authorization: Bearer <token>` | OA `BearerAuth`; SBX:42 |
| API version | Date-based header `x-api-version: YYYY-MM-DD`. Without it the account default applies, and pinning is recommended. The latest spec is `2026-08-21`. NODE beta.5 pins `2025-06-30`. | OAR "API versioning"; NODE `dist/constants/apiConstants.js:4` |

## 2. Create payment (hosted page)

Airwallex has **three** hosted options:

| Option | Endpoint | Redirect to hosted page | Source |
|---|---|---|---|
| A. PaymentIntent + Hosted Payment Page | `POST /api/v1/pa/payment_intents/create`, then in the browser `payments.redirectToCheckout({intent_id, client_secret, currency, successUrl, env:'demo'|'prod'})` from `https://static.airwallex.com/components/sdk/v1/index.js` | **Requires Airwallex.js in the browser.** No server-side URL is returned. | QS:60-79, 117-150; AIG:20 |
| B. Checkout Session (new, "single API call, no JS SDK") | `POST /api/v1/checkout/checkout_sessions/create`, response `url`; redirect with a 302 | Server-only | CS:14,18,52-66,94,118 |
| C. Payment Link | `POST /api/v1/pa/payment_links/create`, response `url` | Server-only, intended for links and invoices | OA `paths./api/v1/pa/payment_links/create` |

### A. PaymentIntent create — fields (OA `paths./api/v1/pa/payment_intents/create.post.requestBody`, response 201)

| Field | Req | Notes | Source |
|---|---|---|---|
| `request_id` | yes | Max 64. This is the idempotency key (v4 UUID suggested). | OA; PI:18,61-63 |
| `amount` | yes | number, **major units** (MYR 12.50 → `12.50`, not `1250`). MYR decimal precision 2. | PI:15; AI:42-43; AIG:11; CUR:94 |
| `currency` | yes | ISO 4217, e.g. `MYR` | OA |
| `merchant_order_id` | yes | Max 64. Your order reference, echoed back. | OA; PI:17 |
| `return_url` | no | "redirect the customer after payment authentication". Required for redirect APMs. **For HPP the redirect is `successUrl` in `redirectToCheckout()`, not `return_url`.** QS:166: HPP goes to `successUrl` if set, else to `return_url`. | OA; AI:53-54; QS:166 |
| `descriptor` | no | Max 32 | OA |
| `metadata` | no | ≤50 keys, key ≤50 chars, value ≤500 chars | OA |
| `customer` / `customer_id` | no | Prefill or saved cards | OA; QS:60 |
| `merchant_website_url`, `order`, `payment_method_options`, `connected_account_id`, ... | no | — | OA |
| Response | `id` (`int_...`), `client_secret` (**valid 60 min, cannot be refreshed**), `status` = `REQUIRES_PAYMENT_METHOD`, `created_at` | OA response schema; PI:51-53; OA `x-examples` |
| Expiry | PaymentIntent: **UNCONFIRMED** (no expiry field, only the 60-minute client_secret). Checkout Session: expires **1 h** after creation (`status` → `EXPIRED`). Payment Link: optional `expires_at` (ISO 8601). | PI:51; CS:107; OA payment_links create |
| Webhook URL per payment | **None.** Webhooks are configured per subscription in the web app (Developer > Webhooks). | WH:13-22 |

### B. Checkout Session create (summary)

Required fields: `account_id`, `mode` (`PAYMENT`), `request_id`. Optional fields include `currency`, `line_items[]` (`price_id`, or inline `price` with `flat_amount`/`unit_amount`), `success_url`, `back_url`, `return_url`, `payment_intent_data.merchant_order_id`, `payment_options.payment_method_types[]` and `metadata` (CSC:29-36,38,141-186,198-202,253,258,282). It needs API version **2026-05-29 or later** (CS:14). The underlying PaymentIntent is created only when the shopper completes checkout (CS:126). Events: `checkout_session.created|cancelled|completed`. For async methods, wait for `payment_intent.succeeded` (CS:171-175).

### C. Payment Link create (summary)

Required fields: `title`, `reusable`. Fixed pricing adds `amount`+`currency`, and there is also `reference` (merchant-only), `expires_at` and `metadata`. **There is no `request_id` and no return/redirect URL field.** Status is `UNPAID`/`PAID`, with `latest_successful_payment_intent_id`. (OA `paths./api/v1/pa/payment_links/create.post`)

## 3. Get / query payment

| Fact | Value | Source |
|---|---|---|
| Endpoint | `GET /api/v1/pa/payment_intents/{id}` (list: `GET /api/v1/pa/payment_intents`) | OA paths |
| Lookup by your reference | Use `merchant_order_id` from the list endpoint (filter params **UNCONFIRMED**, not checked). | OA |
| Amount | `amount`, `captured_amount` (number, major units), `currency` | OA response |
| Reference | `merchant_order_id`, `request_id` (from the last operation), `metadata` | OA response |
| Statuses (PI) | `REQUIRES_PAYMENT_METHOD` (created, or the last attempt failed/expired) · `REQUIRES_CUSTOMER_ACTION` (3DS/redirect/QR) · `REQUIRES_CAPTURE` (only when `auto_capture=false`) · `PENDING` (async, e.g. local methods/direct debit) · `PENDING_REVIEW` (authorised, under risk review) · `SUCCEEDED` (**paid, the final success**) · `CANCELLED`. OA says "this list of statuses is not exhaustive". | OA response `status`; ST:18-26 |
| Failure | There is **no `FAILED` PI status**. A failed attempt reverts the PI to `REQUIRES_PAYMENT_METHOD` and emits `payment_intent.payment_failed` + `payment_intent.requires_payment_method`. | ST:20; PW:18 |
| Attempt detail | `latest_payment_attempt.{id,status,payment_method,failure_code,created_at,updated_at,...}` | OA response `latest_payment_attempt` |
| Paid time | **UNCONFIRMED.** There is no `paid_at`/`succeeded_at` on PaymentIntent. Usable proxies: `updated_at` when `status=SUCCEEDED`, or the webhook event `created_at`. | OA response fields |
| Time format | Examples are inconsistent: `2025-01-31T06:57:10+00:00` (OA example), `2019-10-22T01:54:09+0000` (WH:62), `2021-03-03T08:17:27.659+0000` (PW). OA says `format: date-time`. | OA create `x-examples`; WH:62; PW |
| Sandbox: drive a redirect payment | `POST /api/v1/simulation/pa/shopper_actions/{pay|reject}` with `{"url": next_action.url}` | SIM:18-42 |

## 4. Webhook (callback)

| Fact | Value | Source |
|---|---|---|
| Delivery | HTTP **POST, JSON body**, to the URL registered in the web app (per subscription, with API version per subscription). | WH:11,40; WO:9 |
| Envelope | `{id, name, account_id, org_id, data:{object:<resource>}, created_at, version}`. `data.object` = the same schema as the Retrieve API for that resource. | WH:42-65 |
| Payment events | `payment_intent.{created,requires_payment_method,requires_customer_action,requires_capture,pending,pending_review,succeeded,cancelled,payment_failed,updated}`, `payment_attempt.*`, `refund.{received,accepted,settled,failed}`, `payment_link.{created,paid}` | PW:9-18,62-75,241-244,380-381; OA `webhooks` |
| Headers | `x-timestamp`: Unix time in **milliseconds** (example `1357872222592`). `x-signature`: HMAC hex digest. | WH:35-36 |
| **Signing** | `x-signature = lowercase_hex( HMAC-SHA256( key = webhook secret (per notification URL), message = x-timestamp_string + raw_body ) )` with no separator, timestamp first. | WH:36,86-89,98; Java WH:123-132; PHP WH:160; Node WH:180-181 |
| Key | The webhook secret for that notification URL (web app). **Test events** are signed with the secret in the `client-secret-key` header of the test event. | WH:77,83 |
| Encoding | Hex (`hmacHex`, `hash_hmac(...)` default hex, `digest('hex')`) | WH:132,160,181 |
| Body | Raw bytes, before any JSON parse or re-serialise | WH:94-98 |
| Replay | The docs only say to check the timestamp difference "within your tolerance". No value is given. SFCC uses ±5 min, and MAG does no timestamp check. | WH:90; SFCC `signatureHelper.ts:13,20-24`; MAG:174-186 |
| Compare | The docs use plain `equals`/`!=`/`===`. SFCC uses a constant-time compare. | WH:132,160,183; SFCC:26-33 |
| Ack | Return `200 OK` immediately. Anything else or a timeout is a failure. | WH:71; WO:15 |
| Retries | Exponential back-off for **about 3 days**. Events may be duplicated (dedupe on `id`) and come **out of order** (order by `created_at`). | WO:15,17,18 |
| Source IPs | 25 production IPs and 6 sandbox IPs are listed (e.g. sandbox `35.240.211.132`). | WH:196-233 |
| OpenAPI | `webhooks` lists event names only, with **no** headers/signature. There are no `checkout_session.*` events in OA. | OA `webhooks` |
| Official test vector | **None published.** WH has no fixed body/secret/signature. The SFCC test computes its expected value at runtime with `Date.now()` (secret `test-webhook-secret-key`, payload `{"id":"evt_123","name":"payment_intent.succeeded"}`). | SFCC `__tests__/signatureHelper.test.ts:27-31,53-55` |
| Derived vector (**not official**, computed here with Python `hmac` and `openssl dgst` on 2026-10-23) | ts `1357872222592` (WH:35 example) + body `{"id":"evt_123","name":"payment_intent.succeeded"}` + secret `test-webhook-secret-key` (both from the SFCC test) → `264eba909b8601a09f3edb36b528d20e26e4bed7686cc769c59268edbbf82ecf` | derived |

## 5. Minimum amount, limits, FPX (MYR)

| Fact | Value | Source |
|---|---|---|
| FPX offered | Yes, Online Banking. Shopper country MY, processing currency **MYR**. Available to businesses in MY, SG, HK and others. Activation takes **15-20 business days**. | FPX:17-22; FPX:19 |
| FPX min / max | **1.01 MYR** / **2,000 MYR** (also subject to the bank's limit) | FPX:24-25 |
| FPX refunds | Full and partial within 180 days. They can fail if same-day volume is too low (retry another day). No disputes, no manual capture, no recurring. | FPX:27-31,37 |
| FPX descriptor | "MOLPay", "MOLP", "MOLPay EC" or "NetBuilder EC" | FPX:32 |
| FPX in hosted pages | ✓ Hosted Payment Page, ✓ Payment Links | FPX:45 |
| FPX settlement | MY business: MYR, T+3 business days | FPX:22-23 |
| Generic minimum amount | **UNCONFIRMED** (none stated outside the per-method pages) | — |
| Other MY methods | DuitNow, Touch 'n Go, Boost, GrabPay, ShopeePay, Atome, 7-Eleven Malaysia (per method page) | https://www.airwallex.com/docs/payments/payment-methods.md lines 13-100 |
| Sandbox FPX test | **UNCONFIRMED**. The sandbox payments page covers card numbers and "simulate shopper action" (generic for redirect methods). There is no FPX-specific test bank. | SIM:3,18-21 |
| Rate limits | Production: 100/s global, 20/s per endpoint, 50 concurrent. Sandbox: 20/s, 10/s, 10 concurrent. Over the limit → `429`. | RL:62-65,71 |

## 6. Idempotency, refunds, cancel

| Fact | Value | Source |
|---|---|---|
| Idempotency | Body field `request_id` (required on create PI, cancel, refund, Checkout Session). A retry with the same `request_id` "will return the original successful response". There is no idempotency header. | PI:18,61-63; OA |
| Payment Links | No `request_id`, so link creation is **not** idempotent | OA payment_links create |
| Refund | `POST /api/v1/pa/refunds/create` with `{request_id*, payment_intent_id | payment_attempt_id, amount? (default = remaining), reason? ≤128, metadata?}`. Status `RECEIVED` → `ACCEPTED` (treat as done) → `SETTLED`, or `FAILED`. Multiple partial refunds are allowed. | OA refunds create; RF:39,54 |
| Cancel | `POST /api/v1/pa/payment_intents/{id}/cancel` with `{request_id*, cancellation_reason?}`. Only from `REQUIRES_PAYMENT_METHOD`, `REQUIRES_CUSTOMER_ACTION` or `REQUIRES_CAPTURE`. | OA cancel op; CN |
| SDK retries | NODE retries GET always, POST only for login or when the body has `request_id` (default 1 retry, 300 ms base, exponential with jitter). | NODE `dist/client/apiClient.js` `shouldRetry`/`retryRequest` |

## 7. Contradictions and traps (most valuable)

1. **Sandbox host has two names.** Docs, OA, AI notes and the Magento plugin use `api.sandbox.airwallex.com`. The Node SDK (`env:'demo'`) and the SFCC cartridge use `api-demo.airwallex.com`. They are aliases today (same IP observed), but only the first is documented in the spec. (OA `servers`; AI:36; MAG `Helper/Configuration.php:41`; NODE `airwallex.core.js:76`; SFCC `apiEndpoints.ts:7`)
2. **The Node SDK docs say env `demo`/`production`, but the code checks `'prod'`.** SDKD:57 lists `demo` or `production`, while SDKD:44 and the code use `'prod'` (`airwallex.core.js:73`). Passing `production` silently targets `https://api-production.airwallex.com`.
3. **The official webhook Node sample contradicts its own advice.** WH:94-95 says "Do not use a parsed and re-serialized JSON object", yet the Koa sample falls back to `JSON.stringify(ctx.request.body)` (WH:178).
4. **Amounts are major units, while the examples look like cents.** The guides say `9.99`/`12.50` (PI:15; AI:42), but every PI example uses `"amount": 100` (USD 100.00) (QS:70; OA `x-examples`). Multiplying by 100 overcharges 100×.
5. **The HPP redirect field depends on the flavour.** PaymentIntent HPP uses `successUrl` in the JS call, with `return_url` as fallback (AI:54; QS:166). Checkout Session uses `success_url`/`back_url`/`return_url` in the API body (CSC). Payment Links have no redirect field (OA).
6. **The Checkout Session API is missing from the published OpenAPI.** The docs say it needs API version 2026-05-29+ (CS:14), but the "latest" OA (2026-08-21) has no `/api/v1/checkout/checkout_sessions*` paths and no `checkout_session.*` webhooks. Only the docs `.md` (CSC) describes it.
7. **Token lifetime:** 30 min (OA login op), "configurable" (OA securityScheme), "short-lived, read `expires_at`" (AI:34), and the Node SDK refreshes every 20 min.
8. **Timestamp tolerance is unspecified.** The docs leave it to you (WH:90). The official plugins differ: SFCC uses 5 min, Magento uses none and a non-constant-time `!==` (MAG:186).
9. **The cancel doc example uses different `request_id` values in the request and the response** (`285ecfc8…` vs `c2e5204e…`) (CN). It is a cosmetic doc error.
10. **Date-time strings use mixed offsets** (`+00:00`, `+0000`, with or without milliseconds), so use a tolerant parser (§3).
