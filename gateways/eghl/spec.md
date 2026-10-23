# eGHL (GHL Systems → NTT DATA Payment Services "ADAPTIS") — API contract from official PUBLIC material

Researched 23 Oct 2026. Read-only; no repository modified.

## 0. What is public, and what is not

| Fact | Source |
|---|---|
| `https://e-ghl.com` resolves (35.213.146.5) and port 443 opens, but HTTP does not answer (curl timeout, 23 Oct 2026). | measured: `curl -m 15 https://e-ghl.com` → 000 |
| GHL Systems was bought by NTT DATA Japan in 2024 and renamed NTT DATA Payment Services Sdn Bhd on 13 Nov 2024. The gateway is now sold as **ADAPTIS e-Commerce**. | https://www.nttdatapay.com/en/news/global-news/ntt-data-payment-services-unveils-adaptis |
| The current official Malaysian site is **https://my.nttdatapay.com** (the official OpenCart plugin links there). | bitbucket.org/eghl/adaptis-opencart @38c0db3 `ghl.ocmod.zip` → `admin/language/en-gb/payment/ghl.php:10` |
| **The official API specification is NOT public.** No developer portal, OpenAPI file or llms.txt exists on my.nttdatapay.com, www.nttdatapay.com or ghl.com. `my.nttdatapay.com/llms.txt` returns 404. | measured 23 Oct 2026 |
| The official SDK READMEs say the hashing library is a "private repo"; you get access by contacting `support.eghl@ghl.com`. | https://bitbucket.org/eghl/eghl-omnipay/src/0b2981ebb749acd8787803df76b04051095eadad/README.md#lines-8:10 |
| The merchant integration guide (`eGHL_API_v2.8n.docx`, "Merchant Integration Guide") states on every page: "strictly private and confidential … not intended for public circulation". Copies exist on merchants' web servers (for example `smartcable.com.my/admin/assets/api.pdf`, `room-resv.com/.../eGHL_Bank-Direct_API_v2.8.pdf`). **Those copies are NOT used as sources here.** They are mentioned only where they agree or disagree with the public code, and every such mention is labelled NON-PUBLIC. | (third-party hosts; not official) |
| **What is public and official:** the Bitbucket workspace **`eghl`** (display name "eGHL", public). It holds Packagist packages `e-ghl/*` and the current ADAPTIS plugins: WooCommerce 8.2.4 (Jan 2026), Magento 2.1.7 (Jul 2026), OpenCart (Jan 2026), PrestaShop 1.6 (Aug 2026) and WHMCS (Jul 2025). | https://api.bitbucket.org/2.0/repositories/eghl ; https://packagist.org/packages/list.json?vendor=e-ghl |
| GitHub organisations `EGHL-ITD`, `eGHLPushNotifications` and `eGHLRiskEngine` exist but have **zero public repos**. `github.com/afu-it/*` was NOT used. | https://api.github.com/orgs/EGHL-ITD/repos → `[]` |

Everything below comes from that public Bitbucket source code. **A spec sourced from code tells you what the official SDKs DO. It does not tell you what the gateway guarantees.**

Short repo refs used below (commit pinned):
- `HASH` = bitbucket.org/eghl/eghl_hash @562b45e `eGHL_HASH.php`. The file is obfuscated and sits on ONE line, line 2.
- `MAPI` = bitbucket.org/eghl/merchantapi @0577c28
- `OMNI` = bitbucket.org/eghl/eghl-omnipay @0b2981e
- `PV` = bitbucket.org/eghl/paramvalidator @69275d0
- `WOO` = bitbucket.org/eghl/adaptis-woocommerce @27d20ce → zip `adaptis-woocommerce-8.2.4/eghl-payment-gateway-class.php`
- `MAG` = bitbucket.org/eghl/adaptis-magento @faacfb1 → zip `eghl-magento-2.1.7/magento_root/app/code/Eghl/PaymentMethod/…`
- `OC` = bitbucket.org/eghl/adaptis-opencart @38c0db3 → zip `ghl.ocmod/catalog/controller/payment/ghl.php`
- `PS` = bitbucket.org/eghl/adaptis-prestashop-1.6.x @2c2c30b → zip `…/modules/eghl/`
- `WH` = bitbucket.org/eghl/adaptis-whmcs @6108bb8 → zip `…/modules/gateways/callback/eghl.php`

