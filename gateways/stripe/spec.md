# Stripe Checkout Sessions via raw REST: contract for a Malaysian merchant (MYR, FPX + card)

Retrieved 2026-10-23. Sources are official only: docs.stripe.com (the `.md` rendering of each page), github.com/stripe/openapi,
and github.com/stripe/stripe-node.
- OpenAPI current: `stripe/openapi` master `latest/openapi.spec3.json`, `info.version` = `2026-09-30.endive` (commit 969d8c308ea6)
- OpenAPI previous: commit 9ac29c7795ab (`2026-08-26.dahlia`)
- stripe-node: master @ `3af59f7c86a2350a8ea5298473f258d622bd8651`, `src/Webhooks.ts`, `src/crypto/NodeCryptoProvider.ts`, `src/platform/NodePlatformFunctions.ts`

> ⚠ **The biggest finding: the latest API version removes `payment_method_types` from Checkout.** In `2026-09-30.endive`, `payment_method_types` can no longer be passed to create a Checkout Session. Sending it returns **400**. Use dynamic payment methods (Dashboard) or `allowed_payment_method_types`. See §2.3.

## Measured in test mode (27 October 2026)

A Malaysian sandbox account, through `@bayarkit/stripe` with `Stripe-Version: 2026-09-30.endive` and a real webhook endpoint:

| Fact | Result |
| --- | --- |
| `allowed_payment_method_types[]=card,fpx` on create | accepted; echoed back on the session |
| `payment_method_types[]` under endive | HTTP 400 `invalid_request_error`: "no longer supported when creating a Checkout Session" |
| 199 sen MYR | refused, but the message blames `allowed_payment_method_types` ("All types … are invalid"), not the amount; 200 sen accepted |
| Card `4242…` paid | one `checkout.session.completed`, `status: complete`, `payment_status: paid`, `currency: myr`, `client_reference_id` = reference |
| FPX (test bank, Authorize) | the same single `checkout.session.completed` with `payment_status: paid`: no pending phase, no `async_payment_*` event |
| FPX (test bank, Fail) | no `checkout.session.*` event; the session stays `open` / `unpaid` |
| Webhook endpoint created without `api_version` | events carry the account default (`2026-09-30.endive` on this new account) |
| Webhook signature | `t` + `v1` as documented; a one-byte change to the body fails verification |

---

## 1. Auth, encoding, versioning, test vs live

| Fact                                                                                                                                                                                                                                      | Source                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base host `https://api.stripe.com`, paths `/v1/...`. HTTPS only: plain HTTP fails, and so does a request without auth.                                                                                                                    | https://docs.stripe.com/api/authentication (last line), examples in https://docs.stripe.com/api/checkout/sessions/create                                                                                 |
| Request bodies are **form-encoded** (`application/x-www-form-urlencoded`). Responses are JSON.                                                                                                                                            | https://docs.stripe.com/api ("accepts form-encoded request bodies, returns JSON-encoded responses"); OpenAPI `paths./v1/checkout/sessions.post.requestBody.content["application/x-www-form-urlencoded"]` |
| Auth is HTTP Basic with the key as the username and no password (`-u sk_test_...:`). Bearer also works: `Authorization: Bearer <key>`.                                                                                                    | https://docs.stripe.com/api/authentication                                                                                                                                                               |
| Nested params use bracket notation, e.g. `line_items[0][price_data][currency]=myr`.                                                                                                                                                       | FPX Checkout curl example, https://docs.stripe.com/payments/fpx/accept-a-payment?payment-ui=checkout                                                                                                     |
| Secret keys: `sk_test_` (sandbox/test) and `sk_live_` (live). Restricted keys `rk_test_`/`rk_live_` are recommended for live. Publishable keys `pk_test_`/`pk_live_`.                                                                     | https://docs.stripe.com/keys (lines 14–15), https://docs.stripe.com/api/authentication                                                                                                                   |
| Test and live use the **same host**. The key decides the mode: "The API key that you use to authenticate the request determines whether the request runs in live mode or in a sandbox." Objects carry `livemode` (bool).                  | https://docs.stripe.com/api ; `livemode` in the session response example, https://docs.stripe.com/api/checkout/sessions/create                                                                           |
| `Stripe-Version` header: requests without it use the account's default version (set in Workbench). Webhook events use the version set on the endpoint at creation, otherwise the account default. Current version is `2026-09-30.endive`. | https://docs.stripe.com/api/versioning (lines 5–9)                                                                                                                                                       |
| Pinning is recommended: "If you don't use an SDK, update your API requests to include `Stripe-Version: 2026-09-30.endive`". Pin explicitly, because the account default can change under you.                                             | https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions (Upgrade → REST API)                                                                                   |
| Monthly releases are non-breaking. Twice a year a major release (e.g. Basil, Dahlia, Endive) brings breaking changes.                                                                                                                     | https://docs.stripe.com/api/versioning                                                                                                                                                                   |

