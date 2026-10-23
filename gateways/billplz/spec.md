# Billplz API contract (V3 Bills, V4 where relevant): extracted from official sources only

Fetched 2026-10-23. Abbreviations used for sources:
- **[API]** = https://support.billplz.com/api (the official API docs; `https://www.billplz.com/api` 302-redirects there). `#anchor` = section id on that page.
- **[G:x]** = https://support.billplz.com/guide/x (the official Billplz Guide).
- **[WOO]** = https://github.com/Billplz/Billplz-for-WooCommerce, commit `374f698f0d4a886ce76112e1a9bd2f895ddacfcf`, file `includes/helpers/billplz_wpconnect.php`.
- **[GO]** = https://github.com/Billplz/billplz-go, commit `5a9ae429a32cdf56f68a180f8a14b0ce36629dba`.

Note: the docs page hides e-mail addresses behind Cloudflare `data-cfemail`. I decoded them locally, and the HMAC test vectors below only reproduce with the decoded values (`tester@test.com`, `api@billplz.com`).

---

## 1. Hosts and authentication

| Fact                                                                                                                                                                                                                                                 | Source                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Production base: `https://www.billplz.com/api/`. Bills use `v3/` (e.g. `https://www.billplz.com/api/v3/bills`)                                                                                                                                       | [API]#section-introduction, #section-v3-bills-create-a-bill                                |
| Sandbox base: `https://www.billplz-sandbox.com/api/`                                                                                                                                                                                                 | [API]#section-sandbox-mode; [WOO] L21 `STAGING_URL`                                        |
| Sandbox and production are **separate accounts with separate credentials**; data never crosses                                                                                                                                                       | [API]#section-sandbox-mode; [G:api-quick-start] "Switch to production"                     |
| Using a sandbox key on the production URL (or the reverse) returns **401**                                                                                                                                                                           | [API]#section-references-errors; [G:api-error-codes] 401                                   |
| Auth = HTTP Basic. **API Secret Key = username, password empty.** curl form `-u <key>:`                                                                                                                                                              | [API]#section-authentication                                                               |
| Exact header: `Authorization: Basic base64("<secret_key>:")`, with a trailing colon. Doc example: key `73eb57f0-7d4e-42b9-a544-aeac6e4b0f81` → `Basic NzNlYjU3ZjAtN2Q0ZS00MmI5LWE1NDQtYWVhYzZlNGIwZjgxOg==`                                          | [API]#section-authentication; [WOO] L40 `'Basic ' . base64_encode($this->api_key . ':')`   |
| HTTPS only. Plain HTTP fails                                                                                                                                                                                                                         | [API]#section-authentication                                                               |
| Request bodies: `application/x-www-form-urlencoded` **or** `application/json`. All responses, errors included, are JSON                                                                                                                              | [API]#section-introduction                                                                 |
| Currency is MYR only. All money is an integer in **cents** (sen)                                                                                                                                                                                     | [API]#section-api-flow                                                                     |
| Cheap auth check: `GET /api/v4/webhook_rank` → `{"rank": 0.0}`                                                                                                                                                                                       | [API]#section-v4-webhook-rank; [G:api-error-codes] 401                                     |
| Versions: V3 has no new features but is maintained indefinitely. V4 is current. **Bills endpoints exist only in V3** (V4 adds Collections, webhook_rank and payment_gateways; there is no `v4/bills`). The official Woo plugin also calls `v3/bills` | [API]#section-versioning, #section-v3, #section-v4 (endpoint list); [WOO] L381, L398, L412 |

## 2. Collections (a bill needs a `collection_id`)

