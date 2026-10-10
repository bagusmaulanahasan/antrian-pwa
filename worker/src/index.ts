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
import {
  createCategory,
  createUser,
  DEFAULT_TEMP_PASSWORD,
  deactivateCategory,
  listAllCategories,
  listUsers,
  readSettings,
  resetUserPassword,
  setUserActive,
  updateCategory,
  writeSetting,
} from './lib/settings'
import {
  callNext,
  createQueueEntry,
  listCategories,
  listQueue,
  markPrinted,
  recall,
  setStatus,
  type QueueEntry,
} from './lib/queue'
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
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString()
  const userAgent = request.headers.get('User-Agent')?.slice(0, 500) ?? null

  const supabase = await createUncachedClient(env)

  // Tabel `refresh_tokens` sengaja TIDAK diberi policy RLS (lihat
  // supabase/02_seed_and_fixes.sql) supaya tidak bisa dibaca/diubah dari sisi
  // klien. Karena service_role juga ikut melewati RLS, menulis lewat PostgREST
  // tetap bisa — tapi INSERT langsung ditolak karena tabel tidak punya policy
  // INSERT untuk role yang diizuinkan. Yang dipakai adalah RPC
  // SECURITY DEFINER agar satu-satunya jalur tulis terpusat dan tervalidasi.
  const { error } = await supabase.rpc('store_refresh_token', {
    p_user_id: user.id,
    p_token_hash: tokenHash,
    p_expires_at: expiresAt,
    p_user_agent: userAgent,
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

    // Rotasi refresh token: token lama langsung dicabut, lalu token baru
    // diterbitkan. Semua lewat RPC supaya validasi tetap di satu tempat.
    const newToken = generateRefreshToken()
    const newHash = await hashRefreshToken(newToken)
    await supabase.rpc('revoke_refresh_token', { p_token_hash: tokenHash })
    const { error: storeError } = await supabase.rpc('store_refresh_token', {
      p_user_id: user.id,
      p_token_hash: newHash,
      p_expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString(),
      p_user_agent: request.headers.get('User-Agent')?.slice(0, 500) ?? null,
    })
    if (storeError) {
      console.error('[worker] gagal menyimpan refresh token baru:', storeError.message)
      return failWith('Gagal memperbarui sesi. Coba lagi.', 500)
    }

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
      await supabase.rpc('revoke_refresh_token', { p_token_hash: tokenHash })
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

    // Cabut semua sesi lama — password berubah, semua perangkat harus masuk lagi.
    await supabase.rpc('revoke_all_refresh_tokens', { p_user_id: user.id })

    const updated: UserRow = { ...user, password_hash: newHash, is_password_temporary: false }
    return issueSession(request, updated, env)
  }

  // ================= PENGATURAN OWNER =================
  //
  // Rute di bawah hanya untuk role `owner`. `admin` mendapat 403 — bukan
  // 401, karena sesi-nya valid, hanya tidak cukup hak akses.
  if (url.pathname.startsWith('/api/settings') || url.pathname.startsWith('/api/admin')) {
    if (!bearer) return failWith('Tidak terautentikasi.', 401)
    if (!payload) return failWith('Token tidak valid atau kedaluwarsa.', 401)
    if (payload.role !== 'owner') {
      return failWith('Hanya owner yang boleh mengakses pengaturan.', 403, 'forbidden')
    }

    // --- Kategori ---
    if (url.pathname === '/api/admin/categories' && request.method === 'GET') {
      try {
        return respond({ categories: await listAllCategories(env) })
      } catch (err) {
        return failWith(err instanceof Error ? err.message : 'Gagal membaca kategori.', 500)
      }
    }

    if (url.pathname === '/api/admin/categories' && request.method === 'POST') {
      const body = await readJson<Record<string, unknown>>(request)
      if (!body) return failWith('Body JSON tidak valid.', 400)
      try {
        return respond({ category: await createCategory(env, body) }, 201)
      } catch (err) {
        // Validasi domain jadi 4xx, bukan 500.
        return failWith(err instanceof Error ? err.message : 'Gagal membuat kategori.', 400)
      }
    }

    const catPatch = /^\/api\/admin\/categories\/([0-9a-f-]{36})$/i.exec(url.pathname)
    if (catPatch && request.method === 'PATCH') {
      const body = await readJson<Record<string, unknown>>(request)
      if (!body) return failWith('Body JSON tidak valid.', 400)
      try {
        return respond({ category: await updateCategory(env, catPatch[1], body) })
      } catch (err) {
        return failWith(err instanceof Error ? err.message : 'Gagal memperbarui kategori.', 400)
      }
    }

    if (catPatch && request.method === 'DELETE') {
      try {
        return respond({ category: await deactivateCategory(env, catPatch[1]) })
      } catch (err) {
        return failWith(err instanceof Error ? err.message : 'Gagal menonaktifkan kategori.', 400)
      }
    }

    // --- Manage akun ---
    if (url.pathname === '/api/admin/users' && request.method === 'GET') {
      try {
        return respond({ users: await listUsers(env) })
      } catch (err) {
        return failWith(err instanceof Error ? err.message : 'Gagal membaca akun.', 500)
      }
    }

    if (url.pathname === '/api/admin/users' && request.method === 'POST') {
      const body = await readJson<Record<string, unknown>>(request)
      if (!body) return failWith('Body JSON tidak valid.', 400)
      try {
        const created = await createUser(env, {
          email: String(body.email ?? ''),
          password: String(body.password ?? ''),
          role: String(body.role ?? 'admin'),
          displayName: body.displayName ? String(body.displayName) : undefined,
        })
        return respond({ user: created, temporaryPassword: DEFAULT_TEMP_PASSWORD }, 201)
      } catch (err) {
        return failWith(err instanceof Error ? err.message : 'Gagal membuat akun.', 400)
      }
    }

    const userReset = /^\/api\/admin\/users\/([0-9a-f-]{36})\/reset-password$/i.exec(url.pathname)
    if (userReset && request.method === 'POST') {
      try {
        const updated = await resetUserPassword(env, userReset[1])
        return respond({ user: updated, temporaryPassword: DEFAULT_TEMP_PASSWORD })
      } catch (err) {
        return failWith(err instanceof Error ? err.message : 'Gagal mereset password.', 400)
      }
    }

    const userActive = /^\/api\/admin\/users\/([0-9a-f-]{36})\/active$/i.exec(url.pathname)
    if (userActive && request.method === 'POST') {
      const body = await readJson<{ isActive?: unknown }>(request)
      if (typeof body?.isActive !== 'boolean') {
        return failWith('Field "isActive" harus boolean.', 400)
      }
      try {
        return respond({ user: await setUserActive(env, userActive[1], body.isActive, payload.sub) })
      } catch (err) {
        return failWith(err instanceof Error ? err.message : 'Gagal mengubah status akun.', 400)
      }
    }

    // --- Pengaturan ---
    if (url.pathname === '/api/settings' && request.method === 'GET') {
      try {
        return respond({ settings: await readSettings(env) })
      } catch (err) {
        return failWith(err instanceof Error ? err.message : 'Gagal membaca pengaturan.', 500)
      }
    }

    if (url.pathname === '/api/settings' && request.method === 'PATCH') {
      const body = await readJson<{ key?: unknown; value?: unknown }>(request)
      if (!body) return failWith('Body JSON tidak valid.', 400)
      const key = typeof body.key === 'string' ? body.key : ''
      if (!key) return failWith('Field "key" wajib diisi.', 400)

      try {
        return respond({ setting: await writeSetting(env, key, body.value, payload.sub) })
      } catch (err) {
        return failWith(err instanceof Error ? err.message : 'Gagal menyimpan pengaturan.', 400)
      }
    }
  }

  // ================= OPERASIONAL ANTRIAN =================
  //
  // Semua rute di bawah wajib terautentikasi. Dashboard TV hanya membaca
  // lewat anon key langsung ke Supabase, tidak lewat Worker ini.
  if (url.pathname.startsWith('/api/queue')) {
    if (!bearer) return failWith('Tidak terautentikasi.', 401)
    if (!payload) return failWith('Token tidak valid atau kedaluwarsa.', 401)

    const userId = payload.sub

    // GET /api/queue            → daftar antrian + jumlah per status
    // GET /api/queue/categories → kategori aktif
    if (url.pathname === '/api/queue' && request.method === 'GET') {
      try {
        const date = url.searchParams.get('date') ?? undefined
        return respond(await listQueue(env, date))
      } catch (err) {
        return failWith(err instanceof Error ? err.message : 'Gagal membaca antrian.', 500)
      }
    }

    if (url.pathname === '/api/queue/categories' && request.method === 'GET') {
      try {
        return respond({ categories: await listCategories(env) })
      } catch (err) {
        return failWith(err instanceof Error ? err.message : 'Gagal membaca kategori.', 500)
      }
    }

    // POST /api/queue           → tambah antrian
    if (url.pathname === '/api/queue' && request.method === 'POST') {
      const body = await readJson<{
        customerName?: unknown
        categoryId?: unknown
        printStatus?: unknown
      }>(request)
      if (!body) return failWith('Body JSON tidak valid.', 400)

      const customerName = typeof body.customerName === 'string' ? body.customerName.trim() : ''
      if (!customerName) return failWith('Nama pelanggan wajib diisi.', 400)
      if (customerName.length > 120) {
        return failWith('Nama pelanggan terlalu panjang (maks 120 karakter).', 400)
      }

      const categoryId =
        typeof body.categoryId === 'string' && body.categoryId ? body.categoryId : null
      const printStatus = body.printStatus === 'printed' ? 'printed' : 'pending'

      try {
        const entry = await createQueueEntry(env, { customerName, categoryId, printStatus })
        return respond({ entry }, 201)
      } catch (err) {
        return failWith(err instanceof Error ? err.message : 'Gagal membuat antrian.', 500)
      }
    }

    // POST /api/queue/next      → panggil nomor berikutnya
    if (url.pathname === '/api/queue/next' && request.method === 'POST') {
      try {
        const result = await callNext(env, userId)
        if (!result.ok) return failWith(result.error ?? 'Gagal memanggil nomor berikutnya.', 500)
        return respond(result)
      } catch (err) {
        return failWith(
          err instanceof Error ? err.message : 'Gagal memanggil nomor berikutnya.',
          500,
        )
      }
    }

    // PATCH /api/queue/:id      → ubah status
    const statusMatch = /^\/api\/queue\/([0-9a-f-]{36})$/i.exec(url.pathname)
    if (statusMatch && request.method === 'PATCH') {
      const body = await readJson<{ status?: unknown }>(request)
      const status = body?.status
      const allowed = ['waiting', 'serving', 'pending', 'done', 'cancelled']
      if (typeof status !== 'string' || !allowed.includes(status)) {
        return failWith(
          `Status tidak dikenal: ${String(status)}. Gunakan: ${allowed.join(', ')}.`,
          400,
        )
      }
      try {
        const result = await setStatus(
          env,
          statusMatch[1],
          status as QueueEntry['status'],
          userId,
        )
        if (!result.ok) return failWith(result.error ?? 'Gagal mengubah status.', 500)
        return respond(result)
      } catch (err) {
        return failWith(err instanceof Error ? err.message : 'Gagal mengubah status.', 500)
      }
    }

    // POST /api/queue/:id/recall → panggil ulang
    const recallMatch = /^\/api\/queue\/([0-9a-f-]{36})\/recall$/i.exec(url.pathname)
    if (recallMatch && request.method === 'POST') {
      try {
        const result = await recall(env, recallMatch[1])
        if (!result.ok) return failWith(result.error ?? 'Gagal memanggil ulang.', 500)
        return respond(result)
      } catch (err) {
        return failWith(err instanceof Error ? err.message : 'Gagal memanggil ulang.', 500)
      }
    }

    // POST /api/queue/:id/print → tandai cetak berhasil/gagal
    const printMatch = /^\/api\/queue\/([0-9a-f-]{36})\/print$/i.exec(url.pathname)
    if (printMatch && request.method === 'POST') {
      const body = await readJson<{ printed?: unknown }>(request)
      if (typeof body?.printed !== 'boolean') {
        return failWith('Field "printed" harus boolean.', 400)
      }
      try {
        const entry = await markPrinted(env, printMatch[1], body.printed)
        return respond({ entry })
      } catch (err) {
        return failWith(
          err instanceof Error ? err.message : 'Gagal memperbarui status cetak.',
          500,
        )
      }
    }
  }

  return failWith('Endpoint tidak ditemukan.', 404)
}

export default {
  fetch: withErrorHandling(handler),
} satisfies ExportedHandler<Env>