# @bayarkit/bayarcash

Bayarcash (also behind BCL.my) for [bayarkit](https://github.com/sasateguh/bayarkit): one interface for Malaysian payment gateways, and a checked way to confirm a
payment. [Bahasa Melayu](#bahasa-melayu)

**Evidence:** Measured on the sandbox, 27 Oct 2026: a paid and a failed FPX payment through the adapter (return URL, status query, portal); the server-to-server callback was not observed.

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

- The API secret key is account-wide: a correctly signed return or callback can belong to another portal in the same account. A transaction names its portal by NAME (`portal`), so give every portal a unique name; the adapter compares it with the configured portal key's name. (gateways/bayarcash/spec.md (measured))
- The checkout id is a payment intent (`pi_…`), not a transaction: `GET /transactions/pi_…` is 404. Read it with `GET /payment-intents/{id}` (status and attempts), which answers 201 even though it is a read. (gateways/bayarcash/spec.md (measured))
- The checksum sorts values by field NAME and joins them with `|`; a `payment_channel` list is joined with `,` inside it. (official PHP SDK ChecksumGenerator + tests)
- `amount` is ringgit with two decimals ("25.00") in both the JSON body and the checksum; a callback may carry it as a number. (official PHP SDK tests)

The full contract, with a source for every fact: [gateways/bayarcash/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/bayarcash/spec.md).

## Bahasa Melayu

Bayarcash (juga di belakang BCL.my) untuk [bayarkit](https://github.com/sasateguh/bayarkit): satu antara muka untuk gateway pembayaran Malaysia, dan cara bersemak untuk
mengesahkan bayaran.

**Bukti:** Diukur pada sandbox, 27 Okt 2026: satu bayaran FPX berjaya dan satu gagal melalui adapter (URL return, pertanyaan status, portal); callback pelayan-ke-pelayan tidak diperhatikan.

```bash
npm install @bayarkit/core @bayarkit/bayarcash
```

Contoh kod di atas sama untuk semua gateway: hanya adapter dan kuncinya yang berubah. Jumlah ialah sen integer
(RM10.50 = 1050). Jangan tanda pesanan dibayar daripada badan callback atau pautan kembali semata-mata;
`confirmPayment` menyemak tandatangan, bertanya gateway semula, dan memadankan rujukan, jumlah dan mata wang.

Uji tanpa wang sebenar: `startFakeBayarcash` daripada `@bayarkit/testing`, atau `npx bayarkit-fake bayarcash` sebagai
pelayan.

## Perangkap

- Kunci rahsia API meliputi seluruh akaun: return atau callback yang ditandatangani dengan betul boleh milik portal lain dalam akaun yang sama. Transaksi menamakan portalnya ikut NAMA (`portal`), jadi beri setiap portal nama yang unik; adapter membandingkannya dengan nama bagi kunci portal yang dikonfigurasi. (gateways/bayarcash/spec.md (measured))
- Id checkout ialah payment intent (`pi_…`), bukan transaksi: `GET /transactions/pi_…` memberi 404. Baca dengan `GET /payment-intents/{id}` (status dan percubaan), yang menjawab 201 walaupun ia bacaan. (gateways/bayarcash/spec.md (measured))
- Checksum mengisih nilai mengikut NAMA medan dan menyambungnya dengan `|`; senarai `payment_channel` disambung dengan `,` di dalamnya. (official PHP SDK ChecksumGenerator + tests)
- `amount` ialah ringgit dengan dua tempat perpuluhan ("25.00") dalam badan JSON dan dalam checksum; callback mungkin membawanya sebagai nombor. (official PHP SDK tests)

Kontrak penuh, dengan sumber bagi setiap fakta: [gateways/bayarcash/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/bayarcash/spec.md).
Dokumentasi penuh: [README.ms.md](https://github.com/sasateguh/bayarkit/blob/main/README.ms.md).

MIT © Muhammad Aiman