Browse URL pattern: `https://bitbucket.org/eghl/<repo>/src/<commit>/<path>#lines-<a>:<b>`

## 1. Hosts and auth

| Item | Value | Source |
|---|---|---|
| Test (MY) | `https://pay.e-ghl.com/IPGSG/payment.aspx` (the gateway matches the path case-insensitively; `/ipgsg/payment.aspx` also returns 200) | OMNI `src/Message/PurchaseResponse.php#lines-14` ; MAPI `src/core/APIBase.php#lines-81` ; measured 200 |
| Production | `https://securepay.e-ghl.com/IPG/Payment.aspx` | OMNI `PurchaseResponse.php#lines-16` ; MAPI `APIBase.php#lines-84` |
| Test (PH) | `http://test2ph.ghl.com:86/IPGSG/Payment.aspx` (plain HTTP; did not answer 23 Oct 2026) | MAPI `APIBase.php#lines-87` ; MAG `Model/Config/Source/PaymentURL.php:24` |
| One endpoint for everything | Payment, QUERY, REFUND, RSALE (reversal) and CAPTURE all go to the same `payment.aspx`. The request's `TransactionType` field selects the operation. | MAPI `APIBase.php#lines-27:34,55:57,78:89` |
| Credentials | `ServiceID` (3-character merchant code) plus a **Merchant Password**, also called "merchant key" or `hashpass`. The password is never sent; it is only the hash secret. There is no API-key header and no OAuth. | PV `src/PaymentRequest.php#lines-23:27` ; HASH line 2 (`hash('sha256', $password . …)`) ; OMNI `tests/GatewayTest.php#lines-16:17` |
| Public test credentials | `ServiceID=SIT`, password `sit12345` | OMNI `tests/GatewayTest.php#lines-16:17` ; MAPI `tests/QueryTest.php:14` |
| TLS | Production accepts TLS 1.2 only: **UNCONFIRMED** in public material (the claim appears only in the NON-PUBLIC v2.8n guide) | — |

## 2. Create payment (browser redirect: an auto-submitting HTML form POSTs to `payment.aspx`)

