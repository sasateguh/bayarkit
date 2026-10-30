# PayPal Orders v2 via raw REST: one-time checkout, capture, webhooks and refunds

Retrieved 2026-10-29. Sources are official only: developer.paypal.com (the `.md` rendering of each guide page, which the
docs index `llms.txt` points to) and github.com/paypal/paypal-rest-api-specifications (Apache-2.0, `main` @
`90e8041ffe02`, the OpenAPI files behind the API reference; `checkout_orders_v2.json` is `info.version` 2.32). The
API reference pages themselves render in JavaScript, so the OpenAPI files are the machine-readable copy of them. The
PayPal server SDKs (custom licence) were not used.

> ⚠ **The biggest finding: an order that says `COMPLETED` can hold a declined payment.** The card-testing guide shows a
> capture response with order `status: COMPLETED` and `purchase_units[0].payments.captures[0].status: DECLINED`. A
> capture can also come back `PENDING` (for example when the account does not hold the currency). So "paid" is read
> from the **capture** (`COMPLETED`), never from the order status, and `APPROVED` (buyer said yes, nothing captured
> yet) is never paid.

Facts the docs leave open are marked **UNCONFIRMED** and listed at the end; the sandbox run below answers most of them.

## Measured on the sandbox (30 October 2026)

A sandbox REST app with a business account and a personal (buyer) account, through `@bayarkit/paypal` (and
`Bayarkit\Gateways\PayPal`), the buyer logging in and approving on PayPal's page in a browser, and a temporary webhook
added through the API (deleted afterwards):

| Fact | Result |
| --- | --- |
| Token | `expires_in` 32400 (9 hours) |
| New order with `experience_context` | `PAYER_ACTION_REQUIRED`, link `rel: payer-action` on `www.sandbox.paypal.com/checkoutnow` |
| Buyer approves | order `APPROVED` (`payment_source.paypal.account_status: VERIFIED`); the buyer lands on `return_url` with `?token=<order id>&PayerID=<payer id>`; `CHECKOUT.ORDER.APPROVED` arrives within a second |
| Capture before approval | 422 `UNPROCESSABLE_ENTITY`, issue `ORDER_NOT_APPROVED` |
| Capture USD 10.50 and USD 20.00 | order `COMPLETED`, capture `COMPLETED`, `custom_id` copied, PayPal fee 71 and 106 cents |
| Capture MYR 10.00 | capture `COMPLETED` on this business account (fee 253 sen) |
| Capture JPY 500 (a currency the account does not hold) | order `COMPLETED`, capture `PENDING` with `status_details.reason: RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION`; event `PAYMENT.CAPTURE.PENDING` |
| Capture again with the same `PayPal-Request-Id` | the first capture again (same capture id) |
| Capture again without it | 422, issue `ORDER_ALREADY_CAPTURED` |
| Events after a capture | `PAYMENT.CAPTURE.COMPLETED` (or `.PENDING`) about 15 s later, with `supplementary_data.related_ids.order_id`; `CHECKOUT.ORDER.COMPLETED` (subscribed) never arrived |
| Webhook headers | `PAYPAL-AUTH-ALGO: SHA256withRSA`, `PAYPAL-AUTH-VERSION`, `PAYPAL-CERT-URL`, `PAYPAL-TRANSMISSION-ID`, `-SIG`, `-TIME` |
| `verify-webhook-signature` | `SUCCESS` for the event as received; `FAILURE` for one changed value and for another (well-formed) webhook id; `SUCCESS` for a whitespace-only change; `SUCCESS` for an event 7 minutes old (no replay window) |
| Retries (endpoint answered 500) | same event id, body, transmission id, time and signature; about 28 s, then about 2 minutes later |
| Refund full and partial (500 then 1500 of 2000) | `COMPLETED` at once; capture `PARTIALLY_REFUNDED`, then `REFUNDED`; the order stays `COMPLETED` |
| `PAYMENT.CAPTURE.REFUNDED` | `resource_type: refund`, the resource is the refund (`custom_id`, `amount`, `links` with `rel: up` to the capture) and has no order id |

Through the adapters: `confirmPayment` (TS) and `Confirm::payment` (PHP) answered `ok` on `PAYMENT.CAPTURE.COMPLETED`,
`mismatch` for the amount plus one and for MYR instead of USD, and `not_paid` on `CHECKOUT.ORDER.APPROVED` before the
capture and on `PAYMENT.CAPTURE.PENDING`. A one-byte change to the event verified as `null`, and so did a refund event.

