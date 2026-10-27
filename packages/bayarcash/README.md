# @bayarkit/bayarcash

Bayarcash (also behind BCL.my) for [bayarkit](https://github.com/sasateguh/bayarkit): one interface for Malaysian payment gateways, and a checked way to confirm a
payment. [Bahasa Melayu](#bahasa-melayu)

**Evidence:** Official API v3 docs and PHP SDK; not yet measured on the sandbox.

```bash
npm install @bayarkit/core @bayarkit/bayarcash
```

```ts
import { checkoutResponse, confirmPayment, readCallback } from '@bayarkit/core'
import { bayarcash } from '@bayarkit/bayarcash'

const gateway = bayarcash({ token, secretKey, portalKey, environment: 'sandbox' })

// Checkout: one reference per attempt; amounts are integer sen (RM10.50 = 1050).
const payment = await gateway.createPayment({ reference, amount, description, customer, returnUrl, callbackUrl })
return checkoutResponse(payment) // a 303 redirect, or a self-submitting form when the gateway wants a POST

// Callback route: never mark an order paid from the callback body or the return URL alone.
const result = await confirmPayment(gateway, await readCallback(request), { reference, amount })
if (result.ok) {
  // mark the order paid (idempotently: gateways retry callbacks)
}
```

Test without real money: `startFakeBayarcash` from `@bayarkit/testing` answers like this gateway (signed callbacks
included), and `npx bayarkit-fake bayarcash` runs it as a server for tests in other languages.

## Traps

- The checksum sorts values by field NAME and joins them with `|`; a `payment_channel` list is joined with `,` inside it. (official PHP SDK ChecksumGenerator + tests)
- `amount` is ringgit with two decimals ("25.00") in both the JSON body and the checksum; a callback may carry it as a number. (official PHP SDK tests)

The full contract, with a source for every fact: [gateways/bayarcash/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/bayarcash/spec.md).

## Bahasa Melayu

Bayarcash (juga di belakang BCL.my) untuk [bayarkit](https://github.com/sasateguh/bayarkit): satu antara muka untuk gateway pembayaran Malaysia, dan cara bersemak untuk
mengesahkan bayaran.

**Bukti:** Dokumen rasmi API v3 dan SDK PHP; belum diukur pada sandbox.

```bash
npm install @bayarkit/core @bayarkit/bayarcash
```

Contoh kod di atas sama untuk semua gateway: hanya adapter dan kuncinya yang berubah. Jumlah ialah sen integer
(RM10.50 = 1050). Jangan tanda pesanan dibayar daripada badan callback atau pautan kembali semata-mata;
`confirmPayment` menyemak tandatangan, bertanya gateway semula, dan memadankan rujukan, jumlah dan mata wang.

Uji tanpa wang sebenar: `startFakeBayarcash` daripada `@bayarkit/testing`, atau `npx bayarkit-fake bayarcash` sebagai
pelayan. Perangkap gateway ini (dengan sumber) disenaraikan di atas dalam bahasa Inggeris. Kontrak penuh:
[gateways/bayarcash/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/bayarcash/spec.md). Dokumentasi penuh: [README.ms.md](https://github.com/sasateguh/bayarkit/blob/main/README.ms.md).

MIT © Muhammad Aiman
