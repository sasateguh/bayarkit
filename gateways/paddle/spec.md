# Paddle Billing via raw REST: one-time transactions, webhooks and refunds

Retrieved 2026-10-29. Sources are official only: developer.paddle.com (the `.md` rendering of each page, which the docs
index `llms.txt` points to) and github.com/PaddleHQ/paddle-node-sdk (Apache-2.0, `main` @ `6a01ef4177ea`, 20 Oct 2026),
read as a reference, not used as a dependency.

> ⚠ **The biggest finding: Paddle does not take Malaysian ringgit.** MYR is not in the payment currency list (33 codes,
> §6), not in the `unit_price.currency_code` enum on create, and Paddle pays out only in USD, EUR, GBP, AUD or CAD
> balances. A Malaysian merchant prices in USD (or another listed currency) and every `Expected.currency` must say so.
> Paddle is the merchant of record: it adds or carves out tax per buyer country, so the amount a buyer pays depends on
> `tax_mode` (§2.3).

Nothing in this file has been measured on the sandbox yet. Facts the docs leave open are marked **UNCONFIRMED** and
listed at the end, for the sandbox run.

---

## 1. Auth, hosts, versioning

| Fact | Source |
| --- | --- |
| HTTPS only. Live host `api.paddle.com`, sandbox host `sandbox-api.paddle.com`. Separate accounts, separate keys, separate data. | https://developer.paddle.com/sdks/sandbox.md |
| Bearer auth: `Authorization: Bearer <api key>`. Keys match `^pdl_(live\|sdbx)_apikey_[a-z\d]{26}_[a-zA-Z\d]{22}_[a-zA-Z\d]{3}$`, so the key itself says sandbox (`sdbx_`) or live (`live_`). | https://developer.paddle.com/api-reference/about/authentication.md |
| A sandbox key on the live host (or the reverse) returns `forbidden`. | https://developer.paddle.com/sdks/sandbox.md |
| API keys expire: 90 days by default, at most one year. Events `api_key.expiring` (7 days before) and `api_key.expired` exist. | https://developer.paddle.com/api-reference/about/authentication.md |
| `Paddle-Version` header pins the API version. Current version is **1**. Without the header the account default applies; a version older than the default is refused. | https://developer.paddle.com/api-reference/about/versioning.md |
| Webhooks do not follow the account default: each notification destination has its own `api_version`. | same |
| Requests and responses are JSON; a success carries the entity under `data`. | https://developer.paddle.com/api-reference/transactions/create-transaction.md (Response 201) |
| Client-side tokens (Paddle.js) are prefixed `test_` in sandbox. They are not API keys and never go to the server API. | https://developer.paddle.com/sdks/sandbox.md |

## 2. `POST /transactions` (create)

Permission `transaction.write`.

### 2.1 Fields bayarkit uses

| Field | Contract | Source |
| --- | --- | --- |
| `items[]` | required, 1–100. Either a catalog `price_id`, or a non-catalog `price` object. bayarkit sends one non-catalog price with a non-catalog `product`, so nothing has to exist in the catalog first. | https://developer.paddle.com/api-reference/transactions/create-transaction.md |
| `items[].quantity` | integer. | same |
| `items[].price.unit_price.amount` | **string** holding an integer in the currency's lowest denomination ("10 USD = 1000 (cents)"). | same |
| `items[].price.unit_price.currency_code` | required, ISO 4217 from the enum (no `MYR`). | same |
| `items[].price.tax_mode` | `account_setting` (default) \| `external` (prices exclusive of tax) \| `internal` (prices inclusive of tax) \| `location`. | same |
| `items[].price.description` / `name` | `description` required (2–500, internal, not shown to buyers); `name` (1–150) shown at checkout. | same |
| `items[].price.product.name` | required (1–200). `tax_category` required and must be enabled on the account (`standard`, `digital-goods`, `saas`, …). | same |
| `custom_data` | object or null, "your own structured key-value data", returned on the transaction and in every transaction webhook. Must be valid JSON with at least one key. | create page; https://developer.paddle.com/api-reference/about/custom-data.md |
| `collection_mode` | `automatic` (default, checkout) or `manual` (invoice). bayarkit uses `automatic`. | create page |
| `checkout.url` | optional. An approved domain to build the payment link on, or `null` for the default payment link. | create page |
| `customer_id` / `address_id` | optional. Without them the transaction is created as `draft` and the checkout collects the details. | create page |

There is no idempotency key header anywhere in the API reference; a retried create makes a second transaction.

### 2.2 Response and checkout link

