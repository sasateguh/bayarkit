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
