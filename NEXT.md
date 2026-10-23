# bayarkit — sambung di sini

Keadaan: tanya sistem (`npm run gate`, `git log`). Fail ini = apa seterusnya.

## Menunggu pemilik (MANUAL — akaun atas nama Aiman / Sasa Teguh)

- Akaun SANDBOX: CHIP, Stripe (mod ujian), Billplz (billplz-sandbox.com), senangPay, Bayarcash. Tanpa akaun, adapter
  hanya boleh dilabel `docs`.
- Skop npm `@bayarkit` (organisasi percuma pada akaun npm aimendev) — perlu sebelum terbit.

## Seterusnya (satu demi satu)

1. ~~Adapter Billplz, CHIP, Stripe~~ SIAP 23 Okt (D9, label `docs`). Untuk `measured`: akaun sandbox pemilik + larian set
   ujian piawai terhadap sandbox sebenar (Bayarcash, Billplz, CHIP, Stripe).
2. Kaji gateway inventori satu demi satu (sumber rasmi + spec + gotchas), senangPay dahulu; sahkan e-GHL dan Xendit
   (laman tidak menjawab / 403 pada 23 Okt).
3. CI (Depot semasa private, D21 gilap) + Perisai sebelum awam (D7).
4. Pakej Laravel untuk projek PHP pemilik (tempahan, OSIS, HomestayPro, Dulang) — kongsi gateway palsu yang sama.
5. Laman demo BM/EN (bayar RM1 sandbox) + kajian kes /work.
