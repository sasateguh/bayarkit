# Keputusan (bayarkit)

Setiap baris = keputusan + kenapa. Jangan buka semula tanpa fakta baharu.

**D1 — 23 Okt 2026 — Satu antara muka untuk banyak gateway, bukan "semua gateway" dalam bentuk dokumen.** Kenapa:
afu-it/malaysia-payment-gateway (73★, tiada lesen) sudah meliputi ~80 gateway sebagai _agent skills_ (Markdown) +
perbandingan yuran; menyalin bentuk itu = pengikut. Yang tiada: KOD yang boleh dijalankan, dengan antara muka sama,
pengesahan selamat, gateway palsu dan set ujian piawai. Laporan toyyibPay lambat membayar merchant (Okt 2026, belum
rasmi) = sebab sebenar perniagaan perlu boleh TUKAR gateway. Nama `bayarkit`: kosong di npm (termasuk skop) + GitHub.

**D2 — Amaun = sen integer di semua antara muka.** Kenapa: ringgit titik terapung + padanan tepat = penolakan palsu.

**D3 — `confirmPayment` = tandatangan → tanya gateway SEMULA → padanan tepat rujukan/amaun/mata wang.** Kenapa: corak
yang sama dalam ERP Tun Wan (F3) dan Cutt (D30); tandatangan sah boleh dimain semula, dibocorkan, atau untuk pesanan
lain. Badan callback tidak pernah menjadi bukti.

**D4 — Gateway palsu meniru kelakuan DIUKUR, bukan dokumen; `info.evidence` jujur (`measured` | `docs`).** Kenapa:
palsu dari dokumen meluluskan pepijat yang hidup dua kali dalam sehari (ERP v0.21.0, "No data found!"). Adapter hanya
`measured` selepas set ujian piawai dijalankan terhadap sandbox sebenar.

**D5 — TypeScript ESM, Node ≥ 22.12, SIFAR kebergantungan masa jalan** (fetch + node:crypto). Kenapa: pakej pembayaran
yang menarik pokok kebergantungan = permukaan serangan rantaian bekalan. `vitest` hanya peer bagi `@bayarkit/testing`.

**D6 — Gateway pertama = toyyibPay (diukur, dari ERP) + Bayarcash (dari Cutt).** Kenapa: kod teruji sudah ada; CHIP,
Billplz, senangPay, Stripe perlukan akaun sandbox atas nama pemilik (MANUAL). Kod asal TIDAK diubah (repo lain, sesi
lain); bayarkit menyalin + menterjemah ke API Inggeris.

**D7 — Repo private dahulu; awam selepas: sandbox Bayarcash diukur ATAU dilabel `docs` dengan jelas, Perisai lulus,
pakej diterbitkan melalui Trusted Publishing.** Kenapa: kod pembayaran atas nama Aiman = kredibiliti; terbit separuh siap
merosakkannya.

**D8 — 23 Okt 2026 — `rujukan`: daftar + cap jari dokumen rasmi + spesifikasi bersumber + skil dijana (permintaan
Aiman: "sistem yang aware dengan docs semua, versi padu dari afu-it").** Kenapa: skil Markdown statik tidak tahu bila
ia basi; di sini setiap sumber diambil setiap hari (cron `BAYARKIT-RUJUKAN`), perubahan BAHARU = Telegram sekali, dan
ia kekal "menunggu semakan" sehingga `check --update`. Hanya CAP JARI dalam repo — dokumen pihak ketiga berhak cipta,
salinan + beza di `~/.local/state/bayarkit/rujukan` (private). `mustContain` wajib: diukur hari yang sama, laman
Bayarcash (GitBook) dan FPX Stripe hanya kerangka JavaScript — tanpa pengawal itu kedua-duanya "dipantau" tanpa isi;
sumber kini `llms-full.txt` dan `.md` Stripe. Dua ambilan berturut = cap jari sama pada 12/12 sumber (bukan bunyi).
Skil dijana hanya untuk gateway yang ada sumber rasmi; fail dijana tidak membawa tarikh harian (gerbang tidak basi
setiap hari). Inventori (9 gateway) = laman rasmi disahkan menjawab; e-GHL (tiada jawapan) dan Xendit (403) belum.

**D9 — 23 Okt 2026 — Billplz, CHIP, Stripe dibina serentak (3 ejen, worktree masing-masing) daripada `gateways/<id>/spec.md`,
semuanya `docs`.** Setiap satu: palsu dahulu, set ujian piawai, ujian khusus (Billplz: 3 vektor X Signature rasmi;
CHIP: RSA atas badan MENTAH; Stripe: `Stripe-Version` dipin + `allowed_payment_method_types`, putaran `v1`, had masa),
3–4 sabotaj setiap satu. Pilihan bila spesifikasi UNCONFIRMED direkod dalam komen kepala setiap adapter (bukan di
sini). Ujian asap kini satu gelung: setiap gateway menolak callback awal, mengesahkan yang dibayar, menolak yang
dipalsu — daripada tarball yang dibungkus. Sabotaj silang (confirmPayment percaya callback) = 5/5 gateway gagal.

**D10 — 23 Okt 2026 — Keselamatan = pengimbas Perisai dijalankan terus (`scripts/security.sh`), bukan sasaran Perisai.**
Kenapa: Perisai menyasarkan laman HIDUP (kontena origin + domain); bayarkit pustaka tanpa origin, dan profil baharu dalam
Perisai = menyentuh sistem kongsi. Dasar sama (`polisi.yaml`): semgrep p/default+owasp-top-ten+typescript, had 60 s, 0 tamat
masa, fail diimbas > 0. Dibuktikan: `eval` ditanam → ditangkap. Penemuan pertama (regex dari data `ignore`, ReDoS) dibaiki
dengan MEMBUANG ciri yang tidak dipakai. CI Actions dilangkau bila repo private (`if: !private`), Depot semasa private.

**D11 — 23 Okt 2026 — 9 gateway lagi dikaji (senangPay, iPay88, Fiuu, 2C2P, Curlec, HitPay, Gkash, Xendit, eGHL): 48 sumber
rasmi dipantau, stabil dalam dua larian penuh.** Satu ejen setiap gateway, templat sama; integrasi oleh skrip yang MENOLAK
gateway jika sumbernya tidak stabil (dua `check`, larian kedua mesti 0 berubah). Penemuan yang mengubah reka bentuk:
senangPay kini DOKU (API lama mati); iPay88 + eGHL tiada dokumen pembangun awam (NTT DATA Payment Services) — sumber =
kod/alat rasmi awam sahaja, fakta yang hanya dari salinan pihak ketiga = UNCONFIRMED; Fiuu = PDF, dipantau melalui senarai
fail repo rasminya (API GitHub, `sha` setiap fail); Xendit tiada tandatangan badan (token statik) → `confirmPayment`
(tanya semula) menjadi satu-satunya perlindungan. Contoh rasmi yang dikesan gitleaks ditanda `gitleaks:allow` SEBARIS
dengan sebab (berkesan untuk imbasan pre-commit DAN sejarah). Spesifikasi Markdown dikecualikan daripada Biome.
Adyen + Airwallex ditangguh (global, dokumen sangat besar).

**D12 — 23 Okt 2026 — Kumpulan 1 (senangPay/DOKU, Curlec, HitPay, 2C2P) digabung: 9 adapter, 310 ujian. Fail kongsi
dihapuskan sebagai punca konflik.** Setiap gabungan selari bertembung pada peta CLI dan setup asap (penyelesai teks
gagal dua kali — bentuk penutup berbeza). Kini setiap gateway = `packages/testing/src/cli/<id>.ts` (dimuat dinamik; nama
mesti wujud dalam folder itu) + `scripts/smoke/<id>.mjs` (senarai = nama fail); `rujukan lint` menuntut kedua-duanya.
`pre-merge-commit` menjalankan gerbang untuk gabungan tanpa konflik (git melangkau pre-commit). Pelajaran: buang
worktree SELEPAS komit gabungan disahkan, bukan dalam arahan yang sama.

**D13 — 23 Okt 2026 — Fiuu + eGHL digabung (14 adapter); gateway "borang POST" disatukan dalam teras: `CreatedPayment.form?`
- `checkoutResponse(payment)`.** iPay88 MESTI POST (redirect = halaman ralat), Fiuu dan eGHL terima kedua-duanya. Tanpa
  teras, setiap laluan checkout perlu bercabang ikut gateway — melanggar janji "tukar gateway, kod lain tidak berubah".
  Kini: tiada `form` → 303; ada `form` → halaman auto-POST (setiap nama/nilai di-escape, `no-store`, `noindex`, CSP
  `default-src 'none'` + hash skrip tunggal). Butang KELIHATAN (bukan `<noscript>`) kerana CSP tapak pengguna boleh menyekat
  skrip walaupun JS hidup. TIADA `Referrer-Policy`: iPay88 menyemak Referer terhadap tapak berdaftar. Fiuu/eGHL kini
  POST secara lalai melalui `checkoutResponse` (emel pelanggan + tandatangan tidak masuk sejarah pelayar/log); `url` GET
  dikekalkan. Undur: buang `form` daripada adapter = kembali ke redirect, tiada perubahan API.

**D14 — 23 Okt 2026 — Pakej PHP/Laravel dalam monorepo yang sama (`php/`), bukan repo berasingan; toyyibPay + CHIP
dahulu.** Empat projek PHP pemilik (tempahan v5, OSIS, HomestayPro, Dulang) semuanya guna toyyibPay; tempahan/OSIS sudah
merancang CHIP sebagai gateway kedua (D49 repo itu). Satu repo = satu gerbang: adapter PHP diuji terhadap gateway palsu
YANG SAMA (`bayarkit-fake`, dimulakan oleh `scripts/php-gate.sh`) dengan kes keakuran yang sama, jadi kembar TS/PHP
tidak boleh hanyut tanpa gerbang merah; skrip + hash CSP halaman checkout dipin silang (ujian membaca fail TS). Sifar
kebergantungan masa jalan (ext-curl/json/openssl); Laravel pilihan (`LaravelTransport` supaya `Http::fake()` berfungsi).
Hos tiada PHP → imej ujian dipin `php:8.3.36-cli-alpine` + composer 2.8.12; Depot/Actions guna setup-php dipin SHA.
Gerbang yang senyap bila gagal pernah lulus palsu semasa ditulis (`-q`) — kini setiap langkah memapar ralatnya; fake
hilang = GAGAL, bukan langkau (`failOnSkipped`). Sabotaj: 6/6 ditangkap. Packagist = selepas D7 (pecahan `php/` ke
repo terbitan). Projek pemilik TIDAK dipindah dari sini: kod bayaran pengeluaran milik repo masing-masing (D49 tempahan,
"Settle" atas `transactions()`); pindah = keputusan setiap projek, dengan ujian projek itu. Undur: buang `php/` + satu
baris gate.sh; tiada pakej TS berubah.
Semakan semula 23 Okt: `scripts/security.sh` menyenaraikan pakej dengan TANGAN, jadi 9 adapter selepas D10 (senangPay,
Curlec, HitPay, 2C2P, Gkash, iPay88, Xendit, Fiuu, eGHL) tidak pernah diimbas semgrep walaupun "security lulus". Kini
glob `packages/*/src` + `php/` + `p/php`, dan skrip GAGAL bila mana-mana folder sumber tiada dalam senarai yang diimbas
(48 → 86 fail, 0 penemuan; `eval` ditanam dalam PHP ditangkap).

**D15 — 23 Okt 2026 — Demo = gateway PALSU, bukan sandbox RM1; dalam repo, belum dihos.** Demo sandbox perlukan kunci
akaun pemilik pada pelayan awam, dan hanya meliputi gateway yang ada akaun. Demo atas `bayarkit-fake` meliputi SEMUA
adapter, tanpa kunci/wang, dan menunjukkan perkara yang sandbox tidak boleh tunjuk (callback palsu, callback sah tanpa
bayaran). Setup setiap gateway = fail asap yang sama (`scripts/smoke/<id>.mjs`), senarai = registry, teks = i18n BM/EN,
tiada JS pelayar (CSP tanpa `script-src`), noindex. Penemuan semasa membina: fake Billplz + Gkash menghasilkan callback
dipalsukan yang `rawBody`-nya masih sah (mustahil di dunia sebenar) — dibaiki + invarian keakuran untuk semua fake.
MENGHOS demo (nama hos, laman awam atas nama pemilik) = FLAG, ditunda bersama D7 (repo masih private). Undur: buang
`examples/demo` + skrip `demo`.
