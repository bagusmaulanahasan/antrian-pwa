-- ============================================================
--  00 — DIAGNOSTIK GRANT (READ-ONLY, tidak mengubah apa pun)
--  Sistem Antrian PWA
--
--  ------------------------------------------------------------
--  JALANKAN FILE INI DULUAN, SEBELUM 03_fix_privileges.sql
--  ------------------------------------------------------------
--  File ini hanya membaca. Tidak menambah, mengubah, atau menghapus
--  apa pun. Aman dijalankan kapan saja, termasuk setelah patch.
--
--  Supabase Dashboard -> SQL Editor -> New query ->
--  tempel SELURUH isi file ini -> Run.
--
--  ------------------------------------------------------------
--  TIGA TABEL, SUDAH DIURUTKAN DARI YANG PALING PENTING
--  ------------------------------------------------------------
--
--  TABEL 1 — INI YANG HARUS ANDA BACA.
--    Lima function milik aplikasi. WAJIB dicek.
--
--    Seharusnya TEPAT 5 BARIS, dan idealnya begini:
--
--      function                  | anon | authenticated | service_role | mode
--      --------------------------+------+---------------+--------------+---------
--      create_queue_entry        | false| false         | true         | invoker
--      next_queue_number         | false| false         | true         | invoker
--      revoke_all_refresh_tokens | false| false         | true         | invoker
--      revoke_refresh_token      | false| false         | true         | invoker
--      store_refresh_token       | false| false         | true         | invoker
--
--    - anon atau authenticated = TRUE  -> masih bocor, jalankan 03
--    - mode = definer                  -> lapisan kedua belum aktif
--    - baris kurang dari 5              -> function tidak ada, laporkan
--
--  TABEL 2 — function milik sendiri DI LUAR daftar aplikasi yang
--    masih terbuka oleh anon. Inilah tabel yang memperlihatkan
--    kebocoran sekaligus function internal Supabase seperti
--    rls_auto_enable (aman, tugasnya hanya menyalakan RLS).
--
--    Setelah 03 berhasil, tabel ini SEHARUSNYA hanya berisi
--    rls_auto_enable — 5 function aplikasi harus hilang.
--
--  TABEL 3 — jumlah function extension yang juga bisa dipanggil anon.
--    Abaikan. Angkanya pasti bukan nol dan itu normal: Postgres
--    memberi EXECUTE ke PUBLIC untuk semua function, dan function
--    extension (citext dll.) hanya pembanding string.
--
--  ------------------------------------------------------------
--  RINGKASAN TINDAKAN
--  ------------------------------------------------------------
--    Tabel 1 bersih           -> tidak perlu jalankan 03
--    Tabel 1 ada TRUE         -> jalankan 03_fix_privileges.sql
--    Tabel 1 bukan 5 baris    -> BERHENTI, laporkan hasilnya
-- ============================================================


-- ------------------------------------------------------------
--  TABEL 1 — LIMA FUNCTION MILIK APLIKASI  (BACA INI DULUAN)
-- ------------------------------------------------------------
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


-- ------------------------------------------------------------
--  TABEL 2 — FUNCTION MILIK SENDIRI DI LUAR DAFTAR YANG TERBUKA
--
--  Sebelum patch: berisi 5 function aplikasi + rls_auto_enable.
--  Setelah patch : hanya rls_auto_enable. Itu yang diharapkan.
--
--  Fungsi internal Supabase seperti rls_auto_enable sengaja TIDAK
--  dicabut — tugasnya hanya menyalakan RLS, dan mencabutnya bisa
--  mengganggu Supabase Dashboard.
-- ------------------------------------------------------------
select
  p.proname                                                  as function,
  has_function_privilege('anon',          p.oid, 'execute') as anon,
  has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
  case when p.proname = 'rls_auto_enable'
       then 'internal Supabase (aman)'
       else 'periksa' end                                   as catatan
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
    or has_function_privilege('authenticated', p.oid, 'execute'))
order by p.proname;


-- ------------------------------------------------------------
--  TABEL 3 — JUMLAH FUNCTION EXTENSION YANG TERBUKA  (abaikan)
-- ------------------------------------------------------------
select count(*) as "jumlah function extension (aman, abaikan)"
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f'
  and exists (
    select 1
    from pg_depend d
    where d.classid    = 'pg_proc'::regclass
      and d.objid      = p.oid
      and d.refclassid = 'pg_extension'::regclass
  )
  and has_function_privilege('anon', p.oid, 'execute');