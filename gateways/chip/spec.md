# CHIP Collect (chip-in.asia): API contract from official sources

Retrieved 2026-10-23. Sources, all official:
- **[SPEC]** OpenAPI 3.1 `https://docs.chip-in.asia/openapi/chip-collect.yaml` (4337 lines; `L<n>` = line in that file). The docs call it "the canonical machine-readable source of truth" (https://docs.chip-in.asia/chip-collect/overview/vibe-coding-guide).
- **[DOCS]** Mintlify pages under `https://docs.chip-in.asia/chip-collect/...` (full dump: https://docs.chip-in.asia/llms-full.txt; conventions: https://docs.chip-in.asia/llms.txt).
- **[PHP-SDK]** github.com/CHIPAsia/chip-php-sdk @ `434584e7`
- **[WOO]** github.com/CHIPAsia/chip-for-woocommerce @ `81ac708b` (the production plugin)
- **[NODE]** github.com/CHIPAsia/chip-nodejs-sdk @ `4c2455cd`
- **[SKILL]** github.com/CHIPAsia/skill @ `f2c45e39` (`SKILL.md`). It contradicts the SPEC in places (see §7), so treat it as low trust.
- **[LIVE]** My own unauthenticated read-only probes of `gate.chip-in.asia` on 2026-10-23 (only the 401 shape was observed).

developer.chip-in.asia is a marketing and plugins page that links to docs.chip-in.asia. It has no API reference.

---

## 1. Base URL, auth, test mode, brand_id

| Fact                              | Value                                                                                                                                                    | Source                                                                                                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base URL (only one)               | `https://gate.chip-in.asia/api/v1`                                                                                                                       | SPEC L136-137 `servers`; DOCS /overview/introduction; llms.txt                                                                                                                                     |
| Path style                        | Plural, **trailing slash** (`/purchases/{id}/`)                                                                                                          | llms.txt; DOCS /overview/vibe-coding-guide                                                                                                                                                         |
| Auth header                       | `Authorization: Bearer <secret_key>` on every Collect endpoint                                                                                           | DOCS /overview/authentication §1; SPEC `bearerAuth`                                                                                                                                                |
| Separate sandbox host for Collect | **None.** Test mode uses the **same host with separate test-mode keys**. (A staging host exists only for CHIP _Send_: `staging-api.chip-in.asia`.)       | DOCS /overview/authentication "Test vs live keys": "separate keys for test mode and live mode. Test keys only work against test purchases and never move real money"; llms.txt (Send-only staging) |
| Test flag on objects              | `is_test: boolean`, "created using test API keys or using the merchant portal while in test mode"                                                        | SPEC Purchase `is_test` L2833                                                                                                                                                                      |
| Test/live webhooks                | Separate. Test webhooks don't fire for live purchases, and vice versa                                                                                    | SPEC Webhook L3378                                                                                                                                                                                 |
| brand_id                          | UUID. Required in the `POST /purchases/` body and as a query param on `GET /payment_methods/`. Found in Portal → Developers → Brands                     | SPEC PurchaseBody `required: [client, purchase, brand_id]` (L3898+); DOCS /overview/authentication "Brand ID"                                                                                      |
| Same brand_id for test and live   | Stated only by SKILL ("same Brand ID is used for both test and live", SKILL.md Step 1)                                                                   | **UNCONFIRMED** in docs/spec                                                                                                                                                                       |
| Error body (LIVE)                 | `401 {"__all__":[{"message":"Authorization header missing","code":"authentication_failed"}]}`; bad key gives `"Incorrect secret_key"` with the same code | LIVE probe. The SPEC 400 example (L1266-1272) shows `__all__` as an object rather than an array. DOCS /overview/errors lists code `unauthorized`, which does **not** match live                    |

## 2. Create purchase: `POST /purchases/` → 201 Purchase

Sources: SPEC L139-184 (op), PurchaseBody L3898-4024, PurchaseDetailsBody L4024+, Product L2400; DOCS /api-reference/purchases/create, /overview/quickstart, /overview/callbacks.

**Amount units are minor units (sen).** "`price: 100` is equivalent to `RM 1.00`" (SPEC L145-147; MoneyAmount L1850 is an integer "smallest indivisible units"). WOO sends `round(total*100)` cast to int (class-chip-woocommerce-gateway.php L1822, L1853).

Top-level body fields:

| Field                                        | Req     | Notes                                                                                                                                                                                                                                                                                                                                               | Source                                                                |
| -------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `brand_id`                                   | **yes** | uuid                                                                                                                                                                                                                                                                                                                                                | SPEC PurchaseBody required                                            |
| `client`                                     | yes*    | object `ClientDetails`. Only `email` is required (max 254). `full_name` (max 1000) is "advisable". Optional: `phone`, address, `shipping_*`, `cc`/`bcc` etc. *Use either `client` or `client_id`, not both                                                                                                                                          | SPEC ClientDetails L1529-1545; Purchase.client_id L2845ff             |
| `client_id`                                  | alt     | uuid of a saved Client. Copies its details into `.client`                                                                                                                                                                                                                                                                                           | SPEC Purchase `client_id`                                             |
| `purchase`                                   | **yes** | object `PurchaseDetails` (below)                                                                                                                                                                                                                                                                                                                    | SPEC                                                                  |
| `reference`                                  | no      | string, "Invoice reference" (free-form, e.g. your order id). If omitted, `reference_generated` (e.g. `CH0001`) is used. No maxLength in spec                                                                                                                                                                                                        | SPEC L3941, L2880; DOCS /overview/what-we-offer "Free Form API Field" |
| `success_redirect` / `failure_redirect`      | no      | URL, max 500. Browser redirect. A custom port is allowed                                                                                                                                                                                                                                                                                            | SPEC Purchase L2953-2967; DOCS /overview/callbacks                    |
| `cancel_redirect`                            | no      | Shows a "Return to seller" button. Must not contain `<>'"`. **Does not cancel the purchase**                                                                                                                                                                                                                                                        | SPEC L2961-2967                                                       |
| `success_callback`                           | no      | Server POST of the Purchase JSON on success. **No explicit port allowed** (even `:443` returns `webhooks_callback_port`). http/https only (otherwise `webhooks_callback_scheme`)                                                                                                                                                                    | SPEC L2968-2975; DOCS /overview/callbacks                             |
| (placement)                                  |         | All 4 URL fields must be **top level**. If nested inside `purchase` they are "ignored silently"                                                                                                                                                                                                                                                     | DOCS /overview/callbacks                                              |
| `send_receipt`                               | no      | bool, default false. Sends a receipt email when paid                                                                                                                                                                                                                                                                                                | SPEC L2854                                                            |
| `due`                                        | no      | **Unix timestamp (int seconds)**. Payment is still allowed after `due` (status becomes `overdue`) unless `purchase.due_strict=true`, in which case status becomes `expired`                                                                                                                                                                         | SPEC L2893, PurchaseDetails `due_strict` L3183                        |
| `issued`                                     | no      | date string `YYYY-MM-DD`, display only                                                                                                                                                                                                                                                                                                              | SPEC L2888, Timestamp L3265                                           |
| `payment_method_whitelist`                   | no      | array (minItems 1) of: `fpx, fpx_b2b1, crypto_coin, dnqr, duitnow_qr, maestro, mastercard, mpgs_apple_pay, mpgs_google_pay, razer_atome, razer_grabpay, razer_maybankqr, razer_shopeepay, razer_tng, shopee_pay, visa`. Values must come from `GET /payment_methods/`. A whitelist that leaves no usable method causes a validation error at create | SPEC L2926-2953                                                       |
| `skip_capture`, `force_recurring`            | no      | card hold/preauth and token saving                                                                                                                                                                                                                                                                                                                  | SPEC L2866-2878                                                       |
| `creator_agent` (max 32), `platform`, `tags` | no      | informational                                                                                                                                                                                                                                                                                                                                       | SPEC                                                                  |

`purchase` (PurchaseDetails) fields:

| Field                                                                                                                                                  | Req                 | Notes                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `products`                                                                                                                                             | **yes**, minItems 1 | items `{name (req, ≤256), price (req, int sen, ≥0), quantity (string/number, default 1; responses show `"1.0000"`), discount (int sen), tax_percent (string 0-100), category (≤256), total_price_override}` (SPEC Product L2400-2442)                                                       |
| `currency`                                                                                                                                             | no                  | ISO 4217, ≤3 chars. `GET /payment_methods/` enum is `["MYR"]` only (SPEC L485). The default is not stated. The example response shows `MYR` when currency was omitted, so a MYR default is **inferred, UNCONFIRMED** (SPEC responses.Purchase example L1276-1400, `currency: MYR` at L1353) |
| `total`                                                                                                                                                | read-only           | "Calculated from `products`. You don't need to specify it" (SPEC L3109)                                                                                                                                                                                                                     |
| `total_override`                                                                                                                                       | no                  | Overrides the total (it is the only `*_override` that changes the charged amount). WOO uses it (L1822)                                                                                                                                                                                      |
| `due_strict`                                                                                                                                           | no                  | bool, default false (see `due`)                                                                                                                                                                                                                                                             |
| `language` (ISO 639-1), `timezone`, `notes` (≤10000), `email_message` (≤512), `request_client_details[]`, `metadata` (object), `single_attempt` (bool) | no                  | SPEC L3096-3207                                                                                                                                                                                                                                                                             |

Minimal request (DOCS /overview/quickstart):
```json
{
  "brand_id": "<uuid>",
  "client": { "email": "buyer@example.com" },
  "purchase": { "products": [{ "name": "Test Product", "price": 100 }] },
  "success_redirect": "https://example.com/success",
  "failure_redirect": "https://example.com/failure"
}
```

The response is a full **Purchase** object (201, SPEC L160-161). Key fields: `id` (uuid), `status` (`created`), `checkout_url` (`https://gate.chip-in.asia/p/{id}/`, redirect the payer here), `direct_post_url` (null unless enabled per merchant), `is_test`, `reference`, `reference_generated`, `purchase.total`, `purchase.currency`, `due`, `created_on`/`updated_on` (unix), `status_history[]`, `payment` (null until paid) (SPEC example L1276-1400).

Checkout URL params: `?preferred=fpx&fpx_bank_code=MB2U0227` skips the CHIP page and goes straight to the bank. `?active=fpx` only pre-selects the method (DOCS /overview/direct-post/fpx, /active-payment-method; SPEC checkout_url L3003-3010).

## 3. Get purchase: `GET /purchases/{id}/` → 200 Purchase (404 if not found)

SPEC L185-212. The docs say to use it "to verify purchase status server-side (for example, after a return-URL redirect) rather than trusting client-side data".

| Field                                                                                                         | Meaning / format                                                                                                                                                                                                                           | Source                                                                               |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `status`                                                                                                      | enum below                                                                                                                                                                                                                                 | SPEC PurchaseStatus L3208-3256                                                       |
| `purchase.total`                                                                                              | int sen                                                                                                                                                                                                                                    | SPEC L3109                                                                           |
| `purchase.currency`                                                                                           | ISO 4217                                                                                                                                                                                                                                   | SPEC L3101                                                                           |
| `reference` / `reference_generated`                                                                           | your ref / auto ref                                                                                                                                                                                                                        | SPEC L2880-2885                                                                      |
| `payment`                                                                                                     | `null` while unpaid. Otherwise PaymentDetails: `amount`, `currency`, `net_amount`, **`fee_amount`**, `pending_amount`, `pending_unfreeze_on`, **`paid_on` (Unix timestamp, int seconds)**, `remote_paid_on`, `payment_type`, `is_outgoing` | SPEC PaymentDetails L1904-1952 (`amount = net_amount + fee_amount + pending_amount`) |
| per-attempt fees                                                                                              | `transaction_data.attempts[].fee_amount`, `markup_amount`, `processing_fee` (int sen)                                                                                                                                                      | SPEC Purchase.transaction_data (L2458+340ff)                                         |
| `transaction_data.payment_method`                                                                             | method used (blank if unpaid). `attempts[].error.{code,message}` on failure                                                                                                                                                                | SPEC                                                                                 |
| `status_history[]`                                                                                            | `{status, timestamp(unix), related_object}`                                                                                                                                                                                                | SPEC                                                                                 |
| `is_test`, `refund_availability` (`all/full_only/partial_only/pis_all/pis_partial/none`), `refundable_amount` |                                                                                                                                                                                                                                            | SPEC L2898-2912                                                                      |

**Status values** (SPEC L3208-3256, verbatim meanings condensed):

| status                                | meaning                                                                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `created`                             | created via API/portal                                                                                                      |
| `sent`                                | invoice emailed                                                                                                             |
| `viewed`                              | client viewed payform/invoice                                                                                               |
| `error`                               | failed payment attempt (customer instrument problem, see `transaction_data`). **Not final**: the purchase can still be paid |
| `cancelled`                           | via `POST /purchases/{id}/cancel/`. No longer payable                                                                       |
| `overdue`                             | past `due`, still payable                                                                                                   |
| `expired`                             | past `due` with `due_strict=true`. Not payable                                                                              |
| `blocked`                             | like error, blocked by fraud/security checks                                                                                |
| `hold`                                | funds on hold (`skip_capture`)                                                                                              |
| `released`                            | hold released                                                                                                               |
| `pending_release` / `pending_capture` | release/capture in progress at acquirer                                                                                     |
| `preauthorized`                       | card preauth (total 0) done                                                                                                 |
| `paid`                                | **successfully paid**                                                                                                       |
| `pending_execute`                     | payment (or hold) processing, not final at acquirer                                                                         |
| `pending_charge`                      | recurring charge processing                                                                                                 |
| `cleared` / `settled`                 | post-paid card states (non-card methods stay `paid`)                                                                        |
| `chargeback`                          | chargeback registered                                                                                                       |
| `pending_refund`                      | refund processing                                                                                                           |
| `refunded`                            | refunded fully **or partially**                                                                                             |

"Paid" therefore means `paid`, `cleared` or `settled` (and `refunded`/`chargeback` mean it was paid earlier). There is no `failed` status. The SKILL table lists `failed`, which does not exist in the SPEC enum.

## 4. Callbacks / webhooks and signatures

**Two mechanisms** (DOCS /overview/callbacks; SPEC L101-133):

|             | `success_callback` (per purchase)                                              | Webhook (`POST /webhooks/`, or set up in the portal)                                          |
| ----------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Fires on    | paid (no skip_capture), captured, or paid by recurring token. **Success only** | any subscribed `events[]` or `all_events:true`                                                |
| Payload     | JSON **Purchase** snapshot + `event_type` field                                | related object (Purchase for `purchase.*`, Payment for `payment.*`) + `event_type`            |
| Signing key | **company-wide** key pair, from `GET /public_key/`                             | **per-webhook** key pair, from `Webhook.public_key` (in the create/retrieve webhook response) |
- Event enum (SPEC Event L1669-1807): `purchase.created, purchase.paid, purchase.payment_failure, purchase.refund_failure, purchase.capture_failure, purchase.release_failure, purchase.pending_execute, purchase.pending_charge, purchase.cancelled, purchase.hold, purchase.captured, purchase.pending_capture, purchase.released, purchase.pending_release, purchase.preauthorized, purchase.pending_recurring_token_delete, purchase.recurring_token_deleted, purchase.pending_refund, payment.refunded, payout.pending, payout.failed, payout.success, payment.charged_back, purchase.viewed, purchase.settled, payout.created, payment.chargeback_reversed`. The enum has **no`purchase.expired`** event. Whether anything fires on expiry is **UNCONFIRMED**, so poll `GET` for it.
- The SKILL shows the payload wrapped as `{"event_type", "object": {...}}`. That conflicts with DOCS/SPEC ("pass a JSON-encoded `Purchase` as their payload … will include an `event_type` field") and with WOO, which reads `$payment['id']` and `$payment['status']` at the top level (gateway.php L907-908, L935). **Trust the top-level Purchase.**
- **Delivery**: a delivery counts as successful only on a 2xx response. Failures get up to **8 more attempts** with exponential backoff, and delivery stops 36 h after the trigger. **Duplicates are possible.** Deliveries are sequential per object (DOCS /overview/callbacks "Delivery protocol"; SPEC L119-125).
- Callback/webhook URL rule: no explicit port, http/https only (DOCS /overview/callbacks).

**Signature** (DOCS /overview/webhook-signatures; SPEC L127-133):
- Header **`X-Signature`**: "a base64-encoded RSA PKCS#1 v1.5 signature of the SHA-256 digest of the request body buffer". It is computed over the **raw body bytes as received**, so never re-serialize the parsed JSON.
- `GET /public_key/` (SPEC L895-917) returns **a JSON-encoded string**: the body is `"-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n"` with quotes, "not a bare PEM body and not a `{"key": ...}` object". You must `json_decode` it first. Schema `PublicKey` = PEM RSA public key string (SPEC L2443).
- Steps (DOCS): 1) read the raw body; 2) base64-decode `X-Signature`; 3) verify with RSA PKCS#1 v1.5 + SHA-256 using the right public key; 4) reject on failure.