## 2. `POST /v1/checkout/sessions` (create)

### 2.1 Fields (current `2026-09-30.endive`)

| Field (form key)                                | Contract                                                                                                                                                                                                           | Source                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `mode`                                          | **required**. Enum `payment` \| `setup` \| `subscription`. Use `payment`.                                                                                                                                          | create doc; OpenAPI `mode.enum`                                                                              |
| `line_items[N][price_data][currency]`           | required inside price_data. 3-letter ISO, **lowercase** (`myr`).                                                                                                                                                   | create doc `?query=line_items` (line_items.price_data.currency)                                              |
| `line_items[N][price_data][unit_amount]`        | integer, "smallest currency unit" (MYR → **sen**, so RM20.00 = `2000`). Use either this or `unit_amount_decimal`.                                                                                                  | same; FPX example `unit_amount=2000`                                                                         |
| `line_items[N][price_data][product_data][name]` | required when `product_data` is used. You pass either `product` or `product_data`.                                                                                                                                 | same                                                                                                         |
| `line_items[N][quantity]`                       | integer.                                                                                                                                                                                                           | same                                                                                                         |
| `line_items`                                    | required for `payment` mode. Max 100 line items in payment mode.                                                                                                                                                   | https://docs.stripe.com/api/checkout/sessions/create                                                         |
| `success_url`                                   | URL the customer goes to after payment. Not allowed with `ui_mode` `embedded_page`/`elements`. The literal `{CHECKOUT_SESSION_ID}` placeholder is replaced by Stripe, e.g. `...?session_id={CHECKOUT_SESSION_ID}`. | create doc; https://docs.stripe.com/payments/checkout/custom-success-page?payment-ui=stripe-hosted (line 26) |
| `cancel_url`                                    | optional. When set, Checkout shows a back button that leads to this URL.                                                                                                                                           | create doc                                                                                                   |
| `client_reference_id`                           | optional string, **max 200 chars** on create. The object schema allows up to 5000.                                                                                                                                 | create doc; OpenAPI create `maxLength:200`, object `maxLength:5000`                                          |
| `customer_email`                                | optional prefill, max 800 chars.                                                                                                                                                                                   | create doc                                                                                                   |
| `metadata[key]=value`                           | map. Up to 50 keys, key ≤ 40 chars, value ≤ 500 chars, no `[`/`]` in keys. Don't put sensitive data here.                                                                                                          | create doc; https://docs.stripe.com/api/metadata (lines 5, 11)                                               |
| `expires_at`                                    | Unix seconds. **Must be 30 min to 24 h after creation. Default is 24 h.**                                                                                                                                          | create doc; OpenAPI `expires_at.description`                                                                 |
| `ui_mode`                                       | Default `hosted_page`. Enum `hosted_page`\|`embedded_page`\|`elements`\|`form`. The old values `hosted`/`embedded`/`custom` **fail** since 2026-03-25.dahlia.                                                      | create doc; https://docs.stripe.com/changelog/dahlia/2026-03-25/updates-available-checkout-session-ui-modes  |
| `locale`                                        | optional, includes `ms` and `en` (`auto` = browser).                                                                                                                                                               | create doc                                                                                                   |
| `allowed_payment_method_types[]`                | NEW in endive. Filters the dynamically eligible set and silently drops incompatible types. The enum includes `card` and `fpx`.                                                                                     | create doc; OpenAPI enum check (`fpx` and `card` present); changelog link in §2.3                            |
| `excluded_payment_method_types[]`               | excludes types from the Dashboard-managed set.                                                                                                                                                                     | create doc                                                                                                   |

