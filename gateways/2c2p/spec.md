# 2C2P: API contract (PGW Payment API v4.x, Redirect / Hosted Payment Page)

Researched 2026-10-23 from official material only. **The docs are public**, with no login. developer.2c2p.com is ReadMe-hosted and offers `llms.txt` plus a `.md` export of every page (append `.md`).

Abbreviations for sources (all fetched 2026-10-23):
- `D:<slug>` = `https://developer.2c2p.com/docs/<slug>.md` (Lnn = line in that .md export)
- `R:<slug>` = `https://developer.2c2p.com/reference/<slug>.md` (OpenAPI 3.0.1 embedded)
- `RC:<slug>` = `https://developer.2c2p.com/recipes/<slug>.md`
- `SK:<file>` = `https://raw.githubusercontent.com/2C2P/agent-skills/HEAD/plugins/2c2p-payments/skills/2c2p-payments/steering/<file>` (official 2C2P GitHub org, MIT, pushed 2026-10-12)
- `WOO:<file>` = official WooCommerce plugin "2026 Build" v8.1.0, downloaded from the link on D:woocommerce: `https://d27uu9vmlo4gwh.cloudfront.net/plugin/code/wordpress-2c2p-build20260612.zip` → `2c2p_woocommerce_new/<file>`
- `GHWOO:<file>` = `https://github.com/2C2P/2c2p-woocommerce` (older v7.0, last pushed 2023-10-31)

Note: a different signing scheme (legacy) applies only to the WooCommerce plugin. See §9.

## 1. Hosts and auth

| Item | Value | Source |
|---|---|---|
| Sandbox base | `https://sandbox-pgw.2c2p.com` | D:sandbox-setup L19 |
| Production base | `https://pgw.2c2p.com` | D:sandbox-setup L19 |
| Hosted payment page (sandbox) | `https://sandbox-pgw-ui.2c2p.com/payment/<ver>/#/token/<urlencoded paymentToken>` | D:api-payment-token (response sample) |
| Auth | No header auth. The request body is `{"payload":"<JWT>"}`, a JWT signed with HS256 using the merchant **Secret Key** ("SHA Key"). The response is also `{"payload":"<JWT>"}`, decoded with the same key | D:sandbox-setup L28-36; D:json-web-tokens-jwt |
| HMAC key bytes | The secret key's hex string used **as-is (ASCII/UTF-8 bytes)**, not hex-decoded. Verified: TV1 and TV2 only verify that way | D:json-web-tokens-jwt L44 + local HMAC check |
| Content-Type | `application/json` (OpenAPI also accepts `text/json`, `application/*+json`) | R:post_payment-4-3-paymenttoken |
| Demo merchants (public) | e.g. `JT01` SGD key `ECC4E54D…F6D9`; **Malaysia `JT07` MYR/458 key `9E936798778E8E21ABA8E7B620EF631E0C957BB1ADA14E4960022307A9726A09`** | D:sandbox L155-159 |
| API version in path | Docs disagree: `4.3` (D:sandbox-setup L68, R:* OpenAPI "PGW Payment API 4.3", SK:*) vs `4.5` (D:api-payment-token L18-21, D:api-payment-inquiry L18-21, D:api-transaction-status-inquiry L18-21). **Both paths answer on sandbox** (probe of an empty payload gave `{"respCode":"9040",…}` for 4.3 and 4.5; 4.9 gave `UnsupportedApiVersion`) | observed 2026-10-23 |
| Unsigned errors | Our probe got a **plain JSON** error `{"respCode":"9040","respDesc":"Invalid Request (9040)"}` with no `payload` JWT. Official docs do not say whether error responses are signed: UNCONFIRMED | observed sandbox probe |
| Test cards (MY) | Visa 4111111111111111 / MC 5555555555554444, CVV 123, OTP 123456; 1-2-3 online banking user 1234 / pw 1234 | D:reference-test-information-my |

## 2. Create payment: Payment Token API

