---
name: bayarkit-paypal
description: Integrate PayPal Orders v2 payments (from Malaysia) safely. Use when adding PayPal Orders v2 checkout, callbacks or payment status checks to an app.
---

# PayPal Orders v2

## Use the bayarkit adapter

Install `@bayarkit/core` and `@bayarkit/paypal`. Evidence: **measured on the PayPal Orders v2 sandbox**.

```ts
import { checkoutResponse, confirmPayment, readCallback } from '@bayarkit/core'
import { paypal } from '@bayarkit/paypal'

const gateway = paypal({ clientId, clientSecret, webhookId, currency: 'USD' })
const payment = await gateway.createPayment({ reference, amount /* USD smallest unit */, description, customer, returnUrl, callbackUrl })
return checkoutResponse(payment) // a 303 redirect, or a self-submitting page when the gateway wants a POST form
// Return route: the buyer approved on PayPal, and nothing has moved yet. Capture it (safe to retry)
// with the payment.id you saved at checkout (PayPal appends ?token=<order id>&PayerID=…; do not trust the query).
await gateway.capturePayment(order.paymentId)
// then, in the callback route:
const result = await confirmPayment(gateway, await readCallback(request), { reference, amount, currency: 'USD' })
```

PayPal takes two steps. The buyer approves on PayPal (order `APPROVED`: not paid), then your return route, or a `CHECKOUT.ORDER.APPROVED` webhook, calls `capturePayment(orderId)`. `getPayment` only reads and never captures. Mark the order paid with `confirmPayment` on the `PAYMENT.CAPTURE.COMPLETED` webhook. PayPal has no per-order callback URL: add a webhook to your REST app and pass its id as `webhookId`.

Test without real money: `startFakePayPal` from `@bayarkit/testing`.

The full contract with a source for every fact: `gateways/paypal/spec.md` in the bayarkit repository.

## PayPal Orders v2 traps (each from an official source or a sandbox measurement)

- An order can be `COMPLETED` while its capture is `DECLINED` or `PENDING`, and `APPROVED` only means the buyer agreed. Count a payment as paid only when `purchase_units[0].payments.captures[0].status` is `COMPLETED`, and take the amount from that capture. *(developer.paypal.com/sandbox-testing/card-testing; Orders v2 OpenAPI capture_status)*
- Put your reference in `purchase_units[0].custom_id` (up to 255 characters, hidden from the buyer, copied onto each capture). `invoice_id` is shown to the buyer and must be unique per account by default, so a second order for the same reference is refused. *(Orders v2 OpenAPI purchase_unit_request)*
- MYR works only for a PayPal account based in Malaysia; elsewhere PayPal converts it with a fee. HUF, JPY and TWD take no decimals in PayPal (HUF and TWD do in ISO 4217). A currency the account does not hold leaves the payment pending until the merchant accepts it. *(developer.paypal.com/reference/currency-codes)*
- Verify webhooks by posting the headers, your webhook id and the raw body to `/v1/notifications/verify-webhook-signature` and requiring `verification_status: SUCCESS`. Send the body exactly as received: parsing and re-serialising it can fail verification. Events from the dashboard simulator cannot be verified this way; test with real sandbox events. *(developer.paypal.com/api/rest/webhooks/rest)*
- `PayPal-Request-Id` makes create, capture and refund safe to retry: PayPal keeps it 6 hours on orders and 45 days on refunds. Use a new value per call type (never reuse the create id for capture); without the header a retry captures or refunds again. *(developer.paypal.com/reference/guidelines/idempotency; /api/rest/requests)*
- With `payment_source.paypal.experience_context` the new order is `PAYER_ACTION_REQUIRED` and the buyer link is `rel: payer-action`; the older flow returns `CREATED` with `rel: approve`. An uncaptured order expires: the guide says 3 hours, the API reference 6 hours. *(developer.paypal.com/whats-an-order; Orders v2 OpenAPI order.links)*
- Refunds take the capture id, not the order id: `POST /v2/payments/captures/{id}/refund` with an empty body refunds what is left, with `amount` refunds part. Over-refunding fails with `REFUND_AMOUNT_EXCEEDED`. *(Payments v2 OpenAPI captures.refund)*

## Rules that apply to every gateway

1. Amounts are integers in the currency's smallest unit (cents). Never compare floating-point amounts.
2. Never mark an order paid from the return URL or the callback body alone: verify the signature, ask the gateway again,
   then match reference, amount and currency exactly (`confirmPayment` does all three).
3. Gateways retry callbacks: marking an order paid must be idempotent.
4. Use one reference per payment attempt, so a late callback from an old attempt cannot match a new one.
5. Errors and logs never contain keys or secrets.

## Official sources

- [Orders API integration](https://developer.paypal.com/whats-an-order.md) (fingerprint `926303e76398`, unchanged since 2026-10-29)
- [Orders v2 OpenAPI](https://raw.githubusercontent.com/paypal/paypal-rest-api-specifications/HEAD/openapi/checkout_orders_v2.json) (fingerprint `2fcf75a067d2`, unchanged since 2026-10-29)
- [Payments v2 OpenAPI (captures, refunds)](https://raw.githubusercontent.com/paypal/paypal-rest-api-specifications/HEAD/openapi/payments_payment_v2.json) (fingerprint `a7fe2780d705`, unchanged since 2026-10-29)
- [Integrate webhooks](https://developer.paypal.com/api/rest/webhooks/rest.md) (fingerprint `84188c1d161d`, unchanged since 2026-10-29)
- [Webhooks Management OpenAPI](https://raw.githubusercontent.com/paypal/paypal-rest-api-specifications/HEAD/openapi/notifications_webhooks_v1.json) (fingerprint `fb299f6456a5`, unchanged since 2026-10-29)
- [Authentication](https://developer.paypal.com/api/rest/authentication.md) (fingerprint `9984ba76e943`, unchanged since 2026-10-29)
- [Idempotency](https://developer.paypal.com/reference/guidelines/idempotency.md) (fingerprint `56c6f6706aa6`, unchanged since 2026-10-29)
- [Currency codes](https://developer.paypal.com/reference/currency-codes.md) (fingerprint `516c43f36678`, unchanged since 2026-10-29)
- [Card testing](https://developer.paypal.com/sandbox-testing/card-testing.md) (fingerprint `975f2c3f6bf1`, unchanged since 2026-10-29)

Generated by `node tools/rujukan.mjs skills` from `gateways/registry.json`. Do not edit by hand.
