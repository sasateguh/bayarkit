# @bayarkit/testing

Fake payment gateways (Malaysian and global) and the [bayarkit](https://github.com/sasateguh/bayarkit) conformance suite: test checkout and callbacks without real
money, in JavaScript or in any other language. [Bahasa Melayu](#bahasa-melayu)

```bash
npm install --save-dev @bayarkit/testing
```

Each fake answers like its gateway's API (in the shapes measured on the sandbox where one was measured) and signs
callbacks exactly as the gateway does: `startFakeToyyibPay`, `startFakeBayarcash`, `startFakeBillplz`, `startFakeChip`, `startFakeStripe`, `startFakeSenangPay`, `startFakeIPay88`, `startFakeFiuu`, `startFake2C2P`, `startFakeCurlec`, `startFakeHitPay`, `startFakeGkash`, `startFakeXendit`, `startFakeEghl`, `startFakePaddle`, `startFakePayPal`.
Every fake has `markPaid(id)`, `callbackFor(id)` (a correctly signed callback) and `tamper(callback)`.

- `gatewayConformance(name, setup)` — the suite every adapter must pass (vitest, optional peer).
- `npx bayarkit-fake <gateway>` — one fake as a server for PHP, Python or Go tests. It prints one JSON line
  (`url`, `control`) and serves a control API: `POST /paid/<id>`, `GET /callback/<id>`,
  `GET /callback/<id>/tampered`, and for PayPal `POST /approve/<id>` (the buyer approves, nothing captured yet).
  vitest is not needed for this.

## Bahasa Melayu

Gateway pembayaran palsu (Malaysia dan global) dan set ujian keakuran [bayarkit](https://github.com/sasateguh/bayarkit): uji checkout dan callback tanpa wang
sebenar, dalam JavaScript atau bahasa lain. Setiap fake menjawab seperti API gatewaynya dan menandatangani callback
sama seperti gateway itu. `npx bayarkit-fake <gateway>` menjalankan satu fake sebagai pelayan dengan API kawalan
(`POST /paid/<id>`, `GET /callback/<id>`, `GET /callback/<id>/tampered`, dan untuk PayPal `POST /approve/<id>`:
pembeli meluluskan, belum ditangkap) untuk ujian PHP, Python atau Go.

Dokumentasi penuh: [README.ms.md](https://github.com/sasateguh/bayarkit/blob/main/README.ms.md).

MIT © Muhammad Aiman