`POST {base}/payment/4.3/paymentToken` (or `/payment/4.5/paymentToken`). Body: `{"payload":"<HS256 JWT of the fields below>"}`. Sources: D:api-payment-token; R:post_payment-4-3-paymenttoken.

| Field | Type | M/O | Notes | Source |
|---|---|---|---|---|
| merchantID | AN 25 | M | | D:api-payment-token-request-parameter |
| invoiceNo | AN 50 | M | **Merchant reference**, must be unique. Max 20 alnum for QR, 12 numerics for Myanmar APM | same, L74 |
| description | C 250 | M | HTML-encode special characters | same |
| amount | D(12,5) | M | **Major units (ringgit), decimal**, e.g. `2500.90000`. **Not sen.** Decimals follow ISO 4217, except IDR uses 0 | same, L137-146 |
| currencyCode | A 3 | M | ISO 4217 alpha (`MYR`). If empty, the merchant's base currency is used | same |
| idempotencyID | C 100 | O | "Unique value… used to recognize subsequent retries of the same request" | same, L97 |
| paymentChannel | string[] | O | e.g. `["CC","IPP","APM","QR"]`. Empty = all channels | same |
| paymentExpiry | C 19 | O | `yyyy-MM-dd HH:mm:ss`. **Default 20 minutes.** Payment completed after expiry is rejected. Timezone: UNCONFIRMED | same, L618-632 |
| frontendReturnUrl | NT | O | Browser redirect after payment. Falls back to the URL in the merchant portal profile | same; D:redirect-api-integrate-with-payment |
| backendReturnUrl | NT | O | Server notification URL. Falls back to the merchant portal profile | same; D:redirect-api-integrate-with-payment L83 |
| request3DS | A1 | O | `Y` (default) / `F` force / `N` disable | same |
| locale, userDefined1-5 (C 150), statementDescriptor (5-20 chars), nonceStr (C 32), uiParams, recurring/IPP fields | | O | | same |

Response (decoded JWT): `paymentToken` (C 255, **valid 30 minutes**), `webPaymentUrl` (redirect the customer here), `respCode` (`0000` = OK, anything else = stop), `respDesc`. Sources: D:api-payment-token-response-parameter; D:redirect-api-integrate-with-payment §3.

## 3. Get / query payment: Payment Inquiry API

`POST {base}/payment/4.3|4.5/paymentInquiry`, body `{"payload": JWT}`. Request: `merchantID` (M) plus **either** `paymentToken` **or** `invoiceNo`; `locale` (O). Source: D:api-payment-inquiry-request-parameter.

Response fields (decoded): `merchantID`, `invoiceNo` (your reference), `amount` D(12,5) (major units), `currencyCode`, **`transactionDateTime` N14 `yyyyMMddHHmmss`** (timezone UNCONFIRMED), `agentCode`, `channelCode`, `approvalCode`, `referenceNo`, `tranRef`, `accountNo` (masked PAN), `paymentID`, `idempotencyID`, `respCode`, `respDesc`, plus others. Source: D:api-payment-inquiry-response-parameter L132.

Status = `respCode` (D:response-code-payment):

| respCode | Meaning |
|---|---|
| 0000 | Successful (paid) |
| 0001 | Transaction is pending |
| 0003 | Transaction is cancelled |
| 0004 | Soft-declined, resubmit after 3DS |
| 2001 | Transaction in progress |
| 2002 | Transaction not found |
| 2003 | Payment / Inquiry failed |
| 4xxx | Issuer/acquirer declines (4005 do not honor, 4051 insufficient funds, …). 4120 = Refunded |
| 5009 / 9020 | Payment expired |
| 5005 / 9015 | Duplicated / existing invoice |
| 9041 | Payment token already used |
| 9042 | Hash value mismatch |

Also available: Transaction Status API `POST /payment/4.5/transactionStatus` (D:api-transaction-status-inquiry L18), used for polling in flow codes 1002 and 1005 (D:response-code-payment-flow).

## 4. Callback / webhook

