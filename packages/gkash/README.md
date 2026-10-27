# @bayarkit/gkash

Gkash for [bayarkit](https://github.com/sasateguh/bayarkit): one interface for Malaysian payment gateways, and a checked way to confirm a
payment. [Bahasa Melayu](#bahasa-melayu)

**Evidence:** Official docs (SHA-512 signature test vectors), WooCommerce plugin and gkashmy SDKs; not yet measured on staging.

```bash
npm install @bayarkit/core @bayarkit/gkash
```

```ts
import { checkoutResponse, confirmPayment, readCallback } from '@bayarkit/core'
import { gkash } from '@bayarkit/gkash'

const gateway = gkash({ cid, signatureKey, environment: 'sandbox' })

// Checkout: one reference per attempt; amounts are integer sen (RM10.50 = 1050).
const payment = await gateway.createPayment({ reference, amount, description, customer, returnUrl, callbackUrl })
return checkoutResponse(payment) // a 303 redirect, or a self-submitting form when the gateway wants a POST

// Callback route: never mark an order paid from the callback body or the return URL alone.
const result = await confirmPayment(gateway, await readCallback(request), { reference, amount })
if (result.ok) {
  // mark the order paid (idempotently: gateways retry callbacks)
}
```

Test without real money: `startFakeGkash` from `@bayarkit/testing` answers like this gateway (signed callbacks
included), and `npx bayarkit-fake gkash` runs it as a server for tests in other languages.

## Traps

- The signed amount is the 2-decimal ringgit string with the dot removed and the leading zero kept (0.10 becomes "010", not integer sen 10). (https://doc.gkash.my/v2/web-payments#web-payments-create-checkout-session; wc-gkash.php L378-382)
- The callback signature covers the full uppercased status text ("88 - TRANSFERRED") and the amount Gkash sends, so verify with the raw posted values and separately compare amount/currency with the order. (https://doc.gkash.my/v2/web-payments#web-payments-handle-server-callback; wc-gkash.php L398-412, L517-524)
- Query and refund responses carry no signature, so a query cannot be authenticated beyond TLS and has no paid-time field. (https://doc.gkash.my/query-transaction-status#handle-query-response; https://doc.gkash.my/refund#handle-refund-response)
- Docs say version "1.5.5" while the official plugin and all SDKs send "1.5.0", and the production host api.gkash.my appears only in plugin/SDK code. (https://doc.gkash.my/v2/web-payments#web-payments-create-checkout-session; wc-gkash.php L137-142, L280)

The full contract, with a source for every fact: [gateways/gkash/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/gkash/spec.md).

## Bahasa Melayu

Gkash untuk [bayarkit](https://github.com/sasateguh/bayarkit): satu antara muka untuk gateway pembayaran Malaysia, dan cara bersemak untuk
mengesahkan bayaran.

**Bukti:** Dokumen rasmi (vektor ujian tandatangan SHA-512), plugin WooCommerce dan SDK gkashmy; belum diukur pada staging.

```bash
npm install @bayarkit/core @bayarkit/gkash
```

Contoh kod di atas sama untuk semua gateway: hanya adapter dan kuncinya yang berubah. Jumlah ialah sen integer
(RM10.50 = 1050). Jangan tanda pesanan dibayar daripada badan callback atau pautan kembali semata-mata;
`confirmPayment` menyemak tandatangan, bertanya gateway semula, dan memadankan rujukan, jumlah dan mata wang.

Uji tanpa wang sebenar: `startFakeGkash` daripada `@bayarkit/testing`, atau `npx bayarkit-fake gkash` sebagai
pelayan. Perangkap gateway ini (dengan sumber) disenaraikan di atas dalam bahasa Inggeris. Kontrak penuh:
[gateways/gkash/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/gkash/spec.md). Dokumentasi penuh: [README.ms.md](https://github.com/sasateguh/bayarkit/blob/main/README.ms.md).

MIT © Muhammad Aiman
