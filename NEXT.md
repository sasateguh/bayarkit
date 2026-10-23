# bayarkit — sambung di sini

Keadaan: tanya sistem (`npm run gate`, `git log`). Fail ini = apa seterusnya.

## Menunggu pemilik (MANUAL — akaun atas nama Aiman / Sasa Teguh)

- Akaun SANDBOX: CHIP, Stripe (mod ujian), Billplz (billplz-sandbox.com), senangPay, Bayarcash. Tanpa akaun, adapter
  hanya boleh dilabel `docs`.
- Skop npm `@bayarkit` (organisasi percuma pada akaun npm aimendev) — perlu sebelum terbit.

## Seterusnya (satu demi satu)

0. **Adapter Billplz, CHIP, Stripe** daripada `gateways/<id>/spec.md` (label `docs`). Spesifikasi + vektor ujian rasmi
   Billplz sudah ada; Stripe: pin `Stripe-Version`, `allowed_payment_method_types`; CHIP: RSA `X-Signature` atas badan mentah.
   0b. Kaji gateway inventori satu demi satu (sumber rasmi + spec + gotchas); sahkan e-GHL dan Xendit (laman tidak menjawab /
   403 pada 23 Okt).

1. Ukur Bayarcash pada sandbox bila kunci ada → betulkan palsu dahulu, kemudian adapter → `evidence: measured`.
2. Adapter CHIP (dokumen rasmi dahulu, label `docs`), kemudian Stripe (Checkout Session, mod ujian percuma).
3. CI (Depot semasa private, D21 gilap) + Perisai sebelum awam (D7).
4. Pakej Laravel untuk projek PHP pemilik (tempahan, OSIS, HomestayPro, Dulang) — kongsi gateway palsu yang sama.
5. Laman demo BM/EN (bayar RM1 sandbox) + kajian kes /work.
