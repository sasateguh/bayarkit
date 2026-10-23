# @bayarkit/ipay88

iPay88 (NTT DATA Payment Services Malaysia) for [bayarkit](https://github.com/aimanmalib/bayarkit): one interface for Malaysian payment gateways, and the safe way to confirm a
payment. [Bahasa Melayu](#bahasa-melayu)

**Evidence:** Official signature tools and HMAC script on the gateway host (three vectors), enquiry.asp probed live; no public API docs; not yet measured.

```bash
npm install @bayarkit/core @bayarkit/ipay88
```

```ts
import { checkoutResponse, confirmPayment, readCallback } from '@bayarkit/core'
import { ipay88 } from '@bayarkit/ipay88'

const gateway = ipay88({ merchantCode, merchantKey, environment: 'production' })

// Checkout: one reference per attempt; amounts are integer sen (RM10.50 = 1050).
const payment = await gateway.createPayment({ reference, amount, description, customer, returnUrl, callbackUrl })
return checkoutResponse(payment) // a 303 redirect, or a self-submitting form when the gateway wants a POST

// Callback route: never mark an order paid from the callback body or the return URL alone.
const result = await confirmPayment(gateway, await readCallback(request), { reference, amount })
if (result.ok) {
  // mark the order paid (idempotently: gateways retry callbacks)
}
```

Test without real money: `startFakeIPay88` from `@bayarkit/testing` answers like this gateway (signed callbacks
included), and `npx bayarkit-fake ipay88` runs it as a server for tests in other languages.

## Traps

- The signature is HMAC-SHA512 (lower-case hex, 128 chars) keyed with the MerchantKey, but the MerchantKey is ALSO the first part of the hashed message (key+code+refno+amount+currency), so a 'normal' HMAC over the fields alone will never match. (https://payment.ipay88.com.my/epayment/testing/TestSignatureIpay88.asp lines 35 and 46 (strBeforehash = MerchantKey + ...; GetHmacSHA512(strBeforehash, MerchantKey)))
- Amount is posted in ringgit with two decimals (e.g. 1.00) but must be signed with '.' and ',' removed (100); the gateway's own tool removes only the FIRST '.' and FIRST ',' (JS String.replace), so amounts with two thousands separators (1,000,000.00) give a different string there than a full strip. (https://payment.ipay88.com.my/epayment/testing/TestSignatureIpay88.asp line 31)
- enquiry.asp answers with a bare text/html body, not JSON: only the exact string '00' means paid; 'Invalid parameters' and 'Record not found' are returned with HTTP 200. (https://payment.ipay88.com.my/epayment/enquiry.asp (live probe 2026-10-23: empty POST -> 'Invalid parameters', unknown RefNo -> 'Record not found', both HTTP 200))
- A payment starts with a browser form POST to entry.asp, not a redirect: with @bayarkit/ipay88 serve `payment.html` (or post `payment.form`) instead of redirecting to `payment.url`. The BackendURL page must answer exactly `RECEIVEOK` or iPay88 retries. (gateways/ipay88/spec.md §2 and §4 (iPay88 Technical Specification 1.6.4.4 p.10 and p.14; UNCONFIRMED: not officially hosted))

The full contract, with a source for every fact: [gateways/ipay88/spec.md](https://github.com/aimanmalib/bayarkit/blob/main/gateways/ipay88/spec.md).

## Bahasa Melayu

iPay88 (NTT DATA Payment Services Malaysia) untuk [bayarkit](https://github.com/aimanmalib/bayarkit): satu antara muka untuk gateway pembayaran Malaysia, dan cara selamat untuk
mengesahkan bayaran.

**Bukti:** Alat tandatangan dan skrip HMAC rasmi pada hos gateway (tiga vektor), enquiry.asp diuji secara langsung; tiada dokumen API awam; belum diukur.

```bash
npm install @bayarkit/core @bayarkit/ipay88
```

Contoh kod di atas sama untuk semua gateway: tukar gateway dengan menukar satu baris. Jumlah ialah sen integer
(RM10.50 = 1050). Jangan tanda pesanan dibayar daripada badan callback atau pautan kembali semata-mata;
`confirmPayment` menyemak tandatangan, bertanya gateway semula, dan memadankan rujukan, jumlah dan mata wang.

Uji tanpa wang sebenar: `startFakeIPay88` daripada `@bayarkit/testing`, atau `npx bayarkit-fake ipay88` sebagai
pelayan. Perangkap gateway ini (dengan sumber) disenaraikan di atas dalam bahasa Inggeris. Kontrak penuh:
[gateways/ipay88/spec.md](https://github.com/aimanmalib/bayarkit/blob/main/gateways/ipay88/spec.md). Dokumentasi penuh: [README.ms.md](https://github.com/aimanmalib/bayarkit/blob/main/README.ms.md).

MIT © Muhammad Aiman