### 2.2 Minimal raw request (from the official FPX page, hosted page)

```
POST https://api.stripe.com/v1/checkout/sessions
Authorization: Bearer sk_test_...        (or Basic sk_test_...:)
Stripe-Version: 2026-09-30.endive
Idempotency-Key: <uuid v4>
Content-Type: application/x-www-form-urlencoded

line_items[0][price_data][currency]=myr&line_items[0][price_data][product_data][name]=T-shirt
&line_items[0][price_data][unit_amount]=2000&line_items[0][quantity]=1&mode=payment
&success_url=https%3A%2F%2Fexample.com%2Fsuccess
```
Source: https://docs.stripe.com/payments/fpx/accept-a-payment?payment-ui=checkout ("Stripe-hosted page" curl block). The headers come from §1 and §2.4.

### 2.3 `payment_method_types`: ⚠ removed in endive

- **2026-09-30.endive:** "You can no longer pass `payment_method_types` when you create a Checkout Session ... Passing `payment_method_types` ... now returns a `400` error." Replacement: dynamic payment methods, or `allowed_payment_method_types`, which filters by `currency`, `amount`, `customer`. The compatible subset comes back in the response's `payment_method_types`. Before endive, an incompatible type caused an error; `allowed_payment_method_types` silently filters it out instead. Source: https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions
- **2026-08-26.dahlia (and earlier):** `payment_method_types` existed on create, its enum contained `fpx` and `card`, and `allowed_payment_method_types` did not exist. Source: OpenAPI commit 9ac29c7795ab, `paths./v1/checkout/sessions.post` (local `spec3_dahlia0826.json`).
- Implication: if you pin `Stripe-Version: 2026-08-26.dahlia`, `payment_method_types[]=card&payment_method_types[]=fpx` is valid. On endive, use `allowed_payment_method_types[]=card&allowed_payment_method_types[]=fpx`, or omit both and enable FPX + card in the Dashboard. Note the docs.stripe.com `?api-version=2026-08-26.dahlia` rendering of the create page does NOT list the param, but the dahlia OpenAPI does. Trust the spec + changelog.

### 2.4 FPX requirements

| Fact                                                                                                                                                                                                                                                        | Source                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Currency `myr` only (supported and presentment). Customer geography Malaysia. Payment mode yes; setup/subscription no.                                                                                                                                      | https://docs.stripe.com/payments/fpx/accept-a-payment?payment-ui=checkout ("Determine compatibility")                                   |
| All line items must be in the same currency (`myr`) and one-time only.                                                                                                                                                                                      | same                                                                                                                                    |
| Enable FPX in Dashboard → Settings → Payment methods. Stripe then shows it automatically through dynamic payment methods.                                                                                                                                   | same ("Enable FPX as a payment method")                                                                                                 |
| Only Stripe accounts in **MY** can accept FPX. **Business Registration Number (BRN) is required** to process FPX charges and receive payouts.                                                                                                               | https://docs.stripe.com/payments/fpx ("Business locations"; "Stripe requires businesses to provide their Business Registration Number") |
| FPX is a redirect method (`Requires redirect: Yes`), API enum `fpx`, no manual capture, no setup_future_usage.                                                                                                                                              | https://docs.stripe.com/payments/payment-methods/payment-method-support (Bank redirects API support table)                              |
| The FPX success page **must** show: Charge `created`, `amount`, `statement_descriptor` (Seller Order No.), `payment_method_details[fpx][transaction_id]`, `payment_method_details[fpx][bank]`, `status`. Get them from the PaymentIntent's `latest_charge`. | https://docs.stripe.com/payments/fpx/accept-a-payment?payment-ui=checkout ("Confirmation page")                                         |
| Refunds up to 60 days. They are asynchronous: up to 14 days, sometimes 6 weeks, reported via `refund.updated`/`refund.failed`. No disputes. Payout timing is 5 business days.                                                                               | https://docs.stripe.com/payments/fpx                                                                                                    |
| Malaysian cards accepted: Visa, Mastercard, China UnionPay, debit cards.                                                                                                                                                                                    | https://docs.stripe.com/currencies ("Supported payment methods")                                                                        |