| Fact                                                                                                                                                                                                                                            | Source                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Every Bill belongs to exactly one Collection. Create the Collection first (API or Dashboard > Collections)                                                                                                                                      | [API]#section-api-flow, #section-v3-bills-create-a-bill                                    |
| Lifetime limit: 20,000 Collections per account                                                                                                                                                                                                  | [API]#section-v3-collections                                                               |
| `POST /api/v3/collections`. Required: `title` (string). Optional: `logo` (jpg/jpeg/gif/png), `split_payment[email\|fixed_cut\|variable_cut\|split_header]`. Doc example uses multipart (`-F`)                                                   | [API]#section-v3-collections-create-a-collection                                           |
| Response: `{"id":"inbmmepb","title":...,"logo":{"thumb_url","avatar_url"},"split_payment":{...}}`. `id` is the `collection_id`                                                                                                                  | same                                                                                       |
| `GET /api/v3/collections/{COLLECTION_ID}` adds `status` (`active`/`inactive`)                                                                                                                                                                   | [API]#section-v3-collections-get-a-collection                                              |
| `GET /api/v3/collections?page=N&status=active\|inactive` returns 15 per page and `{"collections":[...],"page":N}`. Keep paging until no results come back                                                                                       | [API]#section-v3-collectons-get-collection-index                                           |
| `POST /api/v3/collections/{id}/activate` and `/deactivate` return `{}`. An already-active or already-inactive collection gets an error message. The HTTP code is **UNCONFIRMED** (the Guide itself says "[Verify: … confirm this returns 422]") | [API]#section-v3-collections-activate-a-collection; [G:api-error-codes] 422                |
| Creating a Bill sets its Collection to active automatically                                                                                                                                                                                     | [API]#section-v3-bills-create-a-bill                                                       |
| V4 equivalents: `POST/GET /api/v4/collections`, required `title`. V4 supports up to 2 split recipients (`split_payments[][…]` + `stack_order`) and has **no custom logo**. A missing collection returns 404 `RecordNotFound`                    | [API]#section-v4-collections-create-a-collection, #section-v4-collections-get-a-collection |

## 3. Create bill: `POST https://www.billplz.com/api/v3/bills`

Source for the whole table: [API]#section-v3-bills-create-a-bill (cross-checked against [G:api-error-codes] 422 and [GO] `models/bill.go`).

| Field                                     | Req?                           | Rule                                                                                                  |
| ----------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `collection_id`                           | required                       | string                                                                                                |
| `email`                                   | required**if `mobile` absent** |                                                                                                       |
| `mobile`                                  | required**if `email` absent**  | country code + number, no spaces or dashes: `+60122345678` or `60122345678`                           |
| `name`                                    | required                       | max **255** chars                                                                                     |
| `amount`                                  | required                       | positive integer, smallest unit (`100` = RM 1.00; `500` = RM 5.00, **not** `5.00`)                    |
| `callback_url`                            | required                       | Billplz POSTs the Bill object here. Callbacks are compulsory                                          |
| `description`                             | required                       | max **200** chars. Shown on the bill                                                                  |
| `due_at`                                  | optional                       | `YYYY-MM-DD`, defaults to today. **Informational only; does not affect payability**                   |
| `redirect_url`                            | optional                       | browser GET with status after payment                                                                 |
| `deliver`                                 | optional                       | boolean, default `false`. Email/SMS delivery. SMS is charged and is skipped if credit is insufficient |
| `reference_1_label` / `reference_2_label` | optional                       | max **20** chars. Defaults `Reference 1` / `Reference 2`                                              |
| `reference_1` / `reference_2`             | optional                       | max **120** chars                                                                                     |
- **Minimum amount: UNCONFIRMED.** The docs only say "positive integer". The one "minimum" in the official sources is the minimum _payout_ of MYR 1.00 ([G:glossary] "Payout"), which is not a bill minimum.
- Bills **expire 30 days after creation** by default. Delete to expire earlier. [API]#section-v3-bills-create-a-bill; [G:api-quick-start] Step 2
- Response (doc example):

  ```json
  {"id":"8X0Iyzaw","collection_id":"inbmmepb","paid":false,"state":"due","amount":200,"paid_amount":0,
   "due_at":"2015-3-9","email":"...","mobile":null,"name":"Sara","url":"https://www.billplz.com/bills/8X0Iyzaw",
   "reference_1_label":"Reference 1","reference_1":null,"reference_2_label":"Reference 2","reference_2":null,
   "redirect_url":null,"callback_url":"http://example.com/webhook/","description":"Maecenas eu placerat ante."}
  ```

  The documented response parameters are only `id` and `url` (the payment page to send the customer to). The rest appears in the examples. [API]#section-v3-bills-create-a-bill
