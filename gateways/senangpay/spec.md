# senangPay: API contract from official sources

Researched 2026-10-23. Read-only. No third-party sources and nothing from `afu-it/*`.

## 0. Read this first: there are two contracts

senangPay (Simplepay Gateway Sdn Bhd) has **moved its merchants onto the DOKU platform**. Its own guide says "The migration from the senangPay Legacy System to the new senangPay–DOKU platform was successfully completed" [G-faqs]. For API integration it sends merchants to the "DOKU Malaysia API Reference" [G-api]. This means:

| Contract | Where it is documented | Status |
|---|---|---|
| **A. senangPay–DOKU (current)**: REST/JSON, header `Signature: HMACSHA256=…` | DOKU Malaysia API Reference on apidog (llms.txt + `.md` per page) [D-llms] | Current, and the one senangPay links to [G-api] [S-faq §Integration] |
| **B. senangPay Legacy**: form POST/redirect to `/payment/{merchantID}`, `hash` = HMAC-SHA256/MD5 over `secret+detail+amount+order_id` | GitBook source in GitHub `senangpay/api_catalog` (last commit 2025-06-04) plus the senangPay plugins in `github.com/senangpay/*` | **Legacy.** Tested 2026-10-23: `POST https://app.senangpay.my/payment/14222653788472` (the docs' example merchant ID) returns **302 → `https://doku.com/not-found`**; `sandbox.senangpay.my` returns **530**; `api.sandbox.senangpay.my` does not connect. Whether a real legacy merchant ID still works: **UNCONFIRMED** |

**Docs are public.** Contract A is fully public as Markdown and OpenAPI (no login needed). Contract B is public as GitBook Markdown and YAML on GitHub. The old guide pages linked from it (`guide.senangpay.my/callback-url/`) now return 404.

**Officialness caveat.** `github.com/senangpay` is a GitHub *user*, not an org (created 2019-08-28). Its content is senangPay-branded (logos, `help@senangpay.my`). However, senangpay.com does **not** link to it, so its official status is inferred, **UNCONFIRMED**. The `api_catalog` repo has **no licence**.

### Source keys used below

| Key | URL / path |
|---|---|
| G-api | https://guide.senangpay.com/doku-api-integration-guide |
| G-faqs | https://guide.senangpay.com/common-faqs-regarding-senangpay-doku-migration |
| G-enh | https://guide.senangpay.com/key-platform-enhancements-on-the-doku-platform |
| S-faq | https://senangpay.com/doku-migration-faq/ (anchors `#Integration`, `#Sandbox`, `#Refund`, `#Payments`) |
| D-llms | https://doku-developers.apidog.io/llms.txt |
| D-auth | https://doku-developers.apidog.io/authentication-api-keys-2466452m0.md |
| D-first | https://doku-developers.apidog.io/make-your-first-api-call-2466453m0.md |
| D-comp | https://doku-developers.apidog.io/prepare-signature-component-2466481m0.md |
| D-gen | https://doku-developers.apidog.io/generating-signature-2466482m0.md |
| D-val | https://doku-developers.apidog.io/validating-signature-2466483m0.md |
| D-code | https://doku-developers.apidog.io/sample-code-2466484m0.md |
| D-ccreq | https://doku-developers.apidog.io/signature-component-from-request-header-2466488m0.md |
| D-ccres | https://doku-developers.apidog.io/signature-component-from-response-header-2466485m0.md |
| D-ccget | https://doku-developers.apidog.io/signature-from-api-get-method-2466486m0.md |
| D-idem | https://doku-developers.apidog.io/idempotency-2466467m0.md |
| D-dtype | https://doku-developers.apidog.io/data-type-2466468m0.md |
| D-stat | https://doku-developers.apidog.io/order-transaction-status-2466469m0.md |
| D-err | https://doku-developers.apidog.io/error-code-2466472m0.md |
| D-cco | https://doku-developers.apidog.io/create-checkout-44767692e0.md |
| D-rco | https://doku-developers.apidog.io/retrieve-checkout-status-44767693e0.md |
| D-cpay | https://doku-developers.apidog.io/create-payment-44767694e0.md |
| D-rpay | https://doku-developers.apidog.io/retrieve-payment-status-44767696e0.md |
| D-banks | https://doku-developers.apidog.io/get-bank-list-fpx-44767695e0.md |
| D-ntf | https://doku-developers.apidog.io/overview-2466462m0.md |
| D-ntfurl | https://doku-developers.apidog.io/setup-notification-url-2466463m0.md |
| D-retry | https://doku-developers.apidog.io/retry-notification-2466464m0.md |
| D-nglob | https://doku-developers.apidog.io/sample-notification-global-44767704e0.md |
| D-ncard | https://doku-developers.apidog.io/sample-notification-cards-44767705e0.md |
| D-refund | https://doku-developers.apidog.io/request-refund-44767697e0.md |
| D-ccstat | https://doku-developers.apidog.io/check-status-44767699e0.md |
| L-hash | `senangpay/api_catalog` `integration-api/manual-integration-api-open-api/generate-secure-hash.md` (raw: https://raw.githubusercontent.com/senangpay/api_catalog/HEAD/…) |
| L-man | `senangpay/api_catalog` `integration-api/manual-integration-api-open-api/README.md` |
| L-rec | `senangpay/api_catalog` `integration-api/api-for-recurring-payment/README.md` |
| L-rhash | `senangpay/api_catalog` `integration-api/api-for-recurring-payment/generate-secure-hash-recurring-payment.md` |
| L-swag | `senangpay/api_catalog` `.gitbook/assets/swagger spelling checked.yaml` (the OpenAPI that L-man embeds) |
| P-give | `senangpay/givewp` `includes/Senangpay_API.php` (MIT) |
| P-hika | `senangpay/senangpay-payment-gateway-for-hikashop` `senangpay.php` (GPL-3.0) |
| P-presta / P-mag | `senangpay/prestashop` `classes/SenangpayApi.php`, `senangpay/magento` `Model/SenangpayApi.php` |

---

## A. senangPay–DOKU (current contract)

### A1. Hosts and auth

| Item | Value | Source |
|---|---|---|
| Sandbox API | `https://api-sandbox.doku.com` | D-auth §Environments and Keys |
| Production API | `https://api.doku.com` | D-auth §Environments and Keys |
| Sandbox sign-up (MY) | `https://sandbox.doku.com/bo/sandbox-registration?country=MY` | G-enh §DOKU Sandbox Access |
| Sandbox test card | `5120910000000012`, any future MM/YY, CVV `100`. FPX/e-wallet: simulate success or failure on the last step | S-faq #Sandbox |
| Credentials | Client ID, Secret Key (signing), API Key (one set per environment) | D-auth §Types of Credentials |
| `Authorization` | `Basic base64("<API-Key>:")`, i.e. API key as username plus a trailing colon (empty password) | D-auth §Notes for API Key |
| Other required headers | `Client-Id`, `Request-Timestamp` (ISO 8601 UTC), `API-Version` (example `arabica.2025-12-01`) | D-cco / D-cpay `parameters` |
| `Signature` header | `HMACSHA256=<base64>`. **Required** on Create Payment and Get Bank List; marked **optional ("Conditional")** on Create Checkout; not listed on the GET retrieve endpoints | D-cpay, D-banks, D-cco, D-rpay `parameters` |
| Timestamp skew window | Error `request_timestamp_invalid` 400 "outside the allowed range"; the range itself is **UNCONFIRMED** | D-err §Authetication & Signature |

### A2. Create payment

Hosted page: **`POST /v3/checkouts`** (D-cco). Direct, per channel: **`POST /v3/payments`** (D-cpay). For FPX on `/v3/payments`, first call `POST /v3/payments/internet-banking/banks` to get `bank_code` (D-banks; D-cpay §overview-2466458m0 "Mandatory for FPX").

| Field | Rule | Source |
|---|---|---|
| `id` (body) | Merchant's own unique reference (`reference_id`), 1–128 chars, pattern `^[A-Za-z0-9-_:]`. **Required** | D-cco `components.schemas.reference_id` |
| `order.amount` | `number`/float, **ringgit with decimals** (e.g. `100.05`), "with or without decimal". **Not sen** | D-cco `order.amount` |
| `order.invoice_number` | Merchant order number. **Max 30 chars if the Credit Card channel is active** | D-cco `components.schemas.order` |
| `order.currency` | ISO 4217, `MYR` | D-cco |
| `order.expired_at` | **Required**, UTC ISO 8601 (e.g. `2029-08-05T12:00:00Z`) | D-cco / D-cpay `order.required` |
| `order.line_items[]` | `name`, `quantity`, `price` required (checkout) | D-cco |
| `checkout_experience.callback_url` | Browser "Back to Merchant" URL. `callback_url_result` overrides it on the result page | D-cco `checkout_experience` |
| `payment.channel` (`/v3/payments`) | `INTERNET_BANKING_FPX`, `EWALLET_TNG`, `EWALLET_SHOPEEPAY`, `EWALLET_GRABPAY`, `BNPL_GRABPAY`, `BNPL_SHOPEEPAY`. **Cards are not available on the Payment API** | D-cpay; overview-2466458m0 §Cards Payment Channel |
| `payment.business_model`, `payment.bank_code` | Required for FPX | D-cpay |
| `payment.callback_url` | Browser redirect after payment | D-cpay |
| `device_info` | Mandatory for Touch 'n Go, ShopeePay, SPayLater (checkout) | D-cco `device_info.description` |
| Response | `payment.checkout_url` (checkout), `payment.status` / `state` | D-first Step 3; D-cco 200 schema |
| Server-to-server webhook URL | **Not** a request field. Set it in Back Office → Settings → Webhook (one URL per channel). Cards use a separate menu (Settings → Credit Card → Payment Configuration) | D-ntfurl §1, §2; S-faq #Integration Q2 |
| Return URL (merchant-level) | Changing it requires a request to Customer Support | S-faq #Integration Q2 |
| Minimum amount | **RM2.00** | S-faq #Payments Q11 |

### A3. Get / query payment

| Item | Value | Source |
|---|---|---|
| Checkout | `GET /v3/checkouts/{id}` | D-rco |
| Payment | `GET /v3/payments/{id}`, where `{id}` = "original id when you request create a payment object" (the merchant `id`, not a DOKU ID) | D-rpay `parameters.id` |
| Timing | "**Hit Retrieve … after 60 seconds after payment completion!**" | D-rpay / D-rco `description` |
| Order status (checkout) | `PENDING`, `EXPIRED`, `PAID` | D-stat §Order Status |
| Transaction `status` (FPX/TNG/GrabPay/ShopeePay) | `PENDING` (state `INITIATE` / `WAITING_APPROVAL` (FPX B2B) / `WAITING_VERIFICATION`), `SUCCESS`+`COMPLETED`, `FAILED`+`COMPLETED`, `EXPIRED`+`COMPLETED`. "You only require to validate payment status using the `status` attribute" | D-stat §Transaction Status |
| Cards status | `PENDING`, `REDIRECT`, `FAILED`, `SUCCESS` (final), `REFUNDED` (final). No `state` | D-stat §Cards |
| Amount | `payment.amount` float in MYR | D-cpay 200 schema `payment.amount` |
| Paid time | **No paid-at field** in the Global (non-card) retrieve or notification schemas → **UNCONFIRMED**. Cards notification carries `transaction.date` such as `'2025-08-28T02:56:15Z'` (ISO 8601 UTC) | D-rpay, D-nglob, D-ncard example 1 |
| Cards check status | `GET /orders/v1/status/{invoice_number}` (the page literally shows the path as `order.invoice_number`) | D-ccstat; D-ccget example |

### A4. Callback / webhook

| Item | Value | Source |
|---|---|---|
| Delivery | HTTP **POST, JSON body**. Parse non-strictly because new fields may be added | D-ntf; D-nglob `requestBody application/json` |
| Global body | `{id, order{amount,invoice_number,currency,expired_at}, payment{channel,type,initiation_type,amount,currency,status,state}, customer{…}, metadata}` | D-nglob example |
| Global headers | `Authorization` (`Base64(doku_ak_test_…)`), `Client-Id`, `Request-Timestamp`, `Signature` (marked `required: false` yet "also required when DOKU webhook call to merchant, and recommended for merchant to verified"), `API-Version` example `doku-global.2025-12-01` | D-nglob `parameters` |
| Cards headers | `Client-Id`, `Request-Id` ("generated by DOKU to make sure no duplicate notification"), `Request-Timestamp`, `Signature` (required) | D-ncard `parameters` |
| Ack | Respond **HTTP 2xx** | D-retry |
| Retries | 3 retries, at 30 min, 6 h and 12 h after the original attempt. Manual resend: Back Office → Integration → HTTP Notification | D-retry |
| Inbound URL rules | Public internet only; no localhost, auth-protected URL, VPN or unusual port | D-ntfurl |

#### A4.1 Signature: "Global" scheme (Checkout, Payment, and the global webhook)

| Step | Rule | Source |
|---|---|---|
| Digest | `base64( SHA-256( raw JSON body bytes ) )`. POST/PATCH only. **Do not re-serialise or beautify the body** | D-comp §Components, §Do & Don't |
| Request string | `Client-Id + "\n" + Request-Timestamp + "\n" + RequestPath + "\n" + Digest`, **values only, no `Name:` labels, no trailing newline** | D-comp §Request Signature; D-gen step 1 |
| Response string | `Client-Id + "\n" + Response-Timestamp + "\n" + Digest` (**no path**) | D-comp §Response Signature |
| Path for inbound webhook | The path of **your** webhook URL | D-comp §Components "Request Path" |
| MAC | `base64( HMAC-SHA256( key = Secret Key (UTF-8), msg = string ) )` | D-gen step 2; D-code Java/Python |
| Header | `Signature: HMACSHA256=<base64>` | D-gen step 3 |
| GET/DELETE | Leave out the digest line | D-code (all languages, comment) |
| Published example | String `BRN-0239-1709018494325\n2026-08-11T06:39:29Z\n/v3/payments\nkouJDoOZUOcxBcR2TFN5ehxSDcjiPydf8V4uJBywFJ0=` → `HMACSHA256=X78G6dJOsfFS5KjPbN9Y0iQ8ZMkadT0UZFzGwHTACHE=`. **The secret key is not published**, so this is **not a usable test vector**. Keys I tried (`secret-key-from-DOKU-back-office`, `secret-key-from-jokul-back-office`, `secret`, empty) all fail to reproduce it | D-gen, D-val |

#### A4.2 Signature: "Cards" scheme (separate, labelled)

`Client-Id:<v>\nRequest-Id:<v>\nRequest-Timestamp:<v>\nRequest-Target:<path>\nDigest:<b64 sha256 body>`, then `HMACSHA256=` + base64 HMAC-SHA256(secret) (D-ccreq). Responses use `Response-Timestamp` (D-ccres). GET leaves out `Digest` (D-ccget). Published examples (`…OvIRJs/jH8BIcGsktr4d8nnYtxY6E0Uzdm9d1GVgv5s=`) again come **without a secret**, so they are not test vectors.

### A5. Idempotency, refunds, other

| Item | Value | Source |
|---|---|---|
| Idempotency | Header `Idempotency-Id` (optional), ≤ 255 chars, kept 24 h, UUIDv4 suggested. Same key with a different payload → error. Errors `idempotency_id_conflict` 409, `idempotency_id_required` 400 | D-idem; D-err §Idempotency; D-cco `parameters` |
| Duplicate reference | `duplicate_transaction` 400 "same reference already exists" | D-err §Transaction |
| Refund API | `POST /cancellation/credit-card/refund`, **cards only**. Body `order.invoice_number`, `payment.original_request_id`, `refund.amount` (**string**). Result `VOID` (unsettled, must equal the full amount) / `PARTIAL_REFUND` / `FULL_REFUND` | D-refund |
| Refund (senangPay policy) | Cards only. Request by **email** to the Finance team. FPX/e-wallet/BNPL/IPP are not refundable | S-faq #Refund Q1–Q2 |
| Cancel / void (non-card) | **UNCONFIRMED** (no endpoint documented) | D-llms (no such page) |
| Tokenisation | Not available on the DOKU platform yet | S-faq #Payments Q8 |

---

## B. senangPay Legacy (for reference and migration)

### B1. Hosts

| Item | Value | Source |
|---|---|---|
| Production | `https://app.senangpay.my/payment/{merchantID}` | L-swag l.12–13, l.24; P-give l.13 |
| Sandbox | `https://sandbox.senangpay.my/payment/{merchantID}` (and `https://api.sandbox.senangpay.my` for the recurring and token APIs) | L-swag l.8–11; P-give l.13 |
| Auth | No API key. `merchantID` in the path plus `hash` using the merchant **Secret Key** (Dashboard → Settings → Profile → "Shopping Cart Integration Link") | L-man l.15 |

### B2. Create payment

`POST application/x-www-form-urlencoded` → **302** to the payment page (L-swag l.24–53). All four official plugins instead **redirect the browser with a GET query string** (`endpoint + merchant_id + '?' + http_build_query(params)`) (P-give l.19–26; P-presta l.53–60; P-mag l.25–28).

| Field | Rule | Source |
|---|---|---|
| `detail` | ≤ 500 chars, `[A-Za-z0-9.,\-_]`, `_` shown as a space | L-man l.32 |
| `amount` | **Ringgit, 2 decimals**, e.g. `25.50` | L-man l.32 |
| `order_id` | ≤ 100 chars, `[A-Za-z0-9-]` | L-man l.32 |
| `hash` | see B4 | L-man l.32 |
| `name`, `email`, `phone` | Optional (per prose) | L-man l.32 |
| `timeout` | Seconds. Minimum 60 (lower values become 60). Omitted = no timeout | L-man l.32 |
| Return / callback URL | Set in the **dashboard** (Settings → Profile), not per request | L-man l.17–23 |

### B3. Return and callback

| Item | Value | Source |
|---|---|---|
| Return (browser) | **GET** query to the Return URL | L-man l.44–46 |
| Callback (server) | **POST** form to the Callback URL ("alternative notification") | L-man l.21, l.58 |
| Fields | `status_id`, `order_id`, `msg` (underscores), `transaction_id`, `hash` | L-man l.50–56 |
| `status_id` | `1` success, `0` failed, **`2` pending authorisation** | L-man l.52 |
| Recurring `status_id` | `1`, `0`, **`3`** pending (first recurring payment only) | L-rec l.73; L-swag l.1505 |
| Callback ack | Hikashop plugin replies the plain text `OK`. Whether the docs require it: **UNCONFIRMED** | P-hika l.191, l.204 |
| Paid time | Not returned. **UNCONFIRMED** | L-man l.50–56 |
| Query/status API | None documented in api_catalog → **UNCONFIRMED** | L-swag paths list |

### B4. Hash (verified test vectors)

Outbound: `HMAC_SHA256(key=secret, msg = secret + detail + amount + order_id)` as lowercase hex, **or** `md5(secret + detail + amount + order_id)` (plain MD5, no key). Inbound: the same over `secret + status_id + order_id + transaction_id + msg` (L-hash l.9, l.25–29, l.47–51). Note that **the secret is both the HMAC key and the string prefix**.

| Vector | Input string | Algorithm | Expected (checked locally, all match) | Source |
|---|---|---|---|---|
| L1 | `53-784Shopping_cart_id_3024.5056` | md5 | `0bde51ff340f110ab7331a902aa969e7` | L-hash l.25–27 |
| L2 | same, key `53-784` | HMAC-SHA256 | `74422328b44d30bf150fffbae89bbb42b885f9ac0960e2a3ddccc0cf9aa48e39` | L-hash l.29 |
| L3 | `53-78415614363538840Payment_was_successful` | md5 | `69686562c29ad3f7955b1843a5c275ca` | L-hash l.47–49 |
| L4 | same, key `53-784` | HMAC-SHA256 | `4ca7837c6c4ddb5f6ba573ea701235b2d04bc6400d32787539e07aaf319eb70f` | L-hash l.51 |
| R1 | `21245-957123412` (secret+recurring_id+order_id) | **plain SHA-256** | `a8167dd09f01ebed0b18e67b2cc2424a0d058ccc83d94803482ecdeedff7728f` | L-rhash l.24–32 |
| R2 | `21245-95711214363538840Payment_was_successful` | **plain SHA-256** | `24354422953c29bf4b822f6783bbaf64ef445623d6e8ea4ddc1582a29c03cda0` | L-rhash l.51–59 |

Tokenisation `pay_cc` (legacy): `hash_hmac('SHA256', merchant_id+name+email+phone+detail+order_id+amount, secret)`. The response hash covers `merchant_id+status_id+order_id+transaction_id+amount_paid+msg`, with `amount_paid` **in sen** (`200` = RM 2.00) (L-swag l.1370–1400).

---

## C. Contradictions (the most useful findings)

| # | Conflict | Sources |
|---|---|---|
| C1 | **Global signature: Python and Node samples prepend `"Digest:"`** to the digest line. Java, Ruby and PHP, and the prose (D-gen), use the bare digest. Following the Python/Node sample gives `invalid_signature` (inferred from prose, **not live-tested**) | D-code Python/Node vs Java/Ruby + D-gen |
| C2 | **Go sample appends the digest twice** (writes `"\n"+digest` unconditionally, then again under `if len(digest)>0`) | D-code Go |
| C3 | Global response signature has **3 lines (no path)** (D-comp). D-val's "validate response" example shows 4 lines including `/v3/payments` | D-comp §Response vs D-val step 1 |
| C4 | Cards raw-string example has `Request-Target://credit-card/...` (double slash). The display version has a single slash. The response example is missing `\n` before `Response-Timestamp` and changes path to `/doku-virtual-account/v2/payment-code` | D-ccreq, D-ccres |
| C5 | `state` enum in schema is `INIT`. Status table and the **same page's** response example use `INITIATE` | D-cpay l.449 vs l.567; D-stat |
| C6 | Create Payment marks `payment.processor{approvel_code,response_code}` (typo) as **required**, but the "Basic Request" example omits it. Retrieve uses `approval_code` | D-cpay `payment.required` vs examples; D-rpay |
| C7 | Checkout schema field is `checkout_experience.payment_channels`. All examples send `channels` plus `callback_url_cancel` (not in schema). Example uses `settlement_data` but the schema says `settlement_object` | D-cco schema vs examples; D-first |
| C8 | `Authorization` example `Base64(doku_ak_test_…)` (no colon) vs the auth page's `Base64(API-Key:)` with a required colon | D-cco/D-nglob vs D-auth |
| C9 | `API-Version` example `arabica.2025-12-01` (requests) vs `doku-global.2025-12-01` (notification) | D-cco vs D-nglob |
| C10 | `reference_id` pattern allows `:` (`^[A-Za-z0-9-_:]`). The Data Type page's Identity type does not (`^[A-Za-z0-9-_]+`) | D-cco vs D-dtype |
| C11 | Idempotency header documented as optional, yet error `idempotency_id_required` exists | D-cco `parameters` vs D-err |
| C12 | **Refund scope**: G-enh says "Refunds are supported across all available payment methods". The senangPay FAQ says cards only, by email. The API refund endpoint is credit-card only | G-enh vs S-faq #Refund vs D-refund |
| C13 | Legacy: prose says `name/email/phone` optional and URLs come from the dashboard. OpenAPI marks `name,email,phone,return_url,callback_url` **required** (and has no `return_url` property) | L-man l.32 vs L-swag l.1300–1309 |
| C14 | Legacy: generic hash page says "HMAC … with SHA256 **or md5**" yet MD5 is plain `md5()`. The recurring page uses **plain SHA-256** without HMAC, while L-rec links to the HMAC page for its hash | L-hash l.9/27; L-rhash l.9; L-rec l.51 |
| C15 | Legacy: amount in **ringgit** (`2.00`) for payment, but tokenisation `amount_paid` in **sen** (`200`). `pay_cc` response field is `status` but its hash uses `status_id` | L-man; L-swag l.1376–1400 |
| C16 | Legacy: OpenAPI says form **POST**. Every official plugin sends **GET query string**. Hikashop uses MD5 (P-hika l.171, l.224); GiveWP/Presta/Magento use HMAC-SHA256 | L-swag l.42 vs P-give l.19–31 |
| C17 | Legacy amount formatting: docs demand 2 decimals, yet GiveWP hashes `strval(price)` and Hikashop `round(x,2)` (`24.5` not `24.50`). The hashed amount must equal the sent string exactly | L-man l.32 vs P-give gateway l.123, P-hika l.104 |
| C18 | senangPay's own links to the DOKU docs (`doku-developers.apidog.io/overview-1950524m0`, `…/overview-1950484m0`) return **404**. The live index is `/llms.txt` | G-api, S-faq #Integration vs D-llms |

## D. Gaps (UNCONFIRMED)

- Live behaviour of the legacy endpoint for real merchant IDs.
- Request-Timestamp tolerance.
- Paid-at timestamp for non-card channels.
- Non-card cancel/void API.
- Whether DOKU signs the global webhook with the merchant path exactly as for requests: the prose says so (D-comp), but there is no worked webhook example.
- Any secret-bearing DOKU signature test vector.
- Retry semantics beyond the 3-step table (the D-retry wording "stop retrying once we receive a response … or if there's still no response" is ambiguous).
