# @bayarkit/toyyibpay

toyyibPay for [bayarkit](https://github.com/sasateguh/bayarkit): one interface for Malaysian payment gateways, and a checked way to confirm a
payment. [Bahasa Melayu](#bahasa-melayu)

**Evidence:** Measured on the sandbox, 10 Oct 2026, including a real test-bank FPX payment; the status query's `userSecretKey` (docs change of 23 Oct 2026) not yet re-measured.

```bash
npm install @bayarkit/core @bayarkit/toyyibpay
```

```ts
import { checkoutResponse, confirmPayment, readCallback } from '@bayarkit/core'
import { toyyibpay } from '@bayarkit/toyyibpay'

const gateway = toyyibpay({ secretKey, categoryCode, environment: 'sandbox' })

// Checkout: one reference per attempt; amounts are integer sen (RM10.50 = 1050).
const payment = await gateway.createPayment({ reference, amount, description, customer, returnUrl, callbackUrl })
return checkoutResponse(payment) // a 303 redirect, or a self-submitting form when the gateway wants a POST

// Callback route: never mark an order paid from the callback body or the return URL alone.
const result = await confirmPayment(gateway, await readCallback(request), { reference, amount })
if (result.ok) {
  // mark the order paid (idempotently: gateways retry callbacks)
}
```

Test without real money: `startFakeToyyibPay` from `@bayarkit/testing` answers like this gateway (signed callbacks
included), and `npx bayarkit-fake toyyibpay` runs it as a server for tests in other languages.

## Traps

- A bill with no transactions answers the text `No data found!`, not `[]`: a strict JSON parser reports every unpaid bill as an error. (gateways/toyyibpay/spec.md (measured))
- Callbacks arrive as `multipart/form-data`; code that only parses URL-encoded bodies sees no fields. (gateways/toyyibpay/spec.md (measured))
- `billExpiryDate` is read in Malaysia time, and RM1.00 (100 sen) itself is accepted although the docs say "more than RM1.00". (gateways/toyyibpay/spec.md (measured))

The full contract, with a source for every fact: [gateways/toyyibpay/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/toyyibpay/spec.md).

## Bahasa Melayu

toyyibPay untuk [bayarkit](https://github.com/sasateguh/bayarkit): satu antara muka untuk gateway pembayaran Malaysia, dan cara bersemak untuk
mengesahkan bayaran.

**Bukti:** Diukur pada sandbox, 10 Okt 2026, termasuk satu bayaran FPX sebenar dengan bank ujian; `userSecretKey` dalam pertanyaan status (perubahan dokumen 23 Okt 2026) belum diukur semula.

```bash
npm install @bayarkit/core @bayarkit/toyyibpay
```

Contoh kod di atas sama untuk semua gateway: hanya adapter dan kuncinya yang berubah. Jumlah ialah sen integer
(RM10.50 = 1050). Jangan tanda pesanan dibayar daripada badan callback atau pautan kembali semata-mata;
`confirmPayment` menyemak tandatangan, bertanya gateway semula, dan memadankan rujukan, jumlah dan mata wang.

Uji tanpa wang sebenar: `startFakeToyyibPay` daripada `@bayarkit/testing`, atau `npx bayarkit-fake toyyibpay` sebagai
pelayan. Perangkap gateway ini (dengan sumber) disenaraikan di atas dalam bahasa Inggeris. Kontrak penuh:
[gateways/toyyibpay/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/toyyibpay/spec.md). Dokumentasi penuh: [README.ms.md](https://github.com/sasateguh/bayarkit/blob/main/README.ms.md).

MIT © Muhammad Aiman