---

## 1. Auth, hosts

| Fact | Source |
| --- | --- |
| HTTPS. Live API host `api-m.paypal.com` (OpenAPI `servers`), sandbox API host `api-m.sandbox.paypal.com` (every sandbox sample). Sandbox and live have separate apps and credentials. | https://developer.paypal.com/api/rest/authentication.md; OpenAPI `servers` |
| OAuth 2.0 client credentials: `POST /v1/oauth2/token`, HTTP Basic with `base64(client_id:client_secret)`, body `grant_type=client_credentials` (`application/x-www-form-urlencoded`). | https://developer.paypal.com/api/rest/authentication.md |
| The response holds `access_token`, `token_type: "Bearer"`, `app_id`, `scope` and `expires_in` (seconds; the sample says 31668, about 8.8 hours). "When your access token expires, call `/v1/oauth2/token` again." Every API call then sends `Authorization: Bearer <access_token>`. | same |
| The docs give no rule for how often a token may be requested; the adapter caches it and refreshes shortly before `expires_in` runs out. | decision for the adapter |
| Errors are `{ name, message, debug_id, details[]: { field, location, issue, description }, links }`. `name` per status: 400 `INVALID_REQUEST`, 401 `AUTHENTICATION_FAILURE`, 403 `NOT_AUTHORIZED`, 404 `RESOURCE_NOT_FOUND`, 422 `UNPROCESSABLE_ENTITY`, 500 `INTERNAL_SERVER_ERROR`, 503 `SERVICE_UNAVAILABLE`. The adapter quotes `name`, `details[].issue`, `details[].description` and `debug_id` only. | https://developer.paypal.com/api/rest/integration/orders-api/errors.md |

## 2. `POST /v2/checkout/orders` (create)

### 2.1 Fields bayarkit uses

| Field | Contract | Source |
| --- | --- | --- |
| `intent` | `CAPTURE` (pay now). `AUTHORIZE` (hold, capture later) is out of scope. | OpenAPI `checkout_orders_v2.json` `checkout_payment_intent` |
| `purchase_units[]` | 1–10; bayarkit sends exactly one. | OpenAPI `order_request` |
| `purchase_units[0].amount` | `{ currency_code, value }`. `value` is a **string**: an integer for zero-digit currencies, a decimal otherwise, pattern `^((-?[0-9]+)\|(-?([0-9]+)?[.][0-9]+))$`, at most 32 characters, must be positive. If `breakdown` is sent it must add up; bayarkit sends none. | OpenAPI `money`, `amount_with_breakdown` |
| `purchase_units[0].custom_id` | 1–255 characters. "Used to reconcile client transactions with PayPal transactions. Appears in transaction and settlement reports but is not visible to the payer." Echoed on the order **and on each capture** (`captures[].custom_id`). | OpenAPI `purchase_unit_request`, `capture` |
| `purchase_units[0].invoice_id` | 1–127 characters. Shown to the payer (history and emails). **Unique per merchant account by default**; turning the check off loses `invoice_id` as an identifier in other APIs. | OpenAPI `purchase_unit_request` |
| `purchase_units[0].reference_id` | 1–256. Defaults to `default` when there is one purchase unit. | same |
| `purchase_units[0].description` | up to 3000 accepted, **truncated to 127** in the response. | same |
| `payment_source.paypal.experience_context` | `return_url` (buyer approved), `cancel_url`, `user_action` (`CONTINUE` default \| `PAY_NOW`), `shipping_preference` (`GET_FROM_FILE` default \| `NO_SHIPPING` \| `SET_PROVIDED_ADDRESS`), `brand_name` (≤ 127), `locale`, `landing_page`. The older top-level `application_context` is deprecated in favour of this object. | OpenAPI `paypal_wallet_experience_context`, `order_application_context` |
| Header `PayPal-Request-Id` | optional idempotency key, 1–108 characters; the server keeps it **6 hours** (72 on request to PayPal). | OpenAPI `orders.create` parameters |
| Header `Prefer` | `return=minimal` (id, status, links) or `return=representation` (full order). | same |

