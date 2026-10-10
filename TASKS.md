# TASKS — Sistem Antrian PWA

Aturan: satu task = implementasi → verifikasi → commit → lanjut.
Task yang tidak bisa diselesaikan ditandai `⚠️ BLOKIR` beserta alasannya.

Status: ⬜ belum · 🟨 dikerjakan · ✅ selesai (lolos verifikasi) · ⚠️ blokir

---

## Infrastruktur & konfigurasi

- ✅ **T01** Fix bug reachability di `diagnostics.ts` (HTTP 401 dari `/rest/v1/` dianggap gagal)
      → commit `238de2a`, diverifikasi ke project nyata (11 kartu, bukan 3)
- ✅ **T02** Tambah pemeriksaan kebocoran grant: RPC callable oleh anon
      → mendeteksi kebocoran nyata di `next_queue_number`, commit `238de2a`
- ✅ **T03** `public/` — ikon PWA 192/512 + maskable, favicon, robots
      → commit `f352733`, 25 cek aset lulus
- ✅ **T04** Utilitas argon2id + CLI hash password + 10 unit test
      → commit `b933b9c`
- ✅ **T05** `wrangler.toml` + Worker `/api/health`
      → `worker/` sebagai package terpisah, `/api/health` OK
- ⬜ **T14** `wrangler deploy` ke workers.dev + dokumentasi

## Autentikasi

- ✅ **T06** Worker API: login + refresh + logout + ganti password + argon2id
      → 51/51 integration test (workerd asli + mock PostgREST)
- ⬜ **T07** Halaman login + store auth (frontend)
- ⬜ **T08** Force ganti password saat `is_password_temporary`
- ⬜ **T09** Route guard per role + layout dashboard

## Dashboard Admin

- ⬜ **T10** Dashboard admin: card kategori + input nama pelanggan
- ⬜ **T11** Cetak tiket Bluetooth ESC/POS + fallback cetak ulang
- ⬜ **T12** Navigasi antrian: next / pending / selesai / panggil ulang / batalkan

## Dashboard TV

- ⬜ **T13** Dashboard TV: realtime + PIN + pengumuman suara

## Database

- ⬜ **T15** Siapkan SQL perbaikan (seed owner, cabut grant anon, publication realtime)

---

## Catatan audit

### 2026-10-10 — Audit koneksi Supabase `rdgrjaaambhdihyfbnru`

Hasil pemeriksaan langsung (di luar browser, via REST API):

| Endpoint | Hasil | Arti |
|---|---|---|
| `GET /rest/v1/` | 401 | Normal. Endpoint OpenAPI root butuh permission lebih tinggi. **Bukan** tanda kegagalan. |
| `GET /rest/v1/categories` | 200 `[]` | Tabel ada, RLS SELECT bekerja, data kosong. |
| `GET /rest/v1/queue_entries` | 200 `[]` | Tabel ada, data kosong. |
| `GET /rest/v1/settings` | 200 `[]` | Tabel ada — **seed belum dijalankan**. |
| `GET /rest/v1/users` | 200 `[]` | RLS menyembunyikan (tanpa policy SELECT). Bagus. |
| `POST /rest/v1/queue_entries` (anon) | 401 | RLS menolak tulis. Bagus. |
| `POST /rpc/next_queue_number` (anon) | **200** | ⚠️ **Bocor** — seharusnya ditolak. |
| `GET /auth/v1/health` | 200 v2.197.0 | Auth aktif. |

Kesimpulan: `schema.sql` pernah dijalankan (tabel ada) tetapi blok **seed** belum dieksekusi.
Nilai kosong di `settings`/`users` konsisten dengan `schema.sql:151-169` belum dijalankan.

---

## Catatan teknis

### argon2id di Cloudflare Workers

`@node-rs/argon2` **tidak bisa dipakai** di Workers:

1. Addon native (`.node`) tidak didukung runtime Workers.
2. Build WASM-nya (`@node-rs/argon2-wasm32-wasi`) gagal saat runtime dengan
   `[unenv] wasi.WASI is not implemented yet!` — produksi hash tetap jalan
   (WASM bisa di-*bundle*), tapi `verify` selalu `false`, sehingga **seluruh
   login ditolak** tanpa error yang mencolok.

Diganti ke `@noble/hashes/argon2.js` (JS murni). Hash yang dihasilkan
byte-identik dengan argon2id standar, dibuktikan oleh unit test
"kompatibel dengan hash argon2id standar" yang memverifikasi fixture yang
dihasilkan implementasi lain.

Catatan: subpath export `@noble/hashes` hanya mendefinisikan `./argon2.js` dan
`./utils.js` — ekstensi `.js` **wajib** ditulis, kalau tidak Node melempar
`ERR_PACKAGE_PATH_NOT_EXPORTED`.

### Set-Cookie harus header terpisah

Menggabungkan dua cookie dengan `join(', ')` menghasilkan satu header
`Set-Cookie` berisi koma. Browser mengurai itu sebagai satu cookie dengan
atribut tambahan, sehingga cookie kedua hilang. `json()` kini menerima array
`extraSetCookies` yang di-`append` satu per satu.

### Verifikasi token

`alg:none` ditolak eksplisit, dan perbandingan signature memakai
constant-time untuk mengurangi risiko timing attack.