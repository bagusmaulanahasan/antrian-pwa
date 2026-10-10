#!/usr/bin/env node
// Validasi sintaks file SQL memakai parser PostgreSQL asli (libpg_query).
//
// Parser ini bittersweet dengan apa yang sebenarnya terjadi di
// Supabase: ia mem-parse statement SQL seperti yang dilakukan
// Postgres, termasuk balok `do $$ ... $$` dan definisi function.
//
// Yang TIDAK bisa divalidasi di sini: isi body plpgsql (hanya
// string bagi parser SQL), dan hasil eksekusi nyata. Untuk itu
// supabase/03_fix_privileges.sql sudah dirancang gagal sendiri
// bila masih ada kebocoran grant.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'libpg-query'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const FILES = [
  'schema.sql',
  'supabase/02_seed_and_fixes.sql',
  'supabase/03_fix_privileges.sql',
]

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

let failed = 0

for (const rel of FILES) {
  const sql = readFileSync(join(root, rel), 'utf8')

  try {
    const result = await pg.parse(sql)
    const count = result.stmts.length
    console.log(`${GREEN}PASS${RESET} ${rel} ${DIM}(${count} statement${count === 1 ? '' : 's'})${RESET}`)
  } catch (err) {
    failed++
    console.log(`${RED}FAIL${RESET} ${rel}`)
    console.log(`     ${err.message}`)
  }
}

console.log('')

if (failed > 0) {
  console.log(`${RED}${failed} file gagal diparse.${RESET}`)
  process.exit(1)
}

console.log(`${GREEN}Semua file SQL valid secara sintaks.${RESET}`)