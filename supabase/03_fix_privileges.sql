-- ============================================================
--  03 — Perbaikan GRANT Function (WAJIB DIJALANKAN)
--  Sistem Antrian PWA
--
--  ------------------------------------------------------------
--  APA YANG SALAH SEBELUMNYA
--  ------------------------------------------------------------
--  Project Supabase memasang default privileges seperti ini
--  saat project dibuat:
--
--      ALTER DEFAULT PRIVILEGES IN SCHEMA public
--        GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
--
--  Artinya setiap CREATE FUNCTION langsung mendapat grant EXECUTE
--  LANGSUNG ke peran anon, authenticated, dan service_role — bukan
--  melalui PUBLIC.
--
--  File 02 menulis `revoke execute ... from public`, yang sama
--  sekali TIDAK menyentuh grant langsung tersebut. Akibatnya
--  kelima function di bawah tetap bisa dipanggil anon.
--
--  ------------------------------------------------------------
--  DAMPAK SEBELUM DIPERBAIKI
--  ------------------------------------------------------------
--  store_refresh_token  — anon bisa membuat refresh token untuk
--                         user_id mana pun, lalu menukarnya lewat
--                         /api/auth/refresh → PENGAMBILALIHAN AKUN.
--  revoke_all_refresh_tokens — anon bisa mengeluarkan semua user.
--  create_queue_entry   — anon bisa menyisipkan antrian.
--  next_queue_number    — anon bisa menghitung nomor antrian.
--  revoke_refresh_token — butuh token_hash, sulit dieksploitasi.
--
--  ------------------------------------------------------------
--  CARA MENJALANKAN
--  ------------------------------------------------------------
--  Buka Supabase Dashboard → SQL Editor → New query →
--  tempel SELURUH isi file ini → klik Run.
--
--  Aman dijalankan berkali-kali (idempotent).
--  Tidak menghapus data. Tidak menyentuh isi tabel.
--  Jika masih ada kebocoran, script ini BERHENTI dan
--  membatalkan semua perubahan (tidak ada kondisi setengah jadi).
-- ============================================================


-- ============================================================
--  LANGKAH 1 — Cabut grant dari public, anon, dan authenticated
--
--  Ketiga peran harus dicabut. Menarik hanya dari public tidak cukup.
-- ============================================================
revoke execute on function next_queue_number(date)
  from public, anon, authenticated;
revoke execute on function create_queue_entry(text, uuid, date, print_status)
  from public, anon, authenticated;
revoke execute on function store_refresh_token(uuid, text, timestamptz, text)
  from public, anon, authenticated;
revoke execute on function revoke_refresh_token(text)
  from public, anon, authenticated;
revoke execute on function revoke_all_refresh_tokens(uuid)
  from public, anon, authenticated;


-- ============================================================
--  LANGKAH 2 — Hanya service_role (Worker) yang boleh memanggil
--
--  Catatan: peran `authenticated` sengaja TIDAK diberi akses.
--  Aplikasi ini memakai custom auth — token session ditangani
--  Worker sebagai cookie, bukan Supabase Auth JWT. Tidak ada
--  satu pun request dari aplikasi ini yang memakai peran
--  `authenticated`. Semua tulisan lewat service_role.
--
--  verifiable: lihat hasil AKHIR file ini.
-- ============================================================
grant execute on function next_queue_number(date)
  to service_role;
grant execute on function create_queue_entry(text, uuid, date, print_status)
  to service_role;
grant execute on function store_refresh_token(uuid, text, timestamptz, text)
  to service_role;
grant execute on function revoke_refresh_token(text)
  to service_role;
grant execute on function revoke_all_refresh_tokens(uuid)
  to service_role;


