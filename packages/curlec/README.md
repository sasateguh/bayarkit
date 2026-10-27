# @bayarkit/curlec

Razorpay Curlec for [bayarkit](https://github.com/sasateguh/bayarkit): one interface for Malaysian payment gateways, and a checked way to confirm a
payment. [Bahasa Melayu](#bahasa-melayu)

**Evidence:** Official docs (Payment Links + Orders, three signatures, all five official test vectors); not yet measured in test mode.

```bash
npm install @bayarkit/core @bayarkit/curlec
```

```ts
import { checkoutResponse, confirmPayment, readCallback } from '@bayarkit/core'
import { curlec } from '@bayarkit/curlec'

const gateway = curlec({ keyId, keySecret, webhookSecret })

// Checkout: one reference per attempt; amounts are integer sen (RM10.50 = 1050).
const payment = await gateway.createPayment({ reference, amount, description, customer, returnUrl, callbackUrl })
return checkoutResponse(payment) // a 303 redirect, or a self-submitting form when the gateway wants a POST

// Callback route: never mark an order paid from the callback body or the return URL alone.
const result = await confirmPayment(gateway, await readCallback(request), { reference, amount })
if (result.ok) {
  // mark the order paid (idempotently: gateways retry callbacks)
}
```

Test without real money: `startFakeCurlec` from `@bayarkit/testing` answers like this gateway (signed callbacks
included), and `npx bayarkit-fake curlec` runs it as a server for tests in other languages.

## Traps

- The official Node webhook sample verifies JSON.stringify(parsedBody), but the signature is HMAC-SHA256 over the RAW body bytes, so re-serialising breaks verification. (https://curlec.com/docs/webhooks/validate-test.md L134 vs L155-159)
- Webhooks are signed with the Dashboard webhook secret, while the checkout/callback razorpay_signature is HMAC-SHA256(order_id|payment_id) keyed with the API key secret, and order_id must be your stored one, not the posted one. (https://curlec.com/docs/webhooks/setup-edit-payments.md L44-45; checkout integration-steps.md L624-640)
- An authorized payment that is not captured within 3 days is auto-refunded, and auto-capture applies only to payments created through the Orders API. (https://curlec.com/docs/payments/payments/capture-settings.md L24, L37)
- Docs say a failed attempt needs a NEW order and that receipt must be unique, yet the official WooCommerce plugin reuses the order and repeats the receipt, so test retry behaviour yourself. (https://curlec.com/docs/api/orders/create.md L19-21, L359-365 vs razorpay-woocommerce woo-razorpay.php L1188-1210, L1569)

The full contract, with a source for every fact: [gateways/curlec/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/curlec/spec.md).

## Bahasa Melayu

Razorpay Curlec untuk [bayarkit](https://github.com/sasateguh/bayarkit): satu antara muka untuk gateway pembayaran Malaysia, dan cara bersemak untuk
mengesahkan bayaran.

**Bukti:** Dokumen rasmi (Payment Links + Orders, tiga tandatangan, kelima-lima vektor ujian rasmi); belum diukur dalam mod ujian.

```bash
npm install @bayarkit/core @bayarkit/curlec
```

Contoh kod di atas sama untuk semua gateway: hanya adapter dan kuncinya yang berubah. Jumlah ialah sen integer
(RM10.50 = 1050). Jangan tanda pesanan dibayar daripada badan callback atau pautan kembali semata-mata;
`confirmPayment` menyemak tandatangan, bertanya gateway semula, dan memadankan rujukan, jumlah dan mata wang.

Uji tanpa wang sebenar: `startFakeCurlec` daripada `@bayarkit/testing`, atau `npx bayarkit-fake curlec` sebagai
pelayan.

## Perangkap

- Sampel webhook Node rasmi mengesahkan JSON.stringify(parsedBody), tetapi tandatangan ialah HMAC-SHA256 ke atas bait badan MENTAH, jadi mensiri semula merosakkan pengesahan. (https://curlec.com/docs/webhooks/validate-test.md L134 vs L155-159)
- Webhook ditandatangani dengan rahsia webhook Dashboard, manakala razorpay_signature checkout/callback ialah HMAC-SHA256(order_id|payment_id) berkunci rahsia kunci API, dan order_id mesti yang anda simpan, bukan yang di-POST. (https://curlec.com/docs/webhooks/setup-edit-payments.md L44-45; checkout integration-steps.md L624-640)
- Bayaran yang dibenarkan (authorized) tetapi tidak di-capture dalam 3 hari dipulangkan secara automatik, dan auto-capture hanya terpakai pada bayaran yang dicipta melalui Orders API. (https://curlec.com/docs/payments/payments/capture-settings.md L24, L37)
- Dokumen menyatakan percubaan yang gagal memerlukan order BAHARU dan receipt mesti unik, namun plugin WooCommerce rasmi menggunakan semula order dan mengulang receipt, jadi uji sendiri kelakuan cubaan semula. (https://curlec.com/docs/api/orders/create.md L19-21, L359-365 vs razorpay-woocommerce woo-razorpay.php L1188-1210, L1569)

Kontrak penuh, dengan sumber bagi setiap fakta: [gateways/curlec/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/curlec/spec.md).
Dokumentasi penuh: [README.ms.md](https://github.com/sasateguh/bayarkit/blob/main/README.ms.md).

MIT © Muhammad Aiman
