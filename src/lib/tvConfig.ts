/**
 * Konfigurasi khusus Dashboard TV.
 *
 * `VITE_TV_PIN` di-inline ke bundle saat build - ini disengaja. PIN TV bukan
 * rahasia: keamanan data tetap dijaga oleh policy RLS yang hanya
 * mengizinkan SELECT lewat anon key (lihat PRD bagian peran pengguna). PIN
 * hanya mencegah layar Tv tampil tanpa disengaja di depan pelanggan.
 */

function readEnv(key: string): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env
  return (env?.[key] ?? '').trim()
}

/** Kode PIN TV, minimal 4 karakter. String kosong berarti tidak terkunci. */
export function getTvPin(): string {
  const pin = readEnv('VITE_TV_PIN')
  if (!pin) return ''
  return pin.length >= 4 ? pin : ''
}

/** True bila PIN dikonfigurasi (layar tidak terbuka bebas). */
export function isTvPinConfigured(): boolean {
  return getTvPin().length >= 4
}

/** Pesan untuk ditampilkan bila PIN belum diatur. */
export const TV_PIN_MISSING_MESSAGE =
  'Dashboard TV belum memiliki kode PIN. Isi VITE_TV_PIN (minimal 4 karakter) lalu build ulang aplikasi.'