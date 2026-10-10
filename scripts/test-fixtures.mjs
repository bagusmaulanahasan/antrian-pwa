/**
 * Fixture bersama untuk test.
 *
 * Password & hash argon2id. Hash bersifat unik per salt, jadi fixture HARUS
 * benar-benar diverifikasi terhadap password-nya — kalau tidak, test login
 * gagal dengan pesan yang menyesatkan.
 *
 * Untuk membuat hash baru:
 *   node scripts/gen-fixture-hash.mjs "WorkerTest123!"
 * lalu salin output ke bawah (tanpa spasi/newline tambahan).
 *
 * Sanity check (harus "true"):
 *   node -e "import('./scripts/test-fixtures.mjs').then(async m=>console.log(await (await import('./worker/src/lib/password.ts')).verifyPassword(m.TEST_HASH,m.TEST_PASSWORD)))"
 */
export const TEST_PASSWORD = 'WorkerTest123!'

export const TEST_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$1K6aQhRq5f/jX2r/KxcZkA$HWElb61UL5TPnMzXvh0XPA1V5KZgusqaM7r3dyeLOYY'