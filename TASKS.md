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
- 🟨 **T03** Buat `public/` — ikon PWA 192/512, favicon, robots.txt
- ⬜ **T04** Tool generate hash argon2id + seed owner
- ⬜ **T05** `wrangler.toml` + Worker `/api/health`
- ⬜ **T14** `wrangler deploy` ke workers.dev + dokumentasi

## Autentikasi

- ⬜ **T06** Worker API: login + refresh + verifikasi argon2id
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