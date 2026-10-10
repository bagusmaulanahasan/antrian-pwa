/**
 * Utilitas HTTP bersama untuk Worker.
 *
 * Menghapus repetisi try/catch dan memastikan setiap response punya
 * header keamanan yang konsisten.
 */

export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  JWT_ACCESS_SECRET: string
  /** Asal yang sah untuk CORS, mis. "https://antrian.pages.dev". */
  ALLOWED_ORIGIN?: string
}

/**
 * CORS untuk API yang memakai cookie HttpOnly.
 *
 * PENTING: wildcard `*` TIDAK boleh dipakai bersama `credentials: 'include'` —
 * browser akan menolak responsnya. Karena itu origin dibaca dari header
 * `Origin` dan dicerminkan balik, lalu `Allow-Credentials: true` dikirim.
 *
 * `ALLOWED_ORIGIN` membatasi asal yang diterima (pisahkan dengan koma).
 * Kosong = izinkan semua asal (cocok untuk penggunaan internal/WIFI'd).
 */
export function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin')
  const allowed = (env.ALLOWED_ORIGIN ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)

  const isAllowed = !allowed.length || allowed.includes('*') || (origin !== null && allowed.includes(origin))

  if (!isAllowed) {
    // Jangan(header CORS apa pun) — browser akan memblokir respons anyway.
    return {}
  }

  return {
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : { 'Access-Control-Allow-Origin': '*' }),
    ...(origin ? { 'Access-Control-Allow-Credentials': 'true' } : {}),
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
}

export function json(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
  extraSetCookies: string[] = [],
  request?: Request,
  env?: Env,
): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    ...SECURITY_HEADERS,
    ...extraHeaders,
  })
  if (request && env) {
    for (const [k, v] of Object.entries(corsHeaders(request, env))) headers.set(k, v)
  }
  // Set-Cookie harus dikirim sebagai header terpisah. Menggabungkannya dengan
  // koma membuat browser salah mengurai sehingga cookie kedua hilang.
  for (const cookie of extraSetCookies) headers.append('Set-Cookie', cookie)

  return new Response(JSON.stringify(body), { status, headers })
}

export function errorResponse(message: string, status: number, code?: string): Response {
  return json({ error: message, ...(code ? { code } : {}) }, status)
}

/** json/errorResponse yang sudah terikat ke request+env tertentu. */
export function jsonFor(request: Request, env: Env) {
  return (
    body: unknown,
    status = 200,
    extraHeaders: Record<string, string> = {},
    extraSetCookies: string[] = [],
  ): Response => json(body, status, extraHeaders, extraSetCookies, request, env)
}

export function errorResponseFor(request: Request, env: Env) {
  return (message: string, status: number, code?: string): Response =>
    jsonFor(request, env)({ error: message, ...(code ? { code } : {}) }, status)
}

export function preflight(request: Request, env: Env): Response {
  return new Response(null, {
    status: 204,
    headers: { ...corsHeaders(request, env), ...SECURITY_HEADERS },
  })
}

/** Bungkus handler agar exception tidak pernah membocorkan stack trace ke klien. */
export function withErrorHandling(
  handler: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>,
) {
  return async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    try {
      return await handler(request, env, ctx)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Kesalahan tidak diketahui'
      console.error('[worker] unhandled error:', message, err)
      return errorResponse('Terjadi kesalahan pada server.', 500)
    }
  }
}

/** Baca dan parses body JSON dengan batas ukuran. */
export async function readJson<T = unknown>(request: Request, maxBytes = 16_384): Promise<T | null> {
  try {
    const text = await request.text()
    if (text.length > maxBytes) return null
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim())
    }
  }
  return null
}

/**
 * Bangun header Set-Cookie yang aman.
 * @param name
 * @param value
 * @param opts.maxAge detik; 0 atau negatif = hapus cookie
 * @param opts.secure default true (wajib di produksi)
 */
export function buildCookie(
  name: string,
  value: string,
  opts: { maxAge?: number; secure?: boolean; httpOnly?: boolean; path?: string } = {},
): string {
  const { maxAge = 0, secure = false, httpOnly = true, path = '/' } = opts
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=Lax`]
  if (httpOnly) parts.push('HttpOnly')
  if (secure) parts.push('Secure')
  if (maxAge > 0) parts.push(`Max-Age=${maxAge}`)
  else parts.push('Max-Age=0')
  return parts.join('; ')
}