**Decision 3 (where the reference goes): `purchase_units[0].custom_id`.** It is invisible to the payer, long enough
for any bayarkit reference (255), and it is copied onto each capture, so the capture (and the
`PAYMENT.CAPTURE.COMPLETED` webhook resource, which is a capture) carries the reference without a second lookup.
`invoice_id` is shown to the payer and is unique per account by default, which would refuse a second order for the
same app reference after the first one expired.

### 2.2 Response and approval link

| Fact | Source |
| --- | --- |
| `200`/`201` with `id` (the order id) and `status`. | OpenAPI `orders.create` responses |
| With `payment_source.paypal.experience_context`, the new order is `PAYER_ACTION_REQUIRED` and the buyer link is `links[]` with `rel: "payer-action"` (`https://www.sandbox.paypal.com/checkoutnow?token=<order id>` in the samples). Without a `payment_source` the order is `CREATED` and the link is `rel: "approve"`. The adapter accepts either. | https://developer.paypal.com/whats-an-order.md (sample responses) |
| After approval the buyer goes to `return_url`. The docs do not say what PayPal appends to it (measured: `token` = the order id, and `PayerID`); the adapter does not rely on it (the app keeps the order id). | whats-an-order page; measured |
| The order must be captured within a window: the guide says the order "will remain in the `CREATED` state for only 3 hours", the OpenAPI text for `links` says 6 hours to redirect plus 6 hours to approve and capture. The two disagree. | whats-an-order page; OpenAPI `order.links` |

## 3. `GET /v2/checkout/orders/{id}` (read) and order status

| Order `status` | Meaning | bayarkit (`getPayment`, read only) |
| --- | --- | --- |
| `CREATED` | created, not approved | `pending` |
| `SAVED` | not used by a pay-now order | `pending` |
| `PAYER_ACTION_REQUIRED` | the buyer must act (approve, 3-D Secure) | `pending` |
| `APPROVED` | **buyer approved, nothing captured** | `pending`, never `paid` |
| `VOIDED` | voided, cannot be paid | `cancelled` |
| `COMPLETED` | intent completed; read the capture below | from the capture |

