-- 04 — Migrasi ke Supabase Auth (Tahap 1: fondasi database)
-- Jalankan di SQL Editor. Idempoten, aman diulang.
--
-- Aditif: tabel `users` dan `refresh_tokens` dibiarkan sampai Tahap 5.

-- Peran dibaca dari app_metadata JWT. raw_user_meta_data bisa diubah sendiri
-- oleh pengguna yang login, jadi tidak boleh jadi sumber peran.
create or replace function public.current_role()
returns text
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '')
$$;

-- Akun yang dinonaktifkan owner masih bisa login (Supabase Auth tidak tahu),
-- jadi setiap policy perlu memeriksa flag ini.
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.profiles is
  'Data aplikasi per pengguna. Peran TIDAK ada di sini — dibaca dari app_metadata JWT.';

-- WAJIB setelah tabel: function `language sql` divalidasi saat CREATE, jadi
-- fungsi yang membaca tabel yang belum ada gagal dengan "relation does not exist".
create or replace function public.is_active_user()
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.is_active
  )
$$;

-- Peran selalu 'admin'. Owner pertama lewat bootstrap_owner().
-- Jangan pernah membaca peran dari raw_user_meta_data: pengguna bisa menulis
-- {"role":"owner"} saat mendaftar dan naik level.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''))
  on conflict (id) do nothing;

  if coalesce(new.raw_app_meta_data ->> 'role', '') = '' then
    update auth.users
       set raw_app_meta_data = jsonb_set(
             coalesce(raw_app_meta_data, '{}'::jsonb), '{role}', '"admin"'::jsonb)
     where id = new.id;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

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

-- Memecahkan chicken-and-egg: akun pertama tidak punya owner untuk memverifikasi
-- diri. Menolak jalan kalau owner sudah ada, jadi tidak bisa dipakai ulang.
-- Pemanggil sah adalah postgres lewat SQL Editor (mengabaikan grant).
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
    from auth.users where raw_app_meta_data ->> 'role' = 'owner';

  if v_existing > 0 then
    raise exception 'Owner sudah ada. Gunakan set_user_role() untuk mengubah peran.';
  end if;

  update auth.users
     set raw_app_meta_data = jsonb_set(
           coalesce(raw_app_meta_data, '{}'::jsonb), '{role}', '"owner"'::jsonb)
   where id = p_user_id;

  if not found then
    raise exception 'User dengan id % tidak ditemukan.', p_user_id;
  end if;

  insert into public.profiles (id) values (p_user_id)
    on conflict (id) do update set is_active = true;
end;
$$;

-- Owner mengubah peran. Menjaga owner terakhir agar tidak kehilangan akses.
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

  if p_role = 'admin'
     and exists (select 1 from auth.users
                  where raw_app_meta_data ->> 'role' = 'owner' and id = p_user_id)
     and (select count(*) from auth.users where raw_app_meta_data ->> 'role' = 'owner') <= 1
  then
    raise exception 'Tidak bisa menurunkan peran owner terakhir.';
  end if;

  update auth.users
     set raw_app_meta_data = jsonb_set(
           coalesce(raw_app_meta_data, '{}'::jsonb), '{role}', to_jsonb(p_role))
   where id = p_user_id;

  if not found then
    raise exception 'User dengan id % tidak ditemukan.', p_user_id;
  end if;
end;
$$;

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

  update public.profiles set is_active = p_active, updated_at = now()
   where id = p_user_id;

  if not found then
    raise exception 'User dengan id % tidak ditemukan.', p_user_id;
  end if;
end;
$$;

-- Membaca auth.users butuh hak postgres, jadi lewat SECURITY DEFINER dengan
-- pemeriksaan peran di dalamnya.
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
  select u.id, u.email, p.display_name,
         coalesce(u.raw_app_meta_data ->> 'role', 'admin'),
         coalesce(p.is_active, true), u.last_sign_in_at
    from auth.users u
    left join public.profiles p on p.id = u.id
   order by u.created_at;
end;
$$;

-- Admin API bawaan butuh service_role key; fungsi ini membuat akun lewat SQL,
-- jadi frontend tidak pernah memegang service_role.
create or replace function public.create_user(
  p_email        text,
  p_password     text,
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

alter table public.profiles enable row level security;

create index if not exists idx_profiles_active on public.profiles(is_active);

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select to authenticated using (id = auth.uid());

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "read all profiles" on public.profiles;
create policy "read all profiles" on public.profiles
  for select to authenticated using (public.current_role() = 'owner');

revoke all on public.profiles from anon;
grant select, update on public.profiles to authenticated;

-- Policy lama `for all to authenticated using (true)` membolehkan admin biasa
-- mengubah kategori. Diperketat jadi owner saja.
drop policy if exists "insert queue_entries" on queue_entries;
create policy "insert queue_entries" on queue_entries
  for insert to authenticated with check (public.is_active_user());

drop policy if exists "update queue_entries" on queue_entries;
create policy "update queue_entries" on queue_entries
  for update to authenticated using (public.is_active_user()) with check (public.is_active_user());

drop policy if exists "delete queue_entries" on queue_entries;
create policy "delete queue_entries" on queue_entries
  for delete to authenticated using (public.is_active_user());

drop policy if exists "manage categories" on categories;
create policy "manage categories" on categories
  for all to authenticated
  using (public.current_role() = 'owner' and public.is_active_user())
  with check (public.current_role() = 'owner' and public.is_active_user());

drop policy if exists "write settings" on settings;
create policy "write settings" on settings
  for all to authenticated
  using (public.current_role() = 'owner' and public.is_active_user())
  with check (public.current_role() = 'owner' and public.is_active_user());

-- Hanya authenticated. anon tetap terkunci (hardening commit b5521c5).
grant execute on function next_queue_number(date) to authenticated;
grant execute on function create_queue_entry(text, uuid, date, print_status) to authenticated;

-- WAJIB: Postgres memberi EXECUTE ke PUBLIC untuk function baru. bootstrap_owner
-- paling berbahaya: siapa pun bisa memanggilnya sebelum owner resmi dibuat.
-- Function trigger dicabut dari semua peran karena pemanggilannya dari jaringan
-- tidak punya arti.
revoke execute on function public.handle_new_user()  from public, anon, authenticated;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;

revoke execute on function public.current_role()   from public, anon;
revoke execute on function public.is_active_user() from public, anon;
revoke execute on function public.create_user(text, text, text)  from public, anon;
revoke execute on function public.list_users()                   from public, anon;
revoke execute on function public.set_user_role(uuid, text)      from public, anon;
revoke execute on function public.set_user_active(uuid, boolean) from public, anon;

-- Ditutup untuk authenticated juga: pemanggil sah adalah postgres lewat SQL Editor.
revoke execute on function public.bootstrap_owner(uuid) from public, anon, authenticated;

grant execute on function public.current_role()   to authenticated;
grant execute on function public.is_active_user() to authenticated;
grant execute on function public.create_user(text, text, text)  to authenticated;
grant execute on function public.list_users()                   to authenticated;
grant execute on function public.set_user_role(uuid, text)      to authenticated;
grant execute on function public.set_user_active(uuid, boolean) to authenticated;

alter default privileges in schema public revoke execute on functions from public, anon;

-- Verifikasi: gagal sendiri kalau ada function migrasi yang bocor ke anon.
do $$
declare
  v_leak text;
  v_bad  text;
begin
  select string_agg(p.proname, ', ') into v_leak
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

  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname in (
       'handle_new_user', 'touch_updated_at', 'current_role', 'is_active_user',
       'bootstrap_owner', 'set_user_role', 'set_user_active', 'list_users', 'create_user'
     )
     and has_function_privilege('anon', p.oid, 'execute');

  if v_bad is not null then
    raise exception 'GAGAL — anon masih bisa memanggil function migrasi: %', v_bad;
  end if;

  raise notice 'TAHAP 1 BERHASIL — profiles ada, function migrasi tertutup untuk anon.';
end;
$$;

select p.proname,
       has_function_privilege('anon', p.oid, 'execute')         as anon,
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
