# @bayarkit/paddle

Paddle Billing (merchant of record, no MYR) for [bayarkit](https://github.com/sasateguh/bayarkit): one interface for Malaysian and global payment gateways, and a checked way to confirm a
payment. [Bahasa Melayu](#bahasa-melayu)

**Evidence:** Official Paddle Billing docs and paddle-node-sdk (webhook test vector); charges in USD or another Paddle currency, never MYR; not yet measured on the sandbox.

```bash
npm install @bayarkit/core @bayarkit/paddle
```

```ts
import { checkoutResponse, confirmPayment, readCallback } from '@bayarkit/core'
import { paddle } from '@bayarkit/paddle'

const gateway = paddle({ apiKey, webhookSecret, currency: 'USD' })

// Checkout: one reference per attempt; amounts are integers in the currency's smallest unit (USD 10.50 = 1050).
const payment = await gateway.createPayment({ reference, amount, description, customer, returnUrl, callbackUrl })
return checkoutResponse(payment) // a 303 redirect, or a self-submitting form when the gateway wants a POST

// Callback route: never mark an order paid from the callback body or the return URL alone.
const result = await confirmPayment(gateway, await readCallback(request), { reference, amount, currency: 'USD' })
if (result.ok) {
  // mark the order paid (idempotently: gateways retry callbacks)
}
```

Paddle has no per-payment return or callback URL: `returnUrl` and `callbackUrl` are not sent. Set a default payment link in Paddle > Checkout (a page of yours that loads Paddle.js) before the first payment, and add a notification destination for `transaction.*` events that points at your callback route. For an overlay checkout, pass `payment.id` to `Paddle.Checkout.open({ transactionId })`.

Test without real money: `startFakePaddle` from `@bayarkit/testing` answers like this gateway (signed callbacks
included), and `npx bayarkit-fake paddle` runs it as a server for tests in other languages.

## Traps

- Paddle has no Malaysian ringgit: MYR is not a payment currency, and balances are held only in USD, EUR, GBP, AUD or CAD. Price in USD (or another listed currency) and state `currency` in every `Expected`; each currency has its own minimum (USD 0.70). (developer.paddle.com/concepts/sell/supported-currencies)
- Paddle is the merchant of record and adds tax per buyer country. With the default `tax_mode` the buyer can pay more than your price, so the total is unknown before checkout. Send `tax_mode: internal` (price includes tax) and compare `details.totals.grand_total`. (developer.paddle.com create/get transaction; gateways/paddle/spec.md §2.3)
- No transaction can be created until the account's default payment link is set (`transaction_default_checkout_url_not_set`). `checkout.url` is that link plus `?_ptxn=<transaction id>`, and the page must load Paddle.js to open the checkout. (developer.paddle.com/build/transactions/default-payment-link)
- `Paddle-Signature` is `ts=…;h1=…`: HMAC-SHA256 of `${ts}:${rawBody}` with the destination's secret. More than one `h1` can appear during secret rotation; the official SDKs reject a `ts` older than five seconds. (developer.paddle.com/webhooks/about/signature-verification; paddle-node-sdk webhooks-validator.ts)
- A declined card does not change a one-time transaction's status: it adds an `error` entry to `payments[]` and sends `transaction.payment_failed`. Both `paid` and `completed` mean the payment was captured. (developer.paddle.com transaction.payment_failed, transaction.paid)
- Refunds are adjustments on `completed` transactions only, and most live refunds wait in `pending_approval` (sandbox approves every ten minutes). The transaction stays `completed` after a refund; read `details.adjusted_totals`. There is no idempotency key: a second refund while one is pending is refused (`adjustment_pending_refund_request`). (developer.paddle.com/api-reference/adjustments/create-adjustment)

The full contract, with a source for every fact: [gateways/paddle/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/paddle/spec.md).

## Bahasa Melayu

Paddle Billing (penjual rasmi, tiada MYR) untuk [bayarkit](https://github.com/sasateguh/bayarkit): satu antara muka untuk gateway pembayaran Malaysia dan global, dan cara bersemak untuk
mengesahkan bayaran.

**Bukti:** Dokumen rasmi Paddle Billing dan paddle-node-sdk (vektor ujian webhook); caj dalam USD atau mata wang Paddle lain, bukan MYR; belum diukur pada sandbox.

```bash
npm install @bayarkit/core @bayarkit/paddle
```

Contoh kod di atas sama untuk semua gateway: hanya adapter dan kuncinya yang berubah. Jumlah ialah integer dalam unit terkecil
mata wang (USD 10.50 = 1050), dan `currency` dinyatakan dalam setiap semakan. Jangan tanda pesanan dibayar daripada badan callback atau pautan kembali semata-mata;
`confirmPayment` menyemak tandatangan, bertanya gateway semula, dan memadankan rujukan, jumlah dan mata wang.

Paddle tiada URL kembali atau callback bagi setiap bayaran: `returnUrl` dan `callbackUrl` tidak dihantar. Tetapkan pautan pembayaran lalai dalam Paddle > Checkout (halaman anda sendiri yang memuatkan Paddle.js) sebelum bayaran pertama, dan tambah destinasi notifikasi untuk acara `transaction.*` yang menghala ke laluan callback anda. Untuk checkout overlay, hantar `payment.id` kepada `Paddle.Checkout.open({ transactionId })`.

Uji tanpa wang sebenar: `startFakePaddle` daripada `@bayarkit/testing`, atau `npx bayarkit-fake paddle` sebagai
pelayan.

## Perangkap

- Paddle tiada ringgit Malaysia: MYR bukan mata wang pembayaran, dan baki hanya disimpan dalam USD, EUR, GBP, AUD atau CAD. Letak harga dalam USD (atau mata wang lain yang disenaraikan) dan nyatakan `currency` dalam setiap `Expected`; setiap mata wang ada minimum sendiri (USD 0.70). (developer.paddle.com/concepts/sell/supported-currencies)
- Paddle ialah penjual rasmi (merchant of record) dan menambah cukai ikut negara pembeli. Dengan `tax_mode` lalai, pembeli boleh membayar lebih daripada harga anda, jadi jumlahnya tidak diketahui sebelum checkout. Hantar `tax_mode: internal` (harga termasuk cukai) dan bandingkan `details.totals.grand_total`. (developer.paddle.com create/get transaction; gateways/paddle/spec.md §2.3)
- Tiada transaksi boleh dicipta selagi pautan pembayaran lalai akaun belum ditetapkan (`transaction_default_checkout_url_not_set`). `checkout.url` ialah pautan itu ditambah `?_ptxn=<id transaksi>`, dan halaman itu mesti memuatkan Paddle.js untuk membuka checkout. (developer.paddle.com/build/transactions/default-payment-link)
- `Paddle-Signature` berbentuk `ts=…;h1=…`: HMAC-SHA256 bagi `${ts}:${rawBody}` dengan rahsia destinasi itu. Lebih daripada satu `h1` boleh muncul semasa putaran rahsia; SDK rasmi menolak `ts` yang lebih lama daripada lima saat. (developer.paddle.com/webhooks/about/signature-verification; paddle-node-sdk webhooks-validator.ts)
- Kad yang ditolak tidak mengubah status transaksi sekali bayar: ia menambah entri `error` dalam `payments[]` dan menghantar `transaction.payment_failed`. `paid` dan `completed` kedua-duanya bermaksud bayaran sudah ditangkap. (developer.paddle.com transaction.payment_failed, transaction.paid)
- Bayaran balik ialah adjustment pada transaksi `completed` sahaja, dan kebanyakan bayaran balik live menunggu dalam `pending_approval` (sandbox meluluskan setiap sepuluh minit). Transaksi kekal `completed` selepas bayaran balik; baca `details.adjusted_totals`. Tiada kunci idempotensi: bayaran balik kedua semasa satu masih menunggu ditolak (`adjustment_pending_refund_request`). (developer.paddle.com/api-reference/adjustments/create-adjustment)

Kontrak penuh, dengan sumber bagi setiap fakta: [gateways/paddle/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/paddle/spec.md).
Dokumentasi penuh: [README.ms.md](https://github.com/sasateguh/bayarkit/blob/main/README.ms.md).

MIT © Muhammad Aiman