| Fact | Source |
| --- | --- |
| `201` with `data.id` = `txn_` + 26 chars (`^txn_[a-z\d]{26}$`). | create page |
| `data.checkout.url` = the passed URL or the **default payment link**, plus `?_ptxn=<transaction id>`, e.g. `https://aeroedit.com/pay?_ptxn=txn_01h2…`. | create page; https://developer.paddle.com/build/transactions/default-payment-link.md |
| The default payment link **must be set** (Paddle > Checkout > Checkout configuration) before any transaction can be created: error `transaction_default_checkout_url_not_set`. | default-payment-link page; https://developer.paddle.com/errors.md |
| The link's page must load Paddle.js; Paddle.js opens the checkout for the `_ptxn` in the URL by itself. A domain that is not approved fails with `checkout_url_domain_not_approved`. | default-payment-link page; https://developer.paddle.com/build/transactions/pass-transaction-checkout.md |
| Overlay instead of the link: `Paddle.Checkout.open({ transactionId })` on a page that ran `Paddle.Environment.set("sandbox")` (sandbox only) and `Paddle.Initialize({ token })` with a client-side token. | https://developer.paddle.com/build/checkout/build-overlay-checkout.md; https://developer.paddle.com/paddle-js/methods/paddle-checkout-open.md |
| Accounts that have not finished onboarding get `transaction_checkout_not_enabled`. | https://developer.paddle.com/errors.md |

### 2.3 Which amount the buyer pays (merchant of record)

- `details.totals` is "considered the source of truth for totals on a transaction": `subtotal` (unit price × quantity),
  `discount`, `tax`, `total` ("after discount and tax"), `credit`, `balance` ("total due after credits and any
  payments"), `grand_total` ("total due after credits but before any payments"), `fee` and `earnings` (null until
  completed). All strings in the lowest denomination. *(get-transaction page)*
- With `tax_mode: external` (or an account default that is exclusive) Paddle adds tax on top, so `total` depends on the
  buyer's country and the app cannot know it before checkout.
- With `tax_mode: internal` the price includes tax. **Decision for the adapter:** send `tax_mode: "internal"` on the
  non-catalog price, so the amount the app asked for is the amount the buyer is charged, and compare
  `details.totals.grand_total` with `Expected.amount`. How Paddle splits an inclusive price between `subtotal` and
  `tax` is **UNCONFIRMED** (the docs only say that for `internal` lines Paddle removes tax from fixed discounts); only
  `grand_total` is relied on.
- Discounts and credits lower `grand_total`; bayarkit sends neither.

## 3. `GET /transactions/{transaction_id}` (read)

| Status | Meaning (docs) | bayarkit |
| --- | --- | --- |
| `draft` | missing fields; first stage of a checkout | `pending` |
| `ready` | all fields present, not paid | `pending` |
| `billed` | invoice issued (manual collection) | `pending` |
| `paid` | "fully paid, but has not yet been processed internally" | **paid** |
| `completed` | "fully paid and processed" | **paid** |
| `canceled` | canceled | `failed` |
| `past_due` | renewal in dunning / invoice overdue | `failed` |

Sources: create and get pages (status enum), https://developer.paddle.com/webhooks/transactions/transaction-paid.md.

- `payments[]` holds every attempt: `amount`, `status` (`authorized`, `authorized_flagged`, `canceled`, `captured`,
  `error`, `action_required`, `pending_no_action_required`, `unknown`), `error_code`, `captured_at`. A declined card adds
  an `error` attempt and fires `transaction.payment_failed`; for a one-time checkout the transaction status does
  **not** change (only renewals and invoices go `past_due`). *(get page; transaction-payment-failed page)*
- `details.adjusted_totals` = totals after adjustments (refunds, credits), with its own `grand_total`. A refunded
  transaction stays `completed`: only the adjusted totals and the adjustments show the refund. *(get page; create
  adjustment page)*
- `currency_code` is on the transaction and on `details.totals`.

## 4. Webhooks: signature verification

| Fact | Source |
| --- | --- |
| Header `Paddle-Signature: ts=1671552777;h1=eb4d0dc8…`. Split on `;`, then on `=`. | https://developer.paddle.com/webhooks/about/signature-verification.md |
| Signed payload = `ts` + `:` + **raw body**, HMAC-SHA256, hex, keyed with the notification destination's `endpoint_secret_key` (`pdl_ntfset_…`). Any change to the body, even whitespace, breaks it. | same |
| "Signatures contain at least one `h1`"; during secret rotation more than one `h1` may be sent. Accept if any matches. | same |
| Replay: the SDK helpers reject events whose `ts` is more than **five seconds** old. The docs present the check as optional. | same; paddle-node-sdk `src/notifications/helpers/webhooks-validator.ts` (`MAX_VALID_TIME_DIFFERENCE = 5`) |
| Test vector from the SDK test suite: secret `VALID_SECRET`, body `{"data": ["1", "2"]}`, `ts=1698796800` → `h1=a300428748dce5c70e4da19bffd60769591ea969c99dea3105d0ec9612cf43f9` (re-computed here with Node `crypto`). | paddle-node-sdk `src/__tests__/notifications/webhooks-validator.node.test.ts` |
| Each destination has its own secret; one secret per destination. | signature-verification page |
| Envelope: `event_id`, `event_type` (e.g. `transaction.completed`), `occurred_at`, `notification_id`, `data` (the full transaction entity, including `custom_data`, `status`, `details.totals`). | https://developer.paddle.com/webhooks/transactions/transaction-completed.md |
| Respond `200` within five seconds. Sandbox retries 3 times within about two minutes; live up to 60 times over about two days. Deduplicate on `event_id`; order is not guaranteed (`occurred_at`). | https://developer.paddle.com/webhooks/about/respond-to-webhooks.md |
| Transaction events: `created`, `ready`, `updated`, `billed`, `paid`, `completed`, `canceled`, `past_due`, `payment_failed`, `revised`. `transaction.paid` comes before payout totals exist; `transaction.completed` follows. | https://developer.paddle.com/webhooks/transactions/transaction-paid.md |
| Destinations are created and deleted through `POST`/`DELETE /notification-settings` (`type: url`, `destination`, `subscribed_events`, `api_version`, `traffic_source` defaults to `platform`). | https://developer.paddle.com/api-reference/notification-settings/create-notification-setting.md |

