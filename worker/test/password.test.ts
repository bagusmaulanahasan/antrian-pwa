/**
 * Unit test untuk worker/src/lib/password.ts
 *
 * Menjalankan test hashing tanpa framework — cukup node:test.
 * Jalankan: npm run test:unit
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ARGON2_DEFAULTS,
  hashPassword,
  isArgon2Hash,
  verifyPassword,
} from '../src/lib/password.ts'
import { TEST_HASH, TEST_PASSWORD } from '../src/test-fixtures.ts'

describe('hashPassword', () => {
  it('menghasilkan hash argon2id berformat PHC', async () => {
    const h = await hashPassword('#Pass123')
    assert.match(h, /^\$argon2id\$/, 'harus diawali $argon2id$')
    assert.match(h, /v=19/, 'harus memuat versi')
    assert.ok(isArgon2Hash(h), 'harus dikenali sebagai argon2 hash')
  })

  it('menggunakan parameter default yang cocok dengan schema.sql', async () => {
    const h = await hashPassword('apa-saja')
    assert.ok(
      h.includes(`m=${ARGON2_DEFAULTS.memoryCost}`),
      `memoryCost harus ${ARGON2_DEFAULTS.memoryCost}`,
    )
    assert.ok(h.includes(`t=${ARGON2_DEFAULTS.timeCost}`), `timeCost harus ${ARGON2_DEFAULTS.timeCost}`)
    assert.ok(
      h.includes(`p=${ARGON2_DEFAULTS.parallelism}`),
      `parallelism harus ${ARGON2_DEFAULTS.parallelism}`,
    )
  })

  it('membangkitkan salt berbeda setiap kali (hash tidak deterministik)', async () => {
    const a = await hashPassword('sama-sama')
    const b = await hashPassword('sama-sama')
    assert.notEqual(a, b, 'dua hash dari password sama harus berbeda')
  })

  it('mengg round-trip: hash → verify benar', async () => {
    const h = await hashPassword('#Pass123')
    assert.equal(await verifyPassword(h, '#Pass123'), true)
    assert.equal(await verifyPassword(h, '#Pass124'), false)
  })

  it('menolak input bukan string atau kosong', async () => {
    await assert.rejects(() => hashPassword(''), /non-kosong/)
    await assert.rejects(() => hashPassword(null as unknown as string), /non-kosong/)
    await assert.rejects(() => hashPassword(undefined as unknown as string), /non-kosong/)
  })
})

describe('verifyPassword', () => {
  it('menerima password yang benar', async () => {
    const h = await hashPassword('#Pass123')
    assert.equal(await verifyPassword(h, '#Pass123'), true)
  })

  it('menolak password yang salah', async () => {
    const h = await hashPassword('#Pass123')
    assert.equal(await verifyPassword(h, '#Pass124'), false)
    assert.equal(await verifyPassword(h, ''), false)
    assert.equal(await verifyPassword(h, '#pass123'), false, 'harus case-sensitive')
  })

  it('kompatibel dengan hash argon2id standar (fixture lintas implementasi)', async () => {
    // Fixture ini dibuat oleh @node-rs/argon2 (addon native). Hash dari
    // implementasi berbeda harus tetap bisa diverifikasi — inilah yang
    // membuat skema::schema.sql portabel antar runtime.
    assert.equal(await verifyPassword(TEST_HASH, TEST_PASSWORD), true, 'fixture harus terverifikasi')
    assert.equal(await verifyPassword(TEST_HASH, 'password-yang-salah'), false)
  })

  it('mengembalikan false tanpa melempar exception untuk input rusak', async () => {
    assert.equal(await verifyPassword('', 'apa-saja'), false)
    assert.equal(await verifyPassword('bukan-hash-argon2', 'apa-saja'), false)
    assert.equal(await verifyPassword('$argon2id$v=19$broken', 'apa-saja'), false)
    assert.equal(await verifyPassword(null as unknown as string, null as unknown as string), false)
  })

  it('menolak hash bcrypt (migrasi dari format lain)', async () => {
    const bcryptLike = '$2b$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ012345'
    assert.equal(await verifyPassword(bcryptLike, 'apa-saja'), false)
  })

  it('menolak argon2i dan argon2d (hanya argon2id yang didukung)', async () => {
    const i = TEST_HASH.replace('argon2id', 'argon2i')
    const d = TEST_HASH.replace('argon2id', 'argon2d')
    assert.equal(await verifyPassword(i, TEST_PASSWORD), false)
    assert.equal(await verifyPassword(d, TEST_PASSWORD), false)
  })
})

describe('isArgon2Hash', () => {
  it('mengenali format argon2id', () => {
    assert.equal(
      isArgon2Hash('$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaGhhc2hoYXNoaGFzaA'),
      true,
    )
  })

  it('menolak format yang salah', () => {
    assert.equal(isArgon2Hash('password123'), false)
    assert.equal(isArgon2Hash(''), false)
    assert.equal(isArgon2Hash(null), false)
    assert.equal(isArgon2Hash('$argon2id$tanpa-parameter'), false)
  })
})