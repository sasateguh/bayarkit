# Adyen — API contract for a Malaysian merchant (Hosted Checkout `/sessions` + Pay by Link `/paymentLinks`, MYR, FPX, Standard webhooks)

Researched 2026-10-23. Docs are PUBLIC: `https://docs.adyen.com/llms.txt` (200, text/plain) lists every page and states
"Every page is also available as Markdown by appending `.md` to the URL". All facts below come from those `.md`
exports, the official OpenAPI repo `Adyen/adyen-openapi` (HEAD `2c1f3ab1e0`) and official SDKs in `github.com/Adyen`
(node `83d827aa78`, python `2b708a439f`, java `0832fcbaca`, php `693fcd44cd`). Line numbers (Lnn) refer to the
file as fetched on that date.

Abbreviations used as sources:
- **OA** = `https://raw.githubusercontent.com/Adyen/adyen-openapi/HEAD/json/CheckoutService-v72.json`
- **WH** = `https://raw.githubusercontent.com/Adyen/adyen-openapi/HEAD/json/Webhooks-v1.json`
- **HC** = `https://docs.adyen.com/standard/integration/hosted-checkout.md`
- **PBL** = `https://docs.adyen.com/unified-commerce/pay-by-link/create-payment-links/api.md`
- **HMAC** = `https://docs.adyen.com/development-resources/webhooks/secure-webhooks/verify-hmac-signatures.md`
- **NODE** = `https://raw.githubusercontent.com/Adyen/adyen-node-api-library/HEAD/…`

## 1. Hosts and auth

| Fact | Value | Source |
|---|---|---|
| Test host (Checkout API) | `https://checkout-test.adyen.com/v72/{method}` | OA L15 `servers[0].url`; `https://docs.adyen.com/development-resources/live-endpoints.md` L70 |
| Live host | `https://[prefix]-checkout-live.adyenpayments.com/checkout/v72/{method}` — per-company `prefix` (hex + company name) from live Customer Area > Developers > API URLs; note the extra `/checkout/` path segment that test does not have | live-endpoints.md L54-60, L71 |
| Test vs live | Separate environments and separate Customer Areas (`ca-test.adyen.com` / `ca-live.adyen.com`); webhook configs are NOT copied to live; a new HMAC key is needed for live | `https://docs.adyen.com/development-resources/webhooks/configure-and-manage.md` L160-161; HMAC L28 |
| Live region | All requests for one payment session must use the same live endpoint region | HC L1209 |
| Auth option 1 | Header `X-API-Key: <api key>` (OpenAPI `ApiKeyAuth`; docs spell it `x-API-key`; headers are case-insensitive) | OA L20193 `components.securitySchemes.ApiKeyAuth`; `https://docs.adyen.com/development-resources/api-authentication.md` #api-key-authentication |
| Auth option 2 | HTTP Basic, `ws_…@Company.YourCompany:password` | OA `securitySchemes.BasicAuth`; api-authentication.md #using-basic-authentication |
| Merchant identity | `merchantAccount` is a required body field on every create request | OA `CreateCheckoutSessionRequest.required`, `PaymentLinkRequest.required` |

## 2. Create payment

### 2a. Hosted Checkout — `POST /sessions` with `mode: "hosted"`

| Item | Value | Source |
|---|---|---|
| Endpoint | `POST /v72/sessions` → 201 `CreateCheckoutSessionResponse` | OA L2903 `paths./sessions.post` |
| Required (OpenAPI) | `amount`, `merchantAccount`, `reference`, `returnUrl` | OA L7135 `CreateCheckoutSessionRequest.required` |
| Required (Hosted Checkout guide) | additionally `countryCode`, `shopperEmail`, `shopperReference`, `mode`=`hosted`, `themeId` (see §9 contradiction) | HC L314-327 |
| `mode` | enum `embedded` (default) / `hosted`; `x-addedInVersion` 69 | OA L7319-7320 |
| Amount | `amount: {currency: "MYR", value: <int64>}`, value in MINOR units | OA L4923 `Amount`; `https://docs.adyen.com/development-resources/currency-codes.md` L164 |
| MYR decimals | 2 → RM10.00 = `1000` (sen) | currency-codes.md L104 |
| Reference | `reference` "The reference to uniquely identify a payment." (no maxLength in this schema; guide says min 3 chars) | OA `CreateCheckoutSessionRequest.properties.reference`; HC L319 |
| Return URL | `returnUrl`, maxLength 1024, may carry your own query params; no PII | OA L7364 |
| Callback URL field | NONE in the request — webhook endpoint is configured in Customer Area (Developers > Webhooks) | configure-and-manage.md L83-121; HC L29 |
| Expiry | `expiresAt` ISO 8601; default 1 h after creation; max 24 h | OA L7268 |
| Result URL | response `url` "The URL for the Hosted Checkout page. Redirect the shopper to this URL" (e.g. `https://eu.adyen.link/WNKH9MC2XJMLNK82`) | OA L7830; HC L804 |
| Response required | `amount, expiresAt, id, merchantAccount, reference, returnUrl` | OA L7481 `CreateCheckoutSessionResponse.required` |
| Restrict to FPX | `allowedPaymentMethods: ["molpay_ebanking_fpx_MY"]` (payment-method type) | OA `CreateCheckoutSessionRequest.properties.allowedPaymentMethods`; `https://docs.adyen.com/payment-methods/fpx-online-banking-malaysia/api-only.md` L65, L983 |
| WebView | Use SFSafariViewController / Chrome Custom Tabs, not WebView | HC L814 |

