# @bayarkit/paypal

PayPal Orders v2 (approve, then capture) for [bayarkit](https://github.com/sasateguh/bayarkit): one interface for Malaysian and global payment gateways, and a checked way to confirm a
payment. [Bahasa Melayu](#bahasa-melayu)

**Evidence:** Measured on the sandbox, 30 Oct 2026: buyer approval, captures in USD and MYR, real webhooks verified by PayPal's postback, full and partial refunds; paid only when the capture is COMPLETED.

```bash
npm install @bayarkit/core @bayarkit/paypal
```

```ts
import { checkoutResponse, confirmPayment, readCallback } from '@bayarkit/core'
import { paypal } from '@bayarkit/paypal'

const gateway = paypal({ clientId, clientSecret, webhookId, currency: 'USD' })

// Checkout: one reference per attempt; amounts are integers in the currency's smallest unit (USD 10.50 = 1050).
const payment = await gateway.createPayment({ reference, amount, description, customer, returnUrl, callbackUrl })
return checkoutResponse(payment) // a 303 redirect, or a self-submitting form when the gateway wants a POST

// Return route: the buyer approved on PayPal, and nothing has moved yet. Capture it (safe to retry)
// with the payment.id you saved at checkout (PayPal appends ?token=<order id>&PayerID=…; do not trust the query).
await gateway.capturePayment(order.paymentId)

// Callback route: never mark an order paid from the callback body or the return URL alone.
const result = await confirmPayment(gateway, await readCallback(request), { reference, amount, currency: 'USD' })
if (result.ok) {
  // mark the order paid (idempotently: gateways retry callbacks)
}
```

PayPal takes two steps. The buyer approves on PayPal (order `APPROVED`: not paid), then your return route, or a `CHECKOUT.ORDER.APPROVED` webhook, calls `capturePayment(orderId)`. `getPayment` only reads and never captures. Mark the order paid with `confirmPayment` on the `PAYMENT.CAPTURE.COMPLETED` webhook. PayPal has no per-order callback URL: add a webhook to your REST app and pass its id as `webhookId`.

Test without real money: `startFakePayPal` from `@bayarkit/testing` answers like this gateway (signed callbacks
included), and `npx bayarkit-fake paypal` runs it as a server for tests in other languages.

## Traps

- An order can be `COMPLETED` while its capture is `DECLINED` or `PENDING`, and `APPROVED` only means the buyer agreed. Count a payment as paid only when `purchase_units[0].payments.captures[0].status` is `COMPLETED`, and take the amount from that capture. (developer.paypal.com/sandbox-testing/card-testing; Orders v2 OpenAPI capture_status)
- Put your reference in `purchase_units[0].custom_id` (up to 255 characters, hidden from the buyer, copied onto each capture). `invoice_id` is shown to the buyer and must be unique per account by default, so a second order for the same reference is refused. (Orders v2 OpenAPI purchase_unit_request)
- MYR works only for a PayPal account based in Malaysia; elsewhere PayPal converts it with a fee. HUF, JPY and TWD take no decimals in PayPal (HUF and TWD do in ISO 4217). A currency the account does not hold leaves the payment pending until the merchant accepts it. (developer.paypal.com/reference/currency-codes)
- Verify webhooks by posting the headers, your webhook id and the raw body to `/v1/notifications/verify-webhook-signature` and requiring `verification_status: SUCCESS`. Send the body exactly as received: parsing and re-serialising it can fail verification. Events from the dashboard simulator cannot be verified this way; test with real sandbox events. (developer.paypal.com/api/rest/webhooks/rest)
- `PayPal-Request-Id` makes create, capture and refund safe to retry: PayPal keeps it 6 hours on orders and 45 days on refunds. Use a new value per call type (never reuse the create id for capture); without the header a retry captures or refunds again. (developer.paypal.com/reference/guidelines/idempotency; /api/rest/requests)
- With `payment_source.paypal.experience_context` the new order is `PAYER_ACTION_REQUIRED` and the buyer link is `rel: payer-action`; the older flow returns `CREATED` with `rel: approve`. An uncaptured order expires: the guide says 3 hours, the API reference 6 hours. (developer.paypal.com/whats-an-order; Orders v2 OpenAPI order.links)
- Refunds take the capture id, not the order id: `POST /v2/payments/captures/{id}/refund` with an empty body refunds what is left, with `amount` refunds part. Over-refunding fails with `REFUND_AMOUNT_EXCEEDED`. (Payments v2 OpenAPI captures.refund)

The full contract, with a source for every fact: [gateways/paypal/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/paypal/spec.md).

## Bahasa Melayu

PayPal Orders v2 (lulus, kemudian tangkap) untuk [bayarkit](https://github.com/sasateguh/bayarkit): satu antara muka untuk gateway pembayaran Malaysia dan global, dan cara bersemak untuk
mengesahkan bayaran.

**Bukti:** Diukur pada sandbox, 30 Okt 2026: kelulusan pembeli, tangkapan dalam USD dan MYR, webhook sebenar disahkan melalui postback PayPal, bayaran balik penuh dan separa; dibayar hanya bila tangkapan COMPLETED.

```bash
npm install @bayarkit/core @bayarkit/paypal
```

Contoh kod di atas sama untuk semua gateway, kecuali langkah tangkap di laluan kembali (di bawah). Jumlah ialah integer dalam unit terkecil
mata wang (USD 10.50 = 1050), dan `currency` dinyatakan dalam setiap semakan. Jangan tanda pesanan dibayar daripada badan callback atau pautan kembali semata-mata;
`confirmPayment` menyemak tandatangan, bertanya gateway semula, dan memadankan rujukan, jumlah dan mata wang.

PayPal ada dua langkah. Pembeli meluluskan di PayPal (pesanan `APPROVED`: belum dibayar), kemudian laluan kembali anda, atau webhook `CHECKOUT.ORDER.APPROVED`, memanggil `capturePayment(orderId)`. `getPayment` hanya membaca dan tidak pernah menangkap. Tanda pesanan dibayar dengan `confirmPayment` pada webhook `PAYMENT.CAPTURE.COMPLETED`. PayPal tiada URL callback bagi setiap pesanan: tambah webhook pada aplikasi REST anda dan hantar idnya sebagai `webhookId`.

Uji tanpa wang sebenar: `startFakePayPal` daripada `@bayarkit/testing`, atau `npx bayarkit-fake paypal` sebagai
pelayan.

## Perangkap

- Pesanan boleh berstatus `COMPLETED` sedangkan tangkapannya `DECLINED` atau `PENDING`, dan `APPROVED` hanya bermaksud pembeli bersetuju. Kira bayaran sebagai dibayar hanya bila `purchase_units[0].payments.captures[0].status` ialah `COMPLETED`, dan ambil amaun daripada tangkapan itu. (developer.paypal.com/sandbox-testing/card-testing; Orders v2 OpenAPI capture_status)
- Letak rujukan anda dalam `purchase_units[0].custom_id` (hingga 255 aksara, tidak dilihat pembeli, disalin ke setiap tangkapan). `invoice_id` dipapar kepada pembeli dan mesti unik bagi setiap akaun secara lalai, jadi pesanan kedua untuk rujukan yang sama ditolak. (Orders v2 OpenAPI purchase_unit_request)
- MYR hanya berfungsi untuk akaun PayPal yang berpangkalan di Malaysia; di tempat lain PayPal menukarnya dengan caj. HUF, JPY dan TWD tiada perpuluhan dalam PayPal (HUF dan TWD ada perpuluhan dalam ISO 4217). Mata wang yang tidak dipegang akaun membiarkan bayaran tertunda sehingga peniaga menerimanya. (developer.paypal.com/reference/currency-codes)
- Sahkan webhook dengan menghantar pengepala, id webhook anda dan badan mentah ke `/v1/notifications/verify-webhook-signature`, dan wajibkan `verification_status: SUCCESS`. Hantar badan tepat seperti diterima: menghurai dan mensiri semula boleh menggagalkan pengesahan. Acara daripada simulator dashboard tidak boleh disahkan dengan cara ini; uji dengan acara sandbox sebenar. (developer.paypal.com/api/rest/webhooks/rest)
- `PayPal-Request-Id` menjadikan cipta, tangkap dan bayaran balik selamat diulang: PayPal menyimpannya 6 jam untuk pesanan dan 45 hari untuk bayaran balik. Guna nilai baharu bagi setiap jenis panggilan (jangan guna semula id cipta untuk tangkap); tanpa pengepala itu, ulangan menangkap atau memulangkan sekali lagi. (developer.paypal.com/reference/guidelines/idempotency; /api/rest/requests)
- Dengan `payment_source.paypal.experience_context`, pesanan baharu berstatus `PAYER_ACTION_REQUIRED` dan pautan pembeli ialah `rel: payer-action`; aliran lama memulangkan `CREATED` dengan `rel: approve`. Pesanan yang tidak ditangkap akan luput: panduan menyebut 3 jam, rujukan API 6 jam. (developer.paypal.com/whats-an-order; Orders v2 OpenAPI order.links)
- Bayaran balik mengambil id tangkapan, bukan id pesanan: `POST /v2/payments/captures/{id}/refund` dengan badan kosong memulangkan baki, dengan `amount` memulangkan sebahagian. Pulangan melebihi baki gagal dengan `REFUND_AMOUNT_EXCEEDED`. (Payments v2 OpenAPI captures.refund)

Kontrak penuh, dengan sumber bagi setiap fakta: [gateways/paypal/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/paypal/spec.md).
Dokumentasi penuh: [README.ms.md](https://github.com/sasateguh/bayarkit/blob/main/README.ms.md).

MIT © Muhammad Aiman
