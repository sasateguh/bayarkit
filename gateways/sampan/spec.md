# Sampan Pay via raw REST: USD invoices paid in Bitcoin Cash, Standard Webhooks

Retrieved 2026-11-16. Sources are official only: the Sampan Pay button script
[`pay.js`](https://sampan.sasateguh.com/pay.js), served by Sampan itself, and the live API at
`https://sampan.sasateguh.com`, read through `@bayarkit/sampan` and `curl`. The site's pages are drawn by JavaScript,
so the source check reads `pay.js`; the request fields below come from the live API's own validation answers.

Sampan Pay has no accounts and no API key. An invoice names the merchant by a token-aware Bitcoin Cash address; the
buyer pays BCH to a fresh address per invoice, Sampan converts what arrives to PUSD (a USD stablecoin on Bitcoin Cash)
and sends it to the merchant's address. Sampan holds no funds, so there are no refunds through the API. There is no
sandbox: the API runs on mainnet only.

## Measured on the live API (16 November 2026)

Two unpaid USD 0.20 invoices (one through the adapter, one with `curl`) and the error answers below. Nothing was paid
and no webhook was received, so the adapter's evidence stays `docs`.

| Fact | Result |
| --- | --- |
| `POST /api/pay/invoice` with `usd` as a string `"0.20"` | 200; accepted (the schema coerces a numeric string) |
| `POST /api/pay/invoice` with `usd` as the number `0.2` | 200 `{id, address, bip21, qrSvgUrl, statusUrl, usd, requiredSats, expiresAt}` |
| `id` | 32 lowercase hex digits |
| `usd` in the answer | two-decimal string, `"0.20"` |
| `requiredSats` | decimal string, `"99181"` for USD 0.20 that day; the `bip21` amount in BCH matches |
| `expiresAt` | ISO 8601, 30 minutes after the request |
| `statusUrl` | `https://sampan.sasateguh.com/pay/i/<id>` |
| `webhookSecret` in the answer | absent when the request sent one |
| `GET /api/pay/invoice/:id`, new invoice | 200 `{id, status: "open", usd, address, bip21, requiredSats, paidSats: "0", expiresAt, createdAt, orderId, returnUrl, payments: [], convert: [], webhook}` |
| `orderId`, `returnUrl` not sent | `null` |
| `webhook` | `{state: "pending", attempts: 0}` with a webhook URL, `{state: "none", attempts: 0}` without |
| merchant address in the GET answer | absent |
| `usd` 0.10 (number or string) | 400 `{error: "below_min", message: "an invoice is at least 0.2 USD"}` |
| `usd` 251 | 400 `above_max`, "an invoice is at most 250 USD" |
| `usd` 0.205 | 400 `bad_request`, "usd must have at most 2 decimals" |
| `usd` `"abc"`, a missing field, an extra field | 400 `{statusCode: 400, code: "FST_ERR_VALIDATION", error: "Bad Request", message}` |
| plain (not token-aware) merchant address | 400 `bad_request` |
| `webhookUrl` over HTTP, or to 127.0.0.1 | 400 `bad_request` |
| `webhookSecret` `whsec_abc` | 400 `bad_request`, "whsec_ followed by base64 of at least 24 bytes" |
| unknown id | 404 `{error: "not_found", message: "unknown invoice"}` |
| id that is not 32 hex digits | 400 `FST_ERR_VALIDATION` |
| `OPTIONS /api/pay/invoice` | 204 (CORS preflight for the button script) |

## Request

`POST /api/pay/invoice`, JSON, no other fields allowed:

| Field | Type | Notes |
| --- | --- | --- |
| `usd` | number | USD 0.20 to 250, at most two decimals; `pay.js` sends `Number(...)` |
| `merchantAddress` | string | token-aware cashaddr (`z...` or `r...`), where the PUSD goes |
| `webhookUrl` | string | HTTPS, not a private, loopback or reserved address |
| `webhookSecret` | string | `whsec_` + base64 of at least 24 bytes; needs `webhookUrl`; generated and answered once when absent |
| `orderId` | string | 1 to 64 of `A-Z a-z 0-9 . _ : -` |
| `returnUrl` | string | HTTPS |

The adapter sends `usd` as a number made from integer cents, `reference` as `orderId`, `callbackUrl` as `webhookUrl`,
and its configured secret with every invoice. Not sent, because there is no field: `description`, `customer`,
`expiresAt`, an idempotency key (a retried create makes a second invoice).

## Status

`open`, `paid`, `underpaid`, `overpaid`, `expired`, `paid_late`. Only `open` was measured; the rest comes from Sampan's
design notes (not public) and is mirrored by the fake:

- Every payment seen at the address counts at once, summed, before any conversion. `paid` within the tolerance
  (Sampan's config: 50 bps under, 100 bps over), `underpaid` below, `overpaid` above.
- `paid_late` when the first payment is seen after `expiresAt`, whatever its size.
- `expired` when nothing was paid by `expiresAt`.
- `convert` lists one `{txid, pusd}` per payment Sampan has turned into PUSD.

The adapter maps `paid` and `overpaid` to paid only when every payment has a conversion; `paid_late` also needs
`paidSats` at least `requiredSats`. `open` and `underpaid` are pending, `expired` is expired. `confirmPayment` is the
only way to "paid".

## Webhooks (not measured yet)

Standard Webhooks: headers `webhook-id`, `webhook-timestamp` (unix seconds), `webhook-signature` (`v1,<base64>`,
space separated), HMAC-SHA256 over `id.timestamp.body` keyed with the base64 after `whsec_`. The body is
`{type, timestamp, data}` with `data` = the GET answer without `webhook`; events `invoice.paid`, `invoice.underpaid`,
`invoice.overpaid`, `invoice.paid_late`. A retry keeps the same `webhook-id`.