### 4a. Backend notification (server to server). This is the trusted one.

| Item | Value | Source |
|---|---|---|
| Delivery | HTTPS POST to `backendReturnUrl` (or the portal default), `Content-Type: application/json; charset=utf-8`, body `{"payload":"<JWT>"}` | D:api-payment-response-backend L21-33; D:redirect-api-integrate-with-payment L83 |
| Signing | JWT **HS256**: `base64url(header) + "." + base64url(payload)`, HMAC-SHA256 with the merchant Secret Key (ASCII bytes), base64url signature without padding. All fields are covered, because the whole JSON is the JWT payload | D:json-web-tokens-jwt; D:api-payment-response-backend |
| Fields | Same set as the inquiry response (merchantID, invoiceNo, amount, currencyCode, transactionDateTime `yyyyMMddHHmmss`, tranRef, referenceNo, approvalCode, eci, respCode, respDesc, paymentID, idempotencyID…) | D:api-payment-response-back-end-parameter L141 |
| Merchant reply expected | UNCONFIRMED in the dev docs. The official skill says "Return HTTP 200 to acknowledge receipt" | SK:redirect-integration.md L183 |
| Retries / schedule | UNCONFIRMED. The docs only say 2C2P "will occasionally send backend responses". The skill says "Handle duplicate notifications (idempotency)" | D:api-payment-response-backend L21; SK:redirect-integration.md L186 |
| No backend URL | The merchant **must** call Payment Inquiry instead | D:redirect-api-integrate-with-payment L129 |

### 4b. Frontend redirect. **Unsigned. Never trust it.**

The customer's browser POSTs `application/x-www-form-urlencoded` with `paymentResponse=<base64 JSON>` to `frontendReturnUrl`. The JSON is `{invoiceNo, channelCode, respCode, respDesc}`, where `respCode` is a *flow* code (`2000` = "completed, do payment inquiry"). There is no signature, only base64 (D:api-payment-response-frontend L21-29; D:api-payment-response-front-end-parameter; D:response-code-payment-flow).

### 4c. Test vectors (verified locally with HMAC-SHA256, 2026-10-23)

