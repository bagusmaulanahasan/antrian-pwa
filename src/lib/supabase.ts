import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { envStatus, isSupabaseConfigured } from './supabaseConfig'

let client: SupabaseClient | null = null
let initError: string | null = null

/**
 * Klien Supabase tunggal (anon key).
 *
 * Dibuat lazy: kalau env belum lengkap, `getSupabase()` mengembalikan null
 * beserta pesan errornya, sehingga UI bisa menampilkan diagnosis alih-alih
 * melempar exception saat modul ini diimpor.
 */
export function initSupabase(): { client: SupabaseClient | null; error: string | null } {
  if (client) return { client, error: null }
  if (initError) return { client: null, error: initError }

  if (!isSupabaseConfigured) {
    initError = envStatus.problems[0] ?? 'Konfigurasi Supabase belum lengkap.'
    return { client: null, error: initError }
  }

  try {
    client = createClient(envStatus.url, envStatus.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        headers: { 'x-application-name': 'antrian-pwa' },
      },
      realtime: {
        params: { eventsPerSecond: 20 },
      },
    })
    return { client, error: null }
  } catch (err) {
    initError = err instanceof Error ? err.message : String(err)
    return { client: null, error: initError }
  }
}

/** Klien aktif, atau null bila env belum dikonfigurasi. */
export function getSupabase(): SupabaseClient | null {
  return initSupabase().client
}

/** Pesan error inisialisasi terakhir (null bila klien siap). */
export function getSupabaseInitError(): string | null {
  return initSupabase().error
}

/** Hanya untuk halaman diagnostic — memaksa instantiate ulang. */
export function resetSupabaseForDiagnostics(): void {
  client = null
  initError = null
}