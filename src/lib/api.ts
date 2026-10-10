/**
 * Klien API ke Cloudflare Worker.
 *
 * Token disimpan di cookie HttpOnly milik Worker — frontend tidak pernah
 * menyentuh nilainya. Karena itu setiap request memakai `credentials:
 * 'include'`: "login" berarti Worker yang menerbitkan cookie.
 */

export interface AuthUser {
  id: string
  email: string
  role: 'owner' | 'admin'
  display_name: string | null
  mustChangePassword: boolean
}

export class ApiError extends Error {
  readonly status: number
  readonly code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }

  /** 401 = sesi tidak valid; pemanggil biasanya ingin mengarahkan ke login. */
  get isUnauthorized(): boolean {
    return this.status === 401
  }
}

/** Base URL Worker. Kosong bila belum di-deploy — pemanggil cek lebih dulu. */
export function apiBaseUrl(): string {
  const raw = typeof __API_BASE_URL__ === 'string' ? __API_BASE_URL__.trim() : ''
  return raw.replace(/\/+$/, '')
}

export function isApiConfigured(): boolean {
  return apiBaseUrl().length > 0
}

export interface ApiBase {
  method?: string
  body?: unknown
  signal?: AbortSignal
}

/**
 * Kirim request ke Worker.
 *
 * Semua token berada di cookie HttpOnly, jadi `credentials: 'include'` wajib
 * dan tidak ada bearer token yang tersimpan di sisi browser.
 */
export async function apiRequest<T>(path: string, options: ApiBase = {}): Promise<T> {
  const base = apiBaseUrl()
  if (!base) {
    throw new ApiError(
      'Worker API belum dikonfigurasi. Isi VITE_API_BASE_URL lalu build ulang aplikasi.',
      0,
      'api_not_configured',
    )
  }

  const { method = 'GET', body, signal } = options

  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      method,
      credentials: 'include',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (err) {
    throw new ApiError(
      `Tidak bisa menghubungi Worker API. ${err instanceof Error ? err.message : ''}`.trim(),
      0,
      'network_error',
    )
  }

  // 204 atau body kosong: kembalikan null sebagai T.
  const text = await res.text()
  let parsed: unknown = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
  }

  if (!res.ok) {
    const payload = (parsed ?? {}) as { error?: string; code?: string }
    throw new ApiError(
      payload.error ?? `Permintaan gagal (HTTP ${res.status}).`,
      res.status,
      payload.code,
    )
  }

  return parsed as T
}

export interface LoginResponse {
  user: AuthUser
  expiresIn: number
}

export function login(email: string, password: string, signal?: AbortSignal) {
  return apiRequest<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: { email, password },
    signal,
  })
}

export function refreshSession(signal?: AbortSignal) {
  return apiRequest<LoginResponse>('/api/auth/refresh', { method: 'POST', signal })
}

export function logout(signal?: AbortSignal) {
  return apiRequest<{ ok: boolean }>('/api/auth/logout', { method: 'POST', signal })
}

export function me(signal?: AbortSignal) {
  return apiRequest<{ user: AuthUser }>('/api/auth/me', { signal })
}

export function changePassword(
  currentPassword: string,
  newPassword: string,
  signal?: AbortSignal,
) {
  return apiRequest<LoginResponse>('/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword, newPassword },
    signal,
  })
}

export function health(signal?: AbortSignal) {
  return apiRequest<{ status: string; database?: string; time?: string }>('/api/health', {
    signal,
  })
}