### 2.5 Idempotency-Key

| Fact                                                                                                                                                | Source                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Header `Idempotency-Key`, up to 255 chars. V4 UUID recommended. Don't use PII as the key.                                                           | https://docs.stripe.com/api/idempotent_requests |
| v1 saves the status code + body of the first request **after endpoint execution begins**. Retries return the saved response, **including 500s**.    | same                                            |
| Keys can be pruned once they're **at least 24 hours old**. Reusing a key after pruning creates a new request.                                       | same                                            |
| Reusing a key with different parameters gives an error. Validation failures and concurrent-conflict requests are NOT saved, so they can be retried. | same                                            |
| All v1 `POST`s accept the key. Sending it on `GET`/`DELETE` has no effect.                                                                          | same                                            |

### 2.6 Response (Checkout Session object)

`id` (`cs_test_...` / `cs_live_...`), `object: "checkout.session"`, `url` (hosted page, `https://checkout.stripe.com/c/pay/cs_...#...`), `status: "open"`, `payment_status: "unpaid"`, `amount_total`, `currency`, `expires_at`, `client_reference_id`, `metadata`, `payment_intent: null` at creation, `payment_method_types`, `livemode`.
Source: the response example at https://docs.stripe.com/api/checkout/sessions/create. `url` "is only present when the session is active" and applies to `ui_mode: hosted_page` (OpenAPI `components.schemas["checkout.session"].properties.url`).
The `cs_live_` prefix is UNCONFIRMED: only `cs_test_` appears in the docs examples.

## 3. `GET /v1/checkout/sessions/{id}` (retrieve)

| Field                 | Contract                                                                                                                                                                   | Source                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| endpoint              | `GET https://api.stripe.com/v1/checkout/sessions/cs_...`. Optional `expand[]=line_items` / `expand[]=payment_intent`.                                                      | https://docs.stripe.com/api/checkout/sessions/retrieve ; fulfillment guide step 3 |
| `status`              | nullable enum `open` (payment processing has not started) \| `complete` ("Payment processing may still be in progress") \| `expired` ("No further processing will occur"). | https://docs.stripe.com/api/checkout/sessions/object (lines 361–371); OpenAPI     |
| `payment_status`      | enum `paid` ("funds are available in your account") \| `unpaid` ("not yet available") \| `no_payment_required`. "You can use this value to decide when to fulfill."        | object doc (lines 305–315)                                                        |
| `amount_total`        | integer, nullable, minor units (sen), after discounts + tax.                                                                                                               | OpenAPI `amount_total`                                                            |
| `currency`            | nullable, ISO, **lowercase** (`"myr"`).                                                                                                                                    | OpenAPI `currency`                                                                |
| `client_reference_id` | nullable string (≤ 5000).                                                                                                                                                  | OpenAPI                                                                           |
| `payment_intent`      | nullable; the PI id (expandable) in payment mode. You **can't** confirm or cancel this PI. To cancel, expire the session instead.                                          | OpenAPI `payment_intent.description`                                              |
| `metadata`            | map, values ≤ 500.                                                                                                                                                         | OpenAPI                                                                           |

**Async / delayed methods:**
- "Delayed payment methods generate a `checkout.session.async_payment_succeeded` event when payment succeeds later." Also listen for `checkout.session.async_payment_failed`. Fulfill on `checkout.session.completed` OR `async_payment_succeeded`, but only when `payment_status != 'unpaid'`. Source: https://docs.stripe.com/checkout/fulfillment?ui=full-page (lines 96–137, the code at 68–70 and 128–130).
- While a delayed payment is pending: `status = complete` + `payment_status = unpaid`, and the PaymentIntent is `processing`. This is DERIVED from the enum descriptions (complete = "processing may still be in progress", unpaid = "funds not yet available"), the fulfillment code gate `payment_status != 'unpaid'`, and https://docs.stripe.com/payments/payment-methods ("status ... will be `processing`"). No single sentence states the combination, so it is partly UNCONFIRMED.
- **FPX specifically is an _immediate_-notification method:** "Customers pay with FPX by redirecting ... then returning to your website where you get immediate notification on whether the payment succeeded or failed." Source: https://docs.stripe.com/payments/fpx/accept-a-payment?payment-ui=checkout (first paragraph). So for FPX expect `checkout.session.completed` with `payment_status=paid`. That FPX never emits `async_payment_*` is UNCONFIRMED (not stated explicitly). Handling both events anyway is harmless and is the documented pattern.
- Webhooks are **required** when you accept delayed-notification methods. You should also fulfil from the success page, because webhooks can be delayed. Fulfil exactly once: the function may be called several times, even concurrently. Source: fulfillment guide (lines 19, 31, 228).
- With a `checkout.session.completed` endpoint and a `success_url`, Checkout **waits up to 10 s** for your webhook response before redirecting. This does not apply to organization endpoints. Source: fulfillment guide (line 189).

## 4. Webhooks: signature verification

| Fact                                                                                                                                                                                                                            | Source                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header `Stripe-Signature`, sent on one line: `t=<unix>,v1=<hex>[,v1=<hex>...][,v0=<hex>]`.                                                                                                                                      | https://docs.stripe.com/webhooks#verify-manually (lines 744–753)                                                                                                                                |
| Only `v1` is a valid live scheme. **Ignore all other schemes** (prevents downgrade). Test events also carry a fake `v0`.                                                                                                        | same (lines 744, 755)                                                                                                                                                                           |
| **Several `v1` values** can appear when an endpoint secret is rolled: the previous secret can stay active for up to 24 h, and Stripe sends one signature per active secret.                                                     | same (line 757); roll procedure at line 646                                                                                                                                                     |
| Parse: split on `,`, then each element on `=`.`t` gives the timestamp, `v1` gives a signature (there may be several). Discard the rest.                                                                                         | same (Step 1)                                                                                                                                                                                   |
| `signed_payload = <t as string> + "." + <raw request body>`.                                                                                                                                                                    | same (Step 2)                                                                                                                                                                                   |
| expected = HMAC-SHA256(key = endpoint signing secret `whsec_...`, message = signed_payload), **hex**.                                                                                                                           | same (Step 3); stripe-node `NodeCryptoProvider.ts:9-13` `createHmac('sha256', secret).update(payload,'utf8').digest('hex')`. The key is the full `whsec_...` string as given, with no decoding. |
| Compare in constant time against each received v1. Pass if any one matches. Then check the age against your tolerance.                                                                                                          | docs Step 4                                                                                                                                                                                     |
| **Default tolerance is 5 minutes (300 s).** Don't use 0, which disables the recency check.                                                                                                                                      | docs (lines 789–791); stripe-node `Webhooks.ts:142` `DEFAULT_TOLERANCE: 300, // 5 minutes`                                                                                                      |
| Every delivery retry gets a new timestamp + signature.                                                                                                                                                                          | docs (line 793)                                                                                                                                                                                 |
| The signature must be computed over the **raw** body. A re-serialized JSON object fails.                                                                                                                                        | docs; stripe-node error message (below)                                                                                                                                                         |
| Return 2xx quickly, before doing slow work. Live retries continue for up to 3 days with exponential backoff (sandbox: 3 times over a few hours). Deduplicate on `event.id`, because duplicates happen. Order is not guaranteed. | https://docs.stripe.com/webhooks (lines 158, 567, 587, 599)                                                                                                                                     |