Official code, quoted:
```php
// chip-php-sdk lib/ChipApi.php L76-84
public static function verify(string $content, string $signature, string $publicKey): bool
{
    return 1 === openssl_verify($content, base64_decode($signature), $publicKey, 'sha256WithRSAEncryption');
}
```
```php
// chip-for-woocommerce includes/class-chip-woocommerce-gateway.php L896-907 (success_callback handler)
if ( isset( $_SERVER['HTTP_X_SIGNATURE'] ) ) {
    $content = file_get_contents( 'php://input' );
    $signature = isset( $_SERVER['HTTP_X_SIGNATURE'] ) ? sanitize_text_field( wp_unslash( $_SERVER['HTTP_X_SIGNATURE'] ) ) : '';
    if ( openssl_verify( $content, base64_decode( $signature ), $this->get_public_key(), 'sha256WithRSAEncryption' ) !== 1 ) { ... wp_die(...) }
    $payment    = json_decode( $content, true );
    $payment_id = array_key_exists( 'id', $payment ) ? sanitize_key( $payment['id'] ) : '';
} elseif ( $payment_id ) {
    $payment = $this->api()->get_payment( $payment_id );   // browser redirect (no X-Signature) → re-fetch via API
}
// get_public_key() L2227-2234:
$this->public_key = str_replace( '\n', "\n", $this->api()->public_key() );  // api()->public_key() = json_decode(body, true) of GET /public_key/ (class-chip-woocommerce-api.php L225-233, L287)
```
```js
// chip-nodejs-sdk src/api/PaymentApi.js L411-416
verify(content, signature, publicKey) {
  const verifier = crypto.createVerify('sha256WithRSAEncryption');
  verifier.update(content)
  return verifier.verify(publicKey, signature);   // signature = Buffer.from(xsig, 'base64'); examples/app.js L92-94 does JSON.parse(GET /public_key/ body)
}
```

- WOO pattern worth copying: it uses the **same URL** for `success_callback` and all three redirects (gateway.php L1804-1815). A POST with `X-Signature` is verified and trusted. A browser GET without a signature causes a re-fetch of `GET /purchases/{id}/`. It also takes a per-order lock (L874) and checks `! $order->is_paid()` before completing (L945), which makes it idempotent against duplicate deliveries.
- **Conflict:** PHP-SDK `PublicKeyResource::get()` reads `$arr['public_key']` (lib/Resource/PublicKeyResource.php L17-20) and its test mocks `{"public_key": "pk_test"}` (tests/ApiTest.php L873). That contradicts DOCS, which say the body is a bare JSON string. WOO and NODE also decode a bare string. Given `strict_types` and a `stdClass|array` return type (lib/Http/GuzzleClient.php L45, L96), the SDK getter probably fails against the real API. **Fetch the key yourself and `json_decode` it.**
- Is the company public key different for test vs live keys? SKILL says separate test/live public keys (SKILL.md Step 1). The docs don't say. **UNCONFIRMED.** Safe approach: fetch `/public_key/` with the same secret key that created the purchase, per mode.
- SKILL says "Return HTTP 200 even when rejecting invalid signatures — CHIP retries on non-200" (SKILL.md Step 4). DOCS only says "Reject the request", and the docs' own examples return 401. Policy choice; not contractual.

## 5. Minimums, idempotency, cancel/refund, rate limits

| Topic                        | Finding                                                                                                                                                                                                                                                                                                                                             | Source                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Minimum amount (per method)  | FPX B2C **RM 1** (100), FPX B2B1 RM 2 (200), DuitNow QR RM 0.15 (15), Atome RM 10 (1000). Methods below their minimum are hidden from `GET /payment_methods/?amount=`                                                                                                                                                                               | DOCS /overview/changelog 2026-07-30; SPEC L455-515 |
| `GET /payment_methods/`      | query `brand_id` (req), `currency` (req, `MYR`), `amount` (sen, "strongly recommended"), `recurring`, `skip_capture`, `preauthorization`, `country`, `language`. Returns `{available_payment_methods:[...], by_country, ...}`. The API key decides the test mode of the lookup                                                                      | SPEC L455-600                                      |
| Idempotency                  | DOCS /overview/errors claims an `Idempotency-Key` header makes write ops idempotent. **It does not appear anywhere in the OpenAPI spec**, and no SDK sends it (PHP-SDK RetryClient retries POSTs on 5xx/429 without a key: lib/Http/RetryClient.php L57-64). **UNCONFIRMED.** Don't rely on it; dedupe on your own `reference` + stored purchase id | DOCS errors; SPEC (absent)                         |
| Cancel                       | `POST /purchases/{id}/cancel/` → 200 Purchase. "If a Purchase is still payable, this request guarantees that it cannot be paid"                                                                                                                                                                                                                     | SPEC L213-229                                      |
| Refund                       | `POST /purchases/{id}/refund/` with optional `{"amount": <sen>}` (partial, ≤ `refundable_amount`). Returns a **Payment** object. It may return a Purchase with `pending_refund`; completion arrives as the `payment.refunded` event. On failure: 400 `purchase_refund_error`                                                                        | SPEC L368-408                                      |
| Others                       | `capture`, `release`, `charge` (recurring), `delete_recurring_token`, `mark_as_paid` (`paid_on` unix), `resend_invoice`                                                                                                                                                                                                                             | SPEC L230-454                                      |
| Rate limits                  | DOCS /overview/errors lists `429 rate_limited` ("Honor any `Retry-After` header if present"). **No numeric limits documented. UNCONFIRMED.** PHP-SDK reads `retry_after` from the 429 body (RetryClient L66-75)                                                                                                                                     | DOCS errors                                        |
| Error-code table reliability | The DOCS /overview/errors codes (`unauthorized`, `invalid_request`, `conflict`…) don't match the LIVE body (`authentication_failed`) or the SPEC (`purchase_refund_error` etc.). Treat that table as indicative only                                                                                                                                | LIVE; SPEC                                         |

## 6. Sandbox / test behaviour

- Same host; test-mode secret key. Test objects have `is_test: true` and never move real money (DOCS authentication; SPEC L2833).
- On the hosted page in test mode you "simulate a successful payment without redirecting to a real bank" (DOCS /overview/quickstart §2). "Dummy payment link will execute fake payment instead of redirect to bank page" (DOCS vibe-coding-guide). So **real FPX bank redirects are not exercised in test mode**.
- Test cards: `4444 3333 2222 1111` (non-3DS) and `5555 5555 5555 4444` (3DS), CVC `123`, any future expiry, any Latin name. A wrong CVC or expiry makes the payment fail (SPEC L76-95; create-op description L157).
- Test and live webhooks are fully separate (SPEC L3378). `GET /payment_methods/` results depend on the key's mode (SPEC L462).
- Whether `success_callback` and webhooks fire for test purchases: the docs imply yes ("Webhook signature verification tested with test deliveries", SKILL go-live checklist) but don't state it explicitly. **UNCONFIRMED**, verify in a test run.

## 7. Known wrong statements in official secondary material (don't copy)

- SKILL.md Step 2 uses `failure_callback` / `cancel_callback`. **These fields don't exist in the SPEC.** The real fields are `failure_redirect` / `cancel_redirect` (and there is only `success_callback`).
- SKILL.md Step 3 says the redirect carries `?id=…&status=paid`: **UNCONFIRMED** in the SPEC/docs. WOO embeds its own `?id=<order>` in the URL instead.
- SKILL status table (`failed`) and payload wrapper (`object`): see §3 and §4.
- PHP-SDK `publicKey->get()` shape: see §4.
