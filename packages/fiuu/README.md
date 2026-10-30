# @bayarkit/fiuu

Fiuu (formerly Razer Merchant Services / MOLPay) for [bayarkit](https://github.com/sasateguh/bayarkit): one interface for Malaysian payment gateways, and a checked way to confirm a
payment. [Bahasa Melayu](#bahasa-melayu)

**Evidence:** Official API spec PDF v13.97 (the official vcode test vector), WooCommerce plugin and PHP SDK; not yet measured on the sandbox.

```bash
npm install @bayarkit/core @bayarkit/fiuu
```

```ts
import { checkoutResponse, confirmPayment, readCallback } from '@bayarkit/core'
import { fiuu } from '@bayarkit/fiuu'

const gateway = fiuu({ merchantId, verifyKey, secretKey, environment: 'sandbox' })

// Checkout: one reference per attempt; amounts are integer sen (RM10.50 = 1050).
const payment = await gateway.createPayment({ reference, amount, description, customer, returnUrl, callbackUrl })
return checkoutResponse(payment) // a 303 redirect, or a self-submitting form when the gateway wants a POST

// Callback route: never mark an order paid from the callback body or the return URL alone.
const result = await confirmPayment(gateway, await readCallback(request), { reference, amount })
if (result.ok) {
  // mark the order paid (idempotently: gateways retry callbacks)
}
```

Test without real money: `startFakeFiuu` from `@bayarkit/testing` answers like this gateway (signed callbacks
included), and `npx bayarkit-fake fiuu` runs it as a server for tests in other languages.

## Traps

- The callback skey is a double MD5 over the raw POSTed strings, keyed with the SECRET key (not the verify key): md5(paydate.domain.md5(tranID.orderid.status.domain.amount.currency).appcode.secret_key). (API Spec v13.97 PDF p.20 (pdf page 21); WooCommerce class-gateway.php L1060-1077)
- Callback URL must ACK with plain-text CBTOKEN:MPSTATOK while return/notification URLs ACK by re-POSTing all fields plus treq=1 to returnipn.php; retry count is 3 in the spec but 4 in the cheatsheet. (API Spec v13.97 PDF p.52-59 (pdf 53-60); Cheatsheet README L38)
- When 'extended vcode' is enabled in the portal the currency must be appended to the vcode hash, but the official PHP SDK never appends it, so its payment links fail with error P03. (API Spec v13.97 PDF p.18-19 (pdf 19-20); SDK-Fiuu_PHP src/lib/Payment.php L36)
- Callback currency can arrive as 'RM' instead of 'MYR' (the official plugin normalises it), so compare currencies after normalising but hash the raw value. (WooCommerce class-gateway.php L977-978)

The full contract, with a source for every fact: [gateways/fiuu/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/fiuu/spec.md).

## Need help installing?

If you would rather not wire up a payment gateway yourself, Sasa Teguh, the studio that maintains bayarkit, can install it on your site or app and test it against the gateway sandbox before you go live.

[Contact page](https://sasateguh.com/contact) · Email: [admin@sasateguh.com](mailto:admin@sasateguh.com) · WhatsApp: [017-762 9379](https://wa.me/60177629379)

## Bahasa Melayu

Fiuu (dahulu Razer Merchant Services / MOLPay) untuk [bayarkit](https://github.com/sasateguh/bayarkit): satu antara muka untuk gateway pembayaran Malaysia, dan cara bersemak untuk
mengesahkan bayaran.

**Bukti:** PDF spesifikasi API rasmi v13.97 (vektor ujian vcode rasmi), plugin WooCommerce dan SDK PHP; belum diukur pada sandbox.

```bash
npm install @bayarkit/core @bayarkit/fiuu
```

Contoh kod di atas sama untuk semua gateway: hanya adapter dan kuncinya yang berubah. Jumlah ialah sen integer
(RM10.50 = 1050). Jangan tanda pesanan dibayar daripada badan callback atau pautan kembali semata-mata;
`confirmPayment` menyemak tandatangan, bertanya gateway semula, dan memadankan rujukan, jumlah dan mata wang.

Uji tanpa wang sebenar: `startFakeFiuu` daripada `@bayarkit/testing`, atau `npx bayarkit-fake fiuu` sebagai
pelayan.

## Perangkap

- skey callback ialah MD5 berganda ke atas rentetan mentah yang di-POST, berkunci kunci RAHSIA (bukan verify key): md5(paydate.domain.md5(tranID.orderid.status.domain.amount.currency).appcode.secret_key). (API Spec v13.97 PDF p.20 (pdf page 21); WooCommerce class-gateway.php L1060-1077)
- URL callback mesti ACK dengan teks biasa CBTOKEN:MPSTATOK manakala URL return/notification ACK dengan POST semula semua medan serta treq=1 ke returnipn.php; bilangan cubaan semula ialah 3 dalam spesifikasi tetapi 4 dalam cheatsheet. (API Spec v13.97 PDF p.52-59 (pdf 53-60); Cheatsheet README L38)
- Apabila 'extended vcode' dihidupkan dalam portal, mata wang mesti ditambah pada hash vcode, tetapi SDK PHP rasmi tidak pernah menambahnya, jadi pautan bayarannya gagal dengan ralat P03. (API Spec v13.97 PDF p.18-19 (pdf 19-20); SDK-Fiuu_PHP src/lib/Payment.php L36)
- Mata wang callback boleh tiba sebagai 'RM' dan bukannya 'MYR' (plugin rasmi menormalkannya), jadi bandingkan mata wang selepas dinormalkan tetapi hash nilai mentah. (WooCommerce class-gateway.php L977-978)

Kontrak penuh, dengan sumber bagi setiap fakta: [gateways/fiuu/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/fiuu/spec.md).
Dokumentasi penuh: [README.ms.md](https://github.com/sasateguh/bayarkit/blob/main/README.ms.md).

## Perlukan bantuan memasang?

Jika anda tidak mahu menyambung gateway pembayaran sendiri, Sasa Teguh, studio yang menyelenggara bayarkit, boleh memasangnya di laman atau aplikasi anda dan mengujinya pada sandbox gateway sebelum anda mula menerima bayaran.

[Halaman hubungi](https://sasateguh.com/ms/contact) · E-mel: [admin@sasateguh.com](mailto:admin@sasateguh.com) · WhatsApp: [017-762 9379](https://wa.me/60177629379)

MIT © Muhammad Aiman
