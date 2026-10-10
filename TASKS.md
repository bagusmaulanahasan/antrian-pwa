# TASKS - Sistem Antrian PWA

Aturan: satu task = implementasi -> verifikasi -> commit -> lanjut.
Task yang tidak bisa diselesaikan ditandai `⚠️ BLOKIR` beserta alasannya.

Status: ⬜ belum · 🟨 dikerjakan · ✅ selesai (lolos verifikasi) · ⚠️ blokir

---

## Infrastruktur & konfigurasi

- ✅ **T01** Fix bug reachability di `diagnostics.ts` (HTTP 401 dari `/rest/v1/` dianggap gagal)
      -> commit `238de2a`, diverifikasi ke project nyata (11 kartu, bukan 3)
- ✅ **T02** Tambah pemeriksaan kebocoran grant: RPC callable oleh anon
      -> mendeteksi kebocoran nyata di `next_queue_number`, commit `238de2a`
- ✅ **T03** `public/` - ikon PWA 192/512 + maskable, favicon, robots
      -> commit `f352733`, 25 cek aset lulus
- ✅ **T04** Utilitas argon2id + CLI hash password + 10 unit test
      -> commit `b933b9c`
- ✅ **T05** `wrangler.toml` + Worker `/api/health`
      -> `worker/` sebagai package terpisah, `/api/health` OK

## Autentikasi

- ✅ **T06** Worker API: login + refresh + logout + ganti password + argon2id
      -> 51/51 integration test (workerd asli + mock PostgREST)
- ✅ **T07** Halaman login + store auth (frontend)
      -> `src/lib/api.ts` + `src/stores/auth.ts` + `LoginView.vue`
- ✅ **T08** Force ganti password saat `is_password_temporary`
      -> seluruh route terkunci sampai password diganti
- ✅ **T09** Route guard per role + layout dashboard
      -> 22/22 E2E (workerd + Chrome headless): guard, redirect peran, persistensi
        sesi, logout, ganti password paksa

## Dashboard Admin

- ✅ **T10** Backend API antrian + dashboard admin
      -> Worker `/api/queue/*`, 58 integration test
- ✅ **T10b** UI: card kategori, dialog pendaftaran, daftar antrian, statistik
      -> 50 E2E (workerd + Chrome headless)
- ✅ **T11** Cetak tiket Bluetooth ESC/POS + fallback cetak ulang
      -> generator byte ESC/POS + lapisan Web Bluetooth, 28 unit test
- ✅ **T12** Navigasi antrian: next / pending / selesai / panggil ulang / batalkan
      -> terverifikasi end-to-end di browser

## Dashboard TV

- ✅ **T13** Dashboard TV: PIN, realtime + polling, pengumuman suara
      -> 26 E2E + 15 unit test

## Pengaturan Owner

- ✅ **T16** Kategori, template suara & cetak, jam reset, kelola akun admin
      -> Worker `/api/admin/*` + `/api/settings`, 44 E2E

- ⬜ **T14** `wrangler deploy` ke workers.dev + dokumentasi (README)

## Catatan T13 - Dashboard TV

**PIN TV bukan rahasia.** PRD menyebutnya "verifikasi ringan"; keamanan data
sesungguhnya datang dari policy RLS yang hanya mengizinkan SELECT lewat anon
key. PIN mencegah layar tampil tanpa disengaja di depan pelanggan, dan diambil
dari `VITE_TV_PIN` (di-inline saat build) supaya bisa diganti per deployment
tanpa menyentuh kode. Tanpa PIN yang dikonfigurasi, layar **tidak terbuka**
sama sekali - membuka bebas lebih buruk daripada menampilkan pesan konfigurasi.

**Realtime punya jaring pengaman polling.** Realtime bisa "diam": tidak error
juga tidak SUBSCRIBED - misalnya `queue_entries` belum masuk publication, atau
WebSocket diblokir firewall. Tanpa batas waktu, badge akan menampilkan
"Menghubungkan..." selamanya padahal polling sedang bekerja. Karena itu ada
fallback 6 detik ke status "Terhubung (penyegaran berkala)" - jujur soal
keadaan, dan data tetap masuk.

**Suara hanya berjalan setelah ada interaksi.** Kebijakan autoplay browser
menuntut klik pengguna, jadi TV menampilkan tombol "Aktifkan Suara". Chrome
membatalkan suara pada halaman tak terlihat; TV sering disembunyikan, jadi
antrean diulang saat halaman kembali terlihat. Pengumuman hanya dipicu saat
*nomor serving berubah* - bukan tiap render - supaya tidak berulang tiap polling.

**Tidak terverifikasi otomatis:** kualitas suara aktual di perangkat TV (bukan
headphone). Yang terverifikasi adalah pemicu pengumuman, urutan antrean, dan
perilaku saat halaman gagal memuat data.

