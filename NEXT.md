# bayarkit — sambung di sini

Keadaan: tanya sistem (`npm run gate`, `git log`). Fail ini = apa seterusnya.

## Menunggu pemilik (MANUAL — akaun atas nama Aiman / Sasa Teguh)

- Akaun SANDBOX: CHIP, Stripe (mod ujian), Billplz (billplz-sandbox.com), senangPay, Bayarcash. Tanpa akaun, adapter
  hanya boleh dilabel `docs`.
- Skop npm `@bayarkit` (organisasi percuma pada akaun npm aimendev) — perlu sebelum terbit.
- Depot CI: tambah repo `bayarkit` ke app Depot Code Access (https://github.com/settings/installations/173311541).
  Diukur 23 Okt: `gerbang-depot.sh` jatuh ke hos kerana tiada akses (gerbang tetap lulus di hos).

## Seterusnya (satu demi satu)

1. ~~Adapter Billplz, CHIP, Stripe~~ SIAP 23 Okt (D9, label `docs`). Untuk `measured`: akaun sandbox pemilik + larian set
   ujian piawai terhadap sandbox sebenar (Bayarcash, Billplz, CHIP, Stripe).
2. Kaji gateway inventori satu demi satu (sumber rasmi + spec + gotchas), senangPay dahulu; sahkan e-GHL dan Xendit
   (laman tidak menjawab / 403 pada 23 Okt).
3. ~~CI + keselamatan~~ SIAP (D10): `scripts/security.sh` lulus; Actions sedia untuk awam; Depot menunggu akses di atas.
4. Pakej Laravel untuk projek PHP pemilik (tempahan, OSIS, HomestayPro, Dulang) — kongsi gateway palsu yang sama.
5. Laman demo BM/EN (bayar RM1 sandbox) + kajian kes /work.
