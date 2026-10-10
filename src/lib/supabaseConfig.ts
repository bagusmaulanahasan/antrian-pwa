/**
 * Klien Supabase + audit konfigurasi env.
 *
 * Nilai env di-inject lewat `define` di vite.config.ts agar process.env tidak
 * bocor ke bundle browser. Modul ini sengaja TIDAK melempar error saat env kosong:
 * halaman /dev/test-connection harus tetap bisa dirender dan melaporkan
 * diagnosis lengkap, bukan blank page.
 */

export interface SupabaseEnvStatus {
  url: string
  anonKey: string
  apiBaseUrl: string
  isDev: boolean
  urlOk: boolean
  urlValid: boolean
  anonKeyOk: boolean
  anonKeyLooksJwt: boolean
  anonKeyIsServiceRole: boolean
  problems: string[]
  hints: string[]
}

const RAW_URL = typeof __SUPABASE_URL__ === 'string' ? __SUPABASE_URL__.trim() : ''
const RAW_ANON_KEY = typeof __SUPABASE_ANON_KEY__ === 'string' ? __SUPABASE_ANON_KEY__.trim() : ''
const RAW_API_BASE = typeof __API_BASE_URL__ === 'string' ? __API_BASE_URL__.trim() : ''
const IS_DEV = typeof __IS_DEV__ === 'boolean' ? __IS_DEV__ : false

const SUPABASE_URL_PATTERN = /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i
// Local Supabase stack (supabase CLI) berjalan di http://localhost:54321.
const LOCAL_SUPABASE_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i

function looksLikeJwt(value: string): boolean {
  return value.split('.').length === 3
}

function looksLikeServiceRoleKey(value: string): boolean {
  // Kunci JWT Supabase memuat role di payload claim.
  if (!looksLikeJwt(value)) return false
  try {
    const payload = JSON.parse(atob(value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return payload?.role === 'service_role'
  } catch {
    return false
  }
}

export const envStatus = ((): SupabaseEnvStatus => {
  const problems: string[] = []
  const hints: string[] = []

  const urlOk = RAW_URL.length > 0
  const urlIsLocal = LOCAL_SUPABASE_PATTERN.test(RAW_URL)
  const urlValid = urlOk && (SUPABASE_URL_PATTERN.test(RAW_URL) || urlIsLocal)
  const anonKeyOk = RAW_ANON_KEY.length > 0
  const anonKeyLooksJwt = anonKeyOk && looksLikeJwt(RAW_ANON_KEY)
  const anonKeyIsServiceRole = anonKeyOk && looksLikeServiceRoleKey(RAW_ANON_KEY)

  if (!urlOk) {
    problems.push('VITE_SUPABASE_URL belum diisi.')
    hints.push('Salin file .env.example menjadi .env, lalu isi VITE_SUPABASE_URL dari Supabase Dashboard > Project Settings > API > Project URL.')
  } else if (!urlValid) {
    problems.push(`Format VITE_SUPABASE_URL tidak valid: "${RAW_URL}".`)
    hints.push('URL harus diawali https:// dan berakhiran .supabase.co / .supabase.in, atau http://localhost untuk Supabase lokal.')
  }

  if (!anonKeyOk) {
    problems.push('VITE_SUPABASE_ANON_KEY belum diisi.')
    hints.push('Isi dengan anon / publishable key. Jangan gunakan service_role key di frontend.')
  } else if (!anonKeyLooksJwt) {
    problems.push('VITE_SUPABASE_ANON_KEY tidak terlihat seperti JWT Supabase (harus 3 bagian dipisah titik).')
    hints.push('Buka Dashboard > API > Project Keys, lalu salin "anon public" key.')
  }

  if (anonKeyIsServiceRole) {
    problems.push('VITE_SUPABASE_ANON_KEY berisi service_role key.')
    hints.push('Key ini melewati RLS dan hanya boleh ada di Cloudflare Worker. Segera rotasi key tersebut.')
  }

  if (!RAW_API_BASE) {
    hints.push('VITE_API_BASE_URL kosong — endpoint /api/auth (login, refresh) belum bisa dipanggil. Fitur auth belum aktif sampai Worker di-deploy.')
  } else if (RAW_API_BASE !== '/api' && !/^https:\/\//i.test(RAW_API_BASE)) {
    problems.push(`Format VITE_API_BASE_URL tidak valid: "${RAW_API_BASE}".`)
    hints.push('Base URL Worker harus diawali https://, misal https://antrian-api.workers.dev, atau "/api" untuk proxy dev Vite.')
  }

  if (!IS_DEV) {
    hints.push('Environment production. Pastikan VITE_* diisi saat build, bukan hanya saat dev — nilai env di-inline ke bundle saat build.')
  }

  return {
    url: RAW_URL,
    anonKey: RAW_ANON_KEY,
    apiBaseUrl: RAW_API_BASE,
    isDev: IS_DEV,
    urlOk,
    urlValid,
    anonKeyOk,
    anonKeyLooksJwt,
    anonKeyIsServiceRole,
    problems,
    hints,
  }
})()

/** True bila env cukup untuk membuat Klien Supabase. */
export const isSupabaseConfigured =
  envStatus.urlOk && envStatus.urlValid && envStatus.anonKeyOk && !envStatus.anonKeyIsServiceRole

/** Samarkan kunci agar tidak tampil utuh di layar. */
export function maskSecret(value: string): string {
  if (!value) return '(kosong)'
  if (value.length <= 12) return `${value.slice(0, 3)}••••`
  return `${value.slice(0, 8)}••••••••${value.slice(-4)} (${value.length} karakter)`
}