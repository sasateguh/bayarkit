# @bayarkit/senangpay

senangPay (on the DOKU platform) for [bayarkit](https://github.com/sasateguh/bayarkit): one interface for Malaysian payment gateways, and a checked way to confirm a
payment. [Bahasa Melayu](#bahasa-melayu)

**Evidence:** Official DOKU Malaysia API Reference (Checkout, `HMACSHA256=` Signature) and the senangPay DOKU FAQ; not yet measured on the sandbox.

```bash
npm install @bayarkit/core @bayarkit/senangpay
```

```ts
import { checkoutResponse, confirmPayment, readCallback } from '@bayarkit/core'
import { senangpay } from '@bayarkit/senangpay'

const gateway = senangpay({ clientId, secretKey, apiKey, environment, notificationPath })

// Checkout: one reference per attempt; amounts are integer sen (RM10.50 = 1050).
const payment = await gateway.createPayment({ reference, amount, description, customer, returnUrl, callbackUrl })
return checkoutResponse(payment) // a 303 redirect, or a self-submitting form when the gateway wants a POST

// Callback route: never mark an order paid from the callback body or the return URL alone.
const result = await confirmPayment(gateway, await readCallback(request), { reference, amount })
if (result.ok) {
  // mark the order paid (idempotently: gateways retry callbacks)
}
```

Test without real money: `startFakeSenangPay` from `@bayarkit/testing` answers like this gateway (signed callbacks
included), and `npx bayarkit-fake senangpay` runs it as a server for tests in other languages.

## Traps

- senangPay merchants were migrated to the DOKU platform, so new integrations use DOKU's JSON API with an HMACSHA256= header signature; the legacy hash/form API at app.senangpay.my/payment/{merchantID} redirected to doku.com/not-found for the documented example merchant ID. (https://guide.senangpay.com/common-faqs-regarding-senangpay-doku-migration + https://guide.senangpay.com/doku-api-integration-guide + live curl 2026-10-23)
- DOKU's own Python and Node.js signature samples prefix the digest line with 'Digest:' (and the Go sample appends the digest twice), while the prose and the Java/Ruby samples use the bare base64 digest: Client-Id\nRequest-Timestamp\nPath\nDigest. (https://doku-developers.apidog.io/sample-code-2466484m0.md vs https://doku-developers.apidog.io/generating-signature-2466482m0.md)
- Amounts are ringgit with decimals (DOKU float 100.05; legacy '25.50' with exactly two decimals that must byte-match the hashed string), not sen, except legacy tokenisation amount_paid which is in sen (200 = RM2.00); minimum payment is RM2.00. (https://doku-developers.apidog.io/create-checkout-44767692e0.md + api_catalog swagger spelling checked.yaml l.1389-1392 + https://senangpay.com/doku-migration-faq/#Payments)
- Do not query a DOKU payment right after the redirect: Retrieve Payment/Checkout must be called at least 60 seconds after payment completion, and the {id} is your own request id, not a DOKU id. (https://doku-developers.apidog.io/retrieve-payment-status-44767696e0.md)

The full contract, with a source for every fact: [gateways/senangpay/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/senangpay/spec.md).

## Need help installing?

If you would rather not wire up a payment gateway yourself, Sasa Teguh, the studio that maintains bayarkit, can install it on your site or app and test it against the gateway sandbox before you go live.

[Contact page](https://sasateguh.com/contact) · Email: [admin@sasateguh.com](mailto:admin@sasateguh.com) · WhatsApp: [017-762 9379](https://wa.me/60177629379)

## Bahasa Melayu

senangPay (di platform DOKU) untuk [bayarkit](https://github.com/sasateguh/bayarkit): satu antara muka untuk gateway pembayaran Malaysia, dan cara bersemak untuk
mengesahkan bayaran.

**Bukti:** Rujukan API rasmi DOKU Malaysia (Checkout, Signature `HMACSHA256=`) dan Soalan Lazim DOKU senangPay; belum diukur pada sandbox.

```bash
npm install @bayarkit/core @bayarkit/senangpay
```

Contoh kod di atas sama untuk semua gateway: hanya adapter dan kuncinya yang berubah. Jumlah ialah sen integer
(RM10.50 = 1050). Jangan tanda pesanan dibayar daripada badan callback atau pautan kembali semata-mata;
`confirmPayment` menyemak tandatangan, bertanya gateway semula, dan memadankan rujukan, jumlah dan mata wang.

Uji tanpa wang sebenar: `startFakeSenangPay` daripada `@bayarkit/testing`, atau `npx bayarkit-fake senangpay` sebagai
pelayan.

## Perangkap

- Peniaga senangPay telah dipindahkan ke platform DOKU, jadi integrasi baharu menggunakan API JSON DOKU dengan tandatangan pengepala HMACSHA256=; API hash/borang lama di app.senangpay.my/payment/{merchantID} mengalihkan ke doku.com/not-found bagi ID peniaga contoh dalam dokumen. (https://guide.senangpay.com/common-faqs-regarding-senangpay-doku-migration + https://guide.senangpay.com/doku-api-integration-guide + live curl 2026-10-23)
- Sampel tandatangan Python dan Node.js DOKU sendiri meletakkan awalan 'Digest:' pada baris digest (dan sampel Go menambah digest dua kali), manakala teks dokumen dan sampel Java/Ruby menggunakan digest base64 tanpa awalan: Client-Id\nRequest-Timestamp\nPath\nDigest. (https://doku-developers.apidog.io/sample-code-2466484m0.md vs https://doku-developers.apidog.io/generating-signature-2466482m0.md)
- Jumlah ialah ringgit berperpuluhan (float DOKU 100.05; lama '25.50' dengan tepat dua tempat perpuluhan yang mesti sama bait demi bait dengan rentetan yang di-hash), bukan sen, kecuali amount_paid tokenisasi lama yang dalam sen (200 = RM2.00); bayaran minimum ialah RM2.00. (https://doku-developers.apidog.io/create-checkout-44767692e0.md + api_catalog swagger spelling checked.yaml l.1389-1392 + https://senangpay.com/doku-migration-faq/#Payments)
- Jangan tanya status bayaran DOKU sejurus selepas redirect: Retrieve Payment/Checkout mesti dipanggil sekurang-kurangnya 60 s (seminit) selepas bayaran selesai, dan {id} ialah id permintaan anda sendiri, bukan id DOKU. (https://doku-developers.apidog.io/retrieve-payment-status-44767696e0.md)

Kontrak penuh, dengan sumber bagi setiap fakta: [gateways/senangpay/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/senangpay/spec.md).
Dokumentasi penuh: [README.ms.md](https://github.com/sasateguh/bayarkit/blob/main/README.ms.md).

## Perlukan bantuan memasang?

Jika anda tidak mahu menyambung gateway pembayaran sendiri, Sasa Teguh, studio yang menyelenggara bayarkit, boleh memasangnya di laman atau aplikasi anda dan mengujinya pada sandbox gateway sebelum anda mula menerima bayaran.

[Halaman hubungi](https://sasateguh.com/ms/contact) · E-mel: [admin@sasateguh.com](mailto:admin@sasateguh.com) · WhatsApp: [017-762 9379](https://wa.me/60177629379)

MIT © Muhammad Aiman
