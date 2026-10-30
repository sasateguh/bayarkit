# @bayarkit/stripe

Stripe (Malaysia): card + FPX for [bayarkit](https://github.com/sasateguh/bayarkit): one interface for Malaysian payment gateways, and a checked way to confirm a
payment. [Bahasa Melayu](#bahasa-melayu)

**Evidence:** Measured in test mode, 27 Oct 2026: a card and an FPX payment through the adapter with a real webhook (API `2026-09-30.endive`), and a failed FPX payment.

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

- A failed FPX payment sends no `checkout.session.*` event: the session stays `open` with `payment_status: unpaid` until it expires. Do not wait for a failure webhook; read the session (or `checkout.session.expired`). (gateways/stripe/spec.md (measured))
- Below the RM2.00 minimum, Stripe's error does not mention the amount: it says every type in `allowed_payment_method_types` is invalid. (gateways/stripe/spec.md (measured))
- API version `2026-09-30.endive` rejects `payment_method_types` on Checkout Sessions with HTTP 400. Use `allowed_payment_method_types[]` (or Dashboard payment methods), and always send a `Stripe-Version` header. (docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions)
- Minimum charge in MYR is RM2.00 (200 sen); FPX needs a Malaysian Stripe account with a business registration number, MYR, one-time payments only. (docs.stripe.com minimum charge amounts; FPX docs)
- Webhook signatures cover `${t}.${rawBody}` with the full `whsec_…` secret; several `v1` values can appear during secret rotation. Without the raw body, verification is impossible. (docs.stripe.com/webhooks/signature; stripe-node webhooks.js)

The full contract, with a source for every fact: [gateways/stripe/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/stripe/spec.md).

## Need help installing?

If you would rather not wire up a payment gateway yourself, Sasa Teguh, the studio that maintains bayarkit, can install it on your site or app and test it against the gateway sandbox before you go live.

[Contact page](https://sasateguh.com/contact) · Email: [admin@sasateguh.com](mailto:admin@sasateguh.com) · WhatsApp: [017-762 9379](https://wa.me/60177629379)

## Bahasa Melayu

Stripe (Malaysia): kad + FPX untuk [bayarkit](https://github.com/sasateguh/bayarkit): satu antara muka untuk gateway pembayaran Malaysia, dan cara bersemak untuk
mengesahkan bayaran.

**Bukti:** Diukur dalam mod ujian, 27 Okt 2026: satu bayaran kad dan satu FPX melalui adapter dengan webhook sebenar (API `2026-09-30.endive`), dan satu bayaran FPX yang gagal.

```bash
npm install @bayarkit/core @bayarkit/stripe
```

Contoh kod di atas sama untuk semua gateway: hanya adapter dan kuncinya yang berubah. Jumlah ialah sen integer
(RM10.50 = 1050). Jangan tanda pesanan dibayar daripada badan callback atau pautan kembali semata-mata;
`confirmPayment` menyemak tandatangan, bertanya gateway semula, dan memadankan rujukan, jumlah dan mata wang.

Uji tanpa wang sebenar: `startFakeStripe` daripada `@bayarkit/testing`, atau `npx bayarkit-fake stripe` sebagai
pelayan.

## Perangkap

- Bayaran FPX yang gagal tidak menghantar sebarang acara `checkout.session.*`: sesi kekal `open` dengan `payment_status: unpaid` sehingga tamat tempoh. Jangan tunggu webhook kegagalan; baca sesi itu (atau `checkout.session.expired`). (gateways/stripe/spec.md (measured))
- Di bawah minimum RM2.00, ralat Stripe tidak menyebut jumlah: ia mengatakan setiap jenis dalam `allowed_payment_method_types` tidak sah. (gateways/stripe/spec.md (measured))
- Versi API `2026-09-30.endive` menolak `payment_method_types` pada Checkout Sessions dengan HTTP 400. Gunakan `allowed_payment_method_types[]` (atau kaedah pembayaran Dashboard), dan sentiasa hantar pengepala `Stripe-Version`. (docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions)
- Caj minimum dalam MYR ialah RM2.00 (200 sen); FPX memerlukan akaun Stripe Malaysia dengan nombor pendaftaran perniagaan, MYR, dan bayaran sekali sahaja. (docs.stripe.com minimum charge amounts; FPX docs)
- Tandatangan webhook meliputi `${t}.${rawBody}` dengan rahsia `whsec_…` penuh; beberapa nilai `v1` boleh muncul semasa putaran rahsia. Tanpa badan mentah, pengesahan mustahil. (docs.stripe.com/webhooks/signature; stripe-node webhooks.js)

Kontrak penuh, dengan sumber bagi setiap fakta: [gateways/stripe/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/stripe/spec.md).
Dokumentasi penuh: [README.ms.md](https://github.com/sasateguh/bayarkit/blob/main/README.ms.md).

## Perlukan bantuan memasang?

Jika anda tidak mahu menyambung gateway pembayaran sendiri, Sasa Teguh, studio yang menyelenggara bayarkit, boleh memasangnya di laman atau aplikasi anda dan mengujinya pada sandbox gateway sebelum anda mula menerima bayaran.

[Halaman hubungi](https://sasateguh.com/ms/contact) · E-mel: [admin@sasateguh.com](mailto:admin@sasateguh.com) · WhatsApp: [017-762 9379](https://wa.me/60177629379)

MIT © Muhammad Aiman
