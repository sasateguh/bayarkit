# bayarkit — peraturan agen

Mula di `NEXT.md`; keputusan dalam `02-DECISIONS.md`. Fail ini = peraturan + perangkap, bukan keadaan.
- Gerbang: `npm run gate` (typecheck, biome, vitest, build, pasang tarball dibungkus ke projek kosong). Lari sendiri.
- **Amaun = sen integer**; jangan tambah API yang menerima ringgit.
- **Satu-satunya cara "dibayar" = `confirmPayment`.** Jangan tambah jalan pintas yang percaya badan callback / return URL.
- **Gateway palsu meniru sandbox YANG DIUKUR.** Kelakuan baharu: ubah palsu dahulu (ujian merah), kemudian adapter.
  `evidence.kind: 'measured'` HANYA selepas larian sandbox sebenar; catat beza dokumen-vs-sandbox dalam komen kepala adapter.
- Mesej ralat memetik JAWAPAN gateway sahaja — kunci/rahsia tidak pernah masuk mesej atau log.
- Sifar kebergantungan masa jalan (D5). Pustaka baharu = keputusan baharu dalam 02-DECISIONS.md.
- Dokumentasi BM + EN serentak (`README.md` + `README.ms.md`) — isi sama, bukan ringkasan.
- Sumber asal: `~/tunwan-business/lib/bayar-toyyibpay.mjs` (+ DESIGN.md v0.21.1–3) dan
  `~/saasclaudemotion/apps/api/src/gateway/bayarcash.ts` — BACA sahaja; repo itu milik sesi lain.