| # | Key (ASCII) | Token | Result | Source |
|---|---|---|---|---|
| TV1 (request) | `1F4EDB965BBB3094F791A83750FBDCDA3852131CB5218E21E4F42929A1975E60` | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJtZXJjaGFudElEIjoiSlQwMSIsImludm9pY2VObyI6IjE1MjM5NTM2NjEiLCJkZXNjcmlwdGlvbiI6Iml0ZW0gMSIsImFtb3VudCI6MTAwMCwiY3VycmVuY3lDb2RlIjoiU0dEIn0.ElmhOULUdK63FnriSs2XyhH1LxULoTVIopTUuQ77DvA` | **verifies**. Header `{"alg":"HS256","typ":"JWT"}`, payload `{"merchantID":"JT01","invoiceNo":"1523953661","description":"item 1","amount":1000,"currencyCode":"SGD"}` (compact, `amount` serialised as `1000`, not `1000.00`) | D:json-web-tokens-jwt L44-47 | <!-- gitleaks:allow (demo token JT01 from 2C2P's public JWT guide) -->
| TV2 (response) | JT01 `ECC4E54DBA738857B84A7EBC6B5DC7187B8DA68750E88AB53AAA41F548D6F2D9` | C# sample `…0YQthKwZEjR9giHWc3mkce9ngQnCNi0asXFWPHP_81k` | **verifies** | RC:process-response-payload-with-jwt L18 |
| TV3 (response) | JT04 `CD229682D3297390B9F66FF4020B758F4A5E625AF4992E5D75D311D6458B38E2` | `…Tq0GW7rQeA9jqjobPXAiDmscQ82qtAAUrcUaVYqTAhw` (payment-token response) | **verifies with JT04 only, not with JT01** | D:api-payment-token; RC:process-response-payload-with-jwt L78/L91 |
| (none) | any published key | backend sample `…QdjSI_dUbiRularwEIFuYROE_svc3Xkm-t58X-VnPxI` | **verifies with no published key**, so it is not usable as a vector | D:api-payment-response-backend L31 |
| (none) | any published key | inquiry request sample `…r8EEFRXlNcLi566BrzroOh6qbjGSyWqJ9ZARSR5XwQ4` | verifies with no published key | D:api-payment-inquiry |

## 5. Minimum amount

UNCONFIRMED. No documented minimum. The official plugin only rejects `amount <= 0` and lengths over 12 characters (WOO:Includes/wc-2c2p-validation-helper.php L30-37). Error 9009 "Amount is invalid" exists (D:response-code-payment).

## 6. Idempotency

- `idempotencyID` (C 100, optional) on the token request is meant to recognise retries. It is echoed in the inquiry and backend responses (D:api-payment-token-request-parameter L97; D:api-payment-inquiry-response-parameter).
- `invoiceNo` must be unique: 9015 "Existing Invoice Number" / 5005 "Duplicated Invoice". A token can be used once: 9041 (D:response-code-payment).
- Behaviour when the same idempotencyID arrives with a different body: UNCONFIRMED for the Payment API. The Maintenance API has "Same Idempotent Key exists with different Type/status Pending" result codes (D:response-code-payment-maintenance-result-code L421-431).

## 7. Refund / void (brief)

Refund and void use a **separate API with different crypto**: `POST https://demo2.2c2p.com/PaymentAction/2.0/action` (sandbox) or `https://t.2c2p.com/PaymentAction/2.0/action` (production). The payload is XML `<PaymentProcessRequest>` with `processType` `R` (refund), `V` (void) or `I` (inquiry), plus `invoiceNo` and `actionAmount`. It is encrypted as **JWE RSA-OAEP + A256GCM, signed JWS PS256** with exchanged keys. **Refund only works on settled transactions.** Status codes: `A`, `S`, `RP`, `RF`, `V`, `VP`, `EX`… (D:payment-maintenance-refund-guide L19-31, L54-61; D:payment-maintenance-void-guide L8-22; D:response-code-payment-maintenance-status-code). Partial refunds up to the settled amount, and an async `notifyURL` (`notifyResponse={encrypted_jwt}`), are described by SK:payment-maintenance.md L41-95.

## 8. Retries

- Backend notification retry policy: UNCONFIRMED (see §4a).
- Client-side guidance: flow codes `1002`/`1005` mean "loop query" Transaction Status. `0001` pending means wait or poll (D:response-code-payment-flow).

## 9. Contradictions between official materials (most valuable)

