# Xendit (Malaysia) — API contract from official sources

Researched 23 Oct 2026. Docs are **public** (no login needed): `https://docs.xendit.co` serves a Markdown export of every
page when you add `.md` (index at `https://docs.xendit.co/llms.txt`). API reference `.md` pages carry the **official
OpenAPI 3.0 JSON** inline, so JSON pointers (`#/components/...`) below point into that embedded spec.
`www.xendit.co` answers 403 to curl. Nothing here comes from blogs or `afu-it/*`.

**Products in scope.** Xendit now steers new integrations to **Payment Sessions** (`/sessions`, hosted checkout = the
redirect-and-callback flow that maps to "create payment → callback") and the low-level **Payments API v3**
(`/v3/payment_requests`). The **legacy Invoice / Payment Link** (`/v2/invoices`) still works and the official WHMCS plugin
and SDKs still use it. Its successor is Sessions (MIGS). AI-SKILL L110-112 says: "APIs not documented here are
legacy. Do not use for new integrations."

## Source keys

| Key | Source |
|---|---|
| QS | https://docs.xendit.co/apidocs/quick-setup.md |
| INTRO | https://docs.xendit.co/apidocs/introduction.md |
| CS / GS / XS | https://docs.xendit.co/apidocs/create-session.md · get-session.md · cancel-session.md (embedded OpenAPI) |
| SWH | https://docs.xendit.co/apidocs/webhook-notification-sent-defined-webhook-url-updates-payment-session.md |
| CPR / GPR | https://docs.xendit.co/apidocs/create-payment-request.md · get-payment-request.md |
| PWH | https://docs.xendit.co/apidocs/payment-webhook-notification.md |
| RF / RWH | https://docs.xendit.co/apidocs/refund-payment-request.md · refund-webhook-notification.md |
| SIM | https://docs.xendit.co/apidocs/simulate-payment-test-mode.md |
| WB | https://docs.xendit.co/apidocs/webhook-behavior.md |
| HW / IS / DW | https://docs.xendit.co/docs/handling-webhooks.md · integration-security.md · delayed-webhooks.md |
| RL | https://docs.xendit.co/apidocs/rate-limits.md |
| PSO / P1 | https://docs.xendit.co/docs/payment-sessions-overview.md · payment-1.md |
| PAW / PIS | https://docs.xendit.co/docs/payments-api-webhooks.md · payments-integration-setup.md |
| MIG3 / MIGS | https://docs.xendit.co/docs/migrate-payment-api-v2-to-v3.md · migrate-to-payment-session.md |
| FPX / DNP / TNG / CARD | https://docs.xendit.co/docs/online-banking.md · duitnow-pay.md · touch-n-go.md · cards.md |
| AI-SKILL / AI-SESS / AI-PAY | github.com/xendit/xendit-ai @923f90e7da `skills/xendit-integrate/SKILL.md` · `references/sessions.md` · `references/payments.md` (Xendit's own agent skill; `author: xendit`, SKILL.md L5-6) |
| MAG | github.com/xendit/xendit-magento-payment-module @e025a48e66 |
| WHMCS | github.com/xendit/xendit-whmcs @10490460c8 |
| NODE | github.com/xendit/xendit-node @c5494c3674 (generated SDK) |
| DEMO | github.com/xendit/demo-store `server/integrations/*.ts` |
| ARCH | https://archive.developers.xendit.co/api-reference/ (Xendit's archived old reference, 3 MB HTML) |

Line numbers (`L`) refer to the raw `.md` file, front-matter included.

## 1. Hosts and auth

| Fact | Value | Source |
|---|---|---|
| Base URL (live **and** test) | `https://api.xendit.co`. The OpenAPI has a single server entry and no separate sandbox host | INTRO L31; CS `servers[0]` |
| Test vs live | Same host. The **API key** picks the mode: `xnd_development_…` = test, `xnd_production_…` = live | AI-SKILL L18; QS L23 ("API keys (for both test and live environments)") |
| Test mode behaviour | "wholly separate environment", partner connections replaced by mocks; no bank network, no charges | AI-SKILL L12; QS L41 |
| Hosted-checkout link host | live example `https://xen.to/kGxPCi60`; test example `https://dev.xen.to/qZx5RD_7` | CS response example; P1 L73 |
| Auth | HTTP Basic: secret key as username, empty password → `Authorization: Basic base64("<key>:")` | QS L29-35; AI-SKILL L20; NODE `payment_request/apis/PaymentRequest.ts` L113 |
| HTTPS only | HTTP requests fail | QS L40 |
| Key permissions | per product None/Read/Write; money-in needs Write | https://docs.xendit.co/docs/api-keys.md |
| API version header (v3 only) | `api-version: 2024-11-11` (enum has one value) | CPR `#/components/parameters/Payments_API_APIVersionHeaderExternal`; MIG3 L54 |
| Rate limits | 60 RPM per endpoint per account (test), 600 RPM (live); 429 `RATE_LIMIT_EXCEEDED`; headers `Rate-Limit-Limit/Remaining/Reset` | RL L22-32 |

## 2. Create payment — Payment Session (hosted checkout, recommended)

`POST https://api.xendit.co/sessions` returns **201** (CS `paths./sessions.post`). Optional headers are `for-user-id` and
`with-split-rule` (xenPlatform). No idempotency header is defined (CS `parameters`).

| Field | Req | Type / rule | Source |
|---|---|---|---|
| `reference_id` | ✓ | string 1-64. "Your reference to uniquely identify the Payment Session". Uniqueness is **not** stated as enforced | CS `#/components/schemas/Payment_Session_ReferenceId` |
| `session_type` | ✓ | `PAY` · `SAVE` · `SUBSCRIPTION` | CS `…SessionTypePublicEnum` |
| `mode` | ✓ | `PAYMENT_LINK` (redirect to `payment_link_url`) · `COMPONENTS` | CS `…SessionModePublicEnum` |
| `amount` | ✓ | number ≥ 0. Must be > 0 for PAY/SUBSCRIPTION and = 0 for SAVE. "must also respect the decimal places allowed for the given currency" | CS `…Payment_Session_Amount`; CS `#/components/responses/Payment_Session_CreateSessionError` (`INVALID_AMOUNT`) |
| `currency` | ✓ | enum includes `MYR` | CS `…CurrencyPublic` |
| `country` | ✓ | enum includes `MY` | CS `…CountryPublic` |
| `customer` / `customer_id` | cond. | Required for SAVE, for `allow_save_payment_method` OPTIONAL/FORCED, and for SUBSCRIPTION. Otherwise `MISSING_CUSTOMER`. `customer` needs `type:"INDIVIDUAL"`, `reference_id`, `individual_detail` | CS `…CreateSessionError`; CS `…CustomerDetails`; AI-SESS L57-61 |
| `success_return_url`, `cancel_return_url` | – | must be **HTTPS**, otherwise `INVALID_URL` | CS `…GenericReturnUrl`; CS `…CreateSessionError` |
| `expires_at` | – | ISO 8601. Default **30 min** after creation. Must be ≥ 10 min in the future and not over a maximum (`INVALID_EXPIRY_DATE`) | CS `…ExpiresAt`; CS `…CreateSessionError` |
| `allowed_payment_channels` | – | list of channel codes. Empty = all activated channels | CS properties |
| `capture_method` | – | `AUTOMATIC` · `MANUAL` | CS `…CaptureMethodEnum` |
| `locale`, `description` (1-1000), `items`, `metadata`, `channel_properties` | – | see §9 for the metadata limits contradiction | CS properties |

**Amount units: major units (ringgit with decimals), NOT sen.** "IMPORTANT: Amounts are _not_ in minor units."
(AI-SESS L26, AI-PAY L20). MY channel pages give minimums as `1`/`1.00` and maximums as `30,000.00` (FPX L30-31, DNP L25-26).
A v3 MYR example uses `"request_amount": 150` for a "Monthly toll payment" (CPR example `PAY_WithToken_TOUCHNGO`).
Exactly which decimal places MYR allows is **UNCONFIRMED**; the docs only say "decimal places allowed for the given currency".

Response fields: `payment_session_id` (`ps-…`), `status:"ACTIVE"`, `payment_link_url`, `expires_at`, `reference_id`,
`amount`, `currency`, `business_id` (CS response example `createSessionResponseExample`).
Integration rules from Xendit: redirect to `payment_link_url`; never log or save `payment_link_url`/`components_sdk_key` (save the session ID);
return URLs are "for UX only, and must NOT be trusted" (AI-SESS L18-24; IS L45-49).

### 2b. Low-level alternative: Payments API v3

`POST /v3/payment_requests` with header `api-version: 2024-11-11` (CPR). Required fields: `reference_id` (1-255; must be
unique only for `CARDS`), `type` (`PAY`/`PAY_AND_SAVE`/`REUSABLE_PAYMENT_CODE`/`VERIFY_PAYMENT_METHOD`), `currency`.
You also send `channel_code` (e.g. `MAYB2U_FPX`, `DUITNOW_PAY`, `TOUCHNGO`, `CARDS`) and `request_amount`.
Return URLs go in `channel_properties.success_return_url` / `failure_return_url`
(CPR `requestBody.schema`; `#/components/schemas/Payments_API_PaymentRequestReferenceId`; HPW example at
https://docs.xendit.co/docs/how-payments-api-work.md L44-47). FPX channel codes are `{Bank}_FPX` and `{Bank}_FPX_BUSINESS` (FPX L23-24).

### 2c. Legacy Invoice (still in SDK and plugins)

`POST /v2/invoices` (NODE `invoice/apis/Invoice.ts` L115; DEMO `invoice.ts` L4). Required fields: `external_id`, `amount`.
Optional: `invoice_duration` (**seconds**), `success_redirect_url`, `failure_redirect_url`, `currency` (incl. `MYR`), `payer_email`, `items`, `fees`
(NODE `docs/invoice/CreateInvoiceRequest.md`; `docs/invoice/InvoiceCurrency.md`). Mapping to Sessions:
`external_id`→`reference_id`, `invoice_duration`→`expires_at` (MIGS L172-175).

## 3. Get / query payment

| What | Endpoint | Source |
|---|---|---|
| Session | `GET /sessions/{session_id}` | GS |
| Cancel session | `POST /sessions/{session_id}/cancel` | XS; AI-SESS L44 |
| Payment request (v3) | `GET /v3/payment_requests/{payment_request_id}` + `api-version` | GPR |
| Payment (v3) | `GET /v3/payments/{payment_id}` | https://docs.xendit.co/apidocs/get-payment.md (listed in llms.txt) |
| Legacy invoice | `GET /v2/invoices/{invoice_id}` | NODE `invoice/apis/Invoice.ts` L151; MIGS L60 |

**Status values**

| Object | Values and meanings | Source |
|---|---|---|
| Session | `ACTIVE` (just created, can still be paid) · `COMPLETED` (payment or save succeeded, `payment_id` filled) · `EXPIRED` (passed `expires_at`, cannot be reactivated) · `CANCELED` (cancelled by hand, link is dead) | GS `#/components/schemas/Payment_Session_SessionStatus`; PSO L122-125 |
| Payment request v3 | `ACCEPTING_PAYMENTS` (reusable code) · `REQUIRES_ACTION` (waiting for the end user) · `AUTHORIZED` (manual capture, end state) · `CANCELED` · `EXPIRED` · `SUCCEEDED` · `FAILED` | GPR `…PaymentRequestStatus`; MIG3 L152-159 |
| Payment v3 | `AUTHORIZED` · `CANCELED` · `SUCCEEDED` · `FAILED` · `EXPIRED` · `PENDING` | PWH `…PaymentStatus` |
| Refund | `SUCCEEDED` · `FAILED` · `PENDING` · `CANCELLED` (double L) | RF `…RefundStatus` |
| Legacy invoice | `PENDING` · `PAID` · `SETTLED` · `EXPIRED`. `PAID`/`SETTLED` ≙ session `COMPLETED` | NODE `docs/invoice/InvoiceStatus.md`; MIGS L184-189 |

**Amount / reference / paid time.**
- Session: `amount`, `reference_id`. The session object has **no paid-time field**. `updated` is ISO 8601 (GS schema).
- Payment: `request_amount`, `reference_id`, `payment_request_id`, plus `captures[].capture_amount` and
  `captures[].capture_timestamp` (ISO 8601 date-time). The official example uses a one-digit fraction: `"2026-08-26T07:28:37.2Z"`
  (PWH example `paymentCapture`; `…Payments_API_Capture`).
- Legacy invoice callback: `paid_at`, `paid_amount`, `external_id` (NODE `docs/invoice/InvoiceCallback.md` L9-21).
- Exact precision or timezone guarantees for timestamps: **UNCONFIRMED** beyond "ISO 8601".

## 4. Callback / webhook

| Aspect | Fact | Source |
|---|---|---|
| Where | One URL per product/event set, configured in **Dashboard → Settings → Webhooks**. No per-request callback URL field on `/sessions` or `/v3/payment_requests` | WB L21; PIS L28-44; CS properties (no such field) |
| Delivery | HTTP **POST** with a **JSON** body `{event, business_id, created, data}` | WB L21; SWH/PWH `requestBody` `application/json`; AI-SKILL L28 |
| Session events | `payment_session.completed`, `payment_session.expired` (not sent on cancel) | SWH `event` enum; AI-SESS L88-107 |
| Payment events | `payment.capture` (money collected), `payment.authorization`, `payment.failure`; table also lists `payment.expiry`, `payment_request.expiry` | PWH `event` enum; PAW L19-26 |
| Refund events | `refund.succeeded`, `refund.failed` | PAW; RWH |
| Ack | any **2xx** counts as success. Respond fast and process asynchronously | WB L27; HW L38-40; AI-SKILL L30 |
| Timeout | 30 s (old reference only); current docs give no number → **UNCONFIRMED** for v3 | ARCH (Report Webhook section: "marks webhook event as failed if there is no response within 30s") |

### Signing — what it really is

**There is no cryptographic signature on merchant webhooks.** Xendit puts a **static shared token** in the request
header `x-callback-token`. The receiver compares it with the "webhook verification token" shown in the Dashboard's webhook settings.

- "Xendit can sign each webhook event … by including a token in each event's `x-callback-token` header" (HW L30; IS L21).
- OpenAPI header param: `x-callback-token`, `required: false`, "Your Xendit unique webhook token to verify the origin"
  (PWH `#/components/parameters/Payments_API_XCallbackToken`; same in RWH).
- "Webhooks are authenticated with the `x-callback-token` header … Always validate" (AI-SKILL L26, L36).
- One token per environment: "Each secret is unique to each environments" (ARCH, "Verify events are sent from Xendit").
- Algorithm, string construction, fields, encoding: **none**. The body is not covered, and there is no timestamp or nonce, so
  replay protection is **UNCONFIRMED / absent**. The token is not derived from the API key (the dashboard issues it on its own; QS, HW L32).
- **Test vector: none published.** No example token value appears in the official material. The only check is
  `constant_time_equals(header["x-callback-token"], configured_token)`.
- Defence in depth that Xendit recommends: check amount, status and IDs against your own records (IS L31-39). The official WHMCS plugin
  ignores the header and instead **re-fetches** the invoice by `id` and trusts only that response (WHMCS
  `modules/gateways/callback/xendit.php` L110-124).

### Separate signed channel (plugins only, not for custom integrations)

The official Magento module (migrated to Payment Sessions) receives "integration notifications" from Xendit's **TPI
Service**. These are signed with **ECDSA P-384 / SHA-384** (MAG `Helper/SignatureVerifier.php` L5-12, L37):

- message = `{_id}.{status}.{session.payment_session_id}.{session.status}.{payment_token.payment_token_id}.{payment_token.status}.{payment_request.payment_request_id}.{payment_request.status}.{refund.refund_id}.{refund.status}?magento_checkout_idempotency_key={key}&magento_checkout_type={type}`.
  Missing parts become empty strings (MAG `Controller/Checkout/IntegrationNotification.php` L241-273).
- The signature is the `signature` field **in the JSON body**, base64 of raw r‖s (96 bytes), converted to DER before
  `openssl_verify` (MAG `SignatureVerifier.php` L60-106).
- Public keys are hard-coded: 2 staging + 2 production, for rotation. They are "shared with the WooCommerce plugin"
  (MAG `Helper/IntegrationNotificationKeys.php` L8-28).
- No official example message + signature is published, so there is **no test vector**. This scheme is not documented on docs.xendit.co.

## 5. Minimum amount (MYR)

| Channel | Min | Max | PR expiry | Refund | Source |
|---|---|---|---|---|---|
| FPX (`{Bank}_FPX`) | 1 | 30,000.00 (B2B 1,000,000.00) | – | **not supported** | FPX L30-32, L46, L51 |
| DuitNow Pay | 1.00 | 30,000.00 | 0.5 h | ✓ (90 days) | DNP L25-26, L40, L45 |
| Touch 'n Go | 1 | 25,000.00 | 1 h | ✓ | TNG L29-30, L43, L48 |
| Cards (MY) | 1.00 | 5,000.00 | 0.166 h | ✓ | CARD L27-28, L42, L47 |

The API itself only enforces amount > 0 (PAY) (CS `INVALID_AMOUNT`). A session-level minimum: **UNCONFIRMED**.

## 6. Idempotency

- `/sessions` and `/v3/payment_requests`: **no idempotency header documented** (CS/CPR `parameters`). `reference_id` is
  documented as unique only for `CARDS` payment requests (CPR `…PaymentRequestReferenceId`). → **UNCONFIRMED**.
- The SDK (v2 `/payment_requests`) sends `idempotency-key` (NODE `payment_request/apis/PaymentRequest.ts` L117-118, L130).
  The old reference says the header name "is dependant on the specific API" (old cards refund: `X-IDEMPOTENCY-KEY`) (ARCH, "Safely retry requests with idempotency").
- Webhook side: duplicates and out-of-order delivery happen. De-duplicate on event name + entity ID (`payment_id`, `capture_id`)
  (HW L19-26, L46-50; AI-SKILL L38).

## 7. Refunds / cancel (brief)

- `POST /refunds` with required `payment_request_id` and `reason` (`FRAUDULENT`/`DUPLICATE`/`REQUESTED_BY_CUSTOMER`/`CANCELLATION`/`OTHERS`),
  plus optional `amount`, `currency`, `reference_id`. The result arrives through `refund.succeeded`/`refund.failed` (RF `…Payments_API_Refund`;
  https://docs.xendit.co/docs/refund-payment-request.md L22, L30-47). Refunds go back to the original method only.
  **FPX has no refund** (FPX L51).
- Cancel: `POST /sessions/{id}/cancel` (only from ACTIVE) and `POST /v3/payment_requests/{id}/cancel` (XS; CPR family).
  A payment received after cancellation is still collected, and the session status does not change (AI-SESS L80-82).

## 8. Retries

Up to **6** automatic retries after the first attempt, at 15m, 1h, 3h, 6h, 12h and 24h after the original
(WB L31-40). Manual resend is in the Dashboard Webhook tab, with up to 500 per batch (WB L46-65). Late webhooks can still arrive
after expiry, and Xendit reconciliation can take up to about 24 h (DW L31, L43-49).

## 9. Contradictions between official materials (most valuable)

| # | Contradiction | Sources |
|---|---|---|
| C1 | **Webhook auth differs by spec page.** The payment and refund webhook OpenAPI declare header `x-callback-token`. The session webhook OpenAPI declares `security: Payment_Session_BasicAuth` and no token header. Prose docs say every webhook carries `x-callback-token`. Treat session webhooks like the rest | PWH/RWH `parameters`; SWH `paths./your_payment_session_webhook_url.post.security`; HW L30; AI-SKILL L26 |
| C2 | **Plugins vs docs on verification.** Docs say "Always authenticate the webhook sender" with the token. Magento/WooCommerce plugins use an undocumented ECDSA-P384 signed TPI channel. The WHMCS plugin checks no token and re-fetches the invoice | HW L28-32; MAG §4; WHMCS callback L110-124 |
| C3 | **Session webhook payload.** AI-SESS says "the same payload as the GET session endpoint". The SWH `data` schema has **no `amount`/`currency`/`country`**, but its examples include them | AI-SESS L93; SWH `#/components/schemas/Payment_Session_SessionWebhookSchema` vs `PaymentSession_CompletedExample` |
| C4 | **Metadata limits.** Field description: 50 keys / key 40 chars / value 500 chars. Error description for `INVALID_METADATA`: max **20** keys / value **80** chars (strings only) | CS `…MerchantMetadata` vs `…CreateSessionError` |
| C5 | **Cancel spelling.** Session/payment enums use `CANCELED`. The Xendit agent skill says sessions become `CANCELLED`. Refund status enum uses `CANCELLED` | GS `…SessionStatus`; AI-SESS L80; RF `…RefundStatus` |
| C6 | **`allow_save_payment_method` case.** OpenAPI enum is `DISABLED`/`OPTIONAL`/`FORCED`. The overview table shows `disabled`/`optional`/`forced` | CS `…AllowSavePaymentMethodEnum`; PSO L53-55 |
| C7 | **Session expiry field name.** The overview says sessions expire on `expiry_date`. The API field is `expires_at` | PSO L122-124; CS `…ExpiresAt` |
| C8 | **v3 failure event name.** The migration "rule of thumb" says `payment.failed`. The v3 event is `payment.failure` | MIG3 L139 vs PWH enum, MIG3 L53 |
| C9 | **`api-version` header.** The migration guide says v3 "Requires `api-version`". The OpenAPI parameter is not marked `required` | MIG3 L54; CPR `…APIVersionHeaderExternal` |
| C10 | **409 duplicate error.** `Payments_API_Http409DuplicateError.error_code` enum is `DATA_NOT_FOUND`, a copy-paste bug | CPR `#/components/schemas/Payments_API_Http409DuplicateError` |
| C11 | **SDK vs docs API generation.** Official SDKs (xendit-node, last push 2025-10) target v2 `/payment_requests` and `/v2/invoices`. They have no `/sessions` and no `/v3/*`. The docs call v2 legacy | NODE `PaymentRequest.ts` L130; AI-SKILL L110-112 |
| C12 | **Payment events list.** The PWH OpenAPI event enum has 3 values (`capture`/`authorization`/`failure`). The webhook table also lists `payment.expiry` | PWH; PAW L25 |
| C13 | **Customer reference_id format.** Schema says "Alphanumeric no special characters allowed". Official examples use `cust_Lorem_Ipsum` (underscores) | CS `…CustomerDetails`; CS request examples |

## 10. Unconfirmed / not found

Session-level minimum amount. Allowed MYR decimal places. Idempotency on `/sessions` and `/v3/payment_requests`. Webhook
timeout for v3. Webhook source IP list (only "contact our CS", IS L29). Any replay protection. Any published webhook-token
or ECDSA test vector. The maximum session `expires_at` (error says "maximum allowed expiry duration" without a number).
