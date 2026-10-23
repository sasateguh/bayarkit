# @bayarkit/senangpay

senangPay (on the DOKU platform) for [bayarkit](https://github.com/aimanmalib/bayarkit): one interface for Malaysian payment gateways, and the safe way to confirm a
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

The full contract, with a source for every fact: [gateways/senangpay/spec.md](https://github.com/aimanmalib/bayarkit/blob/main/gateways/senangpay/spec.md).

## Bahasa Melayu

senangPay (di platform DOKU) untuk [bayarkit](https://github.com/aimanmalib/bayarkit): satu antara muka untuk gateway pembayaran Malaysia, dan cara selamat untuk
mengesahkan bayaran.

**Bukti:** Rujukan API rasmi DOKU Malaysia (Checkout, Signature `HMACSHA256=`) dan Soalan Lazim DOKU senangPay; belum diukur pada sandbox.

```bash
npm install @bayarkit/core @bayarkit/senangpay
```

Contoh kod di atas sama untuk semua gateway: tukar gateway dengan menukar satu baris. Jumlah ialah sen integer
(RM10.50 = 1050). Jangan tanda pesanan dibayar daripada badan callback atau pautan kembali semata-mata;
`confirmPayment` menyemak tandatangan, bertanya gateway semula, dan memadankan rujukan, jumlah dan mata wang.

Uji tanpa wang sebenar: `startFakeSenangPay` daripada `@bayarkit/testing`, atau `npx bayarkit-fake senangpay` sebagai
pelayan. Perangkap gateway ini (dengan sumber) disenaraikan di atas dalam bahasa Inggeris. Kontrak penuh:
[gateways/senangpay/spec.md](https://github.com/aimanmalib/bayarkit/blob/main/gateways/senangpay/spec.md). Dokumentasi penuh: [README.ms.md](https://github.com/aimanmalib/bayarkit/blob/main/README.ms.md).

MIT © Muhammad Aiman
