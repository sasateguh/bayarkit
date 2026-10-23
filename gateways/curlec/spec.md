# Curlec (Razorpay Curlec) API contract: Malaysia

Researched 2026-10-23 from official material only. **The docs are public, no login needed.** Curlec serves a Markdown export of every
page (`<page>.md`) and an index at `https://curlec.com/docs/llms.txt` (478 lines). Curlec runs on Razorpay's API, so the official
SDKs/plugins are in the `github.com/razorpay` org. Curlec's own docs link to that org (D3 lines 37-76; WOO lines 41-46).
`github.com/curlec` has no public repos.

`Lnn` = line number in the `.md` export as fetched on 2026-10-23. SDK lines = `HEAD` as fetched on the same day.

## Source keys

| Key | URL |
|---|---|
| D1 | https://curlec.com/docs/api.md |
| D2 | https://curlec.com/docs/api/authentication.md |
| D3 | https://curlec.com/docs/api/sandbox-setup.md |
| D4 | https://curlec.com/docs/payments/dashboard/test-live-modes.md |
| OC | https://curlec.com/docs/api/orders/create.md |
| OE | https://curlec.com/docs/api/orders/entity.md |
| CK | https://curlec.com/docs/payments/payment-gateway/web-integration/standard/integration-steps.md |
| CB | https://curlec.com/docs/payments/payment-gateway/callback-url.md |
| PE | https://curlec.com/docs/api/payments/entity.md |
| PF | https://curlec.com/docs/api/payments/fetch-with-id.md |
| PS | https://curlec.com/docs/payments/payments.md |
| CS | https://curlec.com/docs/payments/payments/capture-settings.md |
| CAP | https://curlec.com/docs/api/payments/capture.md |
| WH | https://curlec.com/docs/webhooks.md |
| WV | https://curlec.com/docs/webhooks/validate-test.md |
| WB | https://curlec.com/docs/webhooks/best-practices.md |
| WF | https://curlec.com/docs/webhooks/faqs.md |
| WS | https://curlec.com/docs/webhooks/setup-edit-payments.md |
| WP | https://curlec.com/docs/webhooks/payments.md |
| WO | https://curlec.com/docs/webhooks/orders.md |
| PLA | https://curlec.com/docs/payments/payment-links/apis.md |
| PLC | https://curlec.com/docs/api/payments/payment-links/create-standard.md |
| PLE | https://curlec.com/docs/api/payments/payment-links/entity.md |
| PLS | https://curlec.com/docs/payments/payment-links/states.md |
| RN | https://curlec.com/docs/api/refunds/create-normal.md |
| RI | https://curlec.com/docs/api/refunds/normal-refunds-idempotent.md |
| AU | https://curlec.com/docs/api/understand.md |
| SW | https://curlec.com/docs/security/whitelists.md |
| WOO | https://curlec.com/docs/payments/payment-gateway/ecommerce-plugins/woocommerce/integration-steps.md |
| N-U | razorpay/razorpay-node `lib/utils/razorpay-utils.js` |
| N-T | razorpay/razorpay-node `test/utils/razorpay-utils.spec.js` |
| P-U | razorpay/razorpay-php `src/Utility.php` |
| Y-U | razorpay/razorpay-python `razorpay/utility/utility.py` |
| Y-T | razorpay/razorpay-python `tests/test_client_utility.py`, `tests/helpers.py`, `tests/mocks/fake_payment_authorized_webhook.json` |
| W-M / W-W | razorpay/razorpay-woocommerce `woo-razorpay.php` / `includes/razorpay-webhook.php` |

## Hosts, modes, auth

| Fact | Value | Source |
|---|---|---|
| API base (prod **and** test) | `https://api.razorpay.com/v1` (some APIs `/v2`). There is no separate sandbox host. | D1 "API Gateway URL"; D3 "Use Sandbox URL" |
| Test vs live | Selected by the **key pair**: Test-mode keys give the sandbox, Live-mode keys give real money. Entities do not cross modes. | D3; D4 table "Test Mode Vs Live Mode" |
| Checkout JS | `https://checkout.razorpay.com/v1/checkout.js` | CK L250, L283 |
| Auth | HTTP Basic `base64(KEY_ID:KEY_SECRET)`. The scheme is case-sensitive: `BASIC`/`basic` are rejected. | D2 "API Authentication" |
| Static API IPs | `prod-api-static.razorpay.com` (list in doc) | SW "API IPs" |
| Webhook egress IPs | `43.216.167.81`, `43.216.100.227`, `43.216.239.250` | SW "Webhook IPs" |
| Test-mode OTP (webhook setup) | `754081` | WS L58; WV L83 |
| Test payments | Mock bank page with Success/Failure buttons for FPX/wallet | CK "2. Test Integration" |