### 2b. Pay by Link — `POST /paymentLinks`

| Item | Value | Source |
|---|---|---|
| Endpoint | `POST /v72/paymentLinks` → 201 `PaymentLinkResponse` | OA L1008 |
| Required | `amount`, `merchantAccount`, `reference` | OA L11240 `PaymentLinkRequest.required` |
| `returnUrl` | optional, maxLength 8000; shows a **Continue** button on the payment page | OA L11381 |
| Expiry | `expiresAt` ISO 8601 with offset; default 24 h; max 70 days | OA L11303 |
| Reusable | `reusable` default false = one successful payment only | OA L11385 |
| Response | required `amount, id, merchantAccount, reference, status, url`; `url` e.g. `https://test.adyen.link/PL…` | OA L11470; PBL L1008 |
| Force expiry | `PATCH /paymentLinks/{linkId}` body `{"status":"expired"}` (only allowed value) | OA L16133; PBL L7564-7568 |
| iframe | Payment links cannot be embedded in an iframe since 2025-11-01 | PBL L745 |
| Retention | Link details kept 3 months | PBL L761 |

### 2c. FPX specifics

| Fact | Value | Source |
|---|---|---|
| Provider | FPX (PayNet) via partner Razer Merchant Services (formerly MOLPay) | `https://docs.adyen.com/payment-methods/fpx-online-banking-malaysia.md` L21 |
| Flow / country / currency | redirect, MY, MYR; refunds + partial refunds yes; separate captures no; recurring no | fpx…malaysia.md L25-27 |
| Type / issuers | `molpay_ebanking_fpx_MY`; issuer IDs `fpx_abb`, `fpx_mb2u`, `fpx_cimbclicks`, … (18 banks; all must be shown for PayNet compliance in own-UI integrations) | fpx…/api-only.md L40-65 |
| Result | Asynchronous — rely on webhooks | fpx…malaysia.md L23 |
| Pay by Link | FPX page links to Pay by Link as an integration option | fpx…malaysia.md L67-71 |
| Test | Adyen Payment Simulator page (choose outcome) is enabled by default in test Customer Area | fpx…/api-only.md L979-988 |
| Minimum amount | **UNCONFIRMED** — no minimum stated anywhere; OA `Amount.value` has no `minimum` | OA L4923 |

## 3. Get / query payment

| Item | Value | Source |
|---|---|---|
| Session result | `GET /v72/sessions/{sessionId}?sessionResult=…` — `sessionResult` is REQUIRED and only arrives appended to your `returnUrl` (`?sessionId=…&sessionResult=…`) | OA L2976; HC L825-831 |
| Session status enum | `active, canceled, completed, expired, paymentPending, refused` (`active` not defined in the description) | OA L14641-14642 |
| Meanings | completed = paid and authorised; paymentPending = async method in progress; refused = too many refused attempts; canceled = shopper canceled; expired = session expired | OA L14641 |
| Status is a snapshot | "The status included in the response doesn't get updated. Don't make the request again" — use webhooks | OA L14641; HC L1117 |
| Session payments | `payments[]` of `{amount, paymentMethod, pspReference, resultCode ∈ Authorised/Received/Pending}` | OA `Payment` schema |
| Paid time | **Not returned** by `/sessions/{id}`; only webhook `eventDate` (ISO 8601 `YYYY-MM-DDThh:mm:ssTZD`, e.g. `2019-06-28T18:03:50+01:00`) | WH L178; `https://docs.adyen.com/development-resources/webhooks/webhook-types.md` L57, L72 |
| Pay by Link status | `GET /v72/paymentLinks/{linkId}` → `status` enum `active, completed, expired, paid, paymentPending`; `updatedAt` ISO 8601 | OA L1142, L11681 |
| Link status meanings | active = usable; expired; completed = shopper completed payment; paymentPending = async in progress; `paid` **UNDEFINED** | OA L11680; PBL L991 |
| Query by merchant reference | **UNCONFIRMED / none found** in Checkout API v72 paths | OA `paths` keys |

