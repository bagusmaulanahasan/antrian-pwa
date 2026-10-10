-- ============================================================
--  00 — DIAGNOSTIK GRANT (READ-ONLY, tidak mengubah apa pun)
--  Sistem Antrian PWA
--
--  ------------------------------------------------------------
--  JALANKAN FILE INI DULUAN, SEBELUM 03_fix_privileges.sql
--  ------------------------------------------------------------
--  File ini hanya membaca. Tidak menambah, mengubah, atau menghapus
--  apa pun. Aman dijalankan kapan saja.
--
--  Gunanya: Anda bisa melihat kondisi grant SEBELUM patch dijalankan,
--  sehingga kalau nanti ada masalah, kita tahu penyebabnya tanpa
--  menebak.
--
--  Cara menjalankan:
--  Supabase Dashboard -> SQL Editor -> New query ->
--  tempel SELURUH isi file ini -> Run.
--
--  ------------------------------------------------------------
--  CARA MEMBACA HASIL
--  ------------------------------------------------------------
--  Tabel pertama harus mengembalikan TEPAT 5 BARIS:
--
--    function                | anon | authenticated | service_role | mode
--    ------------------------+------+---------------+--------------+--------
--    create_queue_entry      | false| false         | true         | invoker
--    next_queue_number       | false| false         | true         | invoker
--    revoke_all_refresh_tokens | false| false        | true         | invoker
--    revoke_refresh_token    | false| false         | true         | invoker
--    store_refresh_token     | false| false         | true         | invoker
--
--  Kalau kolom anon atau authenticated bernilai TRUE, memang ada
--  kebocoran — itu yang akan diperbaiki 03_fix_privileges.sql.
--
--  Tabel kedua bisa diabaikan. Itu hanya memberi tahu berapa banyak
--  function extension (seperti citext) yang juga bisa dipanggil anon.
--  Itu NORMAL dan AMAN: Postgres memberi EXECUTE ke PUBLIC untuk
--  semua function secara default, dan function extension hanya
--  pembanding string yang tidak menyentuh data aplikasi.
--
--  ------------------------------------------------------------
--  JANGAN JALANKAN 03_fix_privileges.sql JIKA TABEL PERTAMA
--  MENGEMBALIKAN LEBIH DARI 5 BARIS ATAU LEBIH SEDIKIT.
--  Berarti ada function aplikasi yang belum terdaftar di daftar ini.
--  Salin hasilnya dan laporkan sebelum melanjutkan.
-- ============================================================


-- ------------------------------------------------------------
--  TABEL 1 — lima function milik aplikasi
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
--  TABEL 2 — function extension yang juga bisa dipanggil anon
--  Informasi saja. Wajar kalau angkanya bukan nol.
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


-- ------------------------------------------------------------
--  TABEL 3 — function milik sendiri (bukan extension) yang terbuka
--
--  Seharusnya kosong. Kalau berisi nama yang bukan Anda kenal,
--  salin dan laporkan sebelum menjalankan patch.
-- ------------------------------------------------------------
select
  p.proname                                                  as function,
  has_function_privilege('anon',          p.oid, 'execute') as anon,
  has_function_privilege('authenticated', p.oid, 'execute') as authenticated
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