| Field | Req | Format / limit | Source |
|---|---|---|---|
| `TransactionType` | Y | `SALE` (or `AUTH`) | WOO `:306` ; PV `PaymentRequest.php#lines-13:17` |
| `PymtMethod` | Y | A3: `ANY`, `CC`, `DD`, `WA`… | WOO `:280` ; PV `#lines-18:22` |
| `ServiceID` | Y | AN3 | PV `#lines-23:27` |
| `PaymentID` | Y | AN **20**. This is the merchant's unique ID for this attempt (see §6). | PV `#lines-28:32` |
| `OrderNumber` | Y | AN **40** (PV). The NON-PUBLIC guide says 20. | PV `#lines-33:37` |
| `PaymentDesc` | Y | AN100 | PV `#lines-38:42` |
| `MerchantReturnURL` | Y | AN255. The **browser** returns here. Replace `&` with `;` in this URL. | PV `#lines-43:47` ; PV `src/core/validatorBase.php#lines-198:216` ; WOO `:288` |
| `Amount` | Y | **Ringgit, a decimal string with exactly 2 places, no comma** (`10.00`). The value is not in sen. | PV `validatorBase.php#lines-159:177` ; WOO `:285` (`sprintf("%.02f")`) ; OMNI `GatewayTest.php#lines-26` |
| `CurrencyCode` | Y | ISO-4217 alpha-3 (`MYR`) | PV `#lines-53:57` ; WOO `:286` |
| `HashValue` | Y | 64 hex characters (see §4) | PV `#lines-58:62` |
| `CustIP` | Y | AN **45** (PV, IPv6-safe). WOO truncates it to **20**. | PV `#lines-63:67` ; WOO `:325-330` |
| `CustName` / `CustEmail` / `CustPhone` | Y | AN50 / AN60 / AN25 | PV `#lines-68:82` |
| `MerchantApprovalURL`, `MerchantUnApprovalURL` | N | AN255. These are browser targets for approved and declined results. | PV `#lines-103:112` |
| `MerchantCallBackURL` | N (the official README says "recommended") | AN255. This is the **server-to-server** callback. | PV `#lines-113:117` ; OMNI `README.md#lines-37` |
| `PageTimeout` | N | numeric, at most 4 digits, **in seconds**. This is the expiry of the payment page. Plugins send 600, 700 or 900. | PV `#lines-123:127` ; OC `:40` ; PS `eghl.php:243,267` ; MAG guide PDF "Timeout (sec) – payment gateway timeout time in seconds" |
| `LanguageCode`, `Param6`, `Param7`, `Token`, `TokenType`, `B4TaxAmt`, `TaxAmt`, Bill*/Ship*, `PromoCode`, `EPPMonth`… | N | `Param6`/`Param7` are free fields of type ANS50 and are echoed back to you | PV `PaymentRequest.php` (whole `$meta`) ; WOO `:304` (Param6 = order id) |
| Response to the create request | There is no API response. The gateway serves an HTML page, and the result arrives later at the return URL and the callback URL. | OMNI `PurchaseResponse.php` (`isRedirect()=true`, method POST) |

## 3. Query payment

| Item | Value | Source |
|---|---|---|
| Call | Server POST (`form_params`) to the same `payment.aspx` with `TransactionType=QUERY`, `PymtMethod`, `ServiceID`, `PaymentID`, `Amount`, `CurrencyCode` and `HashValue`. Every field is required, and the amount and currency **must match the original**. | MAPI `APIBase.php#lines-52:57` ; PV `src/QueryRequest.php#lines-13:47` ; MAPI `README.md#lines-26` ("matches all parameters sent in Query request") |
| Response body | A URL-encoded `key=value&…` string, parsed with `parse_str`. It is not JSON. | MAPI `APIBase.php#lines-92:96` |
| Response integrity | MAPI checks the response's `HashValue` (the 7-field formula in §4). | MAPI `APIBase.php#lines-102:109` |
| Fields returned | `TxnStatus`, `TxnID`, `AuthCode`, `BankRefNo`, `TxnExists`, `Amount`, `CurrencyCode`, `PaymentID`, `TxnMessage`, `HashValue`… (only the fields the SDK reads; there is no public full list) | MAPI `src/Query.php#lines-24:92` |
| Paid time / timestamp field | **UNCONFIRMED.** No public source names a paid-time field or its format. | — |

### `TxnStatus` values (as the official SDK interprets them)

| Value | Meaning | Source |
|---|---|---|
| `0` | success | MAPI `APIBase.php#lines-122` ; OMNI `CompletePurchaseResponse.php#lines-56` |
| `1` | failed. If `TxnMessage == "Buyer cancelled"`, the buyer cancelled. | MAPI `APIBase.php#lines-129` ; OMNI `CompletePurchaseResponse.php#lines-27` |
| `2` | pending. It counts as "pending by bank" when `TxnID` is present and `BankRefNo` or `AuthCode` is non-empty. | MAPI `Query.php#lines-24:36` |
| `9` | reversed | MAPI `Query.php#lines-50` |
| `10` | refunded | MAPI `Query.php#lines-43` |
| `15` | authorised (AUTH, not captured) | MAPI `Query.php#lines-57` |
| `16` | captured | MAPI `Query.php#lines-64` |
| `31` | reversal pending | MAPI `Query.php#lines-71` |
| `-1` | transaction does not exist | MAPI `Query.php#lines-85` |
| `-2` | system error | MAPI `Query.php#lines-92` |
| `TxnExists` | `'0'` **means the transaction EXISTS**. The flag is inverted. | MAPI `Query.php#lines-78` |

