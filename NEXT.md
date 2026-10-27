# bayarkit — sambung di sini

Keadaan: tanya sistem (`npm run gate`, `git log`). Fail ini = apa seterusnya.

## Mula sesi (5 minit)

- `git pull --ff-only` → `npm install` → `npm run gate` (TS + kembar PHP; PHP melalui Docker bila hos tiada PHP).
- Dokumen gateway berubah? `node tools/rujukan.mjs check` (cron `BAYARKIT-RUJUKAN` 02:53 menghantar Telegram). Semak
  setiap satu sebelum `--update` (corak D16: buktikan kosmetik dengan hash, ubah fake dahulu bila sebenar).
- Sebelum keluaran / selepas ubah `php/composer.json`: `bash scripts/php-compat.sh` + `bash scripts/security.sh`.
- Ubah UI demo: `npm run demo` → `python3 scripts/demo-webkit.py <folder>` + `python3 scripts/demo-shot.py` (gambar README).
- Ubah registry / `package.json` akar: `node tools/rujukan.mjs skills` (README pakej + metadata npm DIJANA — jangan sunting tangan).

## Hari buka awam (D7) — DIBUKA 27 Okt 2026 ~17:15 UTC (pemilik: "buka")

SIAP: `bayarkit` + `bayarkit-php` awam · persekitaran `npm` (tag `v*` sahaja) · pelaporan kerentanan peribadi · CodeQL
default · secret scanning + push protection + Dependabot · ruleset `main` (padam + force-push) · tag `v0.1.0` →
release.yml terbit 16 pakej 0.1.0 dengan provenance (trust npm kini kekal; tiada tarikh luput lagi) · php-split tolak
tag ke cermin · GitHub Release v0.1.0 dari CHANGELOG. Deploy keys org dihidupkan melalui API (UI pelan Free tiada pilihan).

Baki pemilik:
1. packagist.org → Submit `https://github.com/sasateguh/bayarkit-php` (nama `bayarkit/bayarkit`; OAuth GitHub sudah).
2. Muat naik kad OG `~/portal/uploads/bayarkit-kad-og.png` di Settings → Social preview (tiada API).

Baki sesi: daftar bayarkit dalam Perisai (profil pustaka, D20) · `gilap semak` · README profil/org dikemas sendiri.
Keluaran seterusnya: naikkan versi semua pakej serentak (release-check), kemas CHANGELOG, tag `v<versi>`.

## Menunggu pemilik (MANUAL — akaun atas nama Aiman / Sasa Teguh)

- Akaun SANDBOX: CHIP, Stripe (mod ujian), Billplz (billplz-sandbox.com), senangPay, Bayarcash. Tanpa akaun, adapter
  hanya boleh dilabel `docs`.
- Selepas buka (D7 diputuskan): hos demo + kajian kes /work = FLAG (teks awam atas nama pemilik).
- Makluman merentas projek (bukan kerja repo ini): ERP `tunwan-business` mengisi `orders.yuran_gateway` dari
  `transactionCharge` tanpa `userSecretKey` — dokumen toyyibPay 23 Okt kata yuran kosong tanpanya (D16).

## Seterusnya (satu demi satu)

0. **Ukur dahulu bila akaun sandbox ada** (setiap satu = dakwaan dokumen yang keselamatannya bergantung padanya; D16, D18):
   - toyyibPay: `getBillTransactions` dengan/tanpa `userSecretKey` (yuran kosong? bentuk jawapan kunci akaun lain?).
   - iPay88: `enquiry.asp` dengan jumlah SALAH mesti bukan `00` (skema tandatangan boleh dianjak antara medan).
   - eGHL: QUERY tidak menggemakan Amount yang diminta (HashValue2 boleh dipecah semula).
   - Fiuu: jawapan requery ada `Currency`? (fake ada, §7 tidak — tanpanya semua pengesahan = `mismatch`).
   - CHIP: kunci hidup boleh baca pembelian ujian? `is_test` sentiasa ada?
   - Bayarcash: `GET /transactions/{id}` ada medan portal?
1. ~~Adapter Billplz, CHIP, Stripe~~ SIAP 23 Okt (D9, label `docs`). Untuk `measured`: akaun sandbox pemilik + larian set
   ujian piawai terhadap sandbox sebenar (Bayarcash, Billplz, CHIP, Stripe).
2. ~~Kaji gateway inventori + adapter~~ SIAP 23 Okt (D11–D13): 14 adapter dalam `main`, semua `docs`. Adyen + Airwallex
   dikaji 23 Okt (4 sumber stabil setiap satu, spec + skill): 16/16 gateway inventori dikaji. Adapter kedua-duanya = belum
   (global; bina bila ada permintaan). Gateway borang POST (iPay88, eGHL, Fiuu) melalui `checkoutResponse` (D13).
3. ~~CI + keselamatan~~ SIAP (D10): `scripts/security.sh` lulus; Actions sedia untuk awam; Depot CI LULUS (run sl4gj00z4c, 23 Okt).
4. ~~Pakej Laravel~~ SIAP 23 Okt (D14): `php/`, toyyibPay + CHIP, diuji atas `bayarkit-fake` yang sama. Baki: gateway PHP
   lain bila projek memerlukannya; memindah projek pemilik = kerja repo masing-masing (bukan dari sini).
5. ~~Laman demo~~ SIAP dalam repo 23 Okt (D15, `npm run demo`, gateway palsu). Menghos + kajian kes /work = FLAG
   bersama D7 (teks awam atas nama pemilik; repo masih private).
6. ~~Aliran keluaran npm~~ SIAP 27 Okt (D19): `release.yml` (tag `v*`, dilangkau semasa private) + `scripts/publish.sh`
   (`--dry-run` lulus) + `release-check.mjs` dalam gerbang. Selepas D7 + skop npm: cipta persekitaran GitHub `npm`
   (tag `v*` sahaja), Trusted Publisher setiap pakej (16) di npmjs.com, kemudian tag `v0.1.0`. Baki: pecahan `php/` ke
   repo terbitan untuk Packagist (D14) + corak crewforge (CodeQL, Scorecard, ruleset `main`) bila awam.
7. Adapter Adyen / Airwallex bila ada permintaan (spec + sumber sudah ada); kembar PHP gateway lain bila projek PHP
   pemilik memerlukannya.