| Capture `status` (`purchase_units[0].payments.captures[0]`) | bayarkit |
| --- | --- |
| `COMPLETED` | **paid** (amount and currency from the capture's `amount`) |
| `PENDING` (`status_details.reason`, e.g. `RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION`, `PENDING_REVIEW`, `ECHECK`) | `pending`: do not fulfil |
| `DECLINED`, `FAILED` | `failed` |
| `PARTIALLY_REFUNDED`, `REFUNDED` | was paid; how bayarkit reports a refunded capture is decided with the adapter (the same open question as Paddle's `adjusted_totals`) |

Sources: OpenAPI `order_status` (the enum has no per-value text; meanings from the guides), `capture_status`, `capture_status_details`; card-testing guide
https://developer.paypal.com/sandbox-testing/card-testing.md (order `COMPLETED` with capture `DECLINED`);
https://developer.paypal.com/payment-methods/webhooks.md ("Do not fulfill the order until payment completion is
successful" on `PAYMENT.CAPTURE.PENDING`).

`getPayment` never calls capture. Capturing is a separate adapter method (decision 3), which the app calls on the
return URL or on `CHECKOUT.ORDER.APPROVED`.

## 4. `POST /v2/checkout/orders/{id}/capture`

| Fact | Source |
| --- | --- |
| "To successfully capture payment for an order, the buyer must first approve the order." Empty JSON body for an approved PayPal-wallet order. | OpenAPI `orders.capture` |
| Takes `PayPal-Request-Id` (same 6-hour retention) and `Prefer`. Responses `200`, `201`, `202`, `207`, `4xx`, `500`. | same |
| The response is the order; the capture is at `purchase_units[0].payments.captures[0]` with `id`, `status`, `amount`, `custom_id`, `invoice_id`, `final_capture`, `seller_receivable_breakdown` (gross, PayPal fee, net). | OpenAPI `capture` |
| With a `PayPal-Request-Id` that was already used, PayPal "returns the latest status of the previous request" instead of capturing again. Without it, a retry is a new request. Two simultaneous requests with the same id: the second may fail. | https://developer.paypal.com/reference/guidelines/idempotency.md |
| `PayPal-Request-Id` must be unique per request **and** per API call type (do not reuse the create id for capture). UUIDs are recommended. | same |

## 5. Webhooks

| Fact | Source |
| --- | --- |
| A webhook (listener URL + `event_types[]`, or `*`) belongs to one REST app; up to **10** URLs per app. `POST /v1/notifications/webhooks` returns its `id` (the **webhook id**, needed for every verification); `GET` lists them, `DELETE /v1/notifications/webhooks/{id}` returns `204`. | https://developer.paypal.com/api/webhooks/overview.md; OpenAPI `notifications_webhooks_v1.json` |
| The listener must answer 2xx on HTTPS port 443; otherwise PayPal retries **up to 25 times over 3 days**. | https://developer.paypal.com/api/rest/webhooks/rest.md |
| Events for checkout: `CHECKOUT.ORDER.APPROVED` (capture now), `CHECKOUT.PAYMENT-APPROVAL.REVERSED` (approved but not captured in time: PayPal cancels and refunds the buyer), `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.COMPLETED` (fulfil), `PAYMENT.CAPTURE.DENIED`. Refunds: `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.REFUND.PENDING`, `PAYMENT.REFUND.FAILED`; `PAYMENT.CAPTURE.REVERSED` when PayPal reverses. | https://developer.paypal.com/payment-methods/webhooks.md; https://developer.paypal.com/api/rest/webhooks/event-names.md |
| Envelope: `id` (`WH-…`), `event_type`, `create_time`, `resource_type`, `resource_version`, `summary`, `resource`. For `PAYMENT.CAPTURE.*` the resource is a capture (Payments v2), with `custom_id`, `amount`, `status` and `supplementary_data.related_ids.order_id`. | rest.md postback sample; OpenAPI `payments_payment_v2.json` `capture-2`, `related_ids` |
| Headers: `PAYPAL-TRANSMISSION-ID`, `PAYPAL-TRANSMISSION-TIME`, `PAYPAL-TRANSMISSION-SIG` (base64), `PAYPAL-CERT-URL`, `PAYPAL-AUTH-ALGO` (`SHA256withRSA`). | OpenAPI `verify_webhook_signature` |

### 5.1 Two ways to verify

**Postback** (what bayarkit uses, decision 2): `POST /v1/notifications/verify-webhook-signature` with `auth_algo`,
`cert_url`, `transmission_id`, `transmission_sig`, `transmission_time` (from the headers), `webhook_id` (from your
configuration; it is not in the message) and `webhook_event` (the body). All seven are required. The answer is
`{ "verification_status": "SUCCESS" | "FAILURE" }`. The body "be posted back exactly as it was received …
re-serializing back to a JSON string can fail verification", so the adapter splices the raw body text into the request
rather than parsing and re-stringifying it.
*(rest.md §Postback method; OpenAPI `verify_webhook_signature`, `verify_webhook_signature_response`)*

**Self verification** (PayPal calls it "the preferred method"): RSA-SHA256 over
`<transmission id>|<transmission time>|<webhook id>|<crc32 of the raw body, decimal>`, checked with the public key in
the certificate at `PAYPAL-CERT-URL` (downloaded and cached). The docs do not say how to check that the certificate
URL itself belongs to PayPal; an attacker controls that header. bayarkit keeps the postback: PayPal does the check,
nothing to pin. *(rest.md §Self verification method)*

**Mock events:** the dashboard Webhooks simulator's events "do not belong to any App", and "postback verification to
the verify-webhook-signature endpoint is not supported for mock events" (for self verification their webhook id is the
string `WEBHOOK_ID`). The sandbox run must use real sandbox events, not the simulator. *(rest.md §Test the listener)*

There is no documented replay window: nothing says how old `PAYPAL-TRANSMISSION-TIME` may be. Duplicates are
expected (retries over three days), so the app deduplicates on the event `id`.

## 6. Refunds: `POST /v2/payments/captures/{capture_id}/refund`

| Fact | Source |
| --- | --- |
| "For a full refund, include an empty payload … For a partial refund, include an `amount` object." Without `amount`, "captured amount − previous refunds" is refunded. Optional `custom_id`, `invoice_id`, `note_to_payer` (shown to the payer). | OpenAPI `payments_payment_v2.json` `captures.refund`, `refund_request` |
| Refunds take the **capture id**, not the order id; the adapter reads it from the order. | same |
| `PayPal-Request-Id` on refund: a retry with the same id is safe for **45 days**. | https://developer.paypal.com/api/rest/requests.md §PayPal-Request-Id |
| Refund `status`: `CANCELLED`, `FAILED`, `PENDING` (`status_details.reason: ECHECK`), `COMPLETED`. `GET /v2/payments/refunds/{id}` reads one. | OpenAPI `refund_status`, `refund_status_details` |
| Documented 422 issues on refund include `REFUND_AMOUNT_EXCEEDED` and `TRANSACTION_DISPUTED`; 409 `PREVIOUS_REQUEST_IN_PROGRESS` / `RESOURCE_CONFLICT`. | OpenAPI `captures.refund` response examples |
| bayarkit mapping: `PENDING` → `pending`, `COMPLETED` → `succeeded`, `FAILED`/`CANCELLED` → `failed`, else `unknown`. The capture becomes `PARTIALLY_REFUNDED` or `REFUNDED`. | decision for the adapter |

## 7. Currencies and amounts

| Fact | Source |
| --- | --- |
| 24 currencies: AUD, BRL, CAD, CNY, CZK, DKK, EUR, HKD, HUF, ILS, JPY, MYR, MXN, TWD, NZD, NOK, PHP, PLN, GBP, SGD, SEK, CHF, THB, USD. | https://developer.paypal.com/reference/currency-codes.md |
| **MYR is listed, but only "for in-country PayPal accounts"** (same footnote for BRL and CNY): a Malaysian business account can be paid in MYR; an account outside Malaysia gets MYR converted to its primary currency, with a spread or fee. | same |
| Zero-digit currencies in PayPal: **HUF, JPY, TWD** ("no decimal places or fractions"). HUF and TWD have two decimals in ISO 4217, so PayPal's smallest unit is not always ISO's. | same |
| To receive a currency the account does not hold, the account's Payment Receiving Preferences must allow it; otherwise "the payment status remains pending until you manually approve the payment". | same |

**Amounts in bayarkit:** the API takes an integer in the currency's smallest unit **as PayPal counts it** (sen for
MYR, cents for USD, whole yen, whole forint). The adapter converts to the decimal string (`1050` MYR → `"10.50"`,
`500` JPY → `"500"`) with a fixed table of zero-digit currencies, and back from strings it reads. No API takes ringgit
or decimals.

