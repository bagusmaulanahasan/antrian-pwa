/**
 * Unit test untuk worker/src/lib/password.ts
 *
 * Menjalankan testpassword hashing tanpa framework — cukup node:test.
 * Jalankan: node --experimental-strip-types --test worker/test/password.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ARGON2_DEFAULTS,
  hashPassword,
  isArgon2Hash,
  verifyPassword,
} from '../src/lib/password.ts'

describe('hashPassword', () => {
  it('menghasilkan hash argon2id berformat PHC', async () => {
    const h = await hashPassword('#Pass123')
    assert.match(h, /^\$argon2id\$/, 'harus diawali $argon2id$')
    assert.match(h, /v=\d+/, 'harus memuat versi')
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

  it('menolak input bukan string atau kosong', async () => {
    await assert.rejects(() => hashPassword(''), /non-kosong/)
    await assert.rejects(() => hashPassword(null), /non-kosong/)
    await assert.rejects(() => hashPassword(undefined), /non-kosong/)
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

  it('mengembalikan false tanpa melempar exception untuk input rusak', async () => {
    assert.equal(await verifyPassword('', 'apa-saja'), false)
    assert.equal(await verifyPassword('bukan-hash-argon2', 'apa-saja'), false)
    assert.equal(await verifyPassword('$argon2id$v=19$broken', 'apa-saja'), false)
    assert.equal(await verifyPassword(null, null), false)
  })

  it('menolak hash bcrypt (migrasi dari format lain)', async () => {
    const bcryptLike = '$2b$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ012345'
    assert.equal(await verifyPassword(bcryptLike, 'apa-saja'), false)
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