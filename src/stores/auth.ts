import { computed, readonly, ref } from 'vue'
import {
  ApiError,
  changePassword as apiChangePassword,
  isApiConfigured,
  login as apiLogin,
  logout as apiLogout,
  me as apiMe,
  refreshSession,
  type AuthUser,
} from '@/lib/api'

type Status = 'unknown' | 'loading' | 'authenticated' | 'anonymous' | 'unavailable'

const user = ref<AuthUser | null>(null)
const status = ref<Status>('unknown')
const lastError = ref<string | null>(null)

/**
 * Promise yang sedang berjalan, dipakai untuk menutup balapan antara
 * `App.vue` (memanggil initAuth saat mount) dan route guard (memanggilnya
 * lagi sebelum navigating). Tanpa ini, guard bisa membaca status "loading"
 * dan salah menyimpulkan pengguna anonim.
 */
let inFlight: Promise<void> | null = null

/** Ditutup supaya komponen tidak bisa mengubah state dari luar store. */
export const authUser = readonly(user)
export const authStatus = readonly(status)
export const authError = readonly(lastError)

export const isAuthenticated = computed(() => status.value === 'authenticated' && user.value !== null)
export const isOwner = computed(() => user.value?.role === 'owner')
export const mustChangePassword = computed(() => user.value?.mustChangePassword === true)

function setError(err: unknown): string {
  const message =
    err instanceof ApiError
      ? err.message
      : err instanceof Error
        ? err.message
        : 'Terjadi kesalahan tidak diketahui.'
  lastError.value = message
  return message
}

/**
 * Pulihkan sesi dari cookie yang ada (saat refresh halaman).
 *
 * Penting: cookie access token berumur pendek, jadi sesi sering "hilang"
 * walau login masih valid — itulah alasan `/api/auth/refresh` dipanggil
 * di sini sebelum menyatakan pengguna anonim.
 */
export async function initAuth(): Promise<void> {
  if (!isApiConfigured()) {
    status.value = 'unavailable'
    return
  }
  if (status.value === 'authenticated') return
  // Ikuti promise yang sedang berjalan supaya tidak ada request ganda
  // dan tidak ada balapan status.
  if (inFlight) return inFlight

  status.value = 'loading'
  lastError.value = null

  inFlight = (async () => {

  // Coba cookie access token dulu (cepat, tanpa round-trip refresh).
    try {
      const { user: meUser } = await apiMe()
      user.value = meUser
      status.value = 'authenticated'
      return
    } catch (err) {
      const isAuthProblem = err instanceof ApiError && (err.status === 401 || err.status === 0)
      if (!isAuthProblem) setError(err)
    }

    // Cookie access expired/kosong — coba refresh dengan refresh token.
    try {
      const { user: refreshed } = await refreshSession()
      user.value = refreshed
      status.value = 'authenticated'
    } catch (err) {
      user.value = null
      status.value = 'anonymous'
      // 401 di sini normal (belum pernah login), jadi tidak dianggap error.
      const notLoggedIn = err instanceof ApiError && err.status === 401
      if (!notLoggedIn) setError(err)
    }
  })()

  try {
    await inFlight
  } finally {
    inFlight = null
  }
}

export async function login(email: string, password: string): Promise<boolean> {
  lastError.value = null
  status.value = 'loading'
  try {
    const { user: loggedIn } = await apiLogin(email, password)
    user.value = loggedIn
    status.value = 'authenticated'
    return true
  } catch (err) {
    user.value = null
    status.value = 'anonymous'
    setError(err)
    return false
  }
}

export async function logout(): Promise<void> {
  lastError.value = null
  try {
    await apiLogout()
  } catch (err) {
    // Tetap keluar di sisi klien walau server gagal — lebih baik daripada
    // membiarkan pengguna terjebak di state "login".
    setError(err)
  } finally {
    user.value = null
    status.value = 'anonymous'
  }
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<boolean> {
  lastError.value = null
  try {
    const { user: updated } = await apiChangePassword(currentPassword, newPassword)
    user.value = updated
    return true
  } catch (err) {
    setError(err)
    return false
  }
}

export function clearAuthError(): void {
  lastError.value = null
}

/** Reset penuh — dipakai saat logout dari tab lain / saat pengujian. */
export function resetAuthForTesting(): void {
  user.value = null
  status.value = 'unknown'
  lastError.value = null
  inFlight = null
}