| # | Contradiction | Sources |
|---|---|---|
| C1 | **The official WooCommerce plugin does not use the documented v4 JWT API.** The 2026 build v8.1.0 posts an HTML form to legacy `https://demo2.2c2p.com/2C2PFrontEnd/RedirectV3/payment` (test) or `https://t.2c2p.com/RedirectV3/payment` (live) with `version` 8.5. It signs with `hash_value = hex(HMAC-SHA256(secret, concat(version, merchant_id, payment_description, order_id, invoice_no, currency, amount, …)))` and verifies callbacks read from `$_REQUEST` the same way (case-insensitive hex). Success is `payment_status=="000"`, pending is `"001"` | WOO:2c2p.php L179-191, L470-502, L553; WOO:Includes/wc-2c2p-constant.php L4; WOO:Includes/wc-2c2p-hash-helper.php L15-87, L204 |
| C2 | Amount units: docs say decimal major units (`2500.90000`). The plugin sends **12-digit zero-padded minor units** (sen): `amount × 10^exponent`, `str_pad(…,12,'0')`, and MYR exponent 2 | D:api-payment-token-request-parameter L146 vs WOO:Includes/wc-2c2p-validation-helper.php L59-89, WOO:Includes/wc-2c2p-request-helper.php L96, WOO:Includes/wc-2c2p-constant.php (MYR exponent 2) |
| C3 | Refund crypto: docs say JWE/JWS PS256, XML `version` 4.6, `/PaymentAction/2.0/action`. The plugin uses `PaymentActionV2/PaymentProcess.aspx`, `version` 3.4, and `hashValue = UPPER(hex(HMAC-SHA1(secret, version.merchant_id.process_type.invoice_no[.action_amount])))`. The refund guide's own response sample switches between `version` 4.6 and 4.3 | D:payment-maintenance-refund-guide L19-22, L56, L102, L137 vs WOO:Includes/wc-2c2p-refund-helper.php L145-173; WOO:Includes/wc-2c2p-hash-helper.php L221-232 |
| C4 | API version in path: 4.3 (sandbox-setup, OpenAPI, agent-skills) vs 4.5 (Payment Token, Payment Inquiry and Transaction Status pages). The sample `webPaymentUrl` inside JWTs says 4.1 | §1 |
| C5 | Official recipe "Process response payload with JWT" verifies `…Tq0GW7rQ…` with the JT01 key, but that token is signed with the **JT04** key, so the PHP sample as written fails. Recipe "Prepare request payload" signs with JT01 `ECC4E54…` but shows the output of key `1F4EDB…` | RC:process-response-payload-with-jwt L78-91; RC:prepare-request-payload-with-jwt L26, L152 |
| C6 | Backend notification sample: the JWT payload has `"cardNo"` while the decoded sample shows `"accountNo"`. `amount` is the string `"230.87"` while the spec says D(12,5) (inquiry sample uses the number `1000.00`) | D:api-payment-response-backend L31-39; D:api-payment-response-back-end-parameter |
| C7 | Inquiry sample: the "request data" is `{merchantID JT01, invoiceNo 254b77aabc, locale}`, but the JWT beside it encodes `{paymentToken, invoiceNo, locale}` with **no merchantID** (merchantID is Mandatory per the parameter table). The response sample `transactionDateTime` is `"311220235959"` (12 digits) vs the spec `yyyyMMddHHmmss` (14) | D:api-payment-inquiry L44-50, L84; D:api-payment-inquiry-request-parameter; D:api-payment-inquiry-response-parameter L132 |
| C8 | Frontend sample: the base64 decodes to invoiceNo `080223152322`, but the shown JSON says `280520075921`. The page header says "Server-to-Server… encrypted using JWT", but the body is unsigned base64 form data | D:api-payment-response-frontend L9-29 |
| C9 | The agent-skills response codes are **invented or inconsistent** with the dev docs. Skills: 2001 "Invalid merchant ID", 2014 "Duplicate invoice", frontend 2001 "pending", 2002 "rejected". Docs: 2001 = in progress, 2002 = not found, duplicate = 5005/9015, and only `2000` is a frontend flow code. Skills also say the amount has "2 places" (docs D 12,5), read the frontend result from query params (docs: form POST), name endpoints `/transactionStatusInquiry` and `/paymentMaintenance` (OpenAPI: `/transactionstatus`, none for maintenance), and give the maintenance sandbox as `…/2C2PFrontend/PaymentAction/2.0/action` with version 4.3 | SK:redirect-integration.md L49, L104-107, L204-210; SK:references.md L21-37, L448-454; SK:payment-maintenance.md L19, L51 vs D:response-code-payment, D:response-code-payment-flow |
| C10 | Token lifetime: `paymentToken` is "valid for 30 minutes", but the `paymentExpiry` default is 20 minutes. They may be different clocks; the interaction is UNCONFIRMED | D:api-payment-token-response-parameter vs D:api-payment-token-request-parameter L632 |

## 10. Unconfirmed (official material silent)

Minimum amount. Backend-notification retry count and schedule. Expected merchant HTTP reply. Timezone of `transactionDateTime` and `paymentExpiry`. Whether error responses are JWT-signed. Notification source IPs. Webhook replay or timestamp protection (the JWT has no `iat`/`exp` in the samples).
