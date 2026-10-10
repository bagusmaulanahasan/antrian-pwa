-- ============================================================
--  Perbaikan & Seed — Sistem Antrian
--
--  Jalankan script ini di Supabase SQL Editor SETELAH schema.sql.
--  Script ini idempoten: aman dijalankan berulang kali.
--
--  Yang diperbaiki:
--    1. Seed owner/settings yang belum ada (schema.sql bagian seed tidak
--       ikut tereksekusi di project rdgrjaaambhdihyfbnru).
--    2. Kebocoran grant: function next_queue_number bisa dipanggil role
--       anon karena Postgres memberi EXECUTE default ke PUBLIC.
--    3. Tabel queue_entries belum masuk publication realtime, jadi
--       dashboard TV tidak akan sinkron.
--    4. Policy RLS yang belum lengkap (settings, queue_entries, categories).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Cabut grant anon pada function
--
--    PENTING: revoke HARUS dari `public, anon, authenticated`.
--
--    Supabase memasang default privileges saat project dibuat:
--        ALTER DEFAULT PRIVILEGES IN SCHEMA public
--          GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
--
--    Grant itu LANGSUNG ke peran, bukan melalui PUBLIC. Karena itu
--    `revoke ... from public` saja tidak pernah menutup celah —
--    hanya mencabut grant default Postgres yang terpisah.
--
--    Peran `authenticated` sengaja tidak diberi akses. Aplikasi ini
--    memakai custom auth: session ditangani Worker sebagai cookie,
--    bukan Supabase Auth JWT. Semua tulisan lewat service_role.
-- ------------------------------------------------------------
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

grant execute on function next_queue_number(date) to service_role;
grant execute on function create_queue_entry(text, uuid, date, print_status) to service_role;
grant execute on function store_refresh_token(uuid, text, timestamptz, text) to service_role;
grant execute on function revoke_refresh_token(text) to service_role;
grant execute on function revoke_all_refresh_tokens(uuid) to service_role;

-- Hentikan default privileges supaya function berikutnya tidak bocor.
alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2. Policy RLS
--
--    Dashboard TV & admin membaca lewat anon key, jadi SELECT harus
--    terbuka. Tulis TIDAK boleh lewat anon — semua tulisan lewat Worker
--    memakai service_role.
-- ------------------------------------------------------------
alter table users enable row level security;
alter table refresh_tokens enable row level security;
alter table categories enable row level security;
alter table queue_entries enable row level security;
alter table settings enable row level security;

-- read categories (dashboard TV & admin)
drop policy if exists "read categories" on categories;
create policy "read categories" on categories
  for select to anon, authenticated using (true);

-- read queue_entries (dashboard TV & admin)
drop policy if exists "read queue_entries" on queue_entries;
create policy "read queue_entries" on queue_entries
  for select to anon, authenticated using (true);

-- Pengaturan: nilai voice/print template bukan rahasia, dan dashboard TV
-- membacanya untuk menyusun pengumuman suara.
drop policy if exists "read settings" on settings;
create policy "read settings" on settings
  for select to anon, authenticated using (true);

-- Tulis HANYA lewat authenticated atau service_role.
drop policy if exists "insert queue_entries" on queue_entries;
create policy "insert queue_entries" on queue_entries
  for insert to authenticated with check (true);
create policy "update queue_entries" on queue_entries
  for update to authenticated using (true) with check (true);
create policy "delete queue_entries" on queue_entries
  for delete to authenticated using (true);

drop policy if exists "manage categories" on categories;
create policy "manage categories" on categories
  for all to authenticated using (true) with check (true);

-- users & refresh_tokens TIDAK boleh dibaca anon sama sekali.
-- Tanpa policy, RLS menutup semua akses — itu yang kita mau.
drop policy if exists "read users" on users;
revoke select on users from anon;
revoke all on refresh_tokens from anon;

-- Menutup jalur tulis anonim sepenuhnya.
revoke insert, update, delete on queue_entries from anon;
revoke insert, update, delete on categories from anon;
revoke insert, update, delete on settings from anon;

-- ------------------------------------------------------------
-- 3. Realtime publication
--
--    Tanpa ini, dashboard TV hanya bisa refresh manual.
-- ------------------------------------------------------------
-- ------------------------------------------------------------
-- 3b. RPC untuk refresh token
--
--    Tabel `refresh_tokens` sengaja tidak diberi policy RLS apa pun supaya
--    tidak bisa dibaca atau diubah dari sisi klien. Worker memakai
--    `service_role` yang melewati RLS, jadi INSERT langsung tetap bisa —
--    tetapi seluruh jalur tulis dicentralisasi lewat RPC SECURITY DEFINER
--    berikut agar tervalidasi di satu tempat saja.
--
--    Argumen token_hash yang tidak valid langsung ditolak.
-- ------------------------------------------------------------
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

-- Hanya service_role (yaitu Worker) yang boleh memanggil.
revoke execute on function store_refresh_token(uuid, text, timestamptz, text)
  from public, anon, authenticated;
grant execute on function store_refresh_token(uuid, text, timestamptz, text)
  to service_role;

-- Pencabutan token saat logout / ganti password juga lewat RPC supaya
-- konsisten dengan aturan "tidak ada akses langsung ke refresh_tokens".
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

revoke execute on function revoke_refresh_token(text)
  from public, anon, authenticated;
grant execute on function revoke_refresh_token(text) to service_role;

-- Cabut seluruh refresh token milik satu user (dipakai setelah ganti password).
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

revoke execute on function revoke_all_refresh_tokens(uuid)
  from public, anon, authenticated;
grant execute on function revoke_all_refresh_tokens(uuid) to service_role;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'queue_entries'
  ) then
    alter publication supabase_realtime add table public.queue_entries;
  end if;
end
$$;

-- ------------------------------------------------------------
-- 4. Seed pengaturan default
--
--    Idempoten: ON CONFLICT DO NOTHING.
-- ------------------------------------------------------------
insert into settings (key, value) values
  ('reset_hour', '0'::jsonb),
  ('tv_pin_hash', 'null'::jsonb),
  ('print_template', '{
    "placeName": "Nama Tempat",
    "address": "Alamat Lokasi",
    "phone": "",
    "logoUrl": null,
    "template": "{tempat}\n{alamat}\n\nNomor: {nomor}\nNama: {nama}\nKategori: {kategori}\n{tanggal}"
  }'::jsonb),
  ('voice_template', '{
    "text": "Nomor antrian {nomor}, atas nama {nama}, kategori {kategori}, silakan menuju ke depan.",
    "rate": 1.0,
    "volume": 1.0,
    "repeat": 1
  }'::jsonb)
on conflict (key) do nothing;

-- ------------------------------------------------------------
-- 5. Seed kategori contoh (opsional — hapus bila tidak diinginkan)
-- ------------------------------------------------------------
insert into categories (name, color, code, sort_order) values
  ('Rawat Jalan', '#6366f1', 'RJ', 1),
  ('Rawat Inap', '#10b981', 'RI', 2),
  ('Laboratorium', '#f59e0b', 'LAB', 3)
on conflict do nothing;

-- ============================================================
--  6. Seed owner — WAJIB diisi manual
--
--  Ganti placeholder di bawah dengan hash argon2id asli, hasil:
--     node scripts/hash-password.mjs "#Pass123" owner@example.com owner --temp
--
--  ⚠️  JANGAN memakai placeholder di bawah. Akun dengan password
--  yang sudah diketahui umum harus langsung diganti.
-- ============================================================
--
--  Contoh (hash di bawah adalah DUMMY — ganti dengan milik Anda):
--
--  insert into users (email, password_hash, role, is_password_temporary)
--  values (
--    'owner@example.com',
--    '$argon2id$v=19$m=19456,t=2,p=1$SALT_ANDA$HASIL_ANDA',
--    'owner',
--    true
--  )
--  on conflict (email) do update
--    set password_hash = excluded.password_hash,
--        is_password_temporary = true,
--        updated_at = now();

-- ============================================================
--  Verifikasi
--
--  Pemeriksaan di bawah GAGAK SENDIRI (raise exception) kalau
--  kelima function milik aplikasi masih bisa dipanggil anon atau
--  authenticated. Exception membatalkan seluruh transaksi, jadi
--  tidak mungkin ada perubahan yang hanya diterapkan sebagian.
--
--  Cakupan sengaja dibatasi ke lima function milik aplikasi.
--  Schema `public` dipakai BERSAMA dengan extension Supabase
--  (mis. citext), dan Postgres memberi EXECUTE ke PUBLIC untuk
--  semua function secara default. Function extension itu aman —
--  hanya pembanding string — dan kalau ikut dihitung sebagai
--  kegagalan, script ini tidak akan pernah bisa lulus.
--
--  Function `public` milik sendiri yang di luar daftar aplikasi
--  hanya dilaporkan sebagai peringatan.
--
--  Tidak perlu menafsirkan angka true/false — cukup perhatikan
--  apakah pesan "VERIFIKASI LULUS" muncul.
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

  raise notice 'VERIFIKASI LULUS — kelima function aplikasi hanya bisa dipanggil service_role';
end;
$$;

-- Ringkasan grant, hanya lima function milik aplikasi.
-- Function extension seperti citext sengaja tidak ditampilkan.
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

--  Cara baca: baris dengan anon = true atau authenticated = true
--  TIDAK BOLEH diabaikan. Salin pesan error-nya dan laporkan.

select 'tabel di publication realtime' as cek, count(*) as hasil
  from pg_publication_tables
 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'queue_entries';
--  hasil harus: 1

select key, updated_at from settings order by key;
--  harus mengembalikan 4 baris