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

Adapters: `@bayarkit/toyyibpay`, `@bayarkit/bayarcash`, `@bayarkit/billplz`, `@bayarkit/chip`, `@bayarkit/stripe`, `@bayarkit/senangpay`, `@bayarkit/ipay88`, `@bayarkit/fiuu`, `@bayarkit/2c2p`, `@bayarkit/curlec`, `@bayarkit/hitpay`, `@bayarkit/gkash`, `@bayarkit/xendit`, `@bayarkit/eghl`, `@bayarkit/paddle`, `@bayarkit/paypal`.

## Bahasa Melayu

Antara muka yang dilaksanakan oleh setiap adapter [bayarkit](https://github.com/sasateguh/bayarkit), dan `confirmPayment`: satu-satunya jalan
untuk menanda pesanan dibayar. Sifar kebergantungan masa jalan.

```bash
npm install @bayarkit/core @bayarkit/<gateway>
```

- `confirmPayment(gateway, callback, { reference, amount })` — 1. tandatangan callback mesti sah; 2. gateway ditanya
  semula (tandatangan yang sah boleh diulang main); 3. rekod gateway sendiri mesti kata dibayar, untuk rujukan ini,
  jumlah tepat ini (sen integer) dan mata wang ini. Memulangkan `{ ok: true, payment }` atau
  `{ ok: false, reason, detail }` dengan `reason` salah satu daripada `invalid_signature`, `not_paid`,
  `mismatch`, `gateway_error`; ia tidak pernah melempar ralat.
- `readCallback(request)` — callback daripada `Request` piawai web: medan (JSON, url-encoded atau multipart) serta
  badan mentah dan pengepala, supaya gateway yang menandatangani badan dan yang menandatangani pengepala kedua-duanya
  dapat disahkan. `callbackFromFields(fields)` untuk rangka kerja yang sudah menghurai badan.
- `checkoutResponse(payment, label?)` — redirect 303, atau halaman POST yang dihantar sendiri (di-escape) untuk
  gateway yang menerima borang; `autoPostHtml` ialah halaman itu sahaja.
- `toSen` / `toRinggit` — penukaran perpuluhan tepat, tidak pernah melalui float.
- `GatewayError` — mesej memetik jawapan gateway sahaja, tidak pernah kunci.

Adapter: `@bayarkit/toyyibpay`, `@bayarkit/bayarcash`, `@bayarkit/billplz`, `@bayarkit/chip`, `@bayarkit/stripe`, `@bayarkit/senangpay`, `@bayarkit/ipay88`, `@bayarkit/fiuu`, `@bayarkit/2c2p`, `@bayarkit/curlec`, `@bayarkit/hitpay`, `@bayarkit/gkash`, `@bayarkit/xendit`, `@bayarkit/eghl`, `@bayarkit/paddle`, `@bayarkit/paypal`.

Dokumentasi penuh: [README.ms.md](https://github.com/sasateguh/bayarkit/blob/main/README.ms.md).

MIT © Muhammad Aiman
