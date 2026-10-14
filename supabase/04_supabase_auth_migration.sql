-- ============================================================
--  04 — Migrasi ke Supabase Auth (TAHAP 1: fondasi database)
--  Sistem Antrian PWA
--
--  ============================================================
--  TUJUAN
--  ============================================================
--  Pindahkan otorisasi dari Cloudflare Worker (service_role) ke
--  Supabase Auth + Row Level Security, sehingga frontend bisa
--  langsung ber talks dengan Supabase tanpa backend perantara.
--
--  TAHAP INI ADALAH TAHAP AWAL YANG SEPENUHNYA ADITIF:
--  belum menghapus apa pun. `users` dan `refresh_tokens` masih ada
--  dan masih dipakai Worker, sehingga aplikasi lama tetap jalan
--  sampai Tahap 3 selesai.
--
--  ============================================================
--  CARA MENJALANKAN
--  ============================================================
--  Supabase Dashboard -> SQL Editor -> New query ->
--  tempel SELURUH file ini -> Run.
--
--  Aman dijalankan berulang kali (idempoten).
--
--  ============================================================
--  KEPUTUSAN DESAIN PENTING
--  ============================================================
--
--  1. PERAN DISIMPAN DI app_metadata, BUKAN DI TABEL
--     RLS harus membaca peran dari JWT, karena policy dievaluasi
--     di database dan tidak bisa immoral query tabel lain dengan
--     aman pada setiap baris.
--
--     `app_metadata` dipilih, bukan `raw_user_meta_data`, karena
--     `raw_user_meta_data` BISA diubah sendiri oleh pengguna yang
--     login. Kalau peran dibaca dari sana, siapa pun bisa menulis
--     {"role":"owner"} dan naik level menjadi owner.
--
--  2. PERAN BARU SELALU 'admin'
--     Trigger di bawah tidak pernah membaca peran dari metadata
--     pendaftaran. Kalau iya, pengguna bisa mendaftar dan langsung
--     jadi owner. Owner pertama dibuat lewat bootstrap_owner().
--
--  3. TIDAK ADA service_role KEY DI APLIKASI
--     Operasi admin memakai function SECURITY DEFINER yang
--  memeriksa pemanggilnya sendiri.
-- ============================================================


-- ============================================================
--  1. Helper: baca peran dari JWT
-- ============================================================
--  Dipakai oleh seluruh policy RLS. Function ini `stable` supaya
--  PostgreSQL boleh evaluate sekali per query, bukan per baris.
create or replace function public.current_role()
returns text
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '')
$$;

comment on function public.current_role() is
  'Peran pengguna dari app_metadata JWT: owner, admin, atau kosong bila anonim.';


-- ============================================================
--  2. Tabel profiles
-- ============================================================
--  Data khusus aplikasi. Identitas dan password hidup di auth.users.
--
--  URUTAN PENTING: tabel ini harus dibuat SEBELUM is_active_user()
--  dan handle_new_user(). PostgreSQL memvalidasi body function
--  `language sql` saat CREATE, jadi fungsi yang membaca tabel yang
--  belum ada akan gagal dengan "relation does not exist".
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.profiles is
  'Data aplikasi per pengguna. Peran TIDAK ada di sini — dibaca dari app_metadata JWT.';

alter table public.profiles enable row level security;

create index if not exists idx_profiles_active on public.profiles(is_active);


-- ============================================================
--  3. Helper: apakah akun aktif
-- ============================================================
--  Owner bisa menonaktifkan akun admin. Akun yang dinonaktifkan
--  tetap boleh login (Supabase Auth tidak tahu soal ini), jadi
--  setiap policy perlu memeriksa flag ini.
create or replace function public.is_active_user()
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.is_active
  )
$$;

comment on function public.is_active_user() is
  'True bila pengguna login dan akunnya belum dinonaktifkan owner.';


-- ============================================================
--  4. Trigger: buat profile begitu akun dibuat
-- ============================================================
--  Peran selalu 'admin'. Owner pertama lewat bootstrap_owner().
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    nullif(trim(new.raw_user_meta_data ->> 'display_name'), '')
  )
  on conflict (id) do nothing;

  -- Peran default 'admin' secara eksplisit. Jangan pernah membaca
  -- dari raw_user_meta_data — bisa dimanipulasi pengguna.
  if coalesce(new.raw_app_meta_data ->> 'role', '') = '' then
    update auth.users
       set raw_app_meta_data = jsonb_set(
             coalesce(raw_app_meta_data, '{}'::jsonb),
             '{role}', '"admin"'::jsonb
           )
     where id = new.id;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ============================================================
--  5. Trigger: segarkan updated_at
-- ============================================================
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch
  before update on public.profiles
  for each row execute function public.touch_updated_at();


-- ============================================================
--  6. bootstrap_owner — hanya bisa dipakai sekali
--  ============================================================
--  Memecahkan masalah chicken-and-egg: akun pertama tidak punya owner untuk
--  memverifikasi diri. Solusinya: fungsi ini menolak jalan kalau
--  sudah ada owner, jadi tidak bisa disalahgunakan siapa pun
--  setelah sistem berjalan.
--
--  CARA PAKAI (setelah membuat akun lewat Dashboard):
--    select public.bootstrap_owner('<uuid-dari-auth.users>');
create or replace function public.bootstrap_owner(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing int;
begin
  select count(*) into v_existing
  from auth.users
  where raw_app_meta_data ->> 'role' = 'owner';

  if v_existing > 0 then
    raise exception 'Owner sudah ada. Gunakan set_user_role() untuk mengubah peran.';
  end if;

  update auth.users
     set raw_app_meta_data = jsonb_set(
           coalesce(raw_app_meta_data, '{}'::jsonb),
           '{role}', '"owner"'::jsonb
         )
   where id = p_user_id;

  if not found then
    raise exception 'User dengan id % tidak ditemukan.', p_user_id;
  end if;

  insert into public.profiles (id)
  values (p_user_id)
  on conflict (id) do update set is_active = true;
end;
$$;

comment on function public.bootstrap_owner(uuid) is
  'Jadikan satu akun sebagai owner. Hanya bisa dipakai sekali.';


-- ============================================================
--  7. set_user_role — owner mengubah peran (selalu tanpa service_role)
-- ============================================================
create or replace function public.set_user_role(p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_role not in ('owner', 'admin') then
    raise exception 'Peran tidak dikenal: %. Gunakan owner atau admin.', p_role;
  end if;

  if public.current_role() <> 'owner' then
    raise exception 'Hanya owner yang bisa mengubah peran.';
  end if;

  -- Cegah owner terakhir kehilangan akses.
  if p_role = 'admin' then
    if exists (
      select 1 from auth.users
      where raw_app_meta_data ->> 'role' = 'owner' and id = p_user_id
    ) then
      if (select count(*) from auth.users where raw_app_meta_data ->> 'role' = 'owner') <= 1 then
        raise exception 'Tidak bisa menurunkan peran owner terakhir.';
      end if;
    end if;
  end if;

  update auth.users
     set raw_app_meta_data = jsonb_set(
           coalesce(raw_app_meta_data, '{}'::jsonb),
           '{role}', to_jsonb(p_role)
         )
   where id = p_user_id;

  if not found then
    raise exception 'User dengan id % tidak ditemukan.', p_user_id;
  end if;
end;
$$;


-- ============================================================
--  8. set_user_active — owner menonaktifkan/mengaktifkan akun
-- ============================================================
create or replace function public.set_user_active(p_user_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_role() <> 'owner' then
    raise exception 'Hanya owner yang bisa mengubah status akun.';
  end if;

  update public.profiles
     set is_active = p_active,
         updated_at = now()
   where id = p_user_id;

  if not found then
    raise exception 'User dengan id % tidak ditemukan.', p_user_id;
  end if;
end;
$$;


-- ============================================================
--  9. list_users — owner melihat daftar akun
--  ============================================================
--  Membaca auth.users butuh hak postgres, jadi lewat SECURITY
--  DEFINER dengan pemeriksaan peran di dalamnya.
create or replace function public.list_users()
returns table (
  id           uuid,
  email        text,
  display_name text,
  role         text,
  is_active    boolean,
  last_sign_in timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_role() <> 'owner' then
    raise exception 'Hanya owner yang bisa melihat daftar akun.';
  end if;

  return query
  select u.id,
         u.email,
         p.display_name,
         coalesce(u.raw_app_meta_data ->> 'role', 'admin'),
         coalesce(p.is_active, true),
         u.last_sign_in_at
  from auth.users u
  left join public.profiles p on p.id = u.id
  order by u.created_at;
end;
$$;


-- ============================================================
--  10. create_user — owner membuat akun admin
--  ============================================================
--  Supabase tidak menyediakan RPC publik untuk membuat akun; itu
--  Admin API bawaan butuh service_role key. Fungsi ini membuat akun lewat
--  SQL di dalam database, jadi frontend tidak pernah memegang
--  service_role key.
--
--  Password dikembalikan apa adanya supaya owner bisa menyalinnya.
--  Wajib diganti pengguna saat login pertama (lihat auth_metadata).
create or replace function public.create_user(
  p_email       text,
  p_password    text,
  p_display_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if public.current_role() <> 'owner' then
    raise exception 'Hanya owner yang bisa membuat akun.';
  end if;

  if length(p_password) < 8 then
    raise exception 'Password minimal 8 karakter.';
  end if;

  insert into auth.users (email, password)
  values (lower(trim(p_email)), p_password)
  returning id into v_id;

  insert into public.profiles (id, display_name)
  values (v_id, nullif(trim(p_display_name), ''))
  on conflict (id) do nothing;

  return v_id;
end;
$$;

comment on function public.create_user(text, text, text) is
  'Buat akun admin (role default admin). Password wajib diganti saat login pertama.';


-- ============================================================
--  11. RLS untuk profiles
-- ============================================================
drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select to authenticated using (id = auth.uid());

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

drop policy if exists "read all profiles" on public.profiles;
create policy "read all profiles" on public.profiles
  for select to authenticated
  using (public.current_role() = 'owner');

revoke all on public.profiles from anon;
grant select, update on public.profiles to authenticated;


-- ============================================================
--  12. RLS berbasis peran (menggantikan policy longgar)
-- ============================================================
--  Queue: semua staff aktif boleh bekerja dengan antrean.
drop policy if exists "insert queue_entries" on queue_entries;
create policy "insert queue_entries" on queue_entries
  for insert to authenticated
  with check (public.is_active_user());

drop policy if exists "update queue_entries" on queue_entries;
create policy "update queue_entries" on queue_entries
  for update to authenticated
  using (public.is_active_user())
  with check (public.is_active_user());

drop policy if exists "delete queue_entries" on queue_entries;
create policy "delete queue_entries" on queue_entries
  for delete to authenticated
  using (public.is_active_user());

-- Kategori: tulis HANYA owner. Policy lama `for all to authenticated`
-- mengizinkan admin biasa mengubah kategori — itu kelonggaran.
drop policy if exists "manage categories" on categories;
create policy "manage categories" on categories
  for all to authenticated
  using (public.current_role() = 'owner' and public.is_active_user())
  with check (public.current_role() = 'owner' and public.is_active_user());

-- Pengaturan: baca semua staff, tulis hanya owner.
drop policy if exists "write settings" on settings;
create policy "write settings" on settings
  for all to authenticated
  using (public.current_role() = 'owner' and public.is_active_user())
  with check (public.current_role() = 'owner' and public.is_active_user());


-- ============================================================
--  13. Grant RPC antrean ke authenticated
-- ============================================================
--  PENTING: grant hanya ke `authenticated`, TIDAK ke `anon`.
--  Ini melanjutkan hardening commit b5521c5 — anon tetap tidak boleh
--  menghitung atau membuat nomor antrean tanpa login.
grant execute on function next_queue_number(date) to authenticated;
grant execute on function create_queue_entry(text, uuid, date, print_status) to authenticated;

-- Terapkan perubahan default privileges supaya function yang dibuat
-- nanti ikut aturan ini.
alter default privileges in schema public
  grant execute on functions to authenticated;


-- ============================================================
--  14. Verifikasi
-- ============================================================
do $$
declare
  v_leak text;
begin
  -- anon TIDAK BOLEH punya EXECUTE pada function antrean.
  select string_agg(p.proname, ', ')
    into v_leak
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    and p.proname in ('next_queue_number', 'create_queue_entry')
    and has_function_privilege('anon', p.oid, 'execute');

  if v_leak is not null then
    raise exception 'GAGAL — anon masih bisa memanggil: %', v_leak;
  end if;

  if not exists (select 1 from pg_tables
                 where schemaname = 'public' and tablename = 'profiles') then
    raise exception 'GAGAL — tabel profiles belum dibuat.';
  end if;

  raise notice 'TAHAP 1 BERHASIL — profiles ada, anon tetap terkunci dari function antrean.';
end;
$$;

select 'fungsi publik milik aplikasi' as cek, p.proname,
       has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f'
  and p.proname in (
    'next_queue_number', 'create_queue_entry', 'store_refresh_token',
    'revoke_refresh_token', 'revoke_all_refresh_tokens',
    'current_role', 'is_active_user', 'list_users', 'set_user_role',
    'set_user_active', 'create_user', 'bootstrap_owner'
  )
order by p.proname;
