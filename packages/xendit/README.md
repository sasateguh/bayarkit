# @bayarkit/xendit

Xendit (Malaysia): Payment Sessions for [bayarkit](https://github.com/sasateguh/bayarkit): one interface for Malaysian payment gateways, and a checked way to confirm a
payment. [Bahasa Melayu](#bahasa-melayu)

**Evidence:** Official docs (Payment Sessions, v3 payment requests, `x-callback-token` webhooks: a static token, not a signature) and Xendit's agent skill; not yet measured in test mode.

```bash
npm install @bayarkit/core @bayarkit/xendit
```

```ts
import { checkoutResponse, confirmPayment, readCallback } from '@bayarkit/core'
import { xendit } from '@bayarkit/xendit'

const gateway = xendit({ secretKey, callbackToken })

// Checkout: one reference per attempt; amounts are integer sen (RM10.50 = 1050).
const payment = await gateway.createPayment({ reference, amount, description, customer, returnUrl, callbackUrl })
return checkoutResponse(payment) // a 303 redirect, or a self-submitting form when the gateway wants a POST

// Callback route: never mark an order paid from the callback body or the return URL alone.
const result = await confirmPayment(gateway, await readCallback(request), { reference, amount })
if (result.ok) {
  // mark the order paid (idempotently: gateways retry callbacks)
}
```

Test without real money: `startFakeXendit` from `@bayarkit/testing` answers like this gateway (signed callbacks
included), and `npx bayarkit-fake xendit` runs it as a server for tests in other languages.

## Traps

- Webhooks carry no HMAC or signature: authentication is a static per-environment token in the x-callback-token header that must be compared with the dashboard token, so also re-check amount and status against your own record or a GET. (https://docs.xendit.co/docs/handling-webhooks.md L30; https://docs.xendit.co/docs/integration-security.md L31-39)
- Amounts are in major units (RM 150 = 150, decimals allowed), not sen. (https://raw.githubusercontent.com/xendit/xendit-ai/HEAD/skills/xendit-integrate/references/sessions.md L26)
- Fulfil on payment.capture rather than on the session status: a payment can still be collected after a session is cancelled or expired, and the session status will not change. (https://raw.githubusercontent.com/xendit/xendit-ai/HEAD/skills/xendit-integrate/references/sessions.md L82, L103)
- Cancel spelling differs by object: sessions and payments use CANCELED while refunds use CANCELLED, so exact string matching misses one of them. (https://docs.xendit.co/apidocs/get-session.md #/components/schemas/Payment_Session_SessionStatus; https://docs.xendit.co/apidocs/refund-payment-request.md #/components/schemas/Payments_API_RefundStatus)

The full contract, with a source for every fact: [gateways/xendit/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/xendit/spec.md).

## Bahasa Melayu

Xendit (Malaysia): Payment Sessions untuk [bayarkit](https://github.com/sasateguh/bayarkit): satu antara muka untuk gateway pembayaran Malaysia, dan cara bersemak untuk
mengesahkan bayaran.

**Bukti:** Dokumen rasmi (Payment Sessions, payment request v3, webhook `x-callback-token`: token statik, bukan tandatangan) dan skil agen Xendit; belum diukur dalam mod ujian.

```bash
npm install @bayarkit/core @bayarkit/xendit
```

Contoh kod di atas sama untuk semua gateway: hanya adapter dan kuncinya yang berubah. Jumlah ialah sen integer
(RM10.50 = 1050). Jangan tanda pesanan dibayar daripada badan callback atau pautan kembali semata-mata;
`confirmPayment` menyemak tandatangan, bertanya gateway semula, dan memadankan rujukan, jumlah dan mata wang.

Uji tanpa wang sebenar: `startFakeXendit` daripada `@bayarkit/testing`, atau `npx bayarkit-fake xendit` sebagai
pelayan.

## Perangkap

- Webhook tidak membawa HMAC atau tandatangan: pengesahan ialah token statik setiap persekitaran dalam pengepala x-callback-token yang mesti dibandingkan dengan token dashboard, jadi semak semula juga jumlah dan status dengan rekod anda sendiri atau GET. (https://docs.xendit.co/docs/handling-webhooks.md L30; https://docs.xendit.co/docs/integration-security.md L31-39)
- Jumlah dalam unit besar (RM 150 = 150, perpuluhan dibenarkan), bukan sen. (https://raw.githubusercontent.com/xendit/xendit-ai/HEAD/skills/xendit-integrate/references/sessions.md L26)
- Penuhi pesanan pada payment.capture dan bukannya pada status sesi: bayaran masih boleh dikutip selepas sesi dibatalkan atau tamat tempoh, dan status sesi tidak akan berubah. (https://raw.githubusercontent.com/xendit/xendit-ai/HEAD/skills/xendit-integrate/references/sessions.md L82, L103)
- Ejaan batal berbeza mengikut objek: sesi dan bayaran menggunakan CANCELED manakala refund menggunakan CANCELLED, jadi padanan rentetan tepat terlepas salah satu daripadanya. (https://docs.xendit.co/apidocs/get-session.md #/components/schemas/Payment_Session_SessionStatus; https://docs.xendit.co/apidocs/refund-payment-request.md #/components/schemas/Payments_API_RefundStatus)

Kontrak penuh, dengan sumber bagi setiap fakta: [gateways/xendit/spec.md](https://github.com/sasateguh/bayarkit/blob/main/gateways/xendit/spec.md).
Dokumentasi penuh: [README.ms.md](https://github.com/sasateguh/bayarkit/blob/main/README.ms.md).

MIT © Muhammad Aiman