## 4. Webhook (Standard webhook) — delivery

| Item | Value | Source |
|---|---|---|
| Configured where | Customer Area > Developers > Webhooks; method JSON, HTTP POST or SOAP; optional Basic auth; recommended at company-account level | configure-and-manage.md L19, L50, L106, L117 |
| Body (JSON) | `{"live":"false","notificationItems":[{"NotificationRequestItem":{…}}]}`; JSON and HTTP POST carry exactly ONE item, SOAP up to six | webhook-types.md L41-45, L59-84 |
| HTTP POST variant | form/URL parameters; "For HTTP POST notifications, currency and value are returned as URL parameters" | WH L168 |
| Item fields | required `amount, eventCode, eventDate, merchantAccountCode, merchantReference, pspReference, success`; optional `originalReference, reason, paymentMethod, additionalData` | WH L3716 `NotificationRequestItem` |
| `success` | STRING `"true"`/`"false"` | WH `NotificationRequestItem.properties.success`; webhook-types.md L53 |
| Payment result event | `eventCode: AUTHORISATION`; match with `merchantReference`; hosted checkout adds `additionalData.checkoutSessionId`; Pay by Link adds `additionalData.paymentLinkId` | HC L1121, L1148; PBL L763-797 |
| Multiple attempts | one webhook per payment attempt; several can share a `sessionId` (fail then succeed) | HC L1228 |
| Acknowledge | any 2xx (docs say "such as 202" / "200 or 202") within 10 s, before business logic | `https://docs.adyen.com/development-resources/webhooks/handle-webhook-events.md` L38-42; configure-and-manage.md L129 |
| Retries | a few immediate retries → "Failing" → retry queue for up to 30 days at 30 s, 30 s, 1, 2, 5, 10, 15, 30 min, 1, 2, 4, 8 h | `https://docs.adyen.com/development-resources/webhooks/troubleshoot.md` L21-36 |
| Duplicates | same `eventCode`+`pspReference`, `eventDate` may differ — use the latest | handle-webhook-events.md L62 |
| Settlement | no webhook when a payment settles | webhook-types.md L168 |

## 5. Webhook signature (HMAC) — Standard webhooks

| Item | Value | Source |
|---|---|---|
| Where | `NotificationRequestItem.additionalData.hmacSignature` (Standard webhooks); NOT a header | HMAC L41-58 |
| Algorithm | HMAC-SHA256, output Base64 | HMAC L219-229 |
| Key | the hex string from Customer Area, HEX-DECODED to bytes (64 hex chars → 32 bytes); one key per webhook endpoint | HMAC L26, L221 |
| String | `pspReference:originalReference:merchantAccountCode:merchantReference:value:currency:eventCode:success`, empty string for empty fields, `:` delimiter, UTF-8, NO escaping | HMAC L194-212; NODE `src/utils/hmacValidator.ts` L90-101; python `Adyen/util.py` L19-31; java `HMACValidator.java` L175-187; php `HmacSignature.php` L87-110 |
| `value` | integer minor units as decimal text (e.g. `1130`) | HMAC L202 |
| Key rotation | accept old key for a while after generating a new one | HMAC L61-65 |
| Header variant (other webhooks only) | headers `hmacsignature` + `protocol: HmacSHA256`, HMAC over the raw body | HMAC L276-294 |

**Test vectors (all re-computed and reproduced on 2026-10-23 with Python `hmac`):**

