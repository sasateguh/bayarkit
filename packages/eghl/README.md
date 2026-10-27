# @bayarkit/eghl

eGHL (ADAPTIS e-Commerce) for [bayarkit](https://github.com/sasateguh/bayarkit): one interface for Malaysian payment gateways, and a checked way to confirm a
payment. [Bahasa Melayu](#bahasa-melayu)

**Evidence:** Official eGHL public code (hash class, merchant-api QUERY, Omnipay HashValue2 test vector; no public API guide exists); not yet measured on the test host.

```bash
npm install @bayarkit/core @bayarkit/eghl
```

```ts
import { checkoutResponse, confirmPayment, readCallback } from '@bayarkit/core'
import { eghl } from '@bayarkit/eghl'

const gateway = eghl({ serviceId, merchantPassword, environment: 'sandbox', fallbackCustomerIp })

// Checkout: one reference per attempt; amounts are integer sen (RM10.50 = 1050).
const payment = await gateway.createPayment({ reference, amount, description, customer, returnUrl, callbackUrl })
return checkoutResponse(payment) // a 303 redirect, or a self-submitting form when the gateway wants a POST

// Callback route: never mark an order paid from the callback body or the return URL alone.
const result = await confirmPayment(gateway, await readCallback(request), { reference, amount })
if (result.ok) {
  // mark the order paid (idempotently: gateways retry callbacks)
}
```

Test without real money: `startFakeEghl` from `@bayarkit/testing` answers like this gateway (signed callbacks
included), and `npx bayarkit-fake eghl` runs it as a server for tests in other languages.

## Traps

- Official plugins disagree on the HashValue2 field list: eGHL_HASH and WHMCS hash ...OrderNumber+Param6+Param7, Magento 2.1.7 omits Param7, and OpenCart omits both Param6 and Param7, so a callback carrying Param7 fails verification in some plugins. (bitbucket.org/eghl/eghl_hash eGHL_HASH.php line 2 vs bitbucket.org/eghl/adaptis-magento @faacfb1 zip Controller/Index/ResponseHandler.gte_m230.php:623-646 vs bitbucket.org/eghl/adaptis-opencart @38c0db3 zip catalog/controller/payment/ghl.php:206)
- The signature is plain SHA-256 over MerchantPassword concatenated with the field values (no separator, not HMAC), and the official hash class silently returns sha256(password) alone when a mandatory field is missing. (https://bitbucket.org/eghl/eghl_hash/raw/HEAD/eGHL_HASH.php)
- The server callback must answer with the plain body 'OK'; the browser return URL and the server callback receive the same fields, so both must verify the hash and be idempotent. (https://bitbucket.org/eghl/eghl-omnipay/raw/HEAD/README.md (lines 37-38, 96))
- Amount is ringgit as a string with exactly two decimals and no comma ('10.00', not sen), and the query must repeat the original Amount and CurrencyCode exactly or it will not find the transaction. (https://bitbucket.org/eghl/paramvalidator/raw/HEAD/src/core/validatorBase.php (isValidAmount) + https://bitbucket.org/eghl/merchantapi/raw/HEAD/README.md)

The full contract, with a source for every fact: [gateways/eghl/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/eghl/spec.md).

## Bahasa Melayu

eGHL (ADAPTIS e-Commerce) untuk [bayarkit](https://github.com/sasateguh/bayarkit): satu antara muka untuk gateway pembayaran Malaysia, dan cara bersemak untuk
mengesahkan bayaran.

**Bukti:** Kod awam rasmi eGHL (kelas hash, QUERY merchant-api, vektor ujian HashValue2 Omnipay; tiada panduan API awam); belum diukur pada hos ujian.

```bash
npm install @bayarkit/core @bayarkit/eghl
```

Contoh kod di atas sama untuk semua gateway: hanya adapter dan kuncinya yang berubah. Jumlah ialah sen integer
(RM10.50 = 1050). Jangan tanda pesanan dibayar daripada badan callback atau pautan kembali semata-mata;
`confirmPayment` menyemak tandatangan, bertanya gateway semula, dan memadankan rujukan, jumlah dan mata wang.

Uji tanpa wang sebenar: `startFakeEghl` daripada `@bayarkit/testing`, atau `npx bayarkit-fake eghl` sebagai
pelayan. Perangkap gateway ini (dengan sumber) disenaraikan di atas dalam bahasa Inggeris. Kontrak penuh:
[gateways/eghl/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/eghl/spec.md). Dokumentasi penuh: [README.ms.md](https://github.com/sasateguh/bayarkit/blob/main/README.ms.md).

MIT © Muhammad Aiman
