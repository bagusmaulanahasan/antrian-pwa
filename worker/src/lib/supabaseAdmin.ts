/**
 * Klien Supabase untuk sisi Worker (service_role).
 *
 * Berbeda dengan frontend, Worker memakai service_role key yang
 * melewati RLS. Kunci ini TIDAK PERNAH boleh masuk bundle browser —
 * hanya dibaca dari binding/secret Cloudflare.
 */

export interface SupabaseBinding {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
}

let cached: import('@supabase/supabase-js').SupabaseClient | null = null

/** Buat (atau ambil dari cache) klien service_role. */
export async function getServiceClient(env: SupabaseBinding) {
  if (cached) return cached
  const { createClient } = await import('@supabase/supabase-js')
  cached = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-application-name': 'antrian-worker' } },
  })
  return cached
}

/**
 * Client khusus request tertentu — dipakai test agar tidak memakai cache.
 * @param {SupabaseBinding} env
 */
export async function createUncachedClient(env: SupabaseBinding) {
  const { createClient } = await import('@supabase/supabase-js')
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-application-name': 'antrian-worker' } },
  })
}