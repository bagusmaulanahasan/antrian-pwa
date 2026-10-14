-- ============================================================
--  05 — RPC untuk akses langsung dari browser (TAHAP 3)
--  Sistem Antrian PWA
--
--  ============================================================
--  MENGAPA FILE INI ADA
--  ============================================================
--  Sebagian operasi antrian tidak boleh dijalankan sebagai dua query
--  terpisah dari browser. Operasi "panggil berikutnya" misalnya
--  terdiri dari dua langkah: menyelesaikan nomor yang sedang dilayani,
--  lalu menaikkan nomor berikutnya menjadi serving.
--
--  Kalau dilakukan dari browser, dua admin yang menekan tombol secara
--  bersamaan bisa saling menimpa. Index unik parsial
--  idx_queue_single_serving mencegah dua nomor serving aktif, tetapi
--  salah satunya akan mendapat error, bukan hasil yang benar.
--
--  Solusinya: logika bisnis dipindahkan ke dalam function Postgres.
--  Satu panggilan RPC = satu transaksi database yang utuh.
--
--  ============================================================
--  CARA MENJALANKAN
--  ============================================================
--  Supabase Dashboard -> SQL Editor -> New query ->
--  tempel SELURUH file ini -> Run.  Aman dijalankan berulang kali.
--
--  ============================================================
--  CATATAN KEAMANAN
--  ============================================================
--  Semua function memakai `security invoker`, sehingga RLS tetap
--  berlaku. Function ini bukan jalan memintas RLS — justru sebaliknya,
--  RLS tetap memeriksa apakah pengguna benar-benar staff yang aktif.
--
--  EXECUTE hanya diberikan ke `authenticated`. `anon` dicabut,
--  sesuai hardening commit b5521c5.
-- ============================================================


-- ============================================================
--  1. next_serving — panggil nomor berikutnya (atomik)
-- ============================================================
create or replace function public.next_serving(p_date date)
returns public.queue_entries
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_next public.queue_entries;
begin
  -- (1) Selesaikan nomor yang sedang dilayani, bila ada.
  update public.queue_entries
     set status      = 'done',
         completed_at = now(),
         updated_at  = now()
   where queue_date = p_date
     and status = 'serving';

  -- (2) Ambil nomor waiting paling atas.
  --
  --     FOR UPDATE SKIP LOCKED adalah pola standar antrean: baris
  --     terkunci oleh sesi lain akan dilewati, bukan ditunggu.
  --     Inilah yang membuat dua admin yang menekan tombol bersamaan
  --     mendapat dua nomor BERBEDA, bukan error.
  select q.* into v_next
  from public.queue_entries q
  where q.queue_date = p_date
    and q.status = 'waiting'
  order by q.priority desc, q.number asc
  limit 1
  for update skip locked;

  if not found then
    return null;
  end if;

  update public.queue_entries
     set status     = 'serving',
         served_at  = now(),
         served_by  = auth.uid(),
         updated_at = now()
   where id = v_next.id
  returning * into v_next;

  return v_next;
end;
$$;

comment on function public.next_serving(date) is
  'Selesaikan nomor serving lalu naikkan nomor berikutnya. Atomik dalam satu transaksi.';


-- ============================================================
--  2. set_entry_status — ubah status dengan cap waktu yang tepat
-- ============================================================
--  Aturan cap waktu ini sama dengan yang sebelumnya di Worker
--  (worker/src/lib/queue.ts setStatus), dipindah ke database agar
--  tidak bisa terlewat oleh pemanggil baru di masa depan.
create or replace function public.set_entry_status(
  p_id     uuid,
  p_status queue_status
)
returns public.queue_entries
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_entry public.queue_entries;
  v_now   timestamptz := now();
begin
  update public.queue_entries e
     set status      = p_status,
         updated_at  = v_now,
         served_at   = case when p_status = 'serving' then v_now else e.served_at end,
         served_by   = case when p_status = 'serving' then auth.uid() else e.served_by end,
         completed_at = case when p_status = 'done' then v_now else e.completed_at end,
         cancelled_at = case when p_status = 'cancelled' then v_now else e.cancelled_at end
   where e.id = p_id
  returning * into v_entry;

  if not found then
    raise exception 'Nomor antrian tidak ditemukan.';
  end if;

  return v_entry;
end;
$$;


-- ============================================================
--  3. recall_entry — panggil ulang
-- ============================================================
--  Nomor kembali ke `waiting` dengan prioritas tertinggi supaya
--  muncul paling atas.
create or replace function public.recall_entry(p_id uuid)
returns public.queue_entries
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_entry public.queue_entries;
begin
  update public.queue_entries e
     set status      = 'waiting',
         priority    = 1,
         recalled_at = now(),
         updated_at  = now()
   where e.id = p_id
  returning * into v_entry;

  if not found then
    raise exception 'Nomor antrian tidak ditemukan.';
  end if;

  return v_entry;
end;
$$;


-- ============================================================
--  4. mark_printed — perbarui status cetak
-- ============================================================
create or replace function public.mark_printed(
  p_id       uuid,
  p_printed  boolean
)
returns public.queue_entries
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_entry public.queue_entries;
begin
  update public.queue_entries e
     set print_status = case when p_printed then 'printed' else 'failed' end,
         printed_at   = case when p_printed then now() else e.printed_at end,
         updated_at   = now()
   where e.id = p_id
  returning * into v_entry;

  if not found then
    raise exception 'Nomor antrian tidak ditemukan.';
  end if;

  return v_entry;
end;
$$;


-- ============================================================
--  5. queue_snapshot — daftar antrean + jumlah per status
-- ============================================================
--  Satu panggilan, bukan dua. Menghindari dua render bolak-balik
--  saat dashboard admin memuat.
create or replace function public.queue_snapshot(p_date date)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'date', p_date,
    'entries', coalesce((
      select jsonb_agg(to_jsonb(q) order by q.number)
      from public.queue_entries q
      where q.queue_date = p_date
    ), '[]'::jsonb),
    'counts', coalesce((
      select jsonb_object_agg(q.status::text, q.jumlah)
      from (
        select e.status, count(*) as jumlah
        from public.queue_entries e
        where e.queue_date = p_date
        group by e.status
      ) q
    ), '{}'::jsonb)
  )
$$;

comment on function public.queue_snapshot(date) is
  'Daftar antrean beserta jumlah per status untuk satu tanggal, dalam satu panggilan.';


-- ============================================================
--  6. create_category / set_setting — tulis lewat RPC
-- ============================================================
--  Dulu ditulis lewat Worker. Sekarang RLS yang menjaga: hanya
--  owner yang lolos policy `manage categories`.
create or replace function public.create_category(
  p_name   text,
  p_color  text,
  p_code   text default null
)
returns public.categories
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_cat public.categories;
begin
  insert into public.categories (name, color, code, sort_order)
  values (
    btrim(p_name),
    coalesce(nullif(p_color, ''), '#6366f1'),
    nullif(btrim(coalesce(p_code, '')), ''),
    coalesce((select max(sort_order) + 1 from public.categories), 0)
  )
  returning * into v_cat;

  return v_cat;
end;
$$;


create or replace function public.set_setting(p_key text, p_value jsonb)
returns public.settings
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.settings;
begin
  insert into public.settings (key, value, updated_at)
  values (p_key, p_value, now())
  on conflict (key) do update
    set value       = excluded.value,
        updated_at  = now(),
        updated_by  = auth.uid()
  returning * into v_row;

  return v_row;
end;
$$;


-- ============================================================
--  7. Grant ke authenticated, cabut dari anon
-- ============================================================
--  WAJIB: Postgres memberi EXECUTE ke PUBLIC untuk function baru.
--  Tanpa revoke eksplisit, anon bisa memanggil semuanya.
revoke execute on function public.next_serving(date)                   from public, anon;
revoke execute on function public.set_entry_status(uuid, queue_status) from public, anon;
revoke execute on function public.recall_entry(uuid)                    from public, anon;
revoke execute on function public.mark_printed(uuid, boolean)           from public, anon;
revoke execute on function public.queue_snapshot(date)                 from public, anon;
revoke execute on function public.create_category(text, text, text)     from public, anon;
revoke execute on function public.set_setting(text, jsonb)              from public, anon;

grant execute on function public.next_serving(date)                   to authenticated;
grant execute on function public.set_entry_status(uuid, queue_status) to authenticated;
grant execute on function public.recall_entry(uuid)                    to authenticated;
grant execute on function public.mark_printed(uuid, boolean)           to authenticated;
grant execute on function public.queue_snapshot(date)                 to authenticated;
grant execute on function public.create_category(text, text, text)     to authenticated;
grant execute on function public.set_setting(text, jsonb)              to authenticated;


-- ============================================================
--  8. Verifikasi
-- ============================================================
do $$
declare
  v_leak text;
begin
  select string_agg(p.proname, ', ')
    into v_leak
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    and p.proname in (
      'next_serving', 'set_entry_status', 'recall_entry',
      'mark_printed', 'queue_snapshot', 'create_category', 'set_setting'
    )
    and has_function_privilege('anon', p.oid, 'execute');

  if v_leak is not null then
    raise exception 'GAGAL — anon masih bisa memanggil: %', v_leak;
  end if;

  raise notice 'TAHAP 3 SQL BERHASIL — RPC antrean siap, anon tetap terkunci.';
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
    'next_serving', 'set_entry_status', 'recall_entry',
    'mark_printed', 'queue_snapshot', 'create_category', 'set_setting'
  )
order by p.proname;
