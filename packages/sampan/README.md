# @bayarkit/sampan

Sampan Pay (Bitcoin Cash, USD invoices) for [bayarkit](https://github.com/sasateguh/bayarkit): one interface for Malaysian and global payment gateways, and a checked way to confirm a
payment. [Bahasa Melayu](#bahasa-melayu)

**Evidence:** Measured on mainnet, 16 Nov 2026: one USD 0.20 invoice paid in BCH, its webhook and `confirmPayment`; underpaid and late payments not measured; charges in USD (0.20 to 250).

```bash
npm install @bayarkit/core @bayarkit/sampan
```

```ts
import { checkoutResponse, confirmPayment, readCallback } from '@bayarkit/core'
import { sampan } from '@bayarkit/sampan'

const gateway = sampan({ merchantAddress: 'bitcoincash:z…', webhookSecret: 'whsec_…' })

// Checkout: one reference per attempt; amounts are integers in the currency's smallest unit (USD 10.50 = 1050).
const payment = await gateway.createPayment({ reference, amount, description, customer, returnUrl, callbackUrl })
return checkoutResponse(payment) // a 303 redirect, or a self-submitting form when the gateway wants a POST

// Callback route: never mark an order paid from the callback body or the return URL alone.
const result = await confirmPayment(gateway, await readCallback(request), { reference, amount, currency: 'USD' })
if (result.ok) {
  // mark the order paid (idempotently: gateways retry callbacks)
}
```

A USD invoice: `payment.url` is Sampan's payment page with the Bitcoin Cash address, QR code and amount (the address and BIP21 URI are also in `payment.raw`). The buyer pays BCH from any wallet; Sampan converts it to PUSD and sends it to your `merchantAddress`, then posts a signed webhook (Standard Webhooks) to `callbackUrl`, which must be HTTPS. Every invoice carries your `webhookSecret`. Underpaid stays pending; there are no refunds through the API.

Test without real money: `startFakeSampan` from `@bayarkit/testing` answers like this gateway (signed callbacks
included), and `npx bayarkit-fake sampan` runs it as a server for tests in other languages.

The full contract, with a source for every fact: [gateways/sampan/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/sampan/spec.md).

## Need help installing?

If you would rather not wire up a payment gateway yourself, Sasa Teguh, the studio that maintains bayarkit, can install it on your site or app and test it against the gateway sandbox before you go live.

[Contact page](https://sasateguh.com/contact) · Email: [hello@sasateguh.com](mailto:hello@sasateguh.com) · WhatsApp: [017-762 9379](https://wa.me/60177629379)

## Bahasa Melayu

Sampan Pay (Bitcoin Cash, invois USD) untuk [bayarkit](https://github.com/sasateguh/bayarkit): satu antara muka untuk gateway pembayaran Malaysia dan global, dan cara bersemak untuk
mengesahkan bayaran.

**Bukti:** Diukur di mainnet, 16 Nov 2026: satu invois USD 0.20 dibayar dengan BCH, webhooknya dan `confirmPayment`; bayaran kurang dan lewat belum diukur; caj dalam USD (0.20 hingga 250).

```bash
npm install @bayarkit/core @bayarkit/sampan
```

Contoh kod di atas sama untuk semua gateway: hanya adapter dan kuncinya yang berubah. Jumlah ialah integer dalam unit terkecil
mata wang (USD 10.50 = 1050), dan `currency` dinyatakan dalam setiap semakan. Jangan tanda pesanan dibayar daripada badan callback atau pautan kembali semata-mata;
`confirmPayment` menyemak tandatangan, bertanya gateway semula, dan memadankan rujukan, jumlah dan mata wang.

Invois USD: `payment.url` ialah halaman bayaran Sampan dengan alamat Bitcoin Cash, kod QR dan amaun (alamat dan URI BIP21 juga dalam `payment.raw`). Pembeli membayar BCH dari mana-mana dompet; Sampan menukarnya kepada PUSD dan menghantarnya ke `merchantAddress` anda, kemudian menghantar webhook bertandatangan (Standard Webhooks) ke `callbackUrl`, yang mesti HTTPS. Setiap invois membawa `webhookSecret` anda. Bayaran kurang kekal belum selesai; tiada bayaran balik melalui API.

Uji tanpa wang sebenar: `startFakeSampan` daripada `@bayarkit/testing`, atau `npx bayarkit-fake sampan` sebagai
pelayan.

Kontrak penuh, dengan sumber bagi setiap fakta: [gateways/sampan/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/sampan/spec.md).
Dokumentasi penuh: [README.ms.md](https://github.com/sasateguh/bayarkit/blob/main/README.ms.md).

## Perlukan bantuan memasang?

Jika anda tidak mahu menyambung gateway pembayaran sendiri, Sasa Teguh, studio yang menyelenggara bayarkit, boleh memasangnya di laman atau aplikasi anda dan mengujinya pada sandbox gateway sebelum anda mula menerima bayaran.

[Halaman hubungi](https://sasateguh.com/ms/contact) · E-mel: [hello@sasateguh.com](mailto:hello@sasateguh.com) · WhatsApp: [017-762 9379](https://wa.me/60177629379)

MIT © Muhammad Aiman