## 4. Callback / return and SIGNING

| Item | Value | Source |
|---|---|---|
| Delivery | The gateway sends the same field set twice. (a) The browser is sent to `MerchantReturnURL`. (b) The gateway calls `MerchantCallBackURL` server-to-server. The fields arrive as **form/query parameters**, not JSON. Every official handler reads `$_REQUEST`, so the HTTP method (GET or POST) is **UNCONFIRMED**. | OMNI `README.md#lines-37:38,82` ; WH `:42-58` ; PS `eGHLResponseHandler.php:20-26` |
| Callback acknowledgement | Reply with the plain body **`OK`**. WHMCS replies `Fail` when the payment is not a success. | OMNI `README.md#lines-96` (`die('OK'); //acknowlegment sent back to eGHL`) ; WOO `:482` ; MAG `ResponseHandler.gte_m230.php:908` ; WH `:181,193` |
| Response fields | `TransactionType, PymtMethod, ServiceID, PaymentID, OrderNumber, Amount, CurrencyCode, HashValue, HashValue2, TxnID, IssuingBank, TxnStatus, AuthCode, TxnMessage, TokenType, Token, Param6, Param7, CardHolder, CardNoMask, CardExp, CardType, SettleTAID, TID, EPPMonth, EPP_YN, PromoCode, PromoOriAmt` | OMNI `src/Message/CompletePurchaseRequest.php#lines-50:79` |
| **Algorithm** | `lowercase_hex( SHA-256( MerchantPassword ‖ field1 ‖ field2 ‖ … ) )`. This is plain concatenation with **no separator and no HMAC**. Encoding is UTF-8 bytes and the output is hex. | HASH line 2 (`hash('sha256', $pw . concat(fields))`) |
| Missing optional field | Contributes an empty string. | HASH line 2 (the per-type field map marks each field `true` = required or `false` = optional) |
| **Response HashValue2** (recommended, used by every current plugin) | `Password + TxnID + ServiceID + PaymentID + TxnStatus + Amount + CurrencyCode + AuthCode + OrderNumber + Param6 + Param7` | HASH line 2 (`'HASHVALUE2'` map) ; WH `:76-90` ; PS `eGHLResponseHandler.php:29` |
| Response HashValue (legacy) | `Password + TxnID + ServiceID + PaymentID + TxnStatus + Amount + CurrencyCode + AuthCode` | HASH line 2 (`'HASHVALUE'` map) ; PS `eGHLResponseHandler.php:28` |
| Request hash (SALE) | `Password + ServiceID + PaymentID + MerchantReturnURL + MerchantApprovalURL + MerchantUnApprovalURL + MerchantCallBackURL + Amount + CurrencyCode + CustIP + PageTimeout + CardNo + Token` | HASH line 2 (`'SALE'` map) ; WOO `:311-314` |
| Request hash (QUERY / REFUND / REVERSAL / CAPTURE) | `Password + ServiceID + PaymentID + Amount + CurrencyCode` | HASH line 2 |
| URL values inside the hash | Use the exact string you send, with `&` already replaced by `;`. | WOO `:288-289` (replace, then hash at `:311`) ; OC `:44-47,83-85` |

### Test vector (official, public, verified by recomputation)

From OMNI `tests/GatewayTest.php#lines-16:17,35:50`, `password = sit12345`:

| Field | Value |
|---|---|
| TxnID | `SIT15434756362e18a914ef` |
| ServiceID | `SIT` |
| PaymentID | `15434756362e18a914ef` |
| TxnStatus | `0` |
| Amount | `10.00` |
| CurrencyCode | `MYR` |
| AuthCode | `SIT154` |
| OrderNumber | `OMNI001` |
| Param6 / Param7 | absent → empty |

- HashValue2 input string: `sit12345SIT15434756362e18a914efSIT15434756362e18a914ef010.00MYRSIT154OMNI001`
- HashValue2 expected: `b09dd0905ab5d25be8d0d00d5bc5f556befb9d9a5a88c0eca87b2e504fc9667d`. Recomputed with Python `hashlib.sha256` and it **matches**.
- HashValue (legacy) expected: `ca50fa8361ba6e09937e632af4a4ce5b0a74fa687dbcd9c6c98f8ad61c62bb36`. Same input without `OrderNumber`; it **matches**.

The NON-PUBLIC v2.8n guide gives five more examples (password `abc123`, ServiceID `S22`, PaymentID `PAYTEST123`). All five match the same formulas. For example, the request-hash example `abc123S22PAYTEST123https://www.shop.com/success.asp12.34MYR113.210.6.1509004444333322221111` → `28010d7207bdbd6e8ae3890fdb56c541c552c10b609b978fd69428fbb7a4fbc2`. They corroborate the formulas but cannot be cited as public sources.

## 5. Minimum amount

**UNCONFIRMED.** No official public source states a minimum. PV only checks the format (numeric, two decimal places, no comma), at `validatorBase.php#lines-159:177`.

## 6. Idempotency

| Item | Value | Source |
|---|---|---|
| `PaymentID` | Must be unique for each attempt; `OrderNumber` may repeat across attempts. Every plugin generates a fresh ID per attempt and comments "To avoid duplicate Payment ID". | PS `eghl.php:228-229` ; MAG `Helper/Data.php:71-75` (`time()` + hex, 20 characters) ; WOO `:1025-1031` (fnv164 of microtime) |
| Behaviour when an ID is reused | **UNCONFIRMED** (no public statement). There is no idempotency-key header. | — |
| Duplicate callbacks | Plugins de-duplicate: Magento returns `OK` without reprocessing, and WHMCS uses `checkCbTransID($TxnID)`. | MAG `ResponseHandler.gte_m230.php:720-724` ; WH `:137` |

## 7. Refund / cancel (brief)

| Op | TransactionType | Fields | Source |
|---|---|---|---|
| Refund | `REFUND` | PymtMethod, ServiceID, PaymentID, Amount, CurrencyCode, HashValue | PV `src/RefundRequest.php#lines-13:47` (TransactionType…HashValue) ; PV `validatorBase.php#lines-263:270` |
| Reversal (void) | `RSALE` | same fields | MAPI `APIBase.php#lines-28:29` ; PV `validatorBase.php#lines-254:261` |
| Capture | `CAPTURE` | same fields | PV `validatorBase.php` (`case 'capture'`) |
| Settlement | `SETTLE` | different fields (`SettleAmount`…) | PV `validatorBase.php#lines-271:277` |
| Outcome | The SDK checks the outcome by sending a QUERY afterwards: refunded = `10`, reversed = `9`, reversal pending = `31`. | MAPI `src/Refund.php`, `src/Reversal.php` |
| Partial refund | **UNCONFIRMED** | — |

## 8. Retries

**UNCONFIRMED.** No public source states whether callbacks are retried, how often, or for how long. Plugins handle duplicates (§6), and they all acknowledge with `OK`, which suggests the gateway retries until it receives `OK`. That is an inference, not a documented fact.

## 9. Contradictions between official materials (most valuable)

| # | Contradiction | Sources |
|---|---|---|
| C1 | **HashValue2 field list differs between official plugins.** The `eGHL_HASH` library and WHMCS/PrestaShop use 10 fields (`…OrderNumber+Param6+Param7`). The **Magento 2.1.7 plugin omits Param7**, and the **OpenCart plugin omits both Param6 and Param7**. The three agree only when Param6 and Param7 are empty. If you send `Param7`, Magento's check fails. | HASH line 2 ; MAG `Controller/Index/ResponseHandler.gte_m230.php:623-646` ; OC `:206` ; WH `:76-90` |
| C2 | **Which hash to verify.** `merchant-api` (QUERY/REFUND/…) verifies **`HashValue`** (7 fields). Omnipay and every plugin verify **`HashValue2`**. It is unclear whether QUERY responses carry HashValue2 at all: **UNCONFIRMED**. | MAPI `APIBase.php#lines-102:109` ; OMNI `CompletePurchaseRequest.php#lines-34:36` |
| C3 | **Commas in the response `Amount`.** WHMCS strips `,` *before* hashing. PrestaShop hashes the raw `Amount` and strips commas only afterwards ("remove thousand symbol"). Requests must never contain commas. Whether the gateway ever sends `1,000.00` is **UNCONFIRMED**. | WH `:81` ; PS `eGHLResponseHandler.php:29,45` ; PV `validatorBase.php#lines-161:173` |
| C4 | **Field lengths.** `CustIP` is 45 in PV, but WooCommerce truncates it to 20 (an IPv6 address gets cut, and the hash uses the truncated value). `OrderNumber` is 40 in PV, versus 20 in the NON-PUBLIC guide. `HashValue` is 64 in PV, versus 100 in the guide. | PV `PaymentRequest.php#lines-33:37,58:67` ; WOO `:325-330` |
| C5 | **Hash comparison case.** Woo and Magento compare with `strcasecmp`, while WHMCS and OpenCart use `!=`. The test vectors are lowercase hex. | WOO `:405` ; MAG `:709` ; WH `:92` ; OC `:208` |
| C6 | **Request hash fields in plugins.** Magento and OpenCart hash only `ServiceID, PaymentID, ReturnURL, CallBackURL, Amount, CurrencyCode, CustIP, PageTimeout`, leaving out Approval/UnApproval/CardNo/Token. This is equivalent only because they never send those fields. | MAG `Block/Terminal.php:100-118` ; OC `:47` |
| C7 | **Test URL path case.** The paths are `/ipgsg/payment.aspx` (MAPI, Magento), `/IPGSG/payment.aspx` (Omnipay, WHMCS) and `/IPGSG/Payment.aspx` (OC, PS). All of them answer 200, so this is harmless. | MAPI `APIBase.php#lines-81` ; OMNI `PurchaseResponse.php#lines-14` ; OC `:28` |

## 10. Other traps found in official code

- `eGHL_HASH`: a missing *mandatory* field makes it echo "A mandatory field is missing…" and return `false`. The result is `sha256(password)` alone, a wrong hash produced silently. (HASH line 2)
- WooCommerce rewrites every posted value with `str_replace(':', '=>')` before verifying HashValue2. Any hashed field containing `:` would fail verification. (WOO `:394-398`)
- Omnipay `getTransactionReference()` reads `$data` instead of `$this->data`, so it always returns `false`. Read `TxnID` directly. (OMNI `CompletePurchaseResponse.php#lines-94`)
- `pay.e-ghl.com` is the **test** host. Production is `securepay.e-ghl.com`. (OMNI `PurchaseResponse.php#lines-14:16`)

## Independent review notes (23 Oct 2026)

`HashValue2` = sha256(password + fields) with no separator: a genuine FAILED callback for `INV20`/RM5.00 re-splits into a verifying PAID claim for `INV2`/RM15.00 (`INV20|1|5.00` and `INV2|0|15.00` concatenate alike). `confirmPayment` still refuses because the QUERY answer is hash-checked and eGHL's own, provided QUERY does not echo the requested Amount (the spec says it must match the original: UNCONFIRMED until measured). A weakness of eGHL's scheme, not of the adapter.
