/**
 * Token JWT (HS256) tanpa dependensi eksternal.
 *
 * Access token  : JWT singkat (default 15 menit), dibawa via header Authorization.
 * Refresh token : string acak opaque (bukan JWT), disimpan sebagai SHA-256 di
 *                 tabel `refresh_tokens`. Alasannya: tabel punya kolom `revoked_at`,
 *                 sehingga pencabutan bisa berlaku seketika. JWT refresh tidak
 *                 bisa dicabut sebelum kedaluwarsa.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export interface AccessTokenPayload {
  sub: string
  email: string
  role: 'owner' | 'admin'
  /** Menandai akun yang masih memakai password sementara. */
  pwd: boolean
  iat: number
  exp: number
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlEncodeString(value: string): string {
  return base64UrlEncode(encoder.encode(value))
}

function base64UrlDecodeToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60 // 15 menit
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60 // 30 hari

/** Tanda tangan HMAC-SHA256. */
async function hmacSign(data: Uint8Array, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, data)
  return new Uint8Array(sig)
}

/** Bandingkan dua string dalam waktu konstan-ish (anti timing attack sederhana). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Buat access token HS256.
 * @throws bila secret terlalu pendek.
 */
export async function signAccessToken(
  payload: Omit<AccessTokenPayload, 'iat' | 'exp'>,
  secret: string,
  ttlSeconds: number = ACCESS_TOKEN_TTL_SECONDS,
): Promise<string> {
  if (!secret || secret.length < 32) {
    throw new Error('JWT_ACCESS_SECRET minimal 32 karakter')
  }
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'HS256', typ: 'JWT' }
  const body: AccessTokenPayload = {
    ...payload,
    iat: now,
    exp: now + ttlSeconds,
  }
  const headerPart = base64UrlEncodeString(JSON.stringify(header))
  const payloadPart = base64UrlEncodeString(JSON.stringify(body))
  const signingInput = `${headerPart}.${payloadPart}`
  const signature = base64UrlEncode(await hmacSign(encoder.encode(signingInput), secret))
  return `${signingInput}.${signature}`
}

/**
 * Verifikasi access token. Mengembalikan null bila tidak valid (bukan throw),
 * supaya pemanggil tidak perlu try/catch di setiap tempat.
 */
export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<AccessTokenPayload | null> {
  try {
    if (!secret || secret.length < 32) return null
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [headerPart, payloadPart, signaturePart] = parts

    // Cegah algoritma:none dan alg confusion.
    const header = JSON.parse(decoder.decode(base64UrlDecodeToBytes(headerPart)))
    if (header.alg !== 'HS256') return null

    const expected = base64UrlEncode(
      await hmacSign(encoder.encode(`${headerPart}.${payloadPart}`), secret),
    )
    if (!timingSafeEqual(expected, signaturePart)) return null

    const payload = JSON.parse(decoder.decode(base64UrlDecodeToBytes(payloadPart))) as AccessTokenPayload
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null
    if (payload.role !== 'owner' && payload.role !== 'admin') return null
    return payload
  } catch {
    return null
  }
}

/**
 * Refresh token: 32 byte acak, di-base64url. BUKAN JWT.
 * Disimpan sebagai SHA-256 supaya kebocoran database tidak langsung berarti
 * token yang bisa dipakai.
 */
export function generateRefreshToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

/** Hash refresh token untuk disimpan di database. */
export async function hashRefreshToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}