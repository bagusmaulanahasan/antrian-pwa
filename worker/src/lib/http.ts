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

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
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
): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    ...CORS_HEADERS,
    ...SECURITY_HEADERS,
    ...extraHeaders,
  })
  // Set-Cookie harus dikirim sebagai header terpisah. Menggabungkannya dengan
  // koma membuat browser/peramban salah mengurai Expires atau atribut lain.
  for (const cookie of extraSetCookies) headers.append('Set-Cookie', cookie)

  return new Response(JSON.stringify(body), { status, headers })
}

export function errorResponse(message: string, status: number, code?: string): Response {
  return json({ error: message, ...(code ? { code } : {}) }, status)
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: { ...CORS_HEADERS, ...SECURITY_HEADERS } })
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
  const { maxAge = 0, secure = true, httpOnly = true, path = '/' } = opts
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=Strict`]
  if (httpOnly) parts.push('HttpOnly')
  if (secure) parts.push('Secure')
  if (maxAge > 0) parts.push(`Max-Age=${maxAge}`)
  else parts.push('Max-Age=0')
  return parts.join('; ')
}