# PRD — Sistem Antrian PWA (Vue 3 + Supabase + Cloudflare Workers)

## 1. Ringkasan Eksekutif
Aplikasi Progressive Web App (PWA) untuk manajemen antrian berbasis web. Terhubung langsung dengan thermal printer Bluetooth (ESC/POS 58mm) untuk cetak tiket otomatis saat pendaftaran, dashboard admin real-time, dan dashboard TV real-time dengan pengumuman suara (Web Speech API). Backend menggunakan Supabase (Postgres + Realtime + RLS) dan Cloudflare Workers untuk static hosting & auth API.

---

## 2. Peran & Akses Pengguna

| Role | Metode Masuk | Hak Akses & Fitur |
|---|---|---|
| **Owner** | Email & Password | Pengaturan penuh: Kategori antrian (nama, warna), Template suara (teks, rate, volume), Template cetak (preview 58mm), Jam reset harian, Kelola akun admin & dashboard TV, Dashboard admin. |
| **Admin** | Email & Password | Operasional harian: Melihat card kategori & jumlah antrian, Input nama pelanggan & cetak tiket Bluetooth, Tombol Nomor Berikutnya, Pending, Selesai, Panggil Ulang, Batalkan, Cetak Ulang tiket yang gagal. |
| **Dashboard TV** | PIN (Tanpa login) | Khusus display TV (full-screen, kiosk): Nomor sedang dilayani besar, nama pelanggan, daftar antrian (pending di atas), status koneksi internet, tombol "Aktifkan Suara", auto-reconnect, pengumuman suara otomatis. |

- **Bootstrap Owner:** Dibuat manual via SQL (hash argon2id dari `#Pass123`).
- **Reset Password Admin:** Owner mereset password admin menjadi `#Pass123` dengan flag `is_password_temporary = true`, memaksa admin mengganti password saat login pertama.
- **PIN Dashboard TV:** Verifikasi ringan untuk membuka halaman TV; keamanan data tetap dijaga melalui Supabase RLS `SELECT`-only dengan anon key.

---

## 3. Alur Fungsional Utama

### A. Pendaftaran & Cetak Tiket (Admin)
1. Admin membuka dashboard admin, melihat card kategori dengan warna pembeda dan jumlah antrian tersisa/total.
2. Klik card kategori → dialog input **Nama Lengkap** → klik **Konfirmasi**.
3. Sistem mencoba mencetak tiket melalui **Web Bluetooth API** ke printer ESC/POS 58mm yang tersimpan di perangkat tersebut.
4. **Jika Print Sukses:** Data antrian disimpan ke Supabase dengan status `waiting` dan `print_status = 'printed'`.
5. **Jika Print Gagal:** Data antrian **tetap disimpan** dengan `print_status = 'pending'`, muncul popup error Bluetooth, dan admin diberikan opsi **Cetak Ulang** atau **Lewati**. (Menghindari hilangnya nomor antrian pelanggan).

### B. Pemanggilan & Status Antrian
- **Nomor Berikutnya:** Memanggil antrian waiting teratas menjadi `serving`. Baris `serving` sebelumnya otomatis diselesaikan (`done`) untuk memastikan hanya ada **1 nomor serving aktif**.
- **Pending Antrian Selanjutnya:** Meng-skip nomor berikutnya menjadi `pending` (tidak jadi dilayani, tetap dalam antrean). Ditampilkan paling atas di list dengan label **PENDING**.
- **Selesai:** Menandai nomor `serving` menjadi `done`.
- **Panggil Ulang:** Mengubah nomor `pending` atau `done` kembali menjadi `waiting` dan **diprioritaskan** (tampil paling atas).
- **Batalkan:** Mengubah status menjadi `cancelled`.

### C. Dashboard TV (Real-time & Audio)
- Menampilkan nomor antrian yang sedang dilayani (besar) beserta nama pelanggan.
- Daftar antrian di samping, dengan nomor `pending` di bagian atas berlabel khusus.
- **Status Koneksi:** Badge hijau ("Terhubung · Wi-Fi/4G/5G") atau merah ("Terputus"). Auto-reconnect setiap 5 detik tanpa menampilkan error page browser.
- **Suara:** Web Speech API melafalkan teks sesuai template owner (`{nomor}`, `{nama}`, `{kategori}`). Tombol sekali-klik "Aktifkan Suara" saat pertama buka untuk melewati kebijakan autoplay browser.

### D. Pengaturan Owner & Cache
- **Kategori:** Buat, edit, urutkan, dan soft-delete (`is_active = false`) kategori dengan warna pembeda.
- **Template Suara & Cetak:** Disimpan di tabel `settings`. Halaman pengaturan membandingkan `updated_at` dengan `localStorage` untuk menghindari over-fetching.
- **Preview Cetak:** Live HTML preview 58mm di sisi owner.

---

## 4. Stack Teknologi
- **Frontend:** Vue 3 (Composition API, `<script setup>`), TypeScript, Vite, PWA (`vite-plugin-pwa`).
- **UI Components:** shadcn-vue (reka-ui) + Tailwind CSS + `lucide-vue-next`.
- **Database & Realtime:** Supabase Postgres + Supabase Realtime.
- **Hosting & Serverless:** Cloudflare Workers (Static hosting + Auth API dengan `service_role`).
- **Autentikasi:** Custom `users` table, password hashing (argon2id), JWT access token (short-lived) + refresh token di HttpOnly cookie.