-- ============================================================
--  LANGKAH 3 — SECURITY DEFINER → SECURITY INVOKER
--
--  Lapisan kedua, independen dari langkah 1–2.
--
--  SECURITY DEFINER membuat function berjalan sebagai pemilik
--  tabel, sehingga MELEWATI RLS. Itulah penyebab anon bisa
--  menulis ke refresh_tokens.
--
--  SECURITY INVOKER membuat function berjalan sebagai pemanggil,
--  jadi RLS berlaku normal. Karena refresh_tokens tidak punya
--  policy INSERT untuk anon, RLS akan menolak — meskipun suatu
--  saat grant-nya bocor lagi.
--
--  service_role tetap berfungsi: peran itu memang melakukan bypass RLS.
-- ============================================================
create or replace function store_refresh_token(
  p_user_id      uuid,
  p_token_hash   text,
  p_expires_at   timestamptz,
  p_user_agent   text default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_token_hash is null or length(p_token_hash) <> 64 then
    raise exception 'token_hash harus berupa SHA-256 hex (64 karakter)';
  end if;

  insert into refresh_tokens (user_id, token_hash, expires_at, user_agent)
  values (p_user_id, p_token_hash, p_expires_at, p_user_agent)
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function revoke_refresh_token(p_token_hash text)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count integer;
begin
  update refresh_tokens
     set revoked_at = now()
   where token_hash = p_token_hash
     and revoked_at is null;
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

create or replace function revoke_all_refresh_tokens(p_user_id uuid)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_count integer;
begin
  update refresh_tokens
     set revoked_at = now()
   where user_id = p_user_id
     and revoked_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function next_queue_number(p_date date)
returns int
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_next int;
begin
  select coalesce(max(number), 0) + 1 into v_next
    from queue_entries
   where queue_date = p_date;
  return v_next;
end;
$$;

create or replace function create_queue_entry(
  p_customer_name text,
  p_category_id   uuid,
  p_queue_date    date,
  p_print_status  print_status default 'pending'
)
returns queue_entries
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_entry queue_entries;
begin
  insert into queue_entries (queue_date, number, customer_name, category_id, print_status)
  values (p_queue_date, next_queue_number(p_queue_date), p_customer_name, p_category_id, p_print_status)
  returning * into v_entry;
  return v_entry;
end;
$$;


-- ============================================================
--  LANGKAH 4 — Tutup default privileges agar tidak terulang
--
--  Tanpa ini, function berikutnya yang dibuat siapa pun di project
--  ini akan bocor ke anon dengan cara yang sama persis.
-- ============================================================
alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated;
alter default privileges in schema public
  grant execute on functions to service_role;


-- ============================================================
--  LANGKAH 5 — VERIFIKASI (gagal sendiri kalau masih bocor)
--
--  CATATAN PENTING soal cakupan:
--
--  Schema `public` milik BERSAMA. Extension yang dipasang Supabase
--  (mis. citext) menaruh function-nya di sana, dan Postgres memberi
--  EXECUTE ke PUBLIC untuk semua function secara default.
--
--  Function-function itu AMAN — hanya pembanding string, tidak
--  menyentuh data aplikasi. Kalau ikut dihitung sebagai kegagalan,
--  script ini tidak akan pernah bisa lulus.
--
--  Karena itu pengecekan dibelah dua:
--
--    1. WAJIB  — lima function milik aplikasi di bawah.
--                Gagal (raise exception) kalau masih terbuka.
--    2. PERINGATAN — function `public` milik sendiri yang bukan
--                anggota extension. Hanya raise warning.
--
--  Exception membatalkan seluruh transaksi, jadi tidak mungkin
--  tersisa perubahan yang hanya diterapkan sebagian.
-- ============================================================
do $$
declare
  v_app_functions text[] := array[
    'next_queue_number',
    'create_queue_entry',
    'store_refresh_token',
    'revoke_refresh_token',
    'revoke_all_refresh_tokens'
  ];

  v_leak    text;
  v_lainnya text;
begin
  -- (1) Function milik aplikasi: WAJIB tertutup.
  select string_agg(format('%s(%s)', p.proname, pg_get_function_identity_arguments(p.oid)), ', ')
    into v_leak
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    and p.proname = any (v_app_functions)
    and (has_function_privilege('anon',          p.oid, 'execute')
      or has_function_privilege('authenticated', p.oid, 'execute'));

  if v_leak is not null then
    raise exception 'GAGAL — function aplikasi masih bisa dipanggil tanpa login: %', v_leak;
  end if;

  -- (2) Function milik sendiri di luar daftar: PERINGATAN saja.
  --     pg_depend menandai anggota extension, sehingga citext dan
  --     sejenisnya tidak ikut disorot.
  select string_agg(format('%s(%s)', p.proname, pg_get_function_identity_arguments(p.oid)), ', ')
    into v_lainnya
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    and not exists (
      select 1
      from pg_depend d
      where d.classid    = 'pg_proc'::regclass
        and d.objid      = p.oid
        and d.refclassid = 'pg_extension'::regclass
    )
    and (has_function_privilege('anon',          p.oid, 'execute')
      or has_function_privilege('authenticated', p.oid, 'execute'));

  if v_lainnya is not null then
    raise warning 'Perhatian — function di luar daftar aplikasi masih terbuka oleh anon: %', v_lainnya;
  end if;

  raise notice 'PERBAIKAN BERHASIL — kelima function aplikasi hanya bisa dipanggil service_role';
end;
$$;


-- ============================================================
--  RINGKASAN (untuk dibaca manusia)
--
--  Hanya lima function milik aplikasi. Function extension seperti
--  citext sengaja tidak ditampilkan karena selalu ada dan selalu
--  bisa dipanggil anon — itu normal, bukan tanda masalah.
-- ============================================================
select
  p.proname                                                  as function,
  has_function_privilege('anon',          p.oid, 'execute') as anon,
  has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
  has_function_privilege('service_role',  p.oid, 'execute') as service_role,
  case when p.prosecdef then 'definer' else 'invoker' end   as mode
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f'
  and p.proname = any (array[
    'next_queue_number', 'create_queue_entry', 'store_refresh_token',
    'revoke_refresh_token', 'revoke_all_refresh_tokens'
  ])
order by p.proname;

-- Cara baca hasil di atas:
--
--   anon = false, authenticated = false, service_role = true  → AMAN
--   mode = invoker                                             → lapisan kedua aktif
--
--   Kalau ada baris dengan anon = true, JANGAN diabaikan.
--   Salin kembali output pesan error-nya dan laporkan.


-- ============================================================
--  CATATAN UNTUK MIGRASI KE PROJECT BARU
-- ============================================================
--  Hapus owner lama (owner@example.com) bila masih ada:
--
--    delete from users where email = 'owner@example.com';
--
--  Lalu jalankan 02_seed_and_fixes.sql, kemudian file ini (03)
--  karena 02 sudah diperbaiki dan tidak lagi memerlukan 03
--  untuk menutup grant — 03 tetap aman dijalankan sebagai
--  pengaman ulang.
-- ============================================================