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

/**
 * Invariant khusus migrasi ke Supabase Auth (04).
 *
 * Yang diuji di sini bukan sintaks, tapihtubuh keamanan: kalau salah
 * satu lolos, ini adalah privilege escalation yang tidak akan terlihat
 * dari sisi frontend.
 */
describe('Invariant migrasi Supabase Auth', () => {
  const MIGRATION = 'supabase/04_supabase_auth_migration.sql'
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
})