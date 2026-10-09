/**
 * Utilitas hashing password argon2id.
 *
 * Modul ini dipakai oleh BOTH sisi:
 *  - Cloudflare Worker (server) untuk memverifikasi login
 *  - Script CLI (`scripts/hash-password.mjs`) untuk membuat akun owner/admin
 *
 * Format hash mengikuti PHC standard:
 *   $argon2id$v=19$m=19456,t=2,p=1$<salt base64>$<hash base64>
 * yang persis cocok dengan placeholder di schema.sql.
 *
 * Catatan: @node-rs/argon2 memakai prebuilt WASM/native sehingga aman
 * dipakai di runtime Cloudflare Workers.
 */

/** Parameter default — sama dengan nilai di schema.sql. */
export const ARGON2_DEFAULTS = {
  algorithm: 2, // Argon2id
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const

/**
 * Hash password dengan argon2id.
 * @param {string} password
 * @param {Partial<typeof ARGON2_DEFAULTS>} [options]
 * @returns {Promise<string>} hash berformat PHC
 */
export async function hashPassword(password, options = {}) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('password wajib berupa string non-kosong')
  }
  const { hash } = await import('@node-rs/argon2')
  // @node-rs/argon2 memakai nama opsiVersus (bukan algorithm/memoryCost).
  return hash(password, {
    algorithm: options.algorithm ?? ARGON2_DEFAULTS.algorithm,
    memoryCost: options.memoryCost ?? ARGON2_DEFAULTS.memoryCost,
    timeCost: options.timeCost ?? ARGON2_DEFAULTS.timeCost,
    parallelism: options.parallelism ?? ARGON2_DEFAULTS.parallelism,
    outputLen: options.outputLen ?? ARGON2_DEFAULTS.outputLen,
  })
}

/**
 * Verifikasi password terhadap hash.
 * Selalu mengembalikan boolean — tidak pernah melempar exception, supaya
 * pemanggil tidak perlu membedakan "salah password" dari "hash rusak"
 * (keduanya harus memberi respons identik agar tidak membocorkan informasi).
 *
 * @param {string} hashed
 * @param {string} password
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(hashed, password) {
  if (typeof hashed !== 'string' || typeof password !== 'string') return false
  try {
    const { verify } = await import('@node-rs/argon2')
    return await verify(hashed, password)
  } catch {
    return false
  }
}

/**
 * True bila string terlihat seperti hash argon2 yang valid.
 * Dipakai untuk menolak input berbahaya sebelum diteruskan ke pustaka.
 * @param {string} value
 */
export function isArgon2Hash(value) {
  return typeof value === 'string' && /^\$argon2(id|i|d)\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/.test(value)
}