## Create payment (Orders API, then Checkout)

`POST https://api.razorpay.com/v1/orders`, JSON body (OC L23-36). An order is required: "Payments made without an `order_id` cannot be
captured and will be automatically refunded" (CK L61).

| Field | Req | Notes | Source |
|---|---|---|---|
| `amount` | yes | integer, **smallest sub-unit = sen** (RM 1.00 = `100`). It must be a JSON integer: `"100"` and `100.0` are rejected. | OC L184-186, L303-309; CK L339 ("in sen") |
| `currency` | yes | ISO-4217, `MYR` | OC L194 |
| `receipt` | no | Your reference, ≤40 chars, ASCII only, "has to be unique" | OC L204-206, L327-341 |
| `notes` | no | ≤15 key/value pairs, ≤256 chars each | OC L208-210 |
| `partial_payment`, `first_payment_min_amount` | no | Partial payments | CK L206-207; OE "partial_payment" |
| `payment_capture` | no | Sent by the official Woo plugin (0/1); **not documented** in OC | W-M L1572 |
| expiry | none on the order | **UNCONFIRMED.** No order-expiry field is documented. Checkout `timeout` (seconds) only limits the client session. | CK L458-465 |
| Response | `id` (`order_…`), `status` `created`, `amount_due`, `amount_paid`, `attempts`, `created_at` (Unix s) | OC L140-158, L212-264 |

Checkout options (client side): `key`, `amount` (sen), `currency`, `name`, `order_id` (mandatory), `callback_url`, `redirect`,
`timeout` (CK L335-465). **FPX requires `callback_url` + `redirect: true`** (CK L225-228, L441-446).

## Return / callback (browser redirect)

| Fact | Value | Source |
|---|---|---|
| Method | **POST** to `callback_url`. The encoding (form or JSON) is not stated: **UNCONFIRMED**, but a browser auto-submit implies form. | CB "callback_url needs to accept incoming POST"; CK L586 |
| Success fields | `razorpay_payment_id`, `razorpay_order_id`, `razorpay_signature` | CK L603-618; CB FAQ L64 |
| Failure | With the default `redirect:false`, Checkout is re-shown and nothing is posted. With `redirect:true`, a POST goes to the callback with an `error` object (`code`, `description`, `field`). The field naming (e.g. `error[code]`) is **UNCONFIRMED**. | CK L592, L446-447; CB L36-50 |
| Your own params | Query string on `callback_url` is allowed (e.g. `?cart_id=12345`) | CB "Handy Tips" |

## Signatures

### A. Checkout/order payment signature (callback/handler)

`razorpay_signature = hex(HMAC_SHA256(key = API KEY_SECRET, msg = order_id + "|" + razorpay_payment_id))`, lowercase hex.
Use **your stored `order_id`**, not the one Checkout returns (CK L624-640; P-U L15-19; N-U L123-126; Y-U L13-18).

**Test vector (official, reproduced with openssl):** secret `EnLs21M47BllR3X8PSFtjtbd`, msg `order_IEIaMR65cu6nz3|pay_IH4NVgf4Dreq1l`
→ `0d4e745a1838664ad6c9c9902212a32d627d68e917290b0ad5f08ff4561bc50f` (CK L652-654 + L711-716; N-T L145-158).
Second vector: secret `key_secret`, msg `fake_order_id|fake_payment_id` → `b2335e3b0801106b84a7faff035df56ecffde06918c9ddd1f0fafbb37a51cc89`
(Y-T test_client_utility.py L13-21; helpers.py L32).
The sample `9ef4dffb…` at CK L607 has **no published secret**, so it cannot be used as a vector.

### B. Webhook signature

| Fact | Value | Source |
|---|---|---|
| Delivery | HTTP **POST, JSON body**, ports 80/443 only | WH L39, L65 |
| Header | `X-Razorpay-Signature` = hex HMAC-SHA256(key = **webhook secret** set in Dashboard, msg = **raw request body**) | WV L87, L138-153 |
| Key | Webhook secret, **not** the API key secret (it may differ). The secret is "optional but recommended". | WS L44-45; WF L33 |
| Dedupe | `x-razorpay-event-id` header, unique per event | WV L161-169 |
| Envelope | `{"entity":"event","account_id","event","contains":[…],"payload":{"payment":{"entity":{…}},"order":{…}},"created_at"}` | WO L38-94; WP L50-96 |
| Events (payments) | `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid` | WP L23-25; WO L23 |
| Secret rotation | Retries of old events are still signed with the **old** secret | WV L89; WF "Secret changed" |

**Test vectors (official SDK tests, reproduced):**
- secret `123456`, body `{"a":1,"b":2,"c":{"d":3}}` → `2fe04e22977002e6c7cb553adab8b460cb9e2a4970d5953cb27a8472752e3bbc` (N-T L95-108).
- secret `key_secret`, body = the exact bytes of `tests/mocks/fake_payment_authorized_webhook.json` (971 bytes, **with trailing `\n`**)
  → `d60e67fd884556c045e9be7dad57903e33efc7172c17c6e3ef77db42d2b366e9` (Y-T test_client_utility.py L66-72). Without the trailing newline
  the HMAC is `0971cde1…`, which shows that byte-exact raw bodies matter.

### C. Payment Link callback signature

Payment Link redirect = **GET** with query params (`callback_method` must be `get`) (PLC L593-595; PLA "Using Callback URL Parameter").
`msg = payment_link_id + "|" + payment_link_reference_id + "|" + payment_link_status + "|" + razorpay_payment_id`, key = API key secret
(PLA "Verify Signature"; P-U L27-35; N-U L133-139; Y-U L35).
Vector: secret `EnLs21M47BllR3X8PSFtjtbd`, msg `plink_IH3cNucfVEgV68|TSsd1989|paid|pay_IH3d0ara9bSsjQ`
→ `07ae18789e35093e51d0a491eb9922646f3f82773547e5b0f67ee3f2d3bf7d5b` (PLA Java/Go samples; N-T PaymentLink test; Y-T L38-50). Reproduced.

## Get / query payment

| Endpoint | Source |
|---|---|
| `GET /v1/payments/{pay_id}` | PF L19 |
| `GET /v1/orders/{order_id}` | https://curlec.com/docs/api/orders/fetch-with-id.md L19 |
| `GET /v1/orders/{order_id}/payments` (the reliable lookup by your order) | https://curlec.com/docs/api/orders/fetch-payments.md L20 |

| Payment status | Meaning | Source |
|---|---|---|
| `created` | Details submitted, not processed | PS L23 |
| `authorized` | Bank authenticated and funds deducted. **Auto-refunded if not captured within 3 days** (custom timeout 12 min to 3 days). | PS L24; CS L24, L41-43 |
| `captured` | Complete, will settle. This is the "paid" state. | PS L25; CK §6 "ensure … `captured`" |
| `refunded` | Refunded | PS L26 |
| `failed` | Failed; any debit returned in 5-7 working days | PS L27 |

Order status: `created` → `attempted` → `paid`. It stays `paid` even after a refund (OC L242-248).
Amount: `amount` integer sen (PE L121). Your reference = the order `receipt` (fetch the order) or `notes`. The payment entity has no
receipt field (PE). **Paid time: UNCONFIRMED.** Only `created_at` (Unix seconds) is documented on the payment (PE L215). No `captured_at`
appears in PE, PF or the webhook samples. The event envelope `created_at` (WP L96) is the nearest proxy. Auto-capture is the default
(CS L17), but it applies **only to payments created via the Orders API** (CS L37).

## Minimum amount

MYR 1.00 = `100` sen: error `"The amount must be at least MYR 1.00"` (OC L164; RN failure sample L158). See Contradictions for whether 100 itself is allowed.

## Idempotency

| Area | Mechanism | Source |
|---|---|---|
| Create order | `receipt` is described as an idempotency key, and a duplicate gives `"Duplicate request. This request has already been processed."` | OC L359-365 |
| Refund | Header `X-Refund-Idempotency` (≥10 chars, `[A-Za-z0-9_-]`). Same key + different body → `BAD_REQUEST`. | RI L16-24, L247-259 |
| Webhooks | At-least-once delivery. Dedupe on `x-razorpay-event-id`. | WB L50; WV L161-169 |
| Order reuse | "Create a new order for every payment attempt … Reusing the previous order ID will cause an error" | OC L19-21 |

## Refunds / cancel (brief)