**stripe-node exact logic** (`src/Webhooks.ts` @ 3af59f7c):
```ts
// :142
DEFAULT_TOLERANCE: 300, // 5 minutes
// :245
EXPECTED_SCHEME: 'v1',
// :339-344
function makeHMACContent(payload, details) {
  return `${details.timestamp}.${payload}`;
}
// :508-535 parseHeader
return header.split(',').reduce((accum, item) => {
    const kv = item.split('=');
    if (kv[0] === 't') { accum.timestamp = parseInt(kv[1], 10); }
    if (kv[0] === scheme) { accum.signatures.push(kv[1]); }
    return accum;
  }, { timestamp: -1, signatures: [] });
// parseEventDetails: timestamp === -1 → 'Unable to extract timestamp and signatures from header';
//                    no v1 → 'No signatures found with expected scheme'
// :448-505 validateComputedSignature
const signatureFound = !!details.signatures.filter(
  platformFunctions.secureCompare.bind(platformFunctions, expectedSignature)
).length;
if (!signatureFound) { throw ... 'No signatures found matching the expected signature for payload. Are you passing the raw request body ...' }
const timestampAge =
  Math.floor((typeof receivedAt === 'number' ? receivedAt : Date.now()) / 1000) - details.timestamp;
if (tolerance > 0 && timestampAge > tolerance) {
  throw ... 'Timestamp outside the tolerance zone';
}
return true;
// constructEvent (:144-175): verifyHeader(payload, header, secret, tolerance ?? 300, ...) then
// return buildEvent(parsePayload(payload));   ← JSON parse only AFTER verification
```
`secureCompare` (`src/platform/NodePlatformFunctions.ts:110-131`): returns false when the lengths differ, otherwise `crypto.timingSafeEqual(TextEncoder(a), TextEncoder(b))`. The fallback XOR loop is in `PlatformFunctions.ts:112-123`.
Observation: the check is one-sided (`timestampAge > tolerance`), so stripe-node does **not** reject future-dated timestamps. An empty or blank secret throws "No webhook secret value was provided. It should start with `whsec_`".

**Events to subscribe to for Checkout** (`data.object` is a `checkout.session` for all four). Source: https://docs.stripe.com/api/events/types (lines 211–229):
- `checkout.session.completed`: "Checkout Session has been successfully completed"
- `checkout.session.async_payment_succeeded`: "payment intent using a delayed payment method finally succeeds"
- `checkout.session.async_payment_failed`: "payment intent using a delayed payment method fails"
- `checkout.session.expired`: "Checkout Session is expired"

**Event envelope** (https://docs.stripe.com/api/events/object): `{ id: "evt_...", object: "event", api_version, created, data: { object: <checkout.session> }, livemode, pending_webhooks, request: { id, idempotency_key }, type }`.

## 5. Amount limits

| Fact                                                                                                                                                                                                            | Source                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Minimum charge for MYR: 2.00 MYR** (= `200` sen). The minimum depends on the payout bank account's settlement currency. Charges converted into another settlement currency must meet that currency's minimum. | https://docs.stripe.com/currencies ("Minimum charge amount by currency", line 95) |
| MYR is a 2-decimal currency, so amounts are given in sen.                                                                                                                                                       | create doc ("smallest currency unit"); FPX example 2000 = RM20                    |
| Non-card maximum by digits: 8 digits for MYR, i.e. `99999999` = RM999,999.99. A payment method may enforce its own lower maximum. Cards: up to 12 digits (Amex 9), and networks may be stricter.                | https://docs.stripe.com/currencies ("Maximum charge amounts")                     |
| FPX per-transaction minimum or maximum: **NOT documented** by Stripe (none in the FPX overview or the Checkout guide). UNCONFIRMED.                                                                             | https://docs.stripe.com/payments/fpx (no limits section)                          |

## 6. Expire a session

`POST https://api.stripe.com/v1/checkout/sessions/{id}/expire`, no body. It only works while the session is `open`. Afterwards the customer can't complete it, and loading it shows an "expired" message. It returns the Checkout Session object (`status: "expired"`). Use this to cancel, instead of cancelling the PaymentIntent. Sources: https://docs.stripe.com/api/checkout/sessions/expire ; OpenAPI `paths./v1/checkout/sessions/{session}/expire.post.description` ; OpenAPI `checkout.session.payment_intent.description`.
That this call also triggers a `checkout.session.expired` event is UNCONFIRMED (not stated on the expire page).

## UNCONFIRMED summary

1. That FPX never emits `checkout.session.async_payment_*` (Stripe documents FPX as immediate notification).
2. The exact `status=complete` + `payment_status=unpaid` combination for pending delayed methods (derived, not stated in one place).
3. The `cs_live_` id prefix.
4. FPX-specific min/max amounts beyond the MYR 2.00 minimum and the 8-digit maximum.
5. That a manual expire fires `checkout.session.expired`.
