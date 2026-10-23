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