`POST /v1/payments/{pay_id}/refund`. `amount` is optional (omitted = full refund); `speed` defaults to `normal` (5-7 working days).
Status values: `pending` / `processed` / `failed`. Refunds are not possible for payments older than 6 months (RN L19, L176-200, L244-254).
Orders have no cancel endpoint documented: **UNCONFIRMED**. Payment Links can be cancelled only while unpaid (PLS L38).
Capture: `POST /v1/payments/{id}/capture` with `amount` equal to the authorised amount and `currency` (CAP L23, L172-180, L431-441).

## Retries / rate limits

| Fact | Source |
|---|---|
| Webhook must return 2xx within **5 s**. Otherwise it is retried with exponential backoff for 24 h, then the **webhook is disabled** and an email is sent. | WS L90-92; WB L19-38 |
| Delivery order is not guaranteed (`payment.authorized` may arrive after `payment.captured`) | WV L171-182; WP L34 |
| Replay on request via support, for events ≤15 days old. No bulk replay. | WF L49-71 |
| API 429 → backoff with jitter. No numeric limit is published (**UNCONFIRMED**). | AU L279-285 |
| Blacklisted webhook hosts: ngrok.io, webhook.site, requestbin, localhost, … | WV L42-69 |

## Contradictions (docs vs docs vs SDK vs plugin)

1. **Node webhook sample re-serialises the body.** WV L134 calls `validateWebhookSignature(JSON.stringify(webhookBody), …)`, yet the
   same page (L155-159) and WF say "Do not parse or cast the webhook request body". Following the sample breaks verification whenever
   the key order, spacing, unicode escaping or number format differ.
2. **Order reuse.** OC L19-21 says reusing an order ID for a retry "will cause an error". The official WooCommerce plugin **reuses** the
   stored Razorpay order for the same Woo order unless the amount changed (W-M L1188-1199).
3. **`receipt` uniqueness.** OC L206/L363 say receipt "has to be unique" and acts as an idempotency key. The Woo plugin sends
   `receipt = (string)$orderId` (W-M L1569) and creates a **new** order with the same receipt when the amount changes (W-M L1192-1210).
   Either the duplicate rule is not enforced the way OC describes, or the plugin hits that error. **UNCONFIRMED which.**
4. **Minimum amount boundary.** OC L283 says sub-units "should always be greater than 100"; OC L285 says "equal to or greater than …
   100"; the error text says "at least MYR 1.00". CK L176 shows a different error string ("Order amount less than minimum amount allowed").
5. **Payment Link initial state.** PLS L15/L38 say a link starts in `issued` and can be cancelled only in `issued`. PLE L345-352 lists
   `created` (no `issued`) and the PLS table also says "Created".
6. **Payment Link signature with no `reference_id`.** PLA says no value is returned when `reference_id` was not set. The SDKs then
   disagree: Node concatenates the JS value `undefined`, i.e. the literal string `"undefined"` (N-U L136-139). PHP reads a missing array
   key, giving null and therefore `""` (P-U L31-35). Python **returns False** without computing anything if the key is absent (Y-U L26-33).
   Always set `reference_id`.
7. **Payment `method` values.** PE L139-145 lists `card`/`fpx`/`wallet`. PF L525-534 lists `card`/`netbanking`/`wallet`/`emi`/`upi`/
   `paylater` (copied from India, with no `fpx`).
8. **Copy-paste errors in samples.** The OC create sample response says `"currency": "INR"` for a MYR request (L147). Amounts in
   language samples differ (5000 vs 50000 vs 100, OC L28/L105/L71). Checkout samples pass `amount` as the string `"50000"` while the
   parameter is typed `integer` (CK L254 vs L338-339). The .NET verify sample truncates both the order id and the signature
   (`order_IEIaMR65`, `…bc50`; CK L692-694), so it can never verify. PLA field names contain zero-width spaces (U+200B, 4 occurrences),
   which break copy-paste.
9. **Constant-time compare.** PHP uses `hash_equals` (P-U L57-60) and Python uses `hmac.compare_digest` (Y-U L70-73). Node uses plain
   `===` (N-U L102), so it is not timing-safe.
10. **Webhook retry window wording.** WB L19 says retries run "for 24 hours after event creation". WF L47 says retries happen
    "24 hours after event creation timestamp" (i.e. starting after 24 h).
11. **Capture timeout.** CS L42-43 give 3 days as the maximum, but the step example at CS L53 says "For example, 5 days".
12. **Callback fields.** CB FAQ L64 says only three fields are ever posted. CB L36-50 documents an `error` object for failures.
