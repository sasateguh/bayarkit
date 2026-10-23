# @bayarkit/billplz

Billplz for [bayarkit](https://github.com/aimanmalib/bayarkit): one interface for Malaysian payment gateways, and the safe way to confirm a
payment. [Bahasa Melayu](#bahasa-melayu)

**Evidence:** Official API docs (V3 Bills, X Signature test vectors) and the official WooCommerce plugin; not yet measured on the sandbox.

```bash
npm install @bayarkit/core @bayarkit/billplz
```

```ts
import { checkoutResponse, confirmPayment, readCallback } from '@bayarkit/core'
import { billplz } from '@bayarkit/billplz'

const gateway = billplz({ secretKey, xSignatureKey, collectionId, environment: 'sandbox' })

// Checkout: one reference per attempt; amounts are integer sen (RM10.50 = 1050).
const payment = await gateway.createPayment({ reference, amount, description, customer, returnUrl, callbackUrl })
return checkoutResponse(payment) // a 303 redirect, or a self-submitting form when the gateway wants a POST

// Callback route: never mark an order paid from the callback body or the return URL alone.
const result = await confirmPayment(gateway, await readCallback(request), { reference, amount })
if (result.ok) {
  // mark the order paid (idempotently: gateways retry callbacks)
}
```

Test without real money: `startFakeBillplz` from `@bayarkit/testing` answers like this gateway (signed callbacks
included), and `npx bayarkit-fake billplz` runs it as a server for tests in other languages.

## Traps

- X Signature sorts the concatenated `key+value` strings, not the keys: the docs' "sort keys" wording gives a different HMAC than the official plugin and test vectors. (support.billplz.com/api X Signature steps; official WooCommerce plugin L336–341)
- Answer the callback with HTTP 200 within 20 s or Billplz retries (up to 5 attempts over ~24 h), and callback and redirect arrive in no fixed order. (support.billplz.com/api callback retry schedule)
- A deleted bill comes back if the customer completes a payment already in flight, so `paid=true` can arrive after DELETE. (support.billplz.com/api delete bill)

The full contract, with a source for every fact: [gateways/billplz/spec.md](https://github.com/aimanmalib/bayarkit/blob/main/gateways/billplz/spec.md).

## Bahasa Melayu

Billplz untuk [bayarkit](https://github.com/aimanmalib/bayarkit): satu antara muka untuk gateway pembayaran Malaysia, dan cara selamat untuk
mengesahkan bayaran.

**Bukti:** Dokumen rasmi API (V3 Bills, vektor ujian X Signature) dan plugin WooCommerce rasmi; belum diukur pada sandbox.

```bash
npm install @bayarkit/core @bayarkit/billplz
```

Contoh kod di atas sama untuk semua gateway: tukar gateway dengan menukar satu baris. Jumlah ialah sen integer
(RM10.50 = 1050). Jangan tanda pesanan dibayar daripada badan callback atau pautan kembali semata-mata;
`confirmPayment` menyemak tandatangan, bertanya gateway semula, dan memadankan rujukan, jumlah dan mata wang.

Uji tanpa wang sebenar: `startFakeBillplz` daripada `@bayarkit/testing`, atau `npx bayarkit-fake billplz` sebagai
pelayan. Perangkap gateway ini (dengan sumber) disenaraikan di atas dalam bahasa Inggeris. Kontrak penuh:
[gateways/billplz/spec.md](https://github.com/aimanmalib/bayarkit/blob/main/gateways/billplz/spec.md). Dokumentasi penuh: [README.ms.md](https://github.com/aimanmalib/bayarkit/blob/main/README.ms.md).

MIT © Muhammad Aiman
