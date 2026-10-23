# @bayarkit/2c2p

2C2P (PGW Payment API v4.x) for [bayarkit](https://github.com/aimanmalib/bayarkit): one interface for Malaysian payment gateways, and the safe way to confirm a
payment. [Bahasa Melayu](#bahasa-melayu)

**Evidence:** Official developer docs (Payment Token + HS256 JWT, three official JWT test vectors); not yet measured on the sandbox.

```bash
npm install @bayarkit/core @bayarkit/2c2p
```

```ts
import { checkoutResponse, confirmPayment, readCallback } from '@bayarkit/core'
import { twoc2p } from '@bayarkit/2c2p'

const gateway = twoc2p({ merchantId, secretKey, environment: 'sandbox' })

// Checkout: one reference per attempt; amounts are integer sen (RM10.50 = 1050).
const payment = await gateway.createPayment({ reference, amount, description, customer, returnUrl, callbackUrl })
return checkoutResponse(payment) // a 303 redirect, or a self-submitting form when the gateway wants a POST

// Callback route: never mark an order paid from the callback body or the return URL alone.
const result = await confirmPayment(gateway, await readCallback(request), { reference, amount })
if (result.ok) {
  // mark the order paid (idempotently: gateways retry callbacks)
}
```

Test without real money: `startFake2C2P` from `@bayarkit/testing` answers like this gateway (signed callbacks
included), and `npx bayarkit-fake 2c2p` runs it as a server for tests in other languages.

## Traps

- The JWT HMAC key is the secret-key hex string used as ASCII bytes (not hex-decoded), and the official response-decoding recipe verifies a token with the JT01 key although that token is actually signed with the JT04 key, so copy-pasted sample code fails. (https://developer.2c2p.com/docs/json-web-tokens-jwt.md L44-47; https://developer.2c2p.com/recipes/process-response-payload-with-jwt.md L78-91 (verified locally))
- Only the backend notification (JSON {payload: HS256 JWT}) is signed; the frontendReturnUrl POST is unsigned base64 form data (paymentResponse=...) whose respCode 2000 only means 'do a payment inquiry', so it must never mark an order paid. (https://developer.2c2p.com/docs/api-payment-response-frontend.md L21-29; https://developer.2c2p.com/docs/response-code-payment-flow.md)
- The official WooCommerce plugin (2026 build v8.1.0) does not use the documented v4 JWT API but legacy RedirectV3 with an HMAC-SHA256 concatenated-field hash and 12-digit zero-padded minor-unit amounts, while the v4 API expects decimal major units (e.g. 2500.90000), so do not port amount or signing logic from the plugin. (wordpress-2c2p-build20260612.zip: 2c2p_woocommerce_new/2c2p.php L191, Includes/wc-2c2p-hash-helper.php L15-87, Includes/wc-2c2p-validation-helper.php L59-89 vs https://developer.2c2p.com/docs/api-payment-token-request-parameter.md L146)
- Docs disagree on the API version path (4.3 in Sandbox Setup and the OpenAPI reference, 4.5 on the Payment Token and Payment Inquiry pages); both answer on sandbox, so pin one version explicitly and keep it in config. (https://developer.2c2p.com/docs/sandbox-setup.md L68; https://developer.2c2p.com/docs/api-payment-token.md L18-21)

The full contract, with a source for every fact: [gateways/2c2p/spec.md](https://github.com/aimanmalib/bayarkit/blob/main/gateways/2c2p/spec.md).

## Bahasa Melayu

2C2P (PGW Payment API v4.x) untuk [bayarkit](https://github.com/aimanmalib/bayarkit): satu antara muka untuk gateway pembayaran Malaysia, dan cara selamat untuk
mengesahkan bayaran.

**Bukti:** Dokumen pembangun rasmi (Payment Token + JWT HS256, tiga vektor ujian JWT rasmi); belum diukur pada sandbox.

```bash
npm install @bayarkit/core @bayarkit/2c2p
```

Contoh kod di atas sama untuk semua gateway: tukar gateway dengan menukar satu baris. Jumlah ialah sen integer
(RM10.50 = 1050). Jangan tanda pesanan dibayar daripada badan callback atau pautan kembali semata-mata;
`confirmPayment` menyemak tandatangan, bertanya gateway semula, dan memadankan rujukan, jumlah dan mata wang.

Uji tanpa wang sebenar: `startFake2C2P` daripada `@bayarkit/testing`, atau `npx bayarkit-fake 2c2p` sebagai
pelayan. Perangkap gateway ini (dengan sumber) disenaraikan di atas dalam bahasa Inggeris. Kontrak penuh:
[gateways/2c2p/spec.md](https://github.com/aimanmalib/bayarkit/blob/main/gateways/2c2p/spec.md). Dokumentasi penuh: [README.ms.md](https://github.com/aimanmalib/bayarkit/blob/main/README.ms.md).

MIT © Muhammad Aiman