| # | Key (hex) | Signing string | Expected | Source |
|---|---|---|---|---|
| V1 (docs) | `44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056` | `7914073381342284::TestMerchant:TestPayment-1407325143704:1130:EUR:AUTHORISATION:true` | `coqCmt/IZ4E3CzPvMY8zTjQVL5hYJUiBRg8UU+iCWo0=` | HMAC L212, L240, L252 |
| V2 (node SDK) | `DFB1EB5485895CFA84146406857104ABB4CBCABDC8AAF103A624C8F6A3EAAB00` | `pspReference:originalReference:merchantAccount:reference:1000:EUR:EVENT:true` | `ipnxGCaUZ4l8TUW75a71/ghd2Fe5ffvX0pV4TLTntIc=` | NODE `src/__tests__/hmacValidator.spec.ts` L7, L108-124 |
| V3 (node SDK) | same as V2 | `pspReference:originalReference:merchantAccount:reference:1000:EUR:REPORT_AVAILABLE:true` | `ZNBPtI+oDyyRrLyD1XirkKnQgIAlFc07Vj27TeHsDRE=` | NODE spec L7-8, L51 |
| V4 (java SDK, no-escaping) | `74F490DD33F7327BAECC88B2947C011FC02D014A473AAA33A8EC93E4DC069174` | `ZVWN7D3WSMK2WN82::AntoniStroinski:\:/\/slashes are fun:1000:EUR:AUTHORISATION:true` (merchantReference contains `:` and `\` verbatim) | `CZErGCNQaSsxbaQfZaJlakqo7KPP+mIa8a+wx3yNs9A=` | java `src/test/java/com/adyen/util/HMACValidatorTest.java` L64-76 + `src/test/resources/mocks/hmac-validation-webhook.json` |
| V5 (java SDK) | `9064450A8892A093D9E97EFCC9639DE31B74F3A7803135555A3C96F5A57915D6` | `test_REPORT_AVAILABLE::Magento2Rik:testMerchantRef1:0:EUR:REPORT_AVAILABLE:true` | `NuEkADFmlCC6VgX+wcoPAegIWxVPNBPCuKlM4Hzo5qc=` | java HMACValidatorTest.java L36-62 |

## 6. Idempotency

| Fact | Value | Source |
|---|---|---|
| Header | `Idempotency-Key` (case-insensitive), max 64 chars, UUIDv4 recommended; POST only | OA L16919 `components.parameters.Idempotency-Key`; `https://docs.adyen.com/development-resources/api-idempotency.md` L27-37, L417 |
| Supported on | `/sessions`, `/paymentLinks`, refunds, cancels, … (each POST path references the parameter) | OA `paths./sessions.post.parameters`, `paths./paymentLinks.post.parameters` |
| Scope / lifetime | per company account; valid 7-14 days; not checked across regions | api-idempotency.md L411-413 |
| Replay | same key → original response returned | api-idempotency.md L33 |
| In-flight duplicate | HTTP 422 **or** 409, error code 704; retry only when response header `transient-error: true`; 503 + 703 = idempotency store down | api-idempotency.md L425-440 |

## 7. Refund / cancel (brief)

| Item | Value | Source |
|---|---|---|
| Refund | `POST /v72/payments/{paymentPspReference}/refunds`, required `amount, merchantAccount`; optional `reference` (max 80) → 201 `status: "received"` always; outcome via `REFUND` / `REFUND_FAILED` webhook | OA L2463, L12062, L12118; `https://docs.adyen.com/online-payments/refund.md` L30-33, L651 |
| Cancel | `POST /v72/payments/{paymentPspReference}/cancels` (uncaptured only), required `merchantAccount` → `received`; outcome `CANCELLATION` webhook | OA L2163; `https://docs.adyen.com/online-payments/cancel.md` |
| Reversal | `POST /v72/payments/{paymentPspReference}/reversals` "Refund or cancel a payment" | OA L2607 |
| FPX | refunds and partial refunds supported | fpx…malaysia.md L27 |
| Refund timing | up to 40 business days to reach shopper | refund.md L23 |

## 8. Retries (merchant → Adyen)

Use exponential backoff; retry with the SAME idempotency key only on timeout or `transient-error: true`
(api-idempotency.md L423-431). Shopper-side: Hosted Checkout returns the shopper to the page to retry a failed
redirect payment (HC L1222-1228).

## 9. Contradictions and traps found in official material (most valuable)

| # | Finding | Sources |
|---|---|---|
| C1 | Docs' **header-HMAC** example (`recurring.token.disabled`, key `6D5BADA5…AEEA`, expected `nvsZjQiHBuscSdtcA2cl1E+PSLJfgjPeRdd0pSaRiA0=`) does **NOT reproduce**: the quoted payload gives `Qq3rWC8MOdd8c0gqVsTV5VBOZt7H+o+TnSivFQfx9m0=` (also tried pretty-printed, trailing newline, ASCII key — none match). Do not use it as a vector. The Standard-webhook example V1 on the same page does reproduce. | HMAC L321-330 |
| C2 | Node SDK test "should validate Banking webhook correctly" ends with `expect(isValid).toBeTruthy;` (no call) — it asserts nothing. The vector itself (`UVBzHbDayhfT1XgaRGAkuKvxwoxrLoVCBdfi3WZU8lI=` over the raw bytes of `src/__mocks__/notification/accountHolderCreated.json`, key `11223344D785…B2EB`) was checked independently and IS correct. | NODE `src/__tests__/hmacValidator.spec.ts` L138-145 |
| C3 | No escaping in the Standard webhook string (V4: `\:/\/` kept raw), BUT node `getDataToSign()` silently switches to the legacy HPP format (sorted keys, `\`→`\\`, `:`→`\:`) when every value of the passed object is a string — e.g. a flattened HTTP POST form item would be signed wrongly. | NODE `src/utils/hmacValidator.ts` L81-113; java mock above |
| C4 | Null handling differs per SDK: python does `map(str, dict.get(k, ""))` → a JSON `null` field becomes `"None"`; node `join` turns undefined/null into `""`; php uses `!empty()` (empty→`""`); java uses `String.valueOf(primitive boolean)`. Whether Adyen ever sends `"originalReference": null` is **UNCONFIRMED**. Python `is_valid_hmac_notification` checks only `notificationItems[0]`. | python `Adyen/util.py` L30-31, L63-64; NODE hmacValidator.ts L101; php `src/Adyen/Util/HmacSignature.php` L89-97; java `HMACValidator.java` L187 |
| C5 | PHP SDK deprecated `validateHMAC($hmacKey, $hmacSign, $webhook)` uses `$hmacSign` as the key and compares against `$hmacKey` (names swapped); node `validateBankingHMAC` has the same swap (deprecated). | php HmacSignature.php L19-31; NODE hmacValidator.ts L42-52 |
| C6 | Hosted Checkout guide: "/sessions endpoint on Checkout API **v72** or later" vs OpenAPI `mode` `x-addedInVersion: 69`. | HC L39; OA L7320 |
| C7 | Guide marks `countryCode`, `shopperEmail`, `shopperReference`, `themeId`, `mode` as Required and `reference` min 3 chars; OpenAPI requires only `amount, merchantAccount, reference, returnUrl` and has no min length. `PaymentRequest.reference` has maxLength 80; session/link `reference` none. | HC L314-327; OA L7135; OA `PaymentRequest.properties.reference` |
| C8 | Guide's example `/sessions` response has `"expiresAt": "2023-15-05T19:31:22+01:00"` (month 15 — not valid ISO 8601) and `amount.value` 100 for a request of 1000. | HC L798, L803 |
| C9 | Session status: OpenAPI enum has 6 values (`active` undefined); guide's table lists only completed / paymentPending / expired. Payment-link status enum has `paid`, never described (description and guide list active/expired/completed/paymentPending). | OA L14641-14642, L11680-11681; HC L1109-1115; PBL L991 |
| C10 | FPX page says Pay by Link is supported; the Pay by Link "Supported payment methods" table and the Hosted Checkout list name **MOLPay**, not FPX. That MOLPay entry = `molpay_ebanking_fpx_MY` is **UNCONFIRMED**. | fpx…malaysia.md L67-71; `https://docs.adyen.com/unified-commerce/pay-by-link/supported-payment-methods.md` L73; HC L1266 |
| C11 | Live-endpoints page: "your live URL for the /payments endpoint on Checkout API **v69** is: …/checkout/**v72**/payments". | live-endpoints.md L60 |
| C12 | Basic-auth example `d3NfMTIz…UEFTU1dPUkQK` decodes to the credentials **plus a trailing `\n`** (made with `echo` without `-n`); copying the method reproduces a wrong header. | api-authentication.md #using-basic-authentication |
| C13 | `returnUrl` maxLength 1024 on `/sessions` but 8000 on `/paymentLinks`. | OA L7364, L11381 |
| C14 | Webhooks OpenAPI `eventCode` enum and its `webhooks` path list disagree (e.g. path `/ACH_NOTIFICATION_OF_CHANGE` not in enum; enum `AUTHENTICATION` has no path) — do not validate eventCode against a closed enum. | WH `components.schemas.NotificationRequestItem.properties.eventCode.enum` vs `webhooks` keys |
| C15 | Pay by Link Customer Area page shows only EU-created links; links created in other regions (e.g. APAC) need the direct URL with the link id. | PBL L755 |

## 10. Not confirmed

- Minimum / maximum MYR amount for FPX or cards (none published).
- Whether the Hosted Checkout page offers FPX under "MOLPay" (C10), and whether Malaysian merchants get an APAC live prefix (only "same region" rule is stated).
- Whether `originalReference` is ever sent as JSON `null` (affects python SDK, C4).
- Any API to look up a payment by `merchantReference` (none in Checkout v72).
- `.md` pages carry a `last_modified` front-matter line that may change on each docs rebuild (stable across two fetches 5 s apart on 2026-10-23).
