# @bayarkit/billplz

Billplz for [bayarkit](https://github.com/sasateguh/bayarkit): one interface for Malaysian payment gateways, and a checked way to confirm a
payment. [Bahasa Melayu](#bahasa-melayu)

**Evidence:** Measured on the sandbox, 27 Oct 2026: a paid and a failed payment, with the real callback and the redirect verified by the adapter.

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

- Neither the callback nor the redirect carries your reference (`reference_1`): find the order by the bill id saved at checkout, then let the status query return the reference. (gateways/billplz/spec.md (measured))
- A failed payment still sends a callback, with `paid=false` and `state=due`: a callback is not proof of payment either way, so read the bill. (gateways/billplz/spec.md (measured))
- X Signature sorts the concatenated `key+value` strings, not the keys: the docs' "sort keys" wording gives a different HMAC than the official plugin and test vectors. (support.billplz.com/api X Signature steps; official WooCommerce plugin L336–341)
- Answer the callback with HTTP 200 within 20 s or Billplz retries (up to 5 attempts over ~24 h), and callback and redirect arrive in no fixed order. (support.billplz.com/api callback retry schedule)
- A deleted bill comes back if the customer completes a payment already in flight, so `paid=true` can arrive after DELETE. (support.billplz.com/api delete bill)

The full contract, with a source for every fact: [gateways/billplz/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/billplz/spec.md).

## Bahasa Melayu

Billplz untuk [bayarkit](https://github.com/sasateguh/bayarkit): satu antara muka untuk gateway pembayaran Malaysia, dan cara bersemak untuk
mengesahkan bayaran.

**Bukti:** Diukur pada sandbox, 27 Okt 2026: satu bayaran berjaya dan satu gagal, dengan callback sebenar dan ubah hala disahkan oleh adapter.

```bash
npm install @bayarkit/core @bayarkit/billplz
```

Contoh kod di atas sama untuk semua gateway: hanya adapter dan kuncinya yang berubah. Jumlah ialah sen integer
(RM10.50 = 1050). Jangan tanda pesanan dibayar daripada badan callback atau pautan kembali semata-mata;
`confirmPayment` menyemak tandatangan, bertanya gateway semula, dan memadankan rujukan, jumlah dan mata wang.

Uji tanpa wang sebenar: `startFakeBillplz` daripada `@bayarkit/testing`, atau `npx bayarkit-fake billplz` sebagai
pelayan.

## Perangkap

- Callback dan ubah hala tidak membawa rujukan anda (`reference_1`): cari pesanan ikut id bil yang disimpan semasa checkout, kemudian biar pertanyaan status memulangkan rujukan itu. (gateways/billplz/spec.md (measured))
- Bayaran yang gagal tetap menghantar callback, dengan `paid=false` dan `state=due`: callback bukan bukti bayaran dalam apa jua keadaan, jadi baca bil itu. (gateways/billplz/spec.md (measured))
- X Signature mengisih rentetan `key+value` yang telah disambung, bukan kunci: perkataan "sort keys" dalam dokumen memberi HMAC yang berbeza daripada plugin rasmi dan vektor ujian. (support.billplz.com/api X Signature steps; official WooCommerce plugin L336–341)
- Jawab callback dengan HTTP 200 dalam masa 20 s atau Billplz akan mencuba semula (sehingga 5 percubaan dalam ~24 j), dan callback serta redirect tiba tanpa susunan tetap. (support.billplz.com/api callback retry schedule)
- Bil yang telah dipadam muncul semula jika pelanggan menyelesaikan bayaran yang sedang berjalan, jadi `paid=true` boleh tiba selepas DELETE. (support.billplz.com/api delete bill)

Kontrak penuh, dengan sumber bagi setiap fakta: [gateways/billplz/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/billplz/spec.md).
Dokumentasi penuh: [README.ms.md](https://github.com/sasateguh/bayarkit/blob/main/README.ms.md).

MIT © Muhammad Aiman
