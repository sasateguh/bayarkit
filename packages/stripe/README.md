# @bayarkit/stripe

Stripe (Malaysia): card + FPX for [bayarkit](https://github.com/sasateguh/bayarkit): one interface for Malaysian payment gateways, and a checked way to confirm a
payment. [Bahasa Melayu](#bahasa-melayu)

**Evidence:** Official docs (Checkout Sessions, API `2026-09-30.endive`) and stripe-node's webhook check; not yet measured in test mode.

```bash
npm install @bayarkit/core @bayarkit/stripe
```

```ts
import { checkoutResponse, confirmPayment, readCallback } from '@bayarkit/core'
import { stripe } from '@bayarkit/stripe'

const gateway = stripe({ secretKey, webhookSecret })

// Checkout: one reference per attempt; amounts are integer sen (RM10.50 = 1050).
const payment = await gateway.createPayment({ reference, amount, description, customer, returnUrl, callbackUrl })
return checkoutResponse(payment) // a 303 redirect, or a self-submitting form when the gateway wants a POST

// Callback route: never mark an order paid from the callback body or the return URL alone.
const result = await confirmPayment(gateway, await readCallback(request), { reference, amount })
if (result.ok) {
  // mark the order paid (idempotently: gateways retry callbacks)
}
```

Test without real money: `startFakeStripe` from `@bayarkit/testing` answers like this gateway (signed callbacks
included), and `npx bayarkit-fake stripe` runs it as a server for tests in other languages.

## Traps

- API version `2026-09-30.endive` rejects `payment_method_types` on Checkout Sessions with HTTP 400. Use `allowed_payment_method_types[]` (or Dashboard payment methods), and always send a `Stripe-Version` header. (docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions)
- Minimum charge in MYR is RM2.00 (200 sen); FPX needs a Malaysian Stripe account with a business registration number, MYR, one-time payments only. (docs.stripe.com minimum charge amounts; FPX docs)
- Webhook signatures cover `${t}.${rawBody}` with the full `whsec_…` secret; several `v1` values can appear during secret rotation. Without the raw body, verification is impossible. (docs.stripe.com/webhooks/signature; stripe-node webhooks.js)

The full contract, with a source for every fact: [gateways/stripe/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/stripe/spec.md).

## Bahasa Melayu

Stripe (Malaysia): kad + FPX untuk [bayarkit](https://github.com/sasateguh/bayarkit): satu antara muka untuk gateway pembayaran Malaysia, dan cara bersemak untuk
mengesahkan bayaran.

**Bukti:** Dokumen rasmi (Checkout Sessions, API `2026-09-30.endive`) dan semakan webhook stripe-node; belum diukur dalam mod ujian.

```bash
npm install @bayarkit/core @bayarkit/stripe
```

Contoh kod di atas sama untuk semua gateway: hanya adapter dan kuncinya yang berubah. Jumlah ialah sen integer
(RM10.50 = 1050). Jangan tanda pesanan dibayar daripada badan callback atau pautan kembali semata-mata;
`confirmPayment` menyemak tandatangan, bertanya gateway semula, dan memadankan rujukan, jumlah dan mata wang.

Uji tanpa wang sebenar: `startFakeStripe` daripada `@bayarkit/testing`, atau `npx bayarkit-fake stripe` sebagai
pelayan. Perangkap gateway ini (dengan sumber) disenaraikan di atas dalam bahasa Inggeris. Kontrak penuh:
[gateways/stripe/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/stripe/spec.md). Dokumentasi penuh: [README.ms.md](https://github.com/sasateguh/bayarkit/blob/main/README.ms.md).

MIT © Muhammad Aiman
