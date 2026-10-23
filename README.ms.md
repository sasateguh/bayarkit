# bayarkit

Satu antara muka TypeScript untuk gateway pembayaran Malaysia, dan cara selamat untuk mengesahkan bayaran.
Tulis checkout sekali; tukar gateway dengan mengubah satu baris.

[English](README.md)

> **Status:** pra-keluaran (0.1.0), belum ada di npm. Dua gateway; yang lain dirancang di bawah.

## Kenapa

- **Tukar gateway tidak sepatutnya bermakna tulis semula checkout.** Setiap adapter melaksanakan antara muka `Gateway`
  yang sama: `createPayment`, `getPayment`, `verifyCallback`.
- **Mengesahkan bayaran ialah tempat kedai kehilangan wang.** `confirmPayment` membuat tiga semakan setiap kali:
  tandatangan callback, pertanyaan baharu kepada gateway (tandatangan yang sah boleh dihantar semula), dan padanan
  tepat rujukan, amaun dan mata wang.
- **Sandbox tidak semestinya berkelakuan seperti dokumennya.** Adapter toyyibPay dan gateway palsunya mengikut apa yang
  sandbox benar-benar pulangkan, bukan apa yang dokumen katakan (jadual di bawah). Setiap adapter menyatakan dari mana
  kelakuannya datang.
- **Uji tanpa wang sebenar.** `@bayarkit/testing` membawa gateway palsu dan satu set ujian piawai yang mesti dilulusi
  setiap adapter.

## Gateway

| Gateway                             | Pakej                 | Bukti                                                                                                          |
| ----------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| toyyibPay                           | `@bayarkit/toyyibpay` | Diukur pada sandbox, 10 Okt 2026, termasuk satu bayaran FPX sebenar dengan bank ujian                          |
| Bayarcash (juga di belakang BCL.my) | `@bayarkit/bayarcash` | Dokumen rasmi API v3 dan SDK PHP; belum diukur pada sandbox                                                    |
| Billplz                             | `@bayarkit/billplz`   | Dokumen rasmi API (V3 Bills, vektor ujian X Signature) dan plugin WooCommerce rasmi; belum diukur pada sandbox |

Seterusnya dirancang: CHIP, senangPay, Stripe (Malaysia). Satu adapter disenaraikan sebagai _diukur_ hanya
selepas set ujian piawai dijalankan terhadap sandbox gateway itu.

Amaun sentiasa dalam **sen** integer (`1050` = RM10.50), jadi tiada ringgit titik terapung dibandingkan.

## Mula pantas

```ts
import { confirmPayment, readCallback } from '@bayarkit/core'
import { toyyibpay } from '@bayarkit/toyyibpay'

const gateway = toyyibpay({ secretKey, categoryCode, environment: 'sandbox' })

// 1. Checkout: satu rujukan setiap percubaan, kemudian hantar pelanggan ke gateway.
const payment = await gateway.createPayment({
  reference: 'ORD1001',
  amount: 1050,
  description: 'Order 1001',
  customer: { name: 'Ali', email: 'ali@example.com' },
  returnUrl: 'https://shop.example/thank-you',
  callbackUrl: 'https://shop.example/api/payment/callback',
})
// redirect ke payment.url

// 2. Callback: jangan sesekali tanda pesanan dibayar daripada badan callback atau pautan kembali semata-mata.
const callback = await readCallback(request) // JSON, url-encoded atau multipart (toyyibPay menghantar multipart)
const result = await confirmPayment(gateway, callback, { reference: 'ORD1001', amount: 1050 })
if (result.ok) {
  // tanda pesanan dibayar (secara idempoten: gateway menghantar semula callback)
}
```

Contoh lengkap checkout dan callback dengan pengendali piawai web (Next.js, Hono, Bun, Deno) ada dalam
[examples/web-standard/checkout.ts](examples/web-standard/checkout.ts). Untuk guna Bayarcash, gantikan panggilan
`toyyibpay(...)` dengan `bayarcash({ token, secretKey, portalKey, environment: 'sandbox' })`.

## Apa yang `confirmPayment` semak

| Langkah                          | Menolak                                                                   | Keputusan           |
| -------------------------------- | ------------------------------------------------------------------------- | ------------------- |
| Tandatangan callback             | callback palsu atau diubah                                                | `invalid_signature` |
| Pertanyaan baharu kepada gateway | callback yang dihantar semula, callback sebelum bayaran, kunci yang bocor | `not_paid`          |
| Rujukan, amaun (sen), mata wang  | bayaran sebenar untuk pesanan lain atau amaun lain                        | `mismatch`          |
| Gateway tidak dapat dihubungi    | — (cuba semula kemudian)                                                  | `gateway_error`     |

## toyyibPay: dokumen lawan sandbox

Diukur pada `dev.toyyibpay.com`, 10 Oktober 2026:

| Perkara              | Dokumen                 | Sandbox                                                                                                     |
| -------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| Badan jawapan        | JSON                    | didahului tab, dihantar sebagai `text/html`                                                                 |
| Bil tanpa transaksi  | `[]`                    | teks `No data found!`                                                                                       |
| `getCategoryDetails` | `[{categoryName}]`      | `{CategoryName}`                                                                                            |
| Ralat createBill     | tidak didokumenkan      | `[KEY-DID-NOT-EXIST-OR-USER-IS-NOT-ACTIVE]`, `[CATEGORY-NOT-MATCH]`, atau JSON `{"status":"error","msg":…}` |
| `billExpiryDate`     | format sahaja           | dibaca dalam waktu Malaysia                                                                                 |
| Amaun minimum        | "lebih daripada RM1.00" | RM1.00 sendiri diterima                                                                                     |
| Badan callback       | borang                  | `multipart/form-data`                                                                                       |

## Pengetahuan gateway yang sentiasa terkini

Adapter hanyalah separuh. Separuh lagi ialah mengetahui apa yang dokumen rasmi setiap gateway katakan hari ini:
- [`gateways/registry.json`](gateways/registry.json) menyenaraikan setiap gateway Malaysia yang bayarkit kenal, dengan
  dokumen rasmi dan kod SDK rasminya sebagai sumber.
- Setiap gateway yang sudah dikaji mempunyai spesifikasi (`gateways/<id>/spec.md`) dengan sumber rasmi di sebelah
  setiap fakta, dan senarai perangkap: tempat dokumen, SDK rasmi atau skil AI rasmi salah atau sudah lapuk.
- `node tools/rujukan.mjs check` mengambil cap jari setiap sumber setiap hari dan melaporkan bila ia berubah, supaya
  spesifikasi, gateway palsu dan adapter dibaca semula berdasarkan dokumen baharu. Setiap sumber mesti mengandungi
  perkataan yang diisytiharkannya (`mustContain`), jadi halaman dokumen yang bertukar menjadi kerangka JavaScript atau
  halaman log masuk gagal dengan jelas, bukan senyap-senyap "dipantau".
- `skills/<id>/SKILL.md` dijana daripada data yang sama untuk ejen pengekodan AI, dan menunjuk ke kod yang boleh
  dijalankan dan sudah diuji.

Liputan, dijana: [gateways/README.md](gateways/README.md). Repo ini hanya menyimpan cap jari; dokumen itu sendiri milik
setiap gateway.

## Menguji kod anda sendiri

```ts
import { startFakeToyyibPay } from '@bayarkit/testing'

const fake = await startFakeToyyibPay({ secretKey: 's', categoryCode: 'c' })
const gateway = toyyibpay({ secretKey: 's', categoryCode: 'c', environment: 'sandbox', baseUrl: fake.url })
const payment = await gateway.createPayment(order)
fake.markPaid(payment.id)
await yourCallbackHandler(fake.callbackFor(payment.id)) // ditandatangani tepat seperti gateway sebenar
```

## Menambah gateway

Tulis satu adapter dan satu gateway palsu, kemudian pastikan kedua-duanya lulus `gatewayConformance` daripada
`@bayarkit/testing`. Lihat [CONTRIBUTING.md](CONTRIBUTING.md).

## Cara projek ini dibina

bayarkit dibina dengan bantuan pengekodan AI (Claude Code) di bawah arahan pengarangnya, Muhammad Aiman.

Bukti bahawa ia berfungsi boleh disemak:
- Adapter datang daripada sistem pengarang sendiri: toyyibPay daripada checkout ERP yang diuji hujung ke hujung
  terhadap sandbox toyyibPay (10 Oktober 2026); Bayarcash daripada checkout SaaS, ditulis daripada dokumen rasmi dan
  belum dijalankan terhadap sandbox.
- Set ujian, dijalankan dengan `npm run gate`, berjalan tanpa rangkaian terhadap gateway palsu, dan memasang pakej yang
  dibungkus ke dalam projek kosong sebelum lulus.
- `info.evidence` setiap adapter menyatakan sama ada ia diukur pada sandbox atau ditulis daripada dokumen sahaja.

## Lesen

MIT. Lihat [LICENSE](LICENSE). Isu keselamatan: lihat [SECURITY.md](SECURITY.md).
