# AGENTS.md

Panduan kerja untuk agen AI (dan developer) di repo ini.

## Ringkasan

Aturan terpenting: **uji secukupnya untuk perubahan yang dibuat.** Tidak kurang
(tidak melakukan commit yang belum terverifikasi), tidak lebih (tidak menjalankan
seluruh suite untuk perubahan satu baris teks).

---

## Inventaris test: apa yang ditutup, apa yang tidak

| Suite | Menutup | Tidak menutup |
|---|---|---|
| `typecheck` | tipe TypeScript di `src/` + `worker/` | perilaku runtime |
| `test:unit` | logika murni: argon2, ESC/POS, template TV, CLI, invariant SQL | **komponen `.vue`** (tidak ada `vue-test-utils`) |
| `sql:check` | sintaks 4 file SQL via parser PostgreSQL asli | hasil eksekusi di database nyata |
| `test:worker` | API Worker di runtime `workerd` + mock DB | UI |
| `test:queue` | logika antrian API | UI |
| `test:e2e:auth` | login, refresh, logout, ganti password, route guard | UI selain login |
| `test:e2e:admin` | dashboard admin, navigasi antrian, fallback cetak | auth |
| `test:e2e:tv` | dashboard TV, PIN, suara, realtime | auth |
| `test:e2e:owner` | pengaturan owner: kategori, suara, cetak, akun | auth |
| `smoke` | render, redirect, halaman diagnosis, error console | logika bisnis |
| `assets:verify` | kelengkapan aset PWA | — |
| `build` | bundling Vite + service worker PWA | — |

### Dua fakta penting

1. **Setiap E2E sudah menjalankan `vite build` sendiri** (`--outDir` terpisah di
   `scripts/*-e2e.mjs`). Jadi `npm run build` terpisah **redundan** selama E2E
   sudah dijalankan.
2. **Unit test tidak pernah menyentuh komponen `.vue`.** Mengubah `.vue` tidak
   bisa diverifikasi oleh `test:unit` — hanya oleh E2E.

---

## Matriks: jenis perubahan → verifikasi minimum

| Jenis perubahan | Verifikasi minimum |
|---|---|
| Docs, komentar, `TASKS.md` | `typecheck` |
| Logika murni (escpos, TV, password, CLI) | `typecheck` + `test:unit` |
| SQL / schema / grant / RLS | `sql:check` + `test:unit` + `test:worker` |
| Komponen / UI presentasi (warna, layout, teks) | `typecheck` + E2E suite terkait |
| Route / guard / state autentikasi | `typecheck` + `test:unit` + `smoke` + `test:e2e:auth` |
| Endpoint Worker / logika server | `test:worker` + `test:queue` + E2E terkait |
| Cookie / CORS / sesi / token | **seluruh suite** (`npm run verify`) |
| Config build / PWA / Vite / Tailwind | `typecheck` + `build` + `smoke` |
| Aset PWA | `assets:verify` + `build` |
| Lintas beberapa area, atau sebelum release | `npm run verify` |

Pintasan siap pakai:

```bash
npm run verify:ui      # typecheck + smoke:mock (self-contained)
npm run verify:auth    # typecheck + unit + e2e auth
npm run verify:sql     # sql:check + unit + worker
npm run verify:queue   # typecheck + worker + queue
```

> `smoke:mock` menyalakan servernya sendiri. `smoke` (tanpa `:mock`) butuh
> `npm run dev` yang sudah jalan di terminal lain — jangan dipakai di
> `verify:*`.

---

## Cara bekerja

### Saat masih mengedit (loop cepat)

Jalankan **hanya** `typecheck` dan satu suite E2E yang paling relevan. Tujuannya
menangkap kesalahan cepat, bukan membuktikan seluruh sistem.

```bash
npm run typecheck
npm run test:e2e:owner   # ganti sesuai area yang diubah
```

### Sebelum commit (verifikasi penuh untuk perubahan itu)

Jalankan baris matriks yang sesuai — **sekali**, setelah edits selesai. Bukan
setiap kali menyimpan berkas.

### Kalau ragu

Pilih baris **lebih tinggi** di matriks. Lebih baik over-test sebentar daripada
under-test lalu menemukan bug saat rilis.

### Kalau ada test gagal

Perbaiki dulu, **jangan** commit. Kalau kegagalan memang tidak terkait dengan
perubahan (mis. environment), catat alasannya secara eksplisit di pesan commit
supaya bisa ditinjau.

---

## Jebakan yang sudah pernah terjadi di repo ini

Hindari mengulangi:

- **`npm run` memakan flag berawalan `-`.** `npm run hash-password "pw" e@x.com
  owner --temp` membuat flag `--temp` hilang, sehingga akun owner terbentuk dengan
  password **permanen** tanpa peringatan. Gunakan argumen posisional `temp`, atau
  pisahkan dengan `--`.
- **Verifikasi nilai belum tentu memverifikasi langkahnya.** Nilai kolom
  `is_password_temporary` pernah benar sementara perintahnya salah. Kalau
  perbaikan menyentuh alur, periksa jalannya, bukan hanya hasil akhirnya.
- **Jangan commit artefak build.** `dist-e2e-*` harus tetap di `.gitignore`.
- **Nilai env di-inline saat build.** Mengubah `.env` tanpa build ulang tidak
  berpengaruh; pada `npm run dev` pun restart server setelah mengubah `.env`.
- **Komentar SQL harus satu baris.** Jangan pakai blok `=====` atau penjelasan
  panjang. Yang perlu ditulis hanya keputusan yang tidak terbaca dari kodenya
  (kenapa grant dicabut, kenapa urutan fungsi penting). SQL dibaca banyak orang;
  dekorasi hanya menambah noise.
- **`node:test` bisa melaporkan suite berisi 0 test tanpa error.** Kalau jumlah
  test tidak bertambah setelah menambah test baru, berarti suite-nya tidak
  benar-benar jalan — cek scoping `const` di dalam `describe`.