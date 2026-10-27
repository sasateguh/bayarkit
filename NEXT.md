# bayarkit — sambung di sini

Keadaan: tanya sistem (`npm run gate`, `git log`). Fail ini = apa seterusnya.

## Mula sesi (5 minit)

- `git pull --ff-only` → `npm install` → `npm run gate` (TS + kembar PHP; PHP melalui Docker bila hos tiada PHP).
- Dokumen gateway berubah? `node tools/rujukan.mjs check` (cron `BAYARKIT-RUJUKAN` 02:53 menghantar Telegram). Semak
  setiap satu sebelum `--update` (corak D16: buktikan kosmetik dengan hash, ubah fake dahulu bila sebenar).
- Sebelum keluaran / selepas ubah `php/composer.json`: `bash scripts/php-compat.sh` + `bash scripts/security.sh`.
- Ubah UI demo: `npm run demo` → `python3 scripts/demo-webkit.py <folder>` + `python3 scripts/demo-shot.py` (gambar README).
- Ubah registry / `package.json` akar: `node tools/rujukan.mjs skills` (README pakej + metadata npm DIJANA — jangan sunting tangan).

## Hari buka awam (D7) — keadaan 27 Okt 16:00 UTC; pemilik: "gilap dulu supaya padu, baru buka"

SIAP: skop npm `@bayarkit` (aimendev) · `npm-trust.sh` dijalankan pemilik 27 Okt 15:23 UTC → 16 penanda `0.0.0` di npm +
Trusted Publisher setiap pakej (⚠ LUPUT 29 Okt ~15:23 UTC jika tiada terbitan — selepas itu jalankan semula skrip) ·
security.sh (D20) · penggilapan dari semakan pelawat pertama (README EN/BM, contoh diuji atas 14 gateway palsu, CHANGELOG
0.1.0, perangkap BM, README PHP) · cermin Packagist `sasateguh/bayarkit-php` (PRIVATE, sudah ditolak tangan) · kad OG
baharu (`~/portal/uploads/bayarkit-kad-og.png`) · topik + deskripsi lulus `gilap semak` (✗0).

Pemilik (urutan):
1. Org `sasateguh` → Settings → Member privileges → benarkan **Deploy keys** → sesi jalankan `bash scripts/php-split-key.sh`.
2. Balas **"buka"**. Sesi kemudian: kedua-dua repo (`bayarkit`, `bayarkit-php`) → awam · persekitaran GitHub `npm` (tag
   `v*` sahaja) · Private vulnerability reporting ON (SECURITY.md menautnya) · CodeQL default setup · ruleset `main`
   (padam + force-push sahaja) · tag `v0.1.0` (release.yml terbit npm; php-split.yml tolak tag ke cermin) · GitHub Release
   dari CHANGELOG · sahkan `npm view @bayarkit/core` = 0.1.0 + provenance.
3. packagist.org → log masuk GitHub → Submit `https://github.com/sasateguh/bayarkit-php` (nama `bayarkit/bayarkit`).
4. Muat naik kad OG di Settings → Social preview (tiada API).
   Selepas buka: daftar bayarkit dalam Perisai (profil pustaka, D20) · `gilap semak` · README profil/org dikemas sendiri.

## Menunggu pemilik (MANUAL — akaun atas nama Aiman / Sasa Teguh)

- Akaun SANDBOX: CHIP, Stripe (mod ujian), Billplz (billplz-sandbox.com), senangPay, Bayarcash. Tanpa akaun, adapter
  hanya boleh dilabel `docs`.
- Skop npm `@bayarkit` (organisasi percuma pada akaun npm aimendev) — perlu sebelum terbit.
- KEPUTUSAN D7: buka repo kepada umum (FLAG: teks awam atas nama pemilik). Selepas itu sahaja: muat naik kad pratonton
  sosial (`~/gilap/state/aset/kad/bayarkit.png`, Settings → Social preview; tiada API), hos demo, kajian kes /work.
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
