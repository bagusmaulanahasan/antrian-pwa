# Sistem Antrian PWA

Aplikasi manajemen antrian berbasis PWA: pendaftaran pelanggan dengan cetak
tiket Bluetooth ESC/POS 58mm, dashboard admin real-time, dan dashboard TV
dengan pengumuman suara.

- **Frontend** - Vue 3 (`<script setup>` + TypeScript), Vite, Tailwind, PWA
- **Backend** - Cloudflare Workers (autentikasi + API operasional)
- **Database** - Supabase Postgres + Realtime + RLS

Spesifikasi lengkap ada di [PRD.md](./PRD.md), status pengerjaan ada di
[TASKS.md](./TASKS.md).

---

## Daftar isi

1. [Prasyarat](#prasyarat)
2. [Menyiapkan Supabase](#menyiapkan-supabase)
3. [Menjalankan secara lokal](#menjalankan-secara-lokal)
4. [Verifikasi koneksi](#verifikasi-koneksi)
5. [Membuat akun](#membuat-akun)
6. [Deploy Worker](#deploy-worker)
7. [Deploy frontend](#deploy-frontend)
8. [Menguji](#menguji)
9. [Masalah umum](#masalah-umum)

---

## Prasyarat

| Kebutuhan | Versi | Catatan |
|---|---|---|
| Node.js | 20 atau lebih baru | Diuji pada 26.x |
| npm | 10 atau lebih baru | |
| Supabase project | - | Tier gratis cukup |
| Akun Cloudflare | - | Tier gratis Workers cukup |

Dua batasan browser yang perlu diketahui **sebelum** dipakai di lapangan:

- **Web Bluetooth hanya ada di Chrome/Edge**, hanya di Android/ChromeOS/Desktop,
  dan hanya dalam konteks *secure* (HTTPS atau localhost). Safari dan Firefox
  belum mendukungnya.
- **Web Speech API** untuk pengumuman suara tidak tersedia di semua browser;
  Chrome dan Edge mendukungnya.

Aplikasi tetap berfungsi tanpa printer: nomor antrian **tidak pernah hilang**
walaupun cetak gagal (lihat [Alur pendaftaran](#membuat-akun)).

---

## Menyiapkan Supabase

### 1. Diagnostik dulu (opsional tapi disarankan)

Jalankan `supabase/00_check_grants.sql` lebih dulu. File ini **read-only** — hanya
membaca, tidak mengubah apa pun. Gunanya supaya Anda tahu kondisi grant sebelum
perbaikan, dan tidak perlu menebak kalau nanti ada masalah.

Di **SQL Editor** it'll mengembalikan tiga tabel. Yang perlu Anda baca adalah
**Tabel 1**: harus tepat 5 baris, dengan `anon` dan `authenticated` bernilai
`false`.

### 2. Jalankan skema

Di Supabase Dashboard > **SQL Editor**, jalankan berurutan:

1. `schema.sql` - tabel, fungsi, dan policy awal
2. `supabase/02_seed_and_fixes.sql` - seed dan perbaikan (idempoten)
3. `supabase/03_fix_privileges.sql` - penutup grant (idempoten)

File kedua dan ketiga wajib dijalankan. `schema.sql` saja meninggalkan beberapa
masalah yang tidak terlihat sampai aplikasi benar-benar dipakai:

| Yang diperbaiki | Akibatnya kalau dilewati |
|---|---|
| `revoke execute ... from public, anon, authenticated` | Kelima function RPC bisa dipanggil tanpa login |
| `security definer` diganti `security invoker` | Fungsi refresh token melewati RLS |
| `alter default privileges` dicabut | Function berikutnya bocor dengan cara yang sama |
| Policy RLS untuk `settings` | Dashboard TV tidak bisa membaca template suara |
| `queue_entries` masuk publication realtime | Dashboard TV tidak pernah sinkron |
| Seed `settings` dan `categories` | Pengaturan kosong, template tidak ada |

**Kenapa `revoke from public` saja tidak cukup.** Supabase memasang default
privileges saat project dibuat, yang memberi EXECUTE **langsung** ke peran
`anon` dan `authenticated` — bukan lewat `PUBLIC`. Karena itu pencabutan harus
menyebut ketiga peran secara eksplisit.

Verifikasi berhasil bila:
- Pesan `VERIFIKASI LULUS` (file 02) atau `PERBAIKAN BERHASIL` (file 03) muncul
- Tabel ringkasan mengembalikan 5 baris, semua `anon = false`, `mode = invoker`
- Tabel 2 pada `00_check_grants.sql` hanya menyisakan `rls_auto_enable`

> Function seperti `citext` dari extension Supabase memang **selalu** bisa
> dipanggil anon. Itu normal — Postgres memberi EXECUTE ke `PUBLIC` untuk semua
> function secara default, dan fungsi extension hanya pembanding string yang
> tidak menyentuh data aplikasi. Itu sebabnya verifikasi hanya memeriksa lima
> function milik aplikasi.

### 3. Catat kredensial

Dashboard > **Project Settings > API**:

| Nilai | Dipakai untuk |
|---|---|
| Project URL | `VITE_SUPABASE_URL` |
| anon / publishable key | `VITE_SUPABASE_ANON_KEY` |
| service_role key | Worker saja (`wrangler secret put`) |

> **Jangan pernah** memakai `service_role` di frontend. Kunci itu melewati
> seluruh policy RLS.

---

## Menjalankan secara lokal

```bash
npm install

# Salin template lalu isi kredensial
cp .env.example .env
```

`.env`:

```dotenv
VITE_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...

# Worker (dapat setelah langkah Deploy Worker; kosongkan dulu)
VITE_API_BASE_URL=

# PIN Dashboard TV (minimal 4 karakter)
VITE_TV_PIN=1234
```

Jalankan:

```bash
npm run dev          # frontend, http://localhost:5173
npm run worker:dev   # Worker, http://localhost:8788 (opsional)
```

Untuk fitur Worker (login, dashboard admin) yang memanggil `VITE_API_BASE_URL`,
jalankan `npm run worker:dev` di terminal terpisah lalu isi `VITE_API_BASE_URL`
dengan `http://localhost:8788`, **lalu build ulang**. Nilai env di-inline ke
bundle saat build, jadi mengisinya setelah `npm run dev` berjalan tidak
berpengaruh. Gunakan `npm run build && npm run preview` untuk menguji jalur
produksi.

---

## Verifikasi koneksi

Buka **`/dev/test-connection`**. Halaman ini **tidak ditautkan dari UI mana pun**,
jadi harus diketik manual di address bar — dan hanya terbuka pada `npm run dev`.
Pada build produksi route-nya dialihkan ke `/login`.

Halaman ini menjalankan sebelas pemeriksaan dan menjelaskan setiap kegagalan
dengan langkah perbaikan yang konkret:

| Pemeriksaan | Yang diverifikasi |
|---|---|
| Environment | URL, bentuk JWT anon key, deteksi service_role yang salah |
| Inisialisasi klien | Klien Supabase terbentuk |
| Keterjangkauan REST | Server merespons (401 dari root itu **normal**) |
| `categories` | Tabel ada dan policy SELECT berfungsi |
| `queue_entries` | Tabel ada dan policy SELECT berfungsi |
| `settings` | Tabel ada dan seed sudah masuk |
| Proteksi RLS | `INSERT` anon **harus ditolak** |
| Grant RPC | `next_queue_number` **harus menutup** untuk anon |
| Realtime | Berlangganan berhasil |
| Auth health | `/auth/v1/health` merespons |
| Worker | `/api/health` (dilewati bila belum dikonfigurasi) |

Route `devOnly` sengaja diblokir pada build produksi, jadi halaman ini hanya
muncul saat `npm run dev`.

---

## Membuat akun

Tidak ada akun bawaan yang aktif. Buat hash lalu jalankan SQL-nya:

```bash
npm run hash-password -- "PasswordAnda" owner@contoh.com owner temp
```

> **Catatan soal `npm run` dan flag:**
> `npm` secara otomatis memakan flag berawalan `-` (seperti `--temp`) jika ditulis langsung, sehingga flag tersebut hilang dan akun tercipta dengan password **permanen** tanpa peringatan.
> Untuk mencegahnya, gunakan argumen **posisional** `temp` di akhir tanpa tanda `-`, atau gunakan pemisah `--` seperti di atas (`npm run hash-password -- ... --temp`). Script ini mendeteksi keduanya.

Perintah itu mencetak hash argon2id **dan** statement `INSERT` siap tempel.
Jalankan statement tersebut di Supabase SQL Editor.

> Nonaktifkan riwayat shell setelahnya, karena password tersimpan di riwayat
> perintah. Alternatif tanpa meninggalkan jejak: pilih sendiri passwordnya
> lalu tempel langsung ke SQL Editor.

Untuk menambah admin, bisa juga lewat **Pengaturan Owner > Kelola Akun**.
Password yang diberikan owner selalu berstatus *sementara*: admin wajib
menggantinya saat login pertama.

> **PENTING:** Selalu verifikasi akun owner baru memiliki `is_password_temporary = true` di database. Jika Anda membuat akun lewat CLI dan lupa menyertakan flag `temp`, jalankan SQL ini untuk memperbaikinya:
> ```sql
> update users set is_password_temporary = true where email = 'email-owner@anda.com';
> ```

### Alur pendaftaran

Klik kartu kategori, masukkan nama, konfirmasi.

1. Data antrian **disimpan lebih dulu** dengan `print_status = 'pending'`.
2. Sistem mencoba mencetak tiket.
3. Bila gagal: nomor **tetap ada**, ditandai `print_status = 'failed'`, dan
   muncul tombol **Cetak Ulang** atau **Lewati**.

Urutannya disengaja. Kalau penyimpanan dilakukan setelah cetak, kegagalan
printer akan menghilangkan nomor antrian pelanggan.

---

## Deploy Worker

Worker menangani autentikasi dan seluruh penulisan database memakai
`service_role`. Frontend **tidak** pernah menulis langsung ke Supabase.

```bash
cd worker
npm install
npx wrangler login
```

Set secret (disimpan terenkripsi di Cloudflare, bukan di repo):

```bash
npx wrangler secret put SUPABASE_URL            # sama dengan VITE_SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put JWT_ACCESS_SECRET        # openssl rand -base64 48
```

Lalu deploy:

```bash
npx wrangler deploy
```

Catat domain yang muncul, misalnya
`https://antrian-api.<subdomain>.workers.dev`, lalu uji:

```bash
curl https://antrian-api.<subdomain>.workers.dev/api/health
# {"status":"ok","database":"connected",...}
```

Setelah itu kembalikan `ALLOWED_ORIGIN` di `worker/wrangler.toml` ke domain
frontend Anda (pisahkan dengan koma bila lebih dari satu) lalu deploy ulang.
Tanpa itu Worker tetap menerima cookie dari asal mana pun, yang tidak ideal
untuk produksi.

> Tidak ada `JWT_REFRESH_SECRET`. Refresh token berupa string acak yang
> disimpan sebagai SHA-256, bukan JWT. Tabelnya punya `revoked_at` sehingga
> pencabutan berlaku seketika, sesuatu yang tidak bisa dilakukan bila refresh
> token berupa JWT.

---

## Deploy frontend

Frontend adalah situs statis.

```bash
# Isi VITE_API_BASE_URL dengan domain Worker, lalu:
npm run build
```

Hasilnya ada di `dist/`. Unggah ke hosting statis mana pun (Cloudflare Pages,
Netlify, Vercel, GitHub Pages, atau server sendiri). Semua request memakai path
relatif, jadi aplikasi bisa dipasang di sub-path.

### Daftar periksa sebelum produksi

- [ ] `VITE_API_BASE_URL` menunjuk Worker yang sudah ter-deploy
- [ ] `ALLOWED_ORIGIN` di Worker sesuai dengan domain frontend
- [ ] `VITE_TV_PIN` diisi (minimal 4 karakter), tanpa itu layar TV tidak terbuka
- [ ] `supabase/02_seed_and_fixes.sql` sudah dijalankan
- [ ] Akun owner dibuat dan password sementara sudah diganti

---

## Menguji

```bash
npm run verify              # seluruh suite (cepat, butuh RAM cukup)
npm run verify:sequential   # suite satu per satu (mesin kecil)
```

Isi `verify`:

| Suite | Cakupan |
|---|---|
| `typecheck` | TypeScript dan Vue SFC |
| `test:unit` | Hashing password, ESC/POS, logika TV, tanggal antrian |
| `test:worker` | API auth lewat workerd asli dan mock PostgREST |
| `test:queue` | API antrian: aturan satu serving, panggil ulang, cetak |
| `test:e2e:auth` | Login, guard peran, ganti password paksa, sesi |
| `test:e2e:admin` | Pendaftaran, navigasi antrian, jalur cetak gagal |
| `test:e2e:tv` | PIN, urutan antrean, pembaruan, suara |
| `test:e2e:owner` | Kategori, template, validasi, kelola akun, otorisasi |
| `smoke:*` | Empat skenario diagnosis koneksi |
| `assets:verify` | Kelengkapan aset PWA |

Tidak ada satu pun test yang memerlukan Supabase atau Worker sungguhan. Semuanya
memakai mock, jadi aman dijalankan tanpa menyentuh data produksi.

### Tidak perlu menjalankan semuanya

Jalankan **hanya** suite yang sesuai dengan bagian yang Anda ubah:

```bash
npm run verify:ui      # typecheck + smoke          → perubahan UI presentasi
npm run verify:auth    # typecheck + unit + e2e auth → route, guard, autentikasi
npm run verify:sql     # sql:check + unit + worker  → schema, grant, RLS, RPC
npm run verify:queue   # typecheck + worker + queue → API antrian
```

Dua hal yang sering membuat pengujian berlebihan:

- `npm run build` **tidak** perlu dijalankan terpisah kalau E2E sudah dijalankan —
  tiap E2E sudah membangun bundle-nya sendiri.
- `npm run test:unit` **tidak** menyentuh komponen `.vue` sama sekali (proyek ini
  tidak memakai `vue-test-utils`), jadi tidak berguna untuk perubahan tampilan.

Matriks lengkap "jenis perubahan → verifikasi minimum" ada di
[`AGENTS.md`](./AGENTS.md).

Skrip lain:

```bash
npm run hash-password -- "#Pass123" owner@contoh.com owner temp
```

---

## Masalah umum

### "Tidak bisa menghubungi Worker API"

`VITE_API_BASE_URL` kosong, atau Worker belum ter-deploy. Ingat bahwa nilai env
di-inline saat build: isi ulang lalu **build ulang**.

### Login selalu gagal dengan 401

- Password belum diganti setelah owner meresetnya, sehingga
  `is_password_temporary` masih `true`.
- `JWT_ACCESS_SECRET` belum di-set, atau berubah setelah token diterbitkan.
- `SUPABASE_URL` atau `SUPABASE_SERVICE_ROLE_KEY` di Worker salah sehingga akun
  tidak ditemukan.

### `03_fix_privileges.sql` gagal dengan daftar fungsi aneh

Pesan `GAGAL — masih bisa dipanggil tanpa login:` yang menyodorkan puluhan nama
seperti `citext_eq` atau `regexp_match` **bukan** kebocoran Anda. Itu fungsi
extension Supabase yang memang selalu bisa dipanggil anon, dan verifikasi versi
lama ikut menghitungnya sehingga patch tidak pernah bisa lulus.

Perbaikannya sudah masuk di repo (`d18ac05`): verifikasi kini dibatasi ke lima
function milik aplikasi. Kalau Anda masih melihat pesan itu, kemungkinan besar
Anda menjalankan versi file yang lama — unduh ulang dari GitHub.

Kalau `raise exception` muncul, **seluruh transaksi dibatalkan**: tidak ada
perubahan yang hanya diterapkan sebagian. Aman dijalankan berulang kali.

### Fungsi `rls_auto_enable` masih terlihat terbuka

Itu fungsi internal Supabase, bukan kebocoran. Tugasnya hanya menyalakan RLS
dan sengaja tidak dicabut, karena mencabutnya bisa mengganggu Dashboard.

### Printer tidak ditemukan

`requestDevice()` hanya boleh dipanggil **dari gestur pengguna**. Pilih printer
lewat tombol **Hubungkan Printer**, jangan dipicu otomatis.

Bila printer thermal tidak mengekspos UUID standar, Worker mencoba SPP
(`0000ff00-...`) lalu fallback ke GAP (`00001800-...`). Gagal keduanya biasanya
berarti printer belum dalam mode pairing.

### Dashboard TV tidak pernah berubah

`queue_entries` belum masuk publication realtime. Jalankan:

```sql
alter publication supabase_realtime add table public.queue_entries;
```

Aplikasi tetap bekerja lewat polling 15 detik sebagai jaring pengaman, dan
badge akan menampilkan "Terhubung (penyegaran berkala)" alih-alih
"Menghubungkan...".

### Layar TV menampilkan pesan konfigurasi PIN

`VITE_TV_PIN` belum diisi atau kurang dari 4 karakter. Ini disengaja: membuka
layar tanpa PIN lebih buruk daripada menolaknya.

### `VirtualAlloc failed` atau proses berhenti sendiri saat test

Mesin kehabisan memori. Pastikan pagefile Windows aktif
(`scripts\setup-pagefile.cmd`, jalankan sebagai administrator lalu restart),
kemudian gunakan `npm run verify:sequential`.

---

## Struktur folder

```
src/                Frontend Vue 3
  lib/              Klien API, ESC/POS, Bluetooth, speech, auth store
  views/            Halaman: login, admin, owner, TV, diagnosis
  test/             Unit test logika murni
worker/             Cloudflare Worker (paket npm terpisah)
  src/lib/          Auth, token, antrian, pengaturan
  test/             Unit test
scripts/            Build aset, mock, E2E, orkestrasi verifikasi
supabase/           SQL perbaikan dan seed
```

---

## Lisensi

Proyek ini dibangun untuk kebutuhan internal.