## Catatan T16 - Validasi di server

Semua validasi pengaturan berada di Worker, bukan hanya di frontend - satu-satunya
tempat yang tidak bisa dilewati. Contoh yang diuji: `reset_hour` di luar 0-23
ditolak dan nilai lama TIDAK berubah; warna kategori harus hex; password baru
dari owner selalu berstatus `is_password_temporary`, jadi admin wajib
menggantinya saat login pertama.

Role `admin` mendapat **403** (bukan 401) untuk `/api/settings` dan
`/api/admin/*` - sesinya valid, hanya hak aksesnya kurang.

## Catatan T11 - printer thermal

Printer thermal punya beberapa dialek. Mode `compatible` (default) mengirim
`{ESC}/` di awal baris supaya printer resmi Epson tahu posisi awal baris -
tanpa itu beberapa printer menggeser seluruh teks ke kanan. Ukuran font harus
dikembalikan ke normal (`GS ! 0`) **sebelum** potong kertas, kalau tidak
printer akan memotong dengan ketebalan yang salah.

Byte ditulis per chunk 180 (di bawah MTU characteristic GATT ~512). Menulis
seluruh tiket sekaligus sering gagal di sebagian printer.

Web Bluetooth hanya tersedia di Chrome/Edge, hanya di Android/ChromeOS/Desktop,
dan hanya dalam konteks secure (HTTPS atau localhost). Safari dan Firefox belum
mendukungnya - pesan error menjelaskan ini ke pengguna, bukan diam-diam gagal.

**Yang TIDAK bisa diuji otomatis:** selecting perangkat nyata dan Cetak Ulang
karena `requestDevice()` hanya boleh dipanggil dari gestur pengguna dan
memerlukan perangkat Bluetooth sungguhan. Yang terverifikasi adalah jalur
degradasinya: ketika printer tidak tersedia, nomor antrian **tetap tersimpan**
dan ditandai `print_status = 'failed'` dengan tombol Cetak Ulang / Lewati.

## Database

- ✅ **T15** SQL perbaikan: seed, cabut grant anon, publication realtime, RPC token
      -> `supabase/02_seed_and_fixes.sql` (idempoten) - perlu dijalankan manual di SQL Editor

---

## Catatan audit

### 2026-10-10 - Audit koneksi Supabase `rdgrjaaambhdihyfbnru`

Hasil pemeriksaan langsung (di luar browser, via REST API):

| Endpoint | Hasil | Arti |
|---|---|---|
| `GET /rest/v1/` | 401 | Normal. Endpoint OpenAPI root butuh permission lebih tinggi. **Bukan** tanda kegagalan. |
| `GET /rest/v1/categories` | 200 `[]` | Tabel ada, RLS SELECT bekerja, data kosong. |
| `GET /rest/v1/queue_entries` | 200 `[]` | Tabel ada, data kosong. |
| `GET /rest/v1/settings` | 200 `[]` | Tabel ada - **seed belum dijalankan**. |
| `GET /rest/v1/users` | 200 `[]` | RLS menyembunyikan (tanpa policy SELECT). Bagus. |
| `POST /rest/v1/queue_entries` (anon) | 401 | RLS menolak tulis. Bagus. |
| `POST /rpc/next_queue_number` (anon) | **200** | ⚠️ **Bocor** - seharusnya ditolak. |
| `GET /auth/v1/health` | 200 v2.197.0 | Auth aktif. |

Kesimpulan: `schema.sql` pernah dijalankan (tabel ada) tetapi blok **seed** belum dieksekusi.
Nilai kosong di `settings`/`users` konsisten dengan `schema.sql:151-169` belum dijalankan.

---

## Catatan teknis

### argon2id di Cloudflare Workers

`@node-rs/argon2` **tidak bisa dipakai** di Workers:

1. Addon native (`.node`) tidak didukung runtime Workers.
2. Build WASM-nya (`@node-rs/argon2-wasm32-wasi`) gagal saat runtime dengan
   `[unenv] wasi.WASI is not implemented yet!` - produksi hash tetap jalan
   (WASM bisa di-*bundle*), tapi `verify` selalu `false`, sehingga **seluruh
   login ditolak** tanpa error yang mencolok.

Diganti ke `@noble/hashes/argon2.js` (JS murni). Hash yang dihasilkan
byte-identik dengan argon2id standar, dibuktikan oleh unit test
"kompatibel dengan hash argon2id standar" yang memverifikasi fixture yang
dihasilkan implementasi lain.

Catatan: subpath export `@noble/hashes` hanya mendefinisikan `./argon2.js` dan
`./utils.js` - ekstensi `.js` **wajib** ditulis, kalau tidak Node melempar
`ERR_PACKAGE_PATH_NOT_EXPORTED`.

### Set-Cookie harus header terpisah

Menggabungkan dua cookie dengan `join(', ')` menghasilkan satu header
`Set-Cookie` berisi koma. Browser mengurai itu sebagai satu cookie dengan
atribut tambahan, sehingga cookie kedua hilang. `json()` kini menerima array
`extraSetCookies` yang di-`append` satu per satu.

### Verifikasi token

`alg:none` ditolak eksplisit, dan perbandingan signature memakai
constant-time untuk mengurangi risiko timing attack.

### CORS wajib mencerminkan Origin (bukan wildcard)

API memakai cookie HttpOnly, jadi frontend **harus** mengirim
`credentials: 'include'`. Dengan `Access-Control-Allow-Origin: *`, browser
menolak responsnya - gejalanya `Failed to fetch` di console padahal Worker
sudah membalas 200. Karena itu Worker mencerminkan balik header `Origin` dan
mengirim `Allow-Credentials: true`, dengan daftar putih dari `ALLOWED_ORIGIN`.

### Access token dibaca dari cookie, bukan hanya header

Browser tidak bisa membaca cookie HttpOnly, jadi frontend tidak mungkin
mengirim header `Authorization`. Awalnya Worker hanya membaca header - akibatnya
`/api/auth/me` dan `change-password` selalu 401 di browser meski cookie valid.
Sekarang Worker membaca header lebih dulu, lalu cookie `antrian_access`.

### Menulis refresh_tokens lewat RPC

Tabel `refresh_tokens` sengaja TIDAK diberi policy RLS - token sesi tidak
pernah boleh dibaca dari sisi klien. Akses tulis dipusatkan ke RPC
`security definer` (`store_refresh_token`, `revoke_refresh_token`,
`revoke_all_refresh_tokens`) dengan grant hanya untuk `service_role`.
Keuntungannya: seluruh jalur tulis tervalidasi di satu tempat, dan
`token_hash` yang bukan SHA-256 hex ditolak sebelum menyentuh tabel.

### Mutasi PostgREST hanya mengembalikan baris bila diminta

`.update().eq(...).select(...).maybeSingle()` **tidak** selalu mengirim
`Accept: application/vnd.pgrst.object`. PostgREST mengembalikan baris yang
terpengaruh hanya bila ada `Prefer: return=representation`; selain itu
responsnya array kosong.

Karena mock sempat mengembalikan `[]` untuk semua mutasi, `maybeSingle()`
selalu menghasilkan `null` - dan kode produksi menyimpulkan "data tidak
ditemukan" **padahal barisnya sudah berubah**. Gejalanya menipu: update kategori
"berhasil" (terlihat berubah di database) tapi Worker membalas 400, dan test
hanya memeriksa state sehingga miss.

Sekarang mock memakai `respondMutation()` yang meniru aturan itu persis.

## Catatan lingkungan

### Memori: jalankan suite satu per satu

`npm run verify` merantai seluruh suite dalam satu proses shell. Pada mesin
kecil (RAM 8 GB tanpa pagefile) build Vite + Chrome headless + workerd yang
beruntun dapat membuat Windows kehabisan memori commit - gejalanya
`VirtualAlloc ... failed with errno=1455` atau `Zone Allocation failed`, yang
sama sekali tidak berkaitan dengan kode.

`npm run verify:sequential` menjalankan tiap suite sebagai proses terpisah
dengan jeda, sehingga memori dilepas penuh di antaranya. Selain itu, script
setup-pagefile.cmd membantu mengaktifkan pagefile Windows.

Tiga kegagalan test awal berasal dari mock yang terlalu longgar:

| Kelalaian mock | Gejala di kode nyata |
|---|---|
| Selalu balas array | `.maybeSingle()` selalu `null` - status update terlihat kosong padahal DB berubah |
| Terima kolom asing | Salah ketik nama kolom lolos diam-diam |
| `select=*` diperlakukan sebagai nama kolom literal | `entry` berisi `{}` |

Sekarang mock_PROJECT mengembalikan objek tunggal bila `Accept:
application/vnd.pgrst.object` (dipakai `.maybeSingle()`), menolak kolom tak
dikenal dengan PGRST204, dan memperlakukan `*` sebagai "semua kolom".

### Balapan initAuth

`App.vue` memanggil `initAuth()` saat mount, sementara route guard memanggilnya
lagi sebelum navigasi. Tanpa penyatuan promise, guard bisa membaca status
`loading` dan salah menyimpulkan pengguna anonim - akibatnya admin yang sudah
login terlempar ke halaman login. `inFlight` sekarang dipakai bersama.