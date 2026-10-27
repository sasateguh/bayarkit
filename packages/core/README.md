# @bayarkit/core

The interface every [bayarkit](https://github.com/sasateguh/bayarkit) gateway adapter implements, and `confirmPayment`: the one path to marking
an order paid. Zero runtime dependencies. [Bahasa Melayu](#bahasa-melayu)

```bash
npm install @bayarkit/core @bayarkit/<gateway>
```

- `confirmPayment(gateway, callback, { reference, amount })` — 1. the callback signature must verify; 2. the gateway
  is asked again (a valid signature can be replayed); 3. its own record must say paid, for this reference, this exact
  amount (integer sen) and currency. Returns `{ ok: true, payment }` or `{ ok: false, reason, detail }` with
  `reason` one of `invalid_signature`, `not_paid`, `mismatch`, `gateway_error`; it never throws.
- `readCallback(request)` — a callback from a Web-standard `Request`: fields (JSON, url-encoded or multipart) plus the
  raw body and headers, so both body-signed and header-signed gateways verify. `callbackFromFields(fields)` for
  frameworks that already parsed the body.
- `checkoutResponse(payment, label?)` — a 303 redirect, or an escaped self-submitting POST page for gateways that take
  a form; `autoPostHtml` is the page alone.
- `toSen` / `toRinggit` — exact decimal conversion, never through a float.
- `GatewayError` — messages quote the gateway's answer only, never a key.

Adapters: `@bayarkit/toyyibpay`, `@bayarkit/bayarcash`, `@bayarkit/billplz`, `@bayarkit/chip`, `@bayarkit/stripe`, `@bayarkit/senangpay`, `@bayarkit/ipay88`, `@bayarkit/fiuu`, `@bayarkit/2c2p`, `@bayarkit/curlec`, `@bayarkit/hitpay`, `@bayarkit/gkash`, `@bayarkit/xendit`, `@bayarkit/eghl`.

## Bahasa Melayu

Antara muka yang dilaksanakan oleh setiap adapter [bayarkit](https://github.com/sasateguh/bayarkit), dan `confirmPayment`: satu-satunya jalan
untuk menanda pesanan dibayar. Sifar kebergantungan masa jalan.

- `confirmPayment` — tandatangan callback mesti sah; gateway ditanya semula; rekod gateway sendiri mesti kata dibayar,
  untuk rujukan ini, jumlah tepat ini (sen integer) dan mata wang ini. Tidak pernah melempar ralat.
- `readCallback(request)` — callback daripada `Request` piawai web, termasuk badan mentah dan pengepala.
- `checkoutResponse(payment)` — redirect 303, atau halaman borang POST yang dihantar sendiri.
- `toSen` / `toRinggit` — penukaran perpuluhan tepat, tidak pernah melalui float.

Dokumentasi penuh: [README.ms.md](https://github.com/sasateguh/bayarkit/blob/main/README.ms.md).

MIT © Muhammad Aiman