## 5. Refunds: `POST /adjustments`

Permission `adjustment.write`.

| Fact | Source |
| --- | --- |
| `action: "refund"`, `transaction_id`, `reason` (required, non-blank). | https://developer.paddle.com/api-reference/adjustments/create-adjustment.md |
| `type: "full"` refunds the transaction's grand total, no `items`. `type: "partial"` (the default) needs `items[]` of `{ item_id: "txnitm_…" (from details.line_items[].id), type: "partial", amount: "<string>" }` or `type: "full"` per item. | same |
| `tax_mode` (partial only): `internal` (default, amounts include tax) or `external` (Paddle adds tax). | same; error `adjustment_tax_mode_not_allowed` |
| Only `completed` transactions can be refunded (`adjustment_transaction_invalid_status_for_refund`). Over-refund is refused (`adjustment_amount_above_remaining_allowed`, `adjustment_total_amount_above_remaining_allowed`). | same; https://developer.paddle.com/errors.md |
| No new adjustment while a refund on the same transaction is pending approval (`adjustment_pending_refund_request`). With no idempotency key, this is the only guard against a double refund. | create adjustment page; errors index |
| Adjustment `status`: `pending_approval`, `approved`, `rejected`, `reversed`. Most live refunds start `pending_approval`; **sandbox approves refunds automatically every ten minutes**. Events `adjustment.created` / `adjustment.updated`. | create adjustment page |
| bayarkit mapping: `pending_approval` → `pending`, `approved` → `succeeded`, `rejected` → `failed`, anything else → `unknown`. | decision for the adapter |

## 6. Currencies and limits

| Fact | Source |
| --- | --- |
| 33 payment currencies: USD, GBP, EUR, ARS, AUD, BRL, CAD, CHF, CLP, CNY, COP, CZK, DKK, HKD, HUF, ILS, INR, JPY, KRW, MXN, NOK, NZD, PEN, PLN, RUB, SEK, SGD, THB, TRY, TWD, UAH, VND, ZAR (the table lists these). **MYR is absent.** | https://developer.paddle.com/concepts/sell/supported-currencies.md |
| Zero-decimal currencies: CLP, JPY, KRW, VND. For them the lowest denomination is the whole unit. | same |
| Minimum charge per currency, e.g. USD 0.70 (70 cents), EUR 0.65, GBP 0.55, SGD 0.90, JPY 100. `GET /currencies` returns the list with decimals and minimums. | same |
| Balance (payout) currencies: USD, EUR, GBP, AUD, CAD. | same |
| Rate limit: 240 requests per minute per IP; over it = `429 too_many_requests`, then that IP waits 60 s (`Retry-After`). | https://developer.paddle.com/api-reference/about/rate-limiting.md |

## 7. Errors

`4xx`/`5xx` with `{ "error": { "type": "request_error" | "api_error", "code", "detail", "documentation_url" } }`. Retry `5xx` with backoff. The adapter quotes `type`, `code` and `detail` only.
*(https://developer.paddle.com/api-reference/about/errors.md)*

## UNCONFIRMED summary (for the sandbox run)

1. How an inclusive (`tax_mode: internal`) non-catalog price splits into `subtotal`/`tax`, and whether `grand_total`
   always equals `unit_price.amount × quantity` whatever the buyer's country.
2. Whether a retried webhook is re-signed with a fresh `ts` (the five-second SDK tolerance only works if it is).
3. Whether `transaction.paid` and `transaction.completed` both arrive for a card checkout, and in which order.
4. The exact adjustment status returned on create in sandbox (`pending_approval` until the ten-minute approval run is
   expected) and whether `details.adjusted_totals.grand_total` drops on create or only on approval.
5. Size limits on `custom_data` (the docs give none).
6. Whether a declined test card leaves the transaction `ready` (expected from the docs) or moves it elsewhere.
