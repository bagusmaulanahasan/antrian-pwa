/**
 * CLI untuk membangkitkan hash argon2id dan statement SQL pembuatan akun.
 *
 * Dipakai owner/admin untuk membuat akun tanpa Login Dashboard Supabase.
 *
 * Contoh:
 *   node scripts/hash-password.mjs "#Pass123" owner@contoh.com owner
 *   node scripts/hash-password.mjs "#Pass123" admin@contoh.com admin temp
 *
 * Flag `temp` boleh ditulis sebagai argumen POSITIONAL (tanpa tanda --),
 * bukan hanya sebagai `--temp`. Alasannya npm memakan flag berawalan
 * `-` pada `npm run <script> --temp`, sehingga `--temp` diam-diam hilang
 * dan akun terbentuk dengan password permanen tanpa peringatan.
 * Argumen posisional tidak dimakan npm, jadi bentuk ini selalu aman:
 *
 *   npm run hash-password "pass" owner@contoh.com owner temp     <- aman
 *   npm run hash-password -- "pass" owner@contoh.com owner --temp  <- perlu --
 *
 * Output:
 *   - hash PHC siap tempel ke kolom users.password_hash
 *   - statement INSERT/UPDATE siap jalankan di SQL Editor
 */
import { hashPassword, isArgon2Hash } from '../worker/src/lib/password.ts'

const [password, email, role = 'admin', ...rest] = process.argv.slice(2)

function fail(message, code = 1) {
  console.error(`\nERROR: ${message}\n`)
  console.error('Penggunaan:')
  console.error('  node scripts/hash-password.mjs <password> <email> [owner|admin] [--temp]')
  console.error('')
  process.exit(code)
}

if (!password) fail('Password wajib diberikan.')
if (!email) fail('Email wajib diberikan.')

const normalizedRole = role.toLowerCase()
if (!['owner', 'admin'].includes(normalizedRole)) {
  fail(`Role tidak dikenal: "${role}". Gunakan owner atau admin.`)
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  fail(`Format email tidak valid: "${email}"`)
}
if (password.length < 8) fail('Password minimal 8 karakter.')

/**
 * `temp` dikenali baik sebagai argumen posisional maupun sebagai
 * `--temp`. Positional adalah bentuk yang disarankan karena tidak
 * bisa dimakan npm.
 */
const isTemporary =
  rest.includes('temp') || rest.includes('temporary') || rest.includes('--temp')
const displayName = rest.find((f) => f.startsWith('--name='))?.slice(7)

if (normalizedRole === 'owner' && !isTemporary) {
  console.warn('\n' + '='.repeat(60))
  console.warn('PERINGATAN: akun owner dibuat TANPA flag temp.')
  console.warn('')
  console.warn('Password ini akan menjadi password PERMANEN. Ia tidak akan')
  console.warn('pernah dipaksa diganti saat login.')
  console.warn('')
  console.warn('Untuk akun bootstrap, biasanya Anda ingin password sementara:')
  console.warn('')
  console.warn('  npm run hash-password "' + password + '" ' + email.toLowerCase() + ' owner temp')
  console.warn('')
  console.warn('(perhatikan argumen "temp" di akhir — bukan "--temp", yang')
  console.warn('dimakan npm bila tanpa tanda "--" sebelumnya)')
  console.warn('='.repeat(60) + '\n')
}

const hashed = await hashPassword(password)

console.log('\n=== Hash argon2id ===')
console.log(hashed)

console.log('\n=== Verifikasi ===')
const { verifyPassword } = await import('../worker/src/lib/password.ts')
const ok = await verifyPassword(hashed, password)
const bad = await verifyPassword(hashed, 'password-yang-salah')
console.log(`  password benar      → ${ok ? 'LOLOS' : 'GAGAL'}`)
console.log(`  password salah      → ${bad ? 'LOLOS (BAHAYA!)' : 'ditolak (benar)'}`)

if (!ok) {
  console.error('\nVerifikasi gagal — jangan gunakan hash ini.')
  process.exit(1)
}
if (!isArgon2Hash(hashed)) {
  console.error('\nFormat hash tidak dikenali sebagai argon2 PHC.')
  process.exit(1)
}

const safeEmail = email.toLowerCase()
const safeName = displayName ? `, '${displayName.replace(/'/g, "''")}'` : ''

console.log('\n=== SQL untuk Supabase SQL Editor ===')
console.log(`
-- Buat akun baru
insert into users (email, password_hash, role, is_password_temporary, display_name)
values (
  '${safeEmail}',
  '${hashed}',
  '${normalizedRole}',
  ${isTemporary},
  ${displayName ? `'${displayName.replace(/'/g, "''")}'` : 'null'}
)
on conflict (email) do update
  set password_hash        = excluded.password_hash,
      role                 = excluded.role,
      is_password_temporary= excluded.is_password_temporary,
      display_name         = excluded.display_name,
      is_active            = true,
      updated_at           = now();

-- Verifikasi setelah insert
select email, role, is_password_temporary, is_active
from users where email = '${safeEmail}';
`)

console.log('='.repeat(60))
console.log('Hapus riwayat shell setelah ini agar password tidak tersimpan.')
console.log('='.repeat(60), '\n')