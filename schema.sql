-- ============================================================
--  Sistem Antrian â€” Supabase Postgres Schema
--  Jalankan di SQL Editor Supabase
-- ============================================================

create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- ---------- Enums ----------
create type user_role       as enum ('owner', 'admin');
create type queue_status    as enum ('waiting', 'serving', 'pending', 'done', 'cancelled');
create type print_status    as enum ('printed', 'pending', 'failed');

-- ============================================================
--  Users (custom auth â€” password hash argon2id)
-- ============================================================
create table users (
  id                    uuid primary key default gen_random_uuid(),
  email                 citext      not null unique,
  password_hash         text        not null,
  role                  user_role   not null default 'admin',
  is_password_temporary boolean     not null default false,
  display_name          text,
  is_active             boolean     not null default true,
  last_login_at         timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ============================================================
--  Refresh tokens
-- ============================================================
create table refresh_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid        not null references users(id) on delete cascade,
  token_hash  text        not null unique,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  user_agent  text,
  created_at  timestamptz not null default now()
);

create index idx_refresh_tokens_user on refresh_tokens(user_id) where revoked_at is null;

-- Refresh token dibaca lewat `update ... where token_hash = X` lalu
-- `update ... where id = Y`. Tanpa index pada token_hash, setiap permintaan
-- /api/auth/refresh akan melakukan seq scan â€” dan(seq scan) pada tabel token
-- adalah denyasa yang mudah disalahartikan sebagai "token tidak ada".
create index idx_refresh_tokens_hash on refresh_tokens(token_hash);
create unique index idx_refresh_tokens_hash_unique on refresh_tokens(token_hash)
  where revoked_at is null;

-- ============================================================
--  Settings (key-value dengan updated_at untuk sync cache)
-- ============================================================
create table settings (
  key        text primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now(),
  updated_by uuid        references users(id) on delete set null
);

-- ============================================================
--  Categories (soft delete via is_active)
-- ============================================================
create table categories (
  id          uuid primary key default gen_random_uuid(),
  name        text        not null,
  color       text        not null default '#6366f1',
  code        text,
  sort_order  int         not null default 0,
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_categories_active on categories(is_active, sort_order);

-- ============================================================
--  Queue entries (antrean global, reset harian WIB)
-- ============================================================
create table queue_entries (
  id             uuid primary key default gen_random_uuid(),
  queue_date     date         not null,
  number         int          not null,
  customer_name  text         not null,
  category_id    uuid         references categories(id) on delete set null,
  status         queue_status not null default 'waiting',
  priority       int          not null default 0,

  print_status   print_status not null default 'pending',
  printed_at     timestamptz,
  print_attempts int          not null default 0,

  served_at      timestamptz,
  served_by      uuid         references users(id) on delete set null,
  completed_at   timestamptz,
  cancelled_at   timestamptz,
  recalled_at    timestamptz,
  notes          text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  unique (queue_date, number),
  constraint queue_entries_name_not_blank check (length(trim(customer_name)) > 0)
);

create index idx_queue_date_status  on queue_entries(queue_date, status);
create index idx_queue_date_created on queue_entries(queue_date, created_at desc);
create index idx_queue_priority     on queue_entries(queue_date, priority desc, number asc);

-- Pastikan hanya ada 1 nomor serving per hari
create unique index idx_queue_single_serving
  on queue_entries(queue_date) where status = 'serving';

-- Fungsi generator nomor urut harian
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

-- Fungsi tambah antrian
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
--  Seed Owner & Settings Default
-- ============================================================
--  Akun owner SENGAJA TIDAK di-seed di sini.
--
--  Menanamkan akun owner dengan password placeholder di file skema
--  berbahaya: akun itu ikut ada di setiap project yang memakai
--  schema ini. Buat manual setelah schema selesai, memakai hash
--  argon2id asli dari:
--
--      npm run hash-password "#Pass123" owner@email-anda.com owner --temp
--
--  Perintah itu mencetak statement INSERT siap tempel ke SQL Editor.
--
--  Insert manual (jangan pakai hash contoh):
--
--    insert into users (email, password_hash, role, is_password_temporary)
--    values (
--      'owner@email-anda.com',
--      '$argon2id$v=19$m=...$SALT_ANDA$HASIL_ANDA',
--      'owner',
--      true
--    );

insert into settings (key, value) values
  ('reset_hour', '0'),
  ('tv_pin_hash', 'null'),
  ('print_template', '{
    "placeName": "Nama Tempat", "address": "Alamat Lokasi", "phone": "", "logoUrl": null,
    "template": "{tempat}\\n{alamat}\\n\\nNomor: {nomor}\\nNama: {nama}\\nKategori: {kategori}\\n{tanggal}"
  }'::jsonb),
  ('voice_template', '{
    "text": "Nomor antrian {nomor}, atas nama {nama}, kategori {kategori}, silakan menuju ke depan.",
    "rate": 1.0, "volume": 1.0, "repeat": 1
  }'::jsonb);

-- ============================================================
--  Row Level Security (RLS)
-- ============================================================
alter table users enable row level security;
alter table refresh_tokens enable row level security;
alter table queue_entries enable row level security;
alter table categories enable row level security;
alter table settings enable row level security;

-- Publik (Dashboard TV & Admin via Anon key) hanya BACA.
create policy "read categories" on categories for select to anon, authenticated using (true);
create policy "read queue_entries" on queue_entries for select to anon, authenticated using (true);

-- Semua tulisan lewat Worker memakai service_role, yang memang
-- melakukan bypass RLS. Tidak ada policy INSERT untuk anon maupun
-- authenticated — dengan sengaja.
revoke insert, update, delete on queue_entries from anon, authenticated;
revoke insert, update, delete on refresh_tokens from anon, authenticated;
revoke all on users from anon, authenticated;

-- ============================================================
--  Grant function — hanya service_role
--
--  PENTING: Supabase memasang default privileges saat project dibuat:
--
--      ALTER DEFAULT PRIVILEGES IN SCHEMA public
--        GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
--
--  Grant itu LANGSUNG ke peran, bukan lewat PUBLIC. Karena itu
--  `revoke ... from public` saja tidak menutup celah.
--  Ketiga peran harus dicabut secara eksplisit.
--
--  Peran `authenticated` sengaja tidak diberi akses. Aplikasi ini
--  memakai custom auth — session ditangani Worker sebagai cookie,
--  bukan Supabase Auth JWT — sehingga tidak ada request dari aplikasi
--  ini yang memakai peran tersebut.
-- ============================================================
revoke execute on function next_queue_number(date)
  from public, anon, authenticated;
revoke execute on function create_queue_entry(text, uuid, date, print_status)
  from public, anon, authenticated;

grant execute on function next_queue_number(date) to service_role;
grant execute on function create_queue_entry(text, uuid, date, print_status) to service_role;

-- Tutup default privileges supaya function berikutnya tidak bocor
-- dengan cara yang sama.
alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated;