- Missing or invalid params return **422**. [G:api-error-codes] 422
- `name` may come back upper-cased (`"SARA"` in the Get-a-Bill and direct-gateway examples, `"Sara"` in the create example). Don't compare names exactly. [API]#section-v3-bills-get-a-bill vs #section-v3-bills-create-a-bill
- Skipping the bank selection page (optional): set `reference_1_label="Bank Code"` and `reference_1=<bank code>`, then send the customer to `<url>?auto_submit=true`. An invalid or inactive code falls back to the selection page. [API]#section-direct-payment-gateway-bypass-billplz-bill-page

## 4. Get bill: `GET https://www.billplz.com/api/v3/bills/{BILL_ID}`

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Source                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `paid`: boolean, `false` for due bills, `true` for paid ones                                                                                                                                                                                                                                                                                                                                                                                                            | [API]#section-v3-bills-get-a-bill                                                                            |
| `state`: `due` \| `paid` \| `deleted`                                                                                                                                                                                                                                                                                                                                                                                                                                   | same                                                                                                         |
| Other fields as in the create response: `amount`, `paid_amount` (cents), `due_at`, `reference_1/2(_label)`, `url`, `redirect_url`, `callback_url`, `description`                                                                                                                                                                                                                                                                                                        | same; [G:api-quick-start] Step 4 (paid example: `"paid":true,"state":"paid","amount":500,"paid_amount":500`) |
| `paid_at` in GET responses: **UNCONFIRMED.** It appears only as `"paid_at": null` in one example (direct-gateway section) and not in the Get-a-Bill examples. The format is documented only for callback/redirect (`YYYY-MM-DD HH:MM:SS +0800`, see §5). The official [GO] `models/customTime.go` parses `paid_at` with the Go layout `"2006-1-2"`, which suggests a date-only value and conflicts with the callback format. Treat it as nullable and of unknown format | [API]#section-direct-payment-gateway-bypass-billplz-bill-page; [GO] models/bill.go, models/customTime.go     |
| `due_at` examples are **not zero-padded** (`"2015-3-9"`, `"2018-9-27"`) even though the docs say `YYYY-MM-DD`. Never reformat it before signing                                                                                                                                                                                                                                                                                                                         | [API]#section-v3-bills-create-a-bill, #section-payment-completion-x-signature-callback-url                   |
| Transaction details: `GET /api/v3/bills/{BILL_ID}/transactions?page=&status=pending\|completed\|failed` → `{"bill_id","transactions":[{"id","status","completed_at" (ISO 8601, e.g. "2017-02-23T12:49:23.612+08:00"),"payment_channel"}],"page"}`, 15 per page                                                                                                                                                                                                          | [API]#section-v3-transactions-get-transaction-index                                                          |
| Polling is **discouraged**: it is rate-limited and can get the IP blocked. Use signed callbacks/redirects                                                                                                                                                                                                                                                                                                                                                               | [API]#section-v3-bills-get-a-bill; [G:api-quick-start] Step 4                                                |

## 5. X Signature (HMAC-SHA256) on callback and redirect

### 5.1 Algorithm (verified: all three official vectors reproduce)

1. Take **every** received parameter **except `x_signature`**. [API]#x-signature-verification-step-1-…
2. Make one string per pair: **`key + value`**, with no separator. Use the raw value, decoded from form/URL encoding. Booleans are the strings `true`/`false`. Null/empty becomes `""`, so `mobile` alone contributes `mobile`. [API]#x-signature-verification-step-2-…
3. **Sort those concatenated `key+value` strings** ascending, case-insensitive. [API]#x-signature-verification-step-3-sort-in-ascending-order-case-insensitive
   - ⚠ Sort the **concatenated strings, not the keys alone.** The official result orders `paid_amount100 < paid_at2018… < paidtrue` (because `_` 0x5F < `t` 0x74). Sorting by key would put `paid` first, and I measured that this gives a *different* HMAC (`0d7b90c7…` instead of `0fe0a20b…`). The Security section's wording "Sort keys in ascending order" ([API]#section-security-x-signature) is misleading on this point.
   - The official plugin does the same: it builds `k.v` strings, drops `NULL`/`FALSE`/`""` elements, then `sort($a, SORT_REGULAR | SORT_FLAG_CASE)` on the **strings**. [WOO] L336–L341
4. Join with `|`. [API]#x-signature-verification-step-4-…; [WOO] L341 `implode('|', …)`
5. `hex(HMAC_SHA256(key = X Signature key, msg = source))`, lowercase hex. [API] Step 5; [WOO] L352 `hash_hmac('sha256', $signing, $x_signature_key)`
6. Compare to `x_signature` (constant-time compare in the official code). [WOO] L354 `hash_equals`

- Nested params: put the parent key in front of each child, so `billplz[id]=X` becomes `billplzidX`. [API]#section-security-x-signature (nested example); [WOO] `deep_map_pairs` L265–L292
- The X Signature key comes from Dashboard → Settings → Keys & Integration → tick "Enable X Signature Payment Completion" → "Save & Copy X Signature key". **Reset invalidates the old key immediately.** [G:enable-x-signature-key-verification]
- X Signature is on by default for accounts registered from Sep 2018. Older accounts may be on "Basic" (unsigned callback; redirect carries only `billplz[id]`). [API]#basic-vs-x-signature-variants, #section-payment-completion-basic-redirect-url
- If the signature matches, a separate Get-a-Bill call is not needed. [API] Step 6

### 5.2 Callback (server → server)

- `POST {callback_url}`, `Content-Type: application/x-www-form-urlencoded`, flat field names (no `billplz[...]` prefix). [API]#section-payment-completion-x-signature-callback-url; [G:webhooks-and-callbacks] §2
- Field set: `id, collection_id, paid, state, amount, paid_amount, due_at, email, mobile, name, url, paid_at, x_signature`, plus `transaction_id, transaction_status` (pending/completed/failed) **only if "Extra Payment Completion Information" is enabled** (Settings > Keys & Integration > XSignature Payment). When present they **are part of the signed string** (rule: all params except `x_signature`). [API]#section-payment-completion-x-signature-callback-url, #extra-payment-completion-information; [WOO] L308 key list
- `paid_at` format: `YYYY-MM-DD HH:MM:SS +0800` (e.g. `2015-03-09 16:23:59 +0800`). [API] same
- A failed payment still triggers a callback, but the bill stays `due` (`paid=false`). [API] same; [G:webhooks-and-callbacks] "Callback received but `paid` is `false`"
- Your endpoint must answer **HTTP 200 within 20 s**. Otherwise Billplz retries: attempt 2 at +15 s, attempt 3 at +15 min, attempt 4 at +15 min, attempt 5 at +24 h (each plus a random 0–300 s). Then the callback is dropped. Each failure degrades webhook rank by 1 (0.0 best, 10.0 worst; resets daily 17:00 MYT). [API]#bill-callback-retry-schedule-v3-v4, #section-v4-webhook-rank; [G:webhooks-and-callbacks]
- Callback and redirect arrive in **no fixed order**, so processing must be idempotent. [API]#section-api-flow
- `localhost` callback URLs are unreachable from Billplz, including in sandbox. [G:webhooks-and-callbacks] "Testing in sandbox"

**Official TEST VECTOR, callback** ([API]#x-signature-verification-sample-post-body-post-callback-url):
```
key    = S-s7b4yWpp9h7rrkNM1i3Z_g
params = id=zq0tm2wc collection_id=yhx5t1pp paid=true state=paid amount=100 paid_amount=100
         due_at=2018-9-27 email=tester@test.com mobile=(empty) name=TESTER
         url=http://www.billplz-sandbox.com/bills/zq0tm2wc paid_at=2018-09-27 15:15:09 +0800
source = amount100|collection_idyhx5t1pp|due_at2018-9-27|emailtester@test.com|idzq0tm2wc|mobile|nameTESTER|paid_amount100|paid_at2018-09-27 15:15:09 +0800|paidtrue|statepaid|urlhttp://www.billplz-sandbox.com/bills/zq0tm2wc
x_signature = 0fe0a20b8d557eeae570377783d062a3816a9ea80f368860bacfa7ec3ca4d00e   (reproduced locally ✔)
```
(The two "example server side request" bodies on the same page, with signatures `f0ff6c56…` and `b5ca81d0…`, have no key given, so they cannot be used as vectors.)

### 5.3 Redirect (browser)

- `GET {redirect_url}?billplz[id]=…&billplz[paid]=true|false&billplz[paid_at]=<urlencoded>&billplz[x_signature]=…`, plus `billplz[transaction_id]` and `billplz[transaction_status]` if Extra Payment Completion Information is on. [API]#section-payment-completion-x-signature-redirect-url; [WOO] L300 key list
- URL-decode first (`%20`→space, `%2B`→`+`), then sign with the parent key prepended: `billplzid…`, `billplzpaid…`, `billplzpaid_at…`. [API] same
- A redirect is not guaranteed (the browser may close). The callback is the source of truth. [API]#callback-vs-redirect

**Official TEST VECTOR, redirect** ([API]#x-signature-verification-sample-get-request):
```
key    = S-s7b4yWpp9h7rrkNM1i3Z_g
query  = billplz[id]=zq0tm2wc&billplz[paid]=true&billplz[paid_at]=2018-09-27%2015%3A15%3A09%20%2B0800
source = billplzidzq0tm2wc|billplzpaid_at2018-09-27 15:15:09 +0800|billplzpaidtrue
x_signature = 4aab095fe5a39b1d534500988f9a0cb085cd1b6d5bbb55dd4e02ea6fa102b47b   (reproduced ✔; key-only sort gives 5c8f760d… ✘)
```

**Official TEST VECTOR, generic** ([API]#step-2-sign-the-source-string-final-x-signature-value):
```
key    = abc123cde456
source = amount200|callback_urlhttps://example.com/webhook|collection_idinbmmepb|descriptiontesting|emailapi@billplz.com|nameMichael
x_signature = ef5e54a22af0925cba88fab467119742e90262e3646eea1dee3949938daf3a38   (reproduced ✔)
```

(V5 Payment Order callbacks are different: HMAC-**SHA512** over values in a fixed order, no keys and no `|`. Not relevant to bills. [API]#section-payment-completion-payment-order-callback)

## 6. Delete, rate limits, errors, sandbox

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                        | Source                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `DELETE /api/v3/bills/{BILL_ID}` returns `{}`. Only **due** bills can be deleted. Deleting a **paid** bill returns **422**                                                                                                                                                                                                                                                                                                  | [API]#section-v3-bills-delete-a-bill                               |
| ⚠ **A deleted bill reappears if the customer completes payment anyway** (e.g. the payment was already in flight). So a callback with `paid=true` can still arrive after DELETE                                                                                                                                                                                                                                              | same                                                               |
| Intended use: payment time limits (doc example: a 10-minute timer plus a 5-minute grace, then delete if still due)                                                                                                                                                                                                                                                                                                          | same                                                               |
| Rate limit applies to **GET endpoints only**. It is cumulative across all GET endpoints per IP or per account, in a **5-minute window**, at 100 or 10 requests depending on abuse (or `unlimited`). Headers: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (≤300 s). Exceeding it returns **429** with `{"error":{"type":"RateLimit","message":["Too many requests"]}}`. Billplz may block IPs without notice | [API]#section-rate-limit; [G:api-error-codes] 429                  |
| Error codes: 401 bad/missing key or wrong environment · 404 bad ID, or `/v3/` vs `/v4/` mix-up · 422 invalid params or unprocessable · 429 · 500 · 503 maintenance. Apart from 429, the error body "varies by endpoint" (exact 422 shape **UNCONFIRMED**)                                                                                                                                                                   | [API]#section-references-errors; [G:api-error-codes]               |
| Sandbox has a simulated payment page with test bank credentials. Staging-only bank codes include `BP-FKR01` "Billplz Simulator", `TEST0001`–`TEST0004`, `TEST0021`–`23`, `B2B1-TEST0021`–`23` (all rejected in production). Usable with the direct-gateway `reference_1`                                                                                                                                                    | [G:api-quick-start] Step 3; [API]#section-references-codes-staging |
| Sandbox bill URLs use the sandbox host (`https://www.billplz-sandbox.com/bills/<id>`)                                                                                                                                                                                                                                                                                                                                       | [G:api-quick-start] Step 2 response                                |
| Any other functional difference between sandbox and production: **UNCONFIRMED** (docs say the sandbox "mirrors the production server")                                                                                                                                                                                                                                                                                      | [API]#section-sandbox-mode                                         |
| Sandbox rate limits: **UNCONFIRMED** (not documented separately)                                                                                                                                                                                                                                                                                                                                                            | none                                                               |