## 8. Sandbox testing

| Fact | Source |
| --- | --- |
| Sandbox buyer and business accounts are created in the developer dashboard; card checkouts can be forced to fail by putting a code in the card holder name, e.g. `CCREJECT-REFUSED` (`0500`, `DO_NOT_HONOR`), `CCREJECT-IF` (insufficient funds), `CCREJECT-EC` (expired). | https://developer.paypal.com/sandbox-testing/card-testing.md |

## UNCONFIRMED summary (answered by the sandbox run above, 30 October 2026)

Answers: 1. MYR captured on the business account used; JPY, which it did not hold, stayed `PENDING` with
`RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION`. 2. Not measured (it takes hours). 3. `ORDER_NOT_APPROVED`, and
`ORDER_ALREADY_CAPTURED` without the request id. 4. Yes. 5. `FAILURE` for both, not an HTTP error. 6. Only
`PAYMENT.CAPTURE.COMPLETED`, about 15 s after the capture response. 7. `COMPLETED` at once; `PARTIALLY_REFUNDED`. 8.
`token` and `PayerID`. 9. 32400 s. The questions as they were:

1. Whether the owner's sandbox business account (country) can be paid in MYR, or only in USD; and whether a currency
   it does not hold leaves the capture `PENDING` with `RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION`.
2. The real order window before an unapproved/uncaptured order expires (3 hours in the guide, 6 + 6 hours in the
   OpenAPI text), and what `GET` returns afterwards (error or a status).
3. The error `issue` for capturing an order the buyer has not approved, and for capturing twice without a
   `PayPal-Request-Id` (the issue lists live on a JavaScript-rendered page).
4. Whether a capture retried with the same `PayPal-Request-Id` returns the same capture id.
5. Whether `verify-webhook-signature` answers `FAILURE` (or an HTTP error) for a body changed by one byte, and for a
   wrong `webhook_id`.
6. Whether `PAYMENT.CAPTURE.COMPLETED` and `CHECKOUT.ORDER.COMPLETED` both arrive for one checkout, and in which order
   relative to the capture response.
7. Whether a sandbox refund is `COMPLETED` at once or `PENDING` first; the status of the capture after a partial refund.
8. The query string PayPal adds to `return_url` after approval (`token`, `PayerID`).
9. `expires_in` of a sandbox token.
