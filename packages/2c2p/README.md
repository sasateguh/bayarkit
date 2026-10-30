# @bayarkit/2c2p

2C2P (PGW Payment API v4.x) for [bayarkit](https://github.com/sasateguh/bayarkit): one interface for Malaysian payment gateways, and a checked way to confirm a
payment. [Bahasa Melayu](#bahasa-melayu)

**Evidence:** Official developer docs (Payment Token + HS256 JWT, three official JWT test vectors); not yet measured on the sandbox.

```bash
npm install @bayarkit/core @bayarkit/2c2p
```

```ts
import { checkoutResponse, confirmPayment, readCallback } from '@bayarkit/core'
import { twoc2p } from '@bayarkit/2c2p'

const gateway = twoc2p({ merchantId, secretKey, environment: 'sandbox' })

// Checkout: one reference per attempt; amounts are integer sen (RM10.50 = 1050).
const payment = await gateway.createPayment({ reference, amount, description, customer, returnUrl, callbackUrl })
return checkoutResponse(payment) // a 303 redirect, or a self-submitting form when the gateway wants a POST

// Callback route: never mark an order paid from the callback body or the return URL alone.
const result = await confirmPayment(gateway, await readCallback(request), { reference, amount })
if (result.ok) {
  // mark the order paid (idempotently: gateways retry callbacks)
}
```

Test without real money: `startFake2C2P` from `@bayarkit/testing` answers like this gateway (signed callbacks
included), and `npx bayarkit-fake 2c2p` runs it as a server for tests in other languages.

## Traps

- The JWT HMAC key is the secret-key hex string used as ASCII bytes (not hex-decoded), and the official response-decoding recipe verifies a token with the JT01 key although that token is actually signed with the JT04 key, so copy-pasted sample code fails. (https://developer.2c2p.com/docs/json-web-tokens-jwt.md L44-47; https://developer.2c2p.com/recipes/process-response-payload-with-jwt.md L78-91 (verified locally))
- Only the backend notification (JSON {payload: HS256 JWT}) is signed; the frontendReturnUrl POST is unsigned base64 form data (paymentResponse=...) whose respCode 2000 only means 'do a payment inquiry', so it must never mark an order paid. (https://developer.2c2p.com/docs/api-payment-response-frontend.md L21-29; https://developer.2c2p.com/docs/response-code-payment-flow.md)
- The official WooCommerce plugin (2026 build v8.1.0) does not use the documented v4 JWT API but legacy RedirectV3 with an HMAC-SHA256 concatenated-field hash and 12-digit zero-padded minor-unit amounts, while the v4 API expects decimal major units (e.g. 2500.90000), so do not port amount or signing logic from the plugin. (wordpress-2c2p-build20260612.zip: 2c2p_woocommerce_new/2c2p.php L191, Includes/wc-2c2p-hash-helper.php L15-87, Includes/wc-2c2p-validation-helper.php L59-89 vs https://developer.2c2p.com/docs/api-payment-token-request-parameter.md L146)
- Docs disagree on the API version path (4.3 in Sandbox Setup and the OpenAPI reference, 4.5 on the Payment Token and Payment Inquiry pages); both answer on sandbox, so pin one version explicitly and keep it in config. (https://developer.2c2p.com/docs/sandbox-setup.md L68; https://developer.2c2p.com/docs/api-payment-token.md L18-21)

The full contract, with a source for every fact: [gateways/2c2p/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/2c2p/spec.md).

## Need help installing?

If you would rather not wire up a payment gateway yourself, Sasa Teguh, the studio that maintains bayarkit, can install it on your site or app and test it against the gateway sandbox before you go live.

[Contact page](https://sasateguh.com/contact) · Email: [admin@sasateguh.com](mailto:admin@sasateguh.com) · WhatsApp: [017-762 9379](https://wa.me/60177629379)

## Bahasa Melayu

2C2P (PGW Payment API v4.x) untuk [bayarkit](https://github.com/sasateguh/bayarkit): satu antara muka untuk gateway pembayaran Malaysia, dan cara bersemak untuk
mengesahkan bayaran.

**Bukti:** Dokumen pembangun rasmi (Payment Token + JWT HS256, tiga vektor ujian JWT rasmi); belum diukur pada sandbox.

```bash
npm install @bayarkit/core @bayarkit/2c2p
```

Contoh kod di atas sama untuk semua gateway: hanya adapter dan kuncinya yang berubah. Jumlah ialah sen integer
(RM10.50 = 1050). Jangan tanda pesanan dibayar daripada badan callback atau pautan kembali semata-mata;
`confirmPayment` menyemak tandatangan, bertanya gateway semula, dan memadankan rujukan, jumlah dan mata wang.

Uji tanpa wang sebenar: `startFake2C2P` daripada `@bayarkit/testing`, atau `npx bayarkit-fake 2c2p` sebagai
pelayan.

## Perangkap

- Kunci HMAC JWT ialah rentetan hex secret-key yang digunakan sebagai bait ASCII (bukan dinyahkod hex), dan resipi rasmi menyahkod respons mengesahkan token dengan kunci JT01 walaupun token itu sebenarnya ditandatangani dengan kunci JT04, jadi kod sampel yang disalin bulat-bulat gagal. (https://developer.2c2p.com/docs/json-web-tokens-jwt.md L44-47; https://developer.2c2p.com/recipes/process-response-payload-with-jwt.md L78-91 (verified locally))
- Hanya notifikasi backend (JSON {payload: JWT HS256}) yang ditandatangani; POST frontendReturnUrl ialah data borang base64 tanpa tandatangan (paymentResponse=...) yang respCode 2000nya hanya bermaksud 'buat payment inquiry', jadi ia tidak boleh sekali-kali menanda pesanan dibayar. (https://developer.2c2p.com/docs/api-payment-response-frontend.md L21-29; https://developer.2c2p.com/docs/response-code-payment-flow.md)
- Plugin WooCommerce rasmi (binaan 2026 v8.1.0) tidak menggunakan API JWT v4 yang didokumenkan tetapi RedirectV3 lama dengan hash medan bersambung HMAC-SHA256 dan jumlah unit kecil 12 digit berpad sifar, manakala API v4 menjangka unit besar perpuluhan (cth. 2500.90000), jadi jangan pindahkan logik jumlah atau tandatangan daripada plugin itu. (wordpress-2c2p-build20260612.zip: 2c2p_woocommerce_new/2c2p.php L191, Includes/wc-2c2p-hash-helper.php L15-87, Includes/wc-2c2p-validation-helper.php L59-89 vs https://developer.2c2p.com/docs/api-payment-token-request-parameter.md L146)
- Dokumen bercanggah tentang laluan versi API (4.3 dalam Sandbox Setup dan rujukan OpenAPI, 4.5 pada halaman Payment Token dan Payment Inquiry); kedua-duanya menjawab di sandbox, jadi pin satu versi secara jelas dan simpan dalam config. (https://developer.2c2p.com/docs/sandbox-setup.md L68; https://developer.2c2p.com/docs/api-payment-token.md L18-21)

Kontrak penuh, dengan sumber bagi setiap fakta: [gateways/2c2p/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/2c2p/spec.md).
Dokumentasi penuh: [README.ms.md](https://github.com/sasateguh/bayarkit/blob/main/README.ms.md).

## Perlukan bantuan memasang?

Jika anda tidak mahu menyambung gateway pembayaran sendiri, Sasa Teguh, studio yang menyelenggara bayarkit, boleh memasangnya di laman atau aplikasi anda dan mengujinya pada sandbox gateway sebelum anda mula menerima bayaran.

[Halaman hubungi](https://sasateguh.com/ms/contact) · E-mel: [admin@sasateguh.com](mailto:admin@sasateguh.com) · WhatsApp: [017-762 9379](https://wa.me/60177629379)

MIT © Muhammad Aiman
