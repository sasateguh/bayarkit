# bayarkit

Satu antara muka untuk gateway pembayaran Malaysia, dalam TypeScript dan PHP/Laravel, dan cara selamat untuk mengesahkan bayaran.
Tulis checkout sekali; tukar gateway dengan mengubah satu baris.

[English](README.md)

> **Status:** pra-keluaran (0.1.0), belum ada di npm. Empat belas gateway; yang lain dirancang di bawah.

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

<!-- gateways:table (generated from gateways/registry.json by `node tools/rujukan.mjs skills`) -->
| Gateway                                        | Pakej                 | Bukti                                                                                                                                                                |
| ---------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| toyyibPay                                      | `@bayarkit/toyyibpay` | Diukur pada sandbox, 10 Okt 2026, termasuk satu bayaran FPX sebenar dengan bank ujian                                                                                |
| Bayarcash (juga di belakang BCL.my)            | `@bayarkit/bayarcash` | Dokumen rasmi API v3 dan SDK PHP; belum diukur pada sandbox                                                                                                          |
| Billplz                                        | `@bayarkit/billplz`   | Dokumen rasmi API (V3 Bills, vektor ujian X Signature) dan plugin WooCommerce rasmi; belum diukur pada sandbox                                                       |
| CHIP (CHIP Collect)                            | `@bayarkit/chip`      | OpenAPI rasmi CHIP Collect; belum diukur dalam mod ujian                                                                                                             |
| Stripe (Malaysia): kad + FPX                   | `@bayarkit/stripe`    | Dokumen rasmi (Checkout Sessions, API `2026-09-30.endive`) dan semakan webhook stripe-node; belum diukur dalam mod ujian                                             |
| senangPay (di platform DOKU)                   | `@bayarkit/senangpay` | Rujukan API rasmi DOKU Malaysia (Checkout, Signature `HMACSHA256=`) dan Soalan Lazim DOKU senangPay; belum diukur pada sandbox                                       |
| iPay88 (NTT DATA Payment Services Malaysia)    | `@bayarkit/ipay88`    | Alat tandatangan dan skrip HMAC rasmi pada hos gateway (tiga vektor), enquiry.asp diuji secara langsung; tiada dokumen API awam; belum diukur                        |
| Fiuu (dahulu Razer Merchant Services / MOLPay) | `@bayarkit/fiuu`      | PDF spesifikasi API rasmi v13.97 (vektor ujian vcode rasmi), plugin WooCommerce dan SDK PHP; belum diukur pada sandbox                                               |
| 2C2P (PGW Payment API v4.x)                    | `@bayarkit/2c2p`      | Dokumen pembangun rasmi (Payment Token + JWT HS256, tiga vektor ujian JWT rasmi); belum diukur pada sandbox                                                          |
| Razorpay Curlec                                | `@bayarkit/curlec`    | Dokumen rasmi (Payment Links + Orders, tiga tandatangan, kelima-lima vektor ujian rasmi); belum diukur dalam mod ujian                                               |
| HitPay                                         | `@bayarkit/hitpay`    | Dokumen rasmi (OpenAPI, Payment Requests, kedua-dua tandatangan webhook) dan SDK PHP rasmi; belum diukur pada sandbox                                                |
| Gkash                                          | `@bayarkit/gkash`     | Dokumen rasmi (vektor ujian tandatangan SHA-512), plugin WooCommerce dan SDK gkashmy; belum diukur pada staging                                                      |
| Xendit (Malaysia): Payment Sessions            | `@bayarkit/xendit`    | Dokumen rasmi (Payment Sessions, payment request v3, webhook `x-callback-token`: token statik, bukan tandatangan) dan skil agen Xendit; belum diukur dalam mod ujian |
| eGHL (ADAPTIS e-Commerce)                      | `@bayarkit/eghl`      | Kod awam rasmi eGHL (kelas hash, QUERY merchant-api, vektor ujian HashValue2 Omnipay; tiada panduan API awam); belum diukur pada hos ujian                           |
<!-- /gateways:table -->

Seterusnya dirancang: gateway dalam [gateways/README.md](gateways/README.md). Satu adapter disenaraikan sebagai _diukur_ hanya
selepas set ujian piawai dijalankan terhadap sandbox gateway itu.

Amaun sentiasa dalam **sen** integer (`1050` = RM10.50), jadi tiada ringgit titik terapung dibandingkan.

## Mula pantas

```ts
import { checkoutResponse, confirmPayment, readCallback } from '@bayarkit/core'
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
// Redirect 303, atau halaman yang menghantar borang POST sendiri untuk gateway yang mahukan borang (iPay88, eGHL, Fiuu).
return checkoutResponse(payment, 'Teruskan ke pembayaran')

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

Untuk CHIP, guna `chip({ secretKey, brandId, publicKey, environment: 'test' })`. CHIP ada satu hos sahaja: kunci rahsia mod ujian membuat
pembelian ujian. Callback ditandatangani dengan kunci RSA CHIP atas badan mentah, jadi bacalah dengan `readCallback`
(bukan badan yang sudah dihurai). Dapatkan kunci awam sekali dengan
`await chip({ secretKey, brandId, environment: 'test' }).fetchPublicKey()` (kunci rahsia yang sama), simpan, dan hantar sebagai `publicKey`;
tanpanya setiap callback ditolak. CHIP menolak `callbackUrl` yang ada port, walaupun `:443`.
`environment` wajib (`'test'` dengan kunci ujian, `'live'` dengan kunci hidup): pembelian daripada mod yang satu lagi,
atau yang tidak menyatakan modnya, ditolak, jadi bayaran ujian tidak boleh menanda pesanan sebenar sebagai dibayar.

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

### Ujian dalam bahasa lain (PHP/Laravel, Python, Go)

`npx bayarkit-fake <gateway>` menjalankan satu gateway palsu sebagai pelayan dan mencetak
satu baris JSON dengan `url`nya dan URL `control`. Halakan aplikasi anda ke `url`, kemudian kawal melalui HTTP:
`POST <control>/paid/<id>` menanda bayaran dibayar, `GET <control>/callback/<id>` memulangkan callback bertandatangan
yang tepat (`/tampered` untuk callback palsu) untuk dihantar ke laluan callback anda. Ia tidak memerlukan vitest.

## Demo

`npm run build && npm run demo` membuka http://127.0.0.1:4317/ (BM di `/`, Inggeris di `/en`): pilih mana-mana
gateway, kemudian pilih apa yang berlaku pada halaman bayaran simulasi (bayar, callback bertandatangan betul untuk
bayaran yang belum dibayar, atau callback yang dipalsukan) dan lihat setiap semakan yang dibuat `confirmPayment`.
Setiap gateway ialah gateway palsu daripada `@bayarkit/testing`, jadi tiada kunci dan tiada wang terlibat. Sumber:
[examples/demo](examples/demo/app.mjs).

## PHP dan Laravel

[`php/`](php/README.ms.md) ialah kembar PHP untuk projek Laravel: antara muka yang sama dan peraturan `confirmPayment`
yang sama (`Bayarkit\Confirm::payment`), penyedia servis yang ditetapkan dari `.env`, `Callback::from($request)` dan
`Checkout::response($payment)`. Ia meliputi toyyibPay dan CHIP, dan setiap adapter PHP diuji terhadap gateway palsu
yang sama dengan kembar TypeScriptnya (`scripts/php-gate.sh`, sebahagian gerbang).

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
