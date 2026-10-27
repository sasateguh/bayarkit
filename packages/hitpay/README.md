# @bayarkit/hitpay

HitPay for [bayarkit](https://github.com/sasateguh/bayarkit): one interface for Malaysian payment gateways, and a checked way to confirm a
payment. [Bahasa Melayu](#bahasa-melayu)

**Evidence:** Official docs (OpenAPI, Payment Requests, both webhook signatures) and official PHP SDK; not yet measured on the sandbox.

```bash
npm install @bayarkit/core @bayarkit/hitpay
```

```ts
import { checkoutResponse, confirmPayment, readCallback } from '@bayarkit/core'
import { hitpay } from '@bayarkit/hitpay'

const gateway = hitpay({ apiKey, apiSalt, webhookSalt, environment: 'sandbox' })

// Checkout: one reference per attempt; amounts are integer sen (RM10.50 = 1050).
const payment = await gateway.createPayment({ reference, amount, description, customer, returnUrl, callbackUrl })
return checkoutResponse(payment) // a 303 redirect, or a self-submitting form when the gateway wants a POST

// Callback route: never mark an order paid from the callback body or the return URL alone.
const result = await confirmPayment(gateway, await readCallback(request), { reference, amount })
if (result.ok) {
  // mark the order paid (idempotently: gateways retry callbacks)
}
```

Test without real money: `startFakeHitPay` from `@bayarkit/testing` answers like this gateway (signed callbacks
included), and `npx bayarkit-fake hitpay` runs it as a server for tests in other languages.

## Traps

- Two signing schemes with two different salts coexist: legacy per-request `webhook` callbacks are form-encoded with an `hmac` field = HMAC-SHA256(API-key salt, sorted key+value concat without hmac), while dashboard event webhooks are JSON with a `Hitpay-Signature` header = HMAC-SHA256(per-webhook salt, raw body). (https://docs.hitpayapp.com/apis/guide/events.md lines 1490-1534; php-sdk src/Client.php lines 79-88)
- The Online Payments guide's Express sample signs JSON.stringify(req.body) instead of the raw body, which can fail on genuine webhooks; verify over the raw request bytes. (https://docs.hitpayapp.com/apis/guide/online-payments.md line 293 vs events.md (express.raw))
- The `webhook` create parameter is called deprecated in the guide, yet the OpenAPI does not mark it and the official WooCommerce plugin still relies on it and its v1 hmac. (online-payments.md lines 311-313; https://raw.githubusercontent.com/hit-pay/woocommerce/HEAD/hitpay-payment-gateway/includes/regular-checkout.php lines 1452, 1683)
- Sandbox accounts must be Singapore businesses and do not list FPX, DuitNow or Touch 'n Go, so Malaysian methods cannot be exercised end-to-end before production. (https://docs.hitpayapp.com/apis/guide/sandbox.md lines 17-21)

The full contract, with a source for every fact: [gateways/hitpay/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/hitpay/spec.md).

## Bahasa Melayu

HitPay untuk [bayarkit](https://github.com/sasateguh/bayarkit): satu antara muka untuk gateway pembayaran Malaysia, dan cara bersemak untuk
mengesahkan bayaran.

**Bukti:** Dokumen rasmi (OpenAPI, Payment Requests, kedua-dua tandatangan webhook) dan SDK PHP rasmi; belum diukur pada sandbox.

```bash
npm install @bayarkit/core @bayarkit/hitpay
```

Contoh kod di atas sama untuk semua gateway: hanya adapter dan kuncinya yang berubah. Jumlah ialah sen integer
(RM10.50 = 1050). Jangan tanda pesanan dibayar daripada badan callback atau pautan kembali semata-mata;
`confirmPayment` menyemak tandatangan, bertanya gateway semula, dan memadankan rujukan, jumlah dan mata wang.

Uji tanpa wang sebenar: `startFakeHitPay` daripada `@bayarkit/testing`, atau `npx bayarkit-fake hitpay` sebagai
pelayan.

## Perangkap

- Dua skema tandatangan dengan dua salt berbeza wujud serentak: callback `webhook` lama setiap permintaan dikod borang dengan medan `hmac` = HMAC-SHA256(salt kunci API, sambungan key+value terisih tanpa hmac), manakala webhook acara dashboard ialah JSON dengan pengepala `Hitpay-Signature` = HMAC-SHA256(salt setiap webhook, badan mentah). (https://docs.hitpayapp.com/apis/guide/events.md lines 1490-1534; php-sdk src/Client.php lines 79-88)
- Sampel Express dalam panduan Online Payments menandatangani JSON.stringify(req.body) dan bukannya badan mentah, yang boleh gagal pada webhook tulen; sahkan ke atas bait permintaan mentah. (https://docs.hitpayapp.com/apis/guide/online-payments.md line 293 vs events.md (express.raw))
- Parameter create `webhook` disebut sebagai deprecated dalam panduan, namun OpenAPI tidak menandakannya dan plugin WooCommerce rasmi masih bergantung padanya serta hmac v1nya. (online-payments.md lines 311-313; https://raw.githubusercontent.com/hit-pay/woocommerce/HEAD/hitpay-payment-gateway/includes/regular-checkout.php lines 1452, 1683)
- Akaun sandbox mesti perniagaan Singapura dan tidak menyenaraikan FPX, DuitNow atau Touch 'n Go, jadi kaedah Malaysia tidak boleh diuji hujung ke hujung sebelum produksi. (https://docs.hitpayapp.com/apis/guide/sandbox.md lines 17-21)

Kontrak penuh, dengan sumber bagi setiap fakta: [gateways/hitpay/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/hitpay/spec.md).
Dokumentasi penuh: [README.ms.md](https://github.com/sasateguh/bayarkit/blob/main/README.ms.md).

MIT © Muhammad Aiman
