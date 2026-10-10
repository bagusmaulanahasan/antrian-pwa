/**
 * Hashing password argon2id — implementasi murni JS (portable).
 *
 * Kenapa bukan @node-rs/argon2:
 *   Workers tidak bisa memuat addon native (.node), dan build WASM-nya gagal
 *   di runtime Workers dengan error:
 *     "[unenv] wasi.WASI is not implemented yet!"
 *   `@noble/hashes` adalah JS murni, memakai WebCrypto yang tersedia di
 *   Workers maupun browser, dan menghasilkan hash yang identik dengan
 *   argon2id standar (terverifikasi terhadap fixture).
 *
 * Format PHC yang didukung (sama dengan yang dipakai schema.sql):
 *   $argon2id$v=19$m=<mem>,t=<iter>,p=<par>$<salt-b64>$<hash-b64>
 *
 * Password di-hash sebagai UTF-8 bytes.
 */
// Subpath export @noble/hashes hanya mendefinisikan "./argon2.js"/"./utils.js",
// jadi ekstensi .js wajib ditulis (tanpa itu Node ERR_PACKAGE_PATH_NOT_EXPORTED).
import { argon2id as nobleArgon2id } from '@noble/hashes/argon2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'

/** Parameter default — sama dengan nilai yang diasumsikan schema.sql. */
export const ARGON2_DEFAULTS = {
  algorithm: 'argon2id',
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const

export interface Argon2Options {
  memoryCost?: number
  timeCost?: number
  parallelism?: number
  outputLen?: number
}

/**
 * PHC string. Base64 di sini menerima varian standar maupun base64url
 * (seperti yang dihasilkan @node-rs/argon2), supaya hash dari implementasi
 * berbeda tetap bisa diverifikasi.
 */
const PHC_PATTERN =
  /^\$(argon2id|argon2i|argon2d)\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/_-]+={0,2})\$([A-Za-z0-9+/_-]+={0,2})$/

/** Base64 (standar maupun base64url) → Uint8Array. */
function fromBase64(value: string): Uint8Array {
  // Normalisasi base64url → base64 standar.
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * Uint8Array → base64 standar tanpa padding (kelakuan PHC).
 * PHC memakai base64 biasa (bukan base64url) dan mengizinkan karakter
 * `-`/`_` dari implementasi lain, jadi `fromBase64` harus keduanya menerima.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/=+$/, '')
}

/**
 * Hash password dengan argon2id.
 * @throws bila password bukan string non-kosong.
 */
export async function hashPassword(
  password: string,
  options: Argon2Options = {},
): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('password wajib berupa string non-kosong')
  }

  const memoryCost = options.memoryCost ?? ARGON2_DEFAULTS.memoryCost
  const timeCost = options.timeCost ?? ARGON2_DEFAULTS.timeCost
  const parallelism = options.parallelism ?? ARGON2_DEFAULTS.parallelism
  const outputLen = options.outputLen ?? ARGON2_DEFAULTS.outputLen

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = nobleArgon2id(utf8ToBytes(password), salt, {
    m: memoryCost,
    t: timeCost,
    p: parallelism,
    dkLen: outputLen,
  })

  return [
    '$argon2id',
    'v=19',
    `m=${memoryCost},t=${timeCost},p=${parallelism}`,
    toBase64(salt),
    toBase64(hash),
  ].join('$')
}

/**
 * Verifikasi password terhadap hash argon2.
 *
 * Selalu mengembalikan boolean — tidak pernah melempar exception, supaya
 * pemanggil tidak perlu membedakan "salah password" dari "hash rusak"
 * (keduanya harus memberi respons identik agar tidak membocorkan informasi).
 *
 * Perbandingan dilakukan constant-time untuk mengurangi risiko timing attack.
 */
export async function verifyPassword(hashed: string, password: string): Promise<boolean> {
  if (typeof hashed !== 'string' || typeof password !== 'string') return false

  const match = PHC_PATTERN.exec(hashed.trim())
  if (!match) return false

  const [, algorithm, version, m, t, p, saltB64, hashB64] = match
  if (algorithm !== 'argon2id') return false
  if (version !== '19') return false

  try {
    const salt = fromBase64(saltB64)
    const expected = fromBase64(hashB64)
    const actual = nobleArgon2id(utf8ToBytes(password), salt, {
      m: Number(m),
      t: Number(t),
      p: Number(p),
      dkLen: expected.length,
    })
    return timingSafeEqualBytes(expected, actual)
  } catch {
    return false
  }
}

/** Bandingkan dua byte array dalam waktu konstan. */
function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/** True bila string terlihat seperti hash argon2 yang valid. */
export function isArgon2Hash(value: unknown): boolean {
  return typeof value === 'string' && PHC_PATTERN.test(value.trim())
}

/** Helper diagnostik: bytesToHex tanpa membocorkan isi modul. */
export { bytesToHex }