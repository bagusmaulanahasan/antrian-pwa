/**
 * Regression test untuk invariant keamanan SQL.
 *
 * Insiden: file 02 menulis `revoke execute ... from public`, padahal
 * Supabase memasang default privileges yang memberi EXECUTE LANGSUNG
 * ke peran anon. Akibatnya kelima function tetap bisa dipanggil tanpa
 * login, dan `store_refresh_token` membuka jalan pengambilalihan akun.
 *
 * Test ini sengaja TIDAK memakai parser PostgreSQL. Parser berbasis
 * WASM butuh alokasi memori besar dan membuat unit suite kehabisan
 * memori (gejala VirtualAlloc failed yang sama seperti runner suite
 * lain). Validasi tingkat parser ada di `npm run sql:check`, dijalankan
 * sebagai proses terpisah.
 *
 * Sebagai gantinya, teks SQL dibersihkan dari komentar dulu sehingga
 * dokumentasi yang membahas topik sama tidak memicu false positive.
 *
 * Batas lain: isi body plpgsql tidak diperiksa di sini. Parser SQL
 * hanya memperlakukan `$$ ... $$` sebagai string. Body plpgsql baru
 * terbukti benar ketika dieksekusi Postgres — untuk itu patch 03
 * dirancang gagal sendiri bila grant masih bocor.
 *
 * Jalankan: npm run test:unit
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const SQL_FILES = [
  'schema.sql',
  'supabase/02_seed_and_fixes.sql',
  'supabase/03_fix_privileges.sql',
]

/** Function yang hanya boleh dipanggil service_role. */
const PRIVATE_FUNCTIONS = [
  'next_queue_number',
  'create_queue_entry',
  'store_refresh_token',
  'revoke_refresh_token',
  'revoke_all_refresh_tokens',
]

/** Peran yang tidak boleh pernah memegang EXECUTE atas function tersebut. */
const UNTRUSTED_ROLES = ['anon', 'authenticated']

/** Pecah daftar peran pada klausa FROM/TO. */
function parseRoleList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

const CREATE_FN = /create\s+(?:or\s+replace\s+)?function\s+([a-z0-9_]+)\s*\(/gi
const REVOKE_EXEC =
  /revoke\s+execute\s+on\s+function\s+([a-z0-9_]+)\s*\([^)]*\)\s*from\s+([^;]+);/gi
const GRANT_EXEC =
  /grant\s+execute\s+on\s+function\s+([a-z0-9_]+)\s*\([^)]*\)\s*to\s+([^;]+);/gi

function collect(sql: string, re: RegExp): Array<[string, string]> {
  const out: Array<[string, string]> = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) {
    out.push([m[1].toLowerCase(), m[2]])
  }
  return out
}

/**
 * Buang komentar tanpa merusak literal `$$ ... $$`, karena body
 * function boleh memuat karakter yang menyerupai komentar.
 */
function stripComments(sql: string): string {
  const blocks: string[] = []
  const masked = sql.replace(/\$\$[\s\S]*?\$\$/g, (match) => {
    blocks.push(match)
    return `\u0000DQ${blocks.length - 1}\u0000`
  })

  const stripped = masked
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')

  return stripped.replace(/\u0000DQ(\d+)\u0000/g, (_, i: string) => blocks[Number(i)])
}

function loadSql(rel: string): string {
  return stripComments(readFileSync(join(ROOT, rel), 'utf8'))
}

describe('Invariant keamanan SQL', () => {
  for (const rel of SQL_FILES) {
    it(`${rel} tidak memakai SECURITY DEFINER`, () => {
      const offenders: string[] = []
      const sql = loadSql(rel)

      CREATE_FN.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = CREATE_FN.exec(sql)) !== null) {
        // Ambil blok statement fungsi ini, lalu cari "security definer".
        const tail = sql.slice(m.index, m.index + 4000)
        const bodyEnd = tail.search(/\$\$[\s\S]*?\$\$/)
        const header = bodyEnd === -1 ? tail : tail.slice(0, bodyEnd)
        if (/security\s+definer/i.test(header)) offenders.push(m[1])
      }

      assert.deepEqual(offenders, [], 'SECURITY DEFINER melewati RLS. Pakai INVOKER.')
    })
  }

  it('tidak ada GRANT EXECUTE untuk anon atau authenticated', () => {
    const offenders: string[] = []
    for (const rel of SQL_FILES) {
      for (const [name, rawRoles] of collect(loadSql(rel), GRANT_EXEC)) {
        if (!PRIVATE_FUNCTIONS.includes(name)) continue
        for (const role of parseRoleList(rawRoles)) {
          if (UNTRUSTED_ROLES.includes(role)) offenders.push(`${rel}: ${name} -> ${role}`)
        }
      }
    }
    assert.deepEqual(offenders, [], 'peran tak tepercaya memegang EXECUTE')
  })

  it('function privat yang didefinisikan dicabut dari anon DAN authenticated', () => {
    const problems: string[] = []

    for (const rel of SQL_FILES) {
      const sql = loadSql(rel)

      const defined = new Set(collect(sql, CREATE_FN).map(([name]) => name))

      const revoked = new Map<string, Set<string>>()
      for (const [name, rawRoles] of collect(sql, REVOKE_EXEC)) {
        if (!revoked.has(name)) revoked.set(name, new Set())
        for (const role of parseRoleList(rawRoles)) revoked.get(name)!.add(role)
      }

      for (const fn of PRIVATE_FUNCTIONS) {
        if (!defined.has(fn)) continue
        const roles = revoked.get(fn)
        if (!roles) {
          problems.push(`${rel}: ${fn} tidak pernah di-revoke`)
          continue
        }
        for (const role of UNTRUSTED_ROLES) {
          if (!roles.has(role)) problems.push(`${rel}: ${fn} belum di-revoke dari ${role}`)
        }
      }
    }

    assert.deepEqual(
      problems,
      [],
      'revoke harus mencakup anon dan authenticated, bukan hanya public',
    )
  })

  it('kelima function privat ada dan tertutup secara keseluruhan', () => {
    const defined = new Set<string>()
    const revoked = new Map<string, Set<string>>()

    for (const rel of SQL_FILES) {
      const sql = loadSql(rel)
      for (const [name] of collect(sql, CREATE_FN)) defined.add(name)
      for (const [name, rawRoles] of collect(sql, REVOKE_EXEC)) {
        if (!revoked.has(name)) revoked.set(name, new Set())
        for (const role of parseRoleList(rawRoles)) revoked.get(name)!.add(role)
      }
    }

    const problems: string[] = []
    for (const fn of PRIVATE_FUNCTIONS) {
      if (!defined.has(fn)) {
        problems.push(`${fn} tidak didefinisikan di file mana pun — cek nama fungsi`)
        continue
      }
      const roles = revoked.get(fn)
      for (const role of UNTRUSTED_ROLES) {
        if (!roles?.has(role)) problems.push(`${fn} belum di-revoke dari ${role}`)
      }
    }

    assert.deepEqual(problems, [], 'ada function privat yang masih terbuka')
  })

  it('default privileges dicabut di file fondasi', () => {
    for (const rel of ['schema.sql', 'supabase/02_seed_and_fixes.sql']) {
      const sql = loadSql(rel).toLowerCase()
      assert.match(
        sql,
        /alter default privileges in schema public\s+revoke execute on functions from[^;]*anon/,
        `${rel} harus mencabut default privileges dari anon`,
      )
    }
  })

  it('akun owner placeholder tidak ditanam di schema.sql', () => {
    const inserts = [...loadSql('schema.sql').matchAll(/insert\s+into\s+users\b[^;]*;/gi)]
    assert.deepEqual(
      inserts.map((m) => m[0]),
      [],
      'schema.sql tidak boleh melakukan insert akun owner dengan hash placeholder',
    )
  })

  it('patch 03 gagal sendiri bila grant aplikasi masih bocor', () => {
    const raw = readFileSync(join(ROOT, 'supabase/03_fix_privileges.sql'), 'utf8')
    assert.match(raw, /raise exception/i, 'patch harus memaksa gagal bila bocor')
    assert.match(
      raw,
      /has_function_privilege\(\s*'anon'/i,
      'verifikasi harus mengecek peran anon',
    )
  })

  /**
   * Regresi: verifikasi pernah memindai SELURUH function di schema
   * `public`, sehingga function extension (citext) ikut terhitung dan
   * patch selalu gagal. Postgres memang memberi EXECUTE ke PUBLIC
   * untuk semua function, jadi daftar itu memang tidak akan pernah
   * kosong. Test ini menjaga agar verifier tidak melebar lagi.
   */
  for (const rel of ['supabase/02_seed_and_fixes.sql', 'supabase/03_fix_privileges.sql']) {
    it(`${rel} memverifikasi hanya function milik aplikasi`, () => {
      const sql = loadSql(rel)

      for (const fn of PRIVATE_FUNCTIONS) {
        assert.ok(
          sql.includes(fn),
          `${rel}: daftar verifikasi harus menyebut ${fn}`,
        )
      }

      // Bagian yang wajib gagal (raise exception) harus difilter
      // dengan daftar nama, bukan sekadar "semua function di public".
      const wajibBlocks = sql
        .split(/raise\s+exception/i)
        .slice(0, -1)
        .join('raise exception')

      assert.match(
        wajibBlocks,
        /p\.proname\s*=\s*any\s*\(\s*v_app_functions\s*\)/i,
        `${rel}: cek wajib harus dibatasi ke daftar function aplikasi`,
      )

      // Function milik extension dipisahkan agar hanya jadi peringatan.
      assert.match(
        sql,
        /refclassid\s*=\s*'pg_extension'::regclass/i,
        `${rel}: function extension harus dikenali lewat pg_depend`,
      )
      assert.match(
        sql,
        /raise\s+warning/i,
        `${rel}: function di luar daftar harus jadi peringatan, bukan error`,
      )

      // Fungsi internal Supabase boleh tetap terbuka; kalau tidak,
      // patch akan terus memunculkan peringatan yang tidak berguna.
      assert.match(
        sql,
        /v_known_safe\s+text\[\]\s*:=\s*array\[([^\]]*)\]/i,
        `${rel}: harus ada allowlist fungsi internal Supabase`,
      )
      assert.match(
        sql,
        /p\.proname\s*<>\s*all\s*\(\s*v_known_safe\s*\)/i,
        `${rel}: allowlist harus dipakai saat memfilter peringatan`,
      )
    })
  }

  it('diagnostik 00 hanya menampilkan function milik aplikasi', () => {
    const sql = loadSql('supabase/00_check_grants.sql')
    for (const fn of PRIVATE_FUNCTIONS) {
      assert.ok(sql.includes(fn), `diagnostik harus menyebut ${fn}`)
    }
    assert.match(
      sql,
      /nspname\s*=\s*'public'[\s\S]*?p\.proname\s*=\s*any/i,
      'tabel utama harus dibatasi ke daftar function aplikasi',
    )
    assert.doesNotMatch(
      sql,
      /\b(insert|update|delete|drop|alter|create|revoke|grant|truncate)\b/i,
      'diagnostik harus read-only',
    )
  })
})

/** File SQL migrasi ke Supabase Auth. */
const MIGRATION = 'supabase/04_supabase_auth_migration.sql'
/** File SQL RPC yang dipanggil browser langsung. */
const DIRECT = 'supabase/05_direct_api_functions.sql'

/**
 * Invariant khusus migrasi ke Supabase Auth (04).
 *
 * Yang diuji di sini bukan sintaks, tapi bentuk keamanan: kalau salah
 * satu lolos, ini adalah privilege escalation yang tidak akan terlihat
 * dari sisi frontend.
 */
describe('Invariant migrasi Supabase Auth', () => {
  const sql = loadSql(MIGRATION)

  it('peran dibaca dari app_metadata, tidak pernah dari raw_user_meta_data', () => {
    assert.match(
      sql,
      /current_role\(\)[\s\S]*?auth\.jwt\(\)\s*->\s*'app_metadata'\s*->>\s*'role'/,
      'current_role() harus membaca app_metadata dari JWT',
    )
    assert.doesNotMatch(
      sql,
      /raw_user_meta_data\s*->>\s*'role'/,
      'raw_user_meta_data bisa diubah sendiri oleh pengguna — tidak boleh jadi sumber peran',
    )
  })

  it('trigger pendaftaran tidak memuat peran dari metadata pengguna', () => {
    const trigger = sql.slice(
      sql.indexOf('handle_new_user'),
      sql.indexOf('handle_new_user') + 900,
    )
    assert.ok(trigger.length > 100, 'blok trigger tidak ditemukan')
    assert.doesNotMatch(
      trigger,
      /raw_user_meta_data\s*->>\s*'role'/,
      'trigger tidak boleh memberi peran dari metadata pendaftaran',
    )
    assert.match(
      trigger,
      /'\{role\}'\s*,\s*'"admin"'/,
      'peran default harus admin, bukan owner',
    )
  })

  it('fungsi SECURITY DEFINER memverifikasi peran pemanggil', () => {
    const blocks = sql.split(/create or replace function/i).slice(1)
    const unguarded: string[] = []

    for (const block of blocks) {
      const name = block.match(/function\s+(?:public\.)?([a-z0-9_]+)/i)?.[1] ?? '?'
      // Pengecualian, dengan alasan yang jelas:
      //   handle_new_user, touch_updated_at — trigger internal, dipanggil
      //     database, bukan pemanggil dari jaringan.
      //   bootstrap_owner — memang tidak bisa memakai current_role(), karena
      //     belum ada owner saat pertama kali dipanggil. Penggantinya adalah
      //     pemeriksaan "owner sudah ada" yang diuji terpisah di bawah.
      if (['handle_new_user', 'touch_updated_at', 'bootstrap_owner'].includes(name)) continue
      if (!/security definer/i.test(block)) continue
      if (!/current_role\(\)/.test(block)) unguarded.push(name)
    }

    assert.deepEqual(
      unguarded,
      [],
      'setiap SECURITY DEFINER yang bisa dipanggil klien wajib cek current_role()',
    )
  })

  it('grant hanya ke authenticated, tidak pernah ke anon', () => {
    assert.doesNotMatch(
      sql,
      /grant\s+[^;]*\bto\s+anon\b/i,
      'fungsi migrasi tidak boleh memberi akses apa pun ke anon',
    )
  })

  /**
   * Regresi yang sama seperti insiden b5521c5, terulang di file 04:
   * PostgreSQL memberi EXECUTE ke PUBLIC untuk SETIAP function baru.
   * Test sebelumnya hanya memeriksa tidak ada `grant ... to anon` —
   * itu tidak cukup, karena grant default itu datang dari dalam
   * database, bukan dari teks SQL.
   *
   * Setiap function yang didefinisikan di file migrasi WAJIB punya
   * revoke eksplisit terhadap anon, kecuali ada alasan recorded.
   */
  it('setiap function baru dicabut dari PUBLIC/anon', () => {
    const defined = [...sql.matchAll(/create or replace function\s+(?:public\.)?([a-z_]+)/gi)]
      .map((m) => m[1].toLowerCase())
    assert.ok(defined.length >= 9, `hanya menemukan ${defined.length} function`)

    // Cocokkan baris SQL yang benar-benar ada, bukan teks komentar:
    // loadSql() menghapus komentar, jadi pencarian berbasis kalimat
    // di dalam komentar akan selalu gagal diam-diam.
    const revoked = new Set<string>()
    for (const line of sql.split('\n')) {
      const m = line.match(/^\s*revoke\s+execute\s+on\s+function\s+(?:public\.)?([a-z_]+)/i)
      if (m) revoked.add(m[1].toLowerCase())
    }

    // Function antrean dibuat di file lain; penataannya oleh file 03.
    const notRevoked = defined.filter(
      (fn) => !['next_queue_number', 'create_queue_entry'].includes(fn) && !revoked.has(fn),
    )

    assert.deepEqual(
      notRevoked,
      [],
      'function berikut tidak dicabut dari anon; Postgres memberi EXECUTE ke PUBLIC secara default',
    )
  })

  it('bootstrap_owner tertutup untuk semua peran non-postgres', () => {
    const line = sql
      .split('\n')
      .find((l) =>
        /^\s*revoke\s+execute\s+on\s+function\s+public\.bootstrap_owner\(uuid\)/i.test(l),
      )
    assert.ok(line, 'tidak ada revoke untuk bootstrap_owner')
    assert.match(
      line,
      /from\s+public,\s*anon,\s*authenticated/i,
      'bootstrap_owner harus ditutup untuk public, anon, dan authenticated',
    )
  })

  it('fungsi antrean tetap tertutup untuk anon', () => {
    for (const fn of ['next_queue_number', 'create_queue_entry']) {
      assert.match(
        sql,
        new RegExp(`grant\\s+execute\\s+on\\s+function\\s+${fn}\\b[^;]*to\\s+authenticated`, 'i'),
        `${fn} harus di-grant ke authenticated`,
      )
    }
  })

  it('bootstrap_owner menolak jalan kalau owner sudah ada', () => {
    const block = sql.slice(
      sql.indexOf('bootstrap_owner'),
      sql.indexOf('bootstrap_owner') + 1200,
    )
    assert.match(
      block,
      /if\s+v_existing\s*>\s*0\s+then[\s\S]*?raise exception/i,
      'bootstrap_owner harus menolak kalau owner sudah ada',
    )
  })

  it('owner terakhir tidak bisa kehilangan peran', () => {
    const block = sql.slice(sql.indexOf('set_user_role'), sql.indexOf('set_user_role') + 1400)
    assert.match(
      block,
      /owner terakhir/i,
      'set_user_role harus melindungi owner terakhir',
    )
  })

  /**
   * Regresi: is_active_user() sempat dibuat SEBELUM tabel profiles.
   * PostgreSQL memvalidasi body function `language sql` saat CREATE,
   * jadi hasilnya "relation public.profiles does not exist".
   *
   * Test ini mengunci urutan yang benar untuk semua file SQL.
   */
  it('function `language sql` tidak membaca tabel sebelum tabel dibuat', () => {
    const files = [
      'supabase/02_seed_and_fixes.sql',
      'supabase/03_fix_privileges.sql',
      MIGRATION,
      DIRECT,
    ]

    for (const rel of files) {
      const text = loadSql(rel)

      // Posisi setiap CREATE TABLE.
      const tablePos = new Map<string, number>()
      for (const m of text.matchAll(/create\s+table(?:\s+if\s+not\s+exists)?\s+([a-z_.]+)/gi)) {
        const name = m[1].toLowerCase()
        tablePos.set(name, Math.max(tablePos.get(name) ?? 0, m.index ?? 0))
      }

      // Tiap function `language sql`, beserta isi body-nya.
      const fnRe =
        /create\s+or\s+replace\s+function\s+([a-z_.]+)\s*\([^)]*\)[^$]*\$\$([\s\S]*?)\$\$/gi
      for (const m of text.matchAll(fnRe)) {
        const [, name, body] = m
        const fnStart = m.index ?? 0

        if (!/language\s+sql/i.test(text.slice(fnStart, fnStart + 400))) continue

        for (const ref of body.matchAll(/\b(public\.[a-z_]+)/gi)) {
          const table = ref[1].toLowerCase()
          const created = tablePos.get(table)
          if (created === undefined) continue
          assert.ok(
            fnStart > created,
            `${rel}: ${name} membaca ${table} (dibuat di posisi ${created}) ` +
              `tapi function dibuat lebih dulu di posisi ${fnStart}`,
          )
        }
      }
    }
  })
})
/**
 * Invariant RPC yang dipanggil browser langsung (05).
 *
 * File ini menggantikan Worker untuk operasi antrean. Kalau ada
 * SECURITY DEFINER di sini, RLS akan dilewati dan seluruh proteksi
 * yang dibangun di file 04 jadi tidak berarti.
 */
describe('Invariant RPC akses langsung', () => {
  const sql = loadSql(DIRECT)

  const DIRECT_FUNCTIONS = [
    'next_serving',
    'set_entry_status',
    'recall_entry',
    'mark_printed',
    'queue_snapshot',
    'create_category',
    'set_setting',
  ]

  it('tidak ada SECURITY DEFINER — RLS harus tetap berlaku', () => {
    assert.doesNotMatch(
      sql,
      /security\s+definer/i,
      'SECURITY DEFINER akan melewati RLS untuk pemanggil apa pun',
    )
    assert.ok(
      /security\s+invoker/i.test(sql),
      'fungsi harus secara eksplisit memakai security invoker',
    )
  })

  it('setiap function dicabut dari PUBLIC/anon', () => {
    const revoked = new Set<string>()
    for (const line of sql.split('\n')) {
      const m = line.match(/^\s*revoke\s+execute\s+on\s+function\s+(?:public\.)?([a-z_]+)/i)
      if (m) revoked.add(m[1].toLowerCase())
    }

    const missing = DIRECT_FUNCTIONS.filter((fn) => !revoked.has(fn))
    assert.deepEqual(
      missing,
      [],
      'Postgres memberi EXECUTE ke PUBLIC secara default; revoke wajib eksplisit',
    )
  })

  it('setiap function diberikan ke authenticated', () => {
    for (const fn of DIRECT_FUNCTIONS) {
      assert.match(
        sql,
        new RegExp(
          `grant\\s+execute\\s+on\\s+function\\s+(?:public\\.)?${fn}\\b[^;]*to\\s+authenticated`,
          'i',
        ),
        `${fn} harus bisa dipanggil oleh pengguna yang sudah login`,
      )
    }
  })

  it('next_serving memakai row locking supaya dua admin tidak bentrok', () => {
    const at = sql.indexOf('next_serving')
    const block = sql.slice(at, at + 1800)
    assert.match(
      block,
      /for\s+update\s+skip\s+locked/i,
      'tanpa FOR UPDATE SKIP LOCKED, dua admin yang menekan bersamaan bisa bentrok',
    )
  })

  it('next_serving menyelesaikan nomor serving sebelum menaikkan yang baru', () => {
    const at = sql.indexOf('next_serving')
    const block = sql.slice(at, at + 1800)
    const completeAt = block.indexOf("= 'done'")
    const promoteAt = block.indexOf("= 'serving'")
    assert.ok(completeAt > -1 && promoteAt > -1, 'kedua langkah harus ada')
    assert.ok(
      completeAt < promoteAt,
      'harus menyelesaikan dulu baru menaikkan; kalau dibalik bisa lewat satu nomor',
    )
  })
})