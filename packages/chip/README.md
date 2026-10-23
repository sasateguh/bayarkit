# @bayarkit/chip

CHIP (CHIP Collect) for [bayarkit](https://github.com/aimanmalib/bayarkit): one interface for Malaysian payment gateways, and the safe way to confirm a
payment. [Bahasa Melayu](#bahasa-melayu)

**Evidence:** Official CHIP Collect OpenAPI; not yet measured in test mode.

```bash
npm install @bayarkit/core @bayarkit/chip
```

```ts
import { checkoutResponse, confirmPayment, readCallback } from '@bayarkit/core'
import { chip } from '@bayarkit/chip'

const gateway = chip({ secretKey, brandId, publicKey, environment: 'test' })

// Checkout: one reference per attempt; amounts are integer sen (RM10.50 = 1050).
const payment = await gateway.createPayment({ reference, amount, description, customer, returnUrl, callbackUrl })
return checkoutResponse(payment) // a 303 redirect, or a self-submitting form when the gateway wants a POST

// Callback route: never mark an order paid from the callback body or the return URL alone.
const result = await confirmPayment(gateway, await readCallback(request), { reference, amount })
if (result.ok) {
  // mark the order paid (idempotently: gateways retry callbacks)
}
```

Test without real money: `startFakeChip` from `@bayarkit/testing` answers like this gateway (signed callbacks
included), and `npx bayarkit-fake chip` runs it as a server for tests in other languages.

## Traps

- Callbacks are signed in the `X-Signature` header: base64 RSA PKCS#1 v1.5 SHA-256 over the RAW body. `GET /public_key/` returns a JSON-quoted PEM string that must be JSON-decoded first. (CHIP Collect OpenAPI L895–917; docs /overview/callbacks)
- CHIP's own AI skill lists fields and a status that do not exist (`failure_callback`, `cancel_callback`, status `failed`) and a wrapped payload; the OpenAPI spec has none of these. There is no `failed` status: paid means `paid`, `cleared` or `settled`. (CHIP Collect OpenAPI status enum vs github.com/CHIPAsia/skill SKILL.md)
- `success_callback` must not contain a port, not even `:443`; redirect and callback fields go at the top level of the create body (nested inside `purchase` they are ignored). (CHIP Collect OpenAPI L2953–2975; docs /overview/callbacks)

The full contract, with a source for every fact: [gateways/chip/spec.md](https://github.com/aimanmalib/bayarkit/blob/main/gateways/chip/spec.md).

## Bahasa Melayu

CHIP (CHIP Collect) untuk [bayarkit](https://github.com/aimanmalib/bayarkit): satu antara muka untuk gateway pembayaran Malaysia, dan cara selamat untuk
mengesahkan bayaran.

**Bukti:** OpenAPI rasmi CHIP Collect; belum diukur dalam mod ujian.

```bash
npm install @bayarkit/core @bayarkit/chip
```

Contoh kod di atas sama untuk semua gateway: tukar gateway dengan menukar satu baris. Jumlah ialah sen integer
(RM10.50 = 1050). Jangan tanda pesanan dibayar daripada badan callback atau pautan kembali semata-mata;
`confirmPayment` menyemak tandatangan, bertanya gateway semula, dan memadankan rujukan, jumlah dan mata wang.

Uji tanpa wang sebenar: `startFakeChip` daripada `@bayarkit/testing`, atau `npx bayarkit-fake chip` sebagai
pelayan. Perangkap gateway ini (dengan sumber) disenaraikan di atas dalam bahasa Inggeris. Kontrak penuh:
[gateways/chip/spec.md](https://github.com/aimanmalib/bayarkit/blob/main/gateways/chip/spec.md). Dokumentasi penuh: [README.ms.md](https://github.com/aimanmalib/bayarkit/blob/main/README.ms.md).

MIT © Muhammad Aiman
