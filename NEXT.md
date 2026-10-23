# bayarkit — sambung di sini

Keadaan: tanya sistem (`npm run gate`, `git log`). Fail ini = apa seterusnya.

## Menunggu pemilik (MANUAL — akaun atas nama Aiman / Sasa Teguh)

- Akaun SANDBOX: CHIP, Stripe (mod ujian), Billplz (billplz-sandbox.com), senangPay, Bayarcash. Tanpa akaun, adapter
  hanya boleh dilabel `docs`.
- Skop npm `@bayarkit` (organisasi percuma pada akaun npm aimendev) — perlu sebelum terbit.

## Seterusnya (satu demi satu)

1. ~~Adapter Billplz, CHIP, Stripe~~ SIAP 23 Okt (D9, label `docs`). Untuk `measured`: akaun sandbox pemilik + larian set
   ujian piawai terhadap sandbox sebenar (Bayarcash, Billplz, CHIP, Stripe).
2. ~~Kaji gateway inventori + adapter~~ SIAP 23 Okt (D11–D13): 14 adapter dalam `main`, semua `docs`. Baki kajian:
   Adyen, Airwallex (global, ditangguh). Gateway borang POST (iPay88, eGHL, Fiuu) melalui `checkoutResponse` (D13).
3. ~~CI + keselamatan~~ SIAP (D10): `scripts/security.sh` lulus; Actions sedia untuk awam; Depot CI LULUS (run sl4gj00z4c, 23 Okt).
4. ~~Pakej Laravel~~ SIAP 23 Okt (D14): `php/`, toyyibPay + CHIP, diuji atas `bayarkit-fake` yang sama. Baki: gateway PHP
   lain bila projek memerlukannya; memindah projek pemilik = kerja repo masing-masing (bukan dari sini).
5. Laman demo BM/EN (bayar RM1 sandbox) + kajian kes /work.
