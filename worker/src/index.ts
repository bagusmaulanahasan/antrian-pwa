/**
 * Worker API untuk Sistem Antrian.
 *
 * Tanggung jawab:
 *  -Autentikasi custom (tabel `users`, argon2id) via service_role
 *  - Issue access token JWT + refresh token opaque di HttpOnly cookie
 *
 * Route:
 *   GET  /api/health   health check (tanpa auth)
 *   POST /api/auth/login
 *   POST /api/auth/refresh
 *   POST /api/auth/logout
 *   POST /api/auth/change-password
 *   GET  /api/auth/me
 */
import {
  buildCookie,
  errorResponseFor,
  jsonFor,
  preflight,
  readJson,
  withErrorHandling,
  type Env,
} from './lib/http'
import { createUncachedClient } from './lib/supabaseAdmin'
import { verifyPassword, hashPassword } from './lib/password'
import {
  ACCESS_TOKEN_TTL_SECONDS,
  generateRefreshToken,
  hashRefreshToken,
  REFRESH_TOKEN_TTL_SECONDS,
  signAccessToken,
  verifyAccessToken,
} from './lib/token'

const REFRESH_COOKIE = 'antrian_refresh'
const ACCESS_COOKIE = 'antrian_access'
/** Nama kolom refresh token sha256 di tabel refresh_tokens.token_hash */
const TOKEN_HASH_HEX_LENGTH = 64

interface UserRow {
  id: string
  email: string
  password_hash: string
  role: 'owner' | 'admin'
  is_password_temporary: boolean
  display_name: string | null
  is_active: boolean
}

function assertEnv(env: Env): string | null {
  const missing: string[] = []
  if (!env.SUPABASE_URL) missing.push('SUPABASE_URL')
  if (!env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY')
  if (!env.JWT_ACCESS_SECRET || env.JWT_ACCESS_SECRET.length < 32) {
    missing.push('JWT_ACCESS_SECRET (min 32 karakter)')
  }
  return missing.length ? `Konfigurasi Worker belum lengkap: ${missing.join(', ')}` : null
}

/** Pesan error login seragam agar tidak membocorkan keberadaan email. */
const LOGIN_FAILED = 'Email atau password salah.'

function userPayload(u: UserRow) {
  return { sub: u.id, email: u.email, role: u.role, pwd: u.is_password_temporary }
}

async function issueSession(
  request: Request,
  user: UserRow,
  env: Env,
): Promise<Response> {
  const accessToken = await signAccessToken(userPayload(user), env.JWT_ACCESS_SECRET)
  const refreshToken = generateRefreshToken()
  const tokenHash = await hashRefreshToken(refreshToken)

  const supabase = await createUncachedClient(env)
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString()
  const { error } = await supabase.from('refresh_tokens').insert({
    user_id: user.id,
    token_hash: tokenHash,
    expires_at: expiresAt,
    user_agent: request.headers.get('User-Agent')?.slice(0, 500) ?? null,
  })
  if (error) {
    console.error('[worker] gagal menyimpan refresh token:', error.message)
    return errorResponseFor(request, env)('Gagal membuat sesi. Coba lagi.', 500)
  }

  // Both token disimpan sebagai cookie HttpOnly agar frontend tidak pernah
  // menyentuhnya lewat JavaScript (mitigasi XSS).
  return jsonFor(request, env)(
    {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        display_name: user.display_name,
        mustChangePassword: user.is_password_temporary,
      },
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    },
    200,
    {},
    sessionCookies(accessToken, refreshToken),
  )
}

/** Dua header Set-Cookie terpisah (access + refresh). */
function sessionCookies(accessToken: string, refreshToken: string): string[] {
  return [
    buildCookie(ACCESS_COOKIE, accessToken, { maxAge: ACCESS_TOKEN_TTL_SECONDS }),
    buildCookie(REFRESH_COOKIE, refreshToken, { maxAge: REFRESH_TOKEN_TTL_SECONDS }),
  ]
}

/**
 * Baca access token dari Authorization header, lalu cookie HttpOnly.
 *
 * Browser tidak bisa membaca cookie HttpOnly dari JavaScript, jadi frontend
 * tidak pernah bisa mengirim header `Authorization`. Karena itu cookie
 * `antrian_access` adalah jalur utama; header hanya untuk klien non-browser
 * (curl, skrip admin, pengujian).
 */
function readAccessToken(request: Request): string | null {
  const header = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (header) return header

  const raw = request.headers.get('Cookie')
  if (!raw) return null
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === ACCESS_COOKIE) {
      return decodeURIComponent(part.slice(idx + 1).trim())
    }
  }
  return null
}

const handler = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url)

  // Bayangkan ulang json/errorResponse dengan request+env yang sudah terikat,
  // supaya seluruh call site di bawah otomatis membawa header CORS yang benar.
  const respond = jsonFor(request, env)
  const failWith = errorResponseFor(request, env)

  if (request.method === 'OPTIONS') return preflight(request, env)

  if (url.pathname === '/api/health') {
    const envError = assertEnv(env)
    if (envError) return respond({ status: 'misconfigured', detail: envError }, 503)

    // Verifikasi konektivitas database.
    try {
      const supabase = await createUncachedClient(env)
      const { error } = await supabase.from('users').select('id').limit(1)
      if (error) {
        return respond({ status: 'degraded', database: 'error', detail: error.message }, 503)
      }
      return respond({
        status: 'ok',
        database: 'connected',
        time: new Date().toISOString(),
      })
    } catch (err) {
      return respond(
        { status: 'degraded', database: 'unreachable', detail: err instanceof Error ? err.message : 'unknown' },
        503,
      )
    }
  }

  const envError = assertEnv(env)
  if (envError) return failWith(envError, 503, 'misconfigured')

  // ---------------- POST /api/auth/login ----------------
  if (url.pathname === '/api/auth/login' && request.method === 'POST') {
    const body = await readJson<{ email?: unknown; password?: unknown }>(request)
    if (!body) return failWith('Body JSON tidak valid.', 400)

    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!email || !password) return failWith(LOGIN_FAILED, 401)

    const supabase = await createUncachedClient(env)
    // citext membuat perbandingan email case-insensitive di database.
    const { data, error } = await supabase
      .from('users')
      .select('id, email, password_hash, role, is_password_temporary, display_name, is_active')
      .eq('email', email)
      .maybeSingle()

    if (error) {
      console.error('[worker] query users gagal:', error.message)
      return failWith('Kesalahan database saat login.', 500)
    }

    const user = data as UserRow | null
    // Tetap lakukan verifikasi meski user tidak ada, agar waktu respons
    // tidak membocorkan email mana yang terdaftar.
    const valid = user
      ? await verifyPassword(user.password_hash, password)
      : await verifyPassword(
          '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          password,
        )

    if (!user || !valid || !user.is_active) return failWith(LOGIN_FAILED, 401)

    await supabase.from('users').update({ last_login_at: new Date().toISOString() }).eq('id', user.id)
    return issueSession(request, user, env)
  }

  // ---------------- POST /api/auth/refresh ----------------
  if (url.pathname === '/api/auth/refresh' && request.method === 'POST') {
    const refreshToken = request.headers
      .get('Cookie')
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${REFRESH_COOKIE}=`))
      ?.slice(REFRESH_COOKIE.length + 1)

    if (!refreshToken) return failWith('Sesi tidak ditemukan.', 401)
    const decoded = decodeURIComponent(refreshToken)
    if (decoded.length !== 43) return failWith('Token refresh tidak valid.', 401)

    const tokenHash = await hashRefreshToken(decoded)
    if (tokenHash.length !== TOKEN_HASH_HEX_LENGTH) return failWith('Token refresh tidak valid.', 401)

    const supabase = await createUncachedClient(env)
    const { data, error } = await supabase
      .from('refresh_tokens')
      .select('id, user_id, expires_at, revoked_at')
      .eq('token_hash', tokenHash)
      .maybeSingle()

    if (error || !data) return failWith('Sesi tidak valid.', 401)

    const record = data as {
      id: string
      user_id: string
      expires_at: string
      revoked_at: string | null
    }
    if (record.revoked_at || new Date(record.expires_at).getTime() <= Date.now()) {
      return failWith('Sesi kedaluwarsa. Silakan masuk lagi.', 401)
    }

    const { data: userData } = await supabase
      .from('users')
      .select('id, email, password_hash, role, is_password_temporary, display_name, is_active')
      .eq('id', record.user_id)
      .maybeSingle()

    const user = userData as UserRow | null
    if (!user || !user.is_active) return failWith('Akun tidak aktif.', 401)

    // Rotasi refresh token: token lama langsung dicabut.
    const newToken = generateRefreshToken()
    const newHash = await hashRefreshToken(newToken)
    await supabase
      .from('refresh_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', record.id)
    await supabase.from('refresh_tokens').insert({
      user_id: user.id,
      token_hash: newHash,
      expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString(),
      user_agent: request.headers.get('User-Agent')?.slice(0, 500) ?? null,
    })

    const accessToken = await signAccessToken(userPayload(user), env.JWT_ACCESS_SECRET)
    return respond(
      {
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          display_name: user.display_name,
          // WAJIB ikut di refresh: frontend memakainya untuk mengunci
          // seluruh route sampai password sementara diganti. Kalau hilang,
          // sesi yang di-refresh terlihat seolah sudah aman.
          mustChangePassword: user.is_password_temporary,
        },
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      },
      200,
      {},
      sessionCookies(accessToken, newToken),
    )
  }

  // ---------------- POST /api/auth/logout ----------------
  if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
    const cookie = request.headers.get('Cookie') ?? ''
    const raw = cookie
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${REFRESH_COOKIE}=`))
      ?.slice(REFRESH_COOKIE.length + 1)

    if (raw) {
      const supabase = await createUncachedClient(env)
      const tokenHash = await hashRefreshToken(decodeURIComponent(raw))
      await supabase
        .from('refresh_tokens')
        .update({ revoked_at: new Date().toISOString() })
        .eq('token_hash', tokenHash)
    }

    return respond({ ok: true }, 200, {}, [
      buildCookie(ACCESS_COOKIE, '', { maxAge: 0 }),
      buildCookie(REFRESH_COOKIE, '', { maxAge: 0 }),
    ])
  }

  // ---------------- /api/auth/me ----------------
  const bearer = readAccessToken(request)
  const payload = bearer ? await verifyAccessToken(bearer, env.JWT_ACCESS_SECRET) : null

  if (url.pathname === '/api/auth/me' && request.method === 'GET') {
    if (!bearer) return failWith('Tidak terautentikasi.', 401)
    if (!payload) return failWith('Token tidak valid atau kedaluwarsa.', 401)
    const supabase = await createUncachedClient(env)
    const { data } = await supabase
      .from('users')
      .select('id, email, role, display_name, is_password_temporary, is_active')
      .eq('id', payload.sub)
      .maybeSingle()
    const user = data as Pick<UserRow, 'id' | 'email' | 'role' | 'display_name' | 'is_password_temporary' | 'is_active'> | null
    if (!user || !user.is_active) return failWith('Akun tidak aktif.', 401)
    return respond({ user: { ...user, mustChangePassword: user.is_password_temporary } })
  }

  // ---------------- POST /api/auth/change-password ----------------
  if (url.pathname === '/api/auth/change-password' && request.method === 'POST') {
    if (!bearer) return failWith('Tidak terautentikasi.', 401)
    if (!payload) return failWith('Token tidak valid atau kedaluwarsa.', 401)
    const payloadToken = payload

    const body = await readJson<{ currentPassword?: unknown; newPassword?: unknown }>(request)
    if (!body) return failWith('Body JSON tidak valid.', 400)

    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : ''
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''

    if (newPassword.length < 8) {
      return failWith('Password baru minimal 8 karakter.', 400)
    }

    const supabase = await createUncachedClient(env)
    const { data } = await supabase
      .from('users')
      .select('id, email, password_hash, role, is_password_temporary, display_name, is_active')
      .eq('id', payloadToken.sub)
      .maybeSingle()
    const user = data as UserRow | null
    if (!user) return failWith('Akun tidak ditemukan.', 404)

    if (!(await verifyPassword(user.password_hash, currentPassword))) {
      return failWith('Password saat ini salah.', 401)
    }

    const newHash = await hashPassword(newPassword)
    const { error } = await supabase
      .from('users')
      .update({ password_hash: newHash, is_password_temporary: false, updated_at: new Date().toISOString() })
      .eq('id', user.id)
    if (error) return failWith('Gagal menyimpan password baru.', 500)

    // Cabut semua sesi lama â€” password berubah, semua perangkat harus masuk lagi.
    await supabase
      .from('refresh_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .is('revoked_at', null)

    const updated: UserRow = { ...user, password_hash: newHash, is_password_temporary: false }
    return issueSession(request, updated, env)
  }

  return failWith('Endpoint tidak ditemukan.', 404)
}

export default {
  fetch: withErrorHandling(handler),
} satisfies ExportedHandler<Env>