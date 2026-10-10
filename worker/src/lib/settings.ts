/**
 * API pengaturan & kategori (Worker) â€” khusus Owner.
 *
 * Semua rute di sini menolak role `admin`; hanya `owner` yang boleh mengubah
 * konfigurasi yang memengaruhi seluruh operasional (kategori, template suara,
 * jam reset) dan mengelola akun.
 */
import type { Env } from './http'
import { createUncachedClient } from './supabaseAdmin'
import { hashPassword } from './password'

export interface SettingsRow {
  key: string
  value: unknown
  updated_at: string
}

/** Kunci yang boleh dibaca/diubah lewat API. */
export const MANAGED_SETTING_KEYS = [
  'reset_hour',
  'print_template',
  'voice_template',
  'tv_pin_hash',
] as const
export type ManagedSettingKey = (typeof MANAGED_SETTING_KEYS)[number]

export async function readSettings(env: Env): Promise<Record<string, unknown>> {
  const client = await createUncachedClient(env)
  const { data, error } = await client.from('settings').select('key, value').in('key', [
    ...MANAGED_SETTING_KEYS,
  ])
  if (error) throw new Error(`Gagal membaca pengaturan: ${error.message}`)

  const out: Record<string, unknown> = {}
  for (const row of (data ?? []) as SettingsRow[]) out[row.key] = row.value
  return out
}

/**
 * Ubah satu pengaturan.
 *
 * Validasi dilakukan di sini, bukan di frontend: satu-satunya tempat yang
 * tidak bisa dilewati adalah server.
 */
export async function writeSetting(
  env: Env,
  key: string,
  value: unknown,
  userId: string,
): Promise<SettingsRow> {
  if (!(MANAGED_SETTING_KEYS as readonly string[]).includes(key)) {
    throw new Error(`Kunci pengaturan tidak dikenal: ${key}`)
  }
  validateSettingValue(key, value)

  const client = await createUncachedClient(env)
  const { data, error } = await client
    .from('settings')
    .update({ value, updated_at: new Date().toISOString(), updated_by: userId })
    .eq('key', key)
    .select()
    .maybeSingle()

  if (error) throw new Error(`Gagal menyimpan pengaturan: ${error.message}`)
  if (!data) throw new Error(`Pengaturan "${key}" belum ada. Jalankan seed di SQL Editor.`)
  return data as SettingsRow
}

function validateSettingValue(key: string, value: unknown): void {
  if (key === 'reset_hour') {
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isInteger(n) || n < 0 || n > 23) {
      throw new Error('reset_hour harus berupa bilangan bulat 0-23 (jam dalam WIB).')
    }
    return
  }

  if (key === 'print_template' || key === 'voice_template') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${key} harus berupa objek JSON.`)
    }
    const v = value as Record<string, unknown>

    if (key === 'voice_template') {
      if (typeof v.text !== 'string' || v.text.trim().length === 0) {
        throw new Error('voice_template.text wajib diisi.')
      }
      if (v.text.length > 400) {
        throw new Error('voice_template.text terlalu panjang (maks 400 karakter).')
      }
      const rate = Number(v.rate ?? 1)
      if (!(rate > 0 && rate <= 2)) throw new Error('rate harus di antara 0 dan 2.')
      const volume = Number(v.volume ?? 1)
      if (!(volume > 0 && volume <= 1)) throw new Error('volume harus di antara 0 dan 1.')
      const repeat = Number(v.repeat ?? 1)
      if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5) {
        throw new Error('repeat harus bilangan bulat 1-5.')
      }
      return
    }

    if (typeof v.template !== 'string' || v.template.length === 0) {
      throw new Error('print_template.template wajib diisi.')
    }
    if (v.template.length > 2000) {
      throw new Error('print_template.template terlalu panjang (maks 2000 karakter).')
    }
    return
  }

  if (key === 'tv_pin_hash') {
    if (value !== null && typeof value !== 'string') {
      throw new Error('tv_pin_hash harus berupa string atau null.')
    }
  }
}

// ------------------------------------------------------------ kategori

export interface CategoryRow {
  id: string
  name: string
  color: string
  code: string | null
  sort_order: number
  is_active: boolean
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i

function validateCategory(input: Partial<CategoryRow>): void {
  if (input.name !== undefined) {
    const name = String(input.name).trim()
    if (!name) throw new Error('Nama kategori wajib diisi.')
    if (name.length > 60) throw new Error('Nama kategori terlalu panjang (maks 60 karakter).')
  }
  if (input.color !== undefined && !HEX_COLOR.test(String(input.color))) {
    throw new Error('Warna harus format hex seperti #4f46e5.')
  }
  if (input.sort_order !== undefined && !Number.isInteger(input.sort_order)) {
    throw new Error('sort_order harus bilangan bulat.')
  }
  if (input.code !== undefined && input.code !== null && String(input.code).length > 20) {
    throw new Error('Kode kategori terlalu panjang (maks 20 karakter).')
  }
}

export async function listAllCategories(env: Env): Promise<CategoryRow[]> {
  const client = await createUncachedClient(env)
  const { data, error } = await client
    .from('categories')
    .select('id, name, color, code, sort_order, is_active')
    .order('sort_order', { ascending: true })
  if (error) throw new Error(`Gagal membaca kategori: ${error.message}`)
  return (data ?? []) as CategoryRow[]
}

export async function createCategory(env: Env, input: Partial<CategoryRow>): Promise<CategoryRow> {
  validateCategory(input)
  const client = await createUncachedClient(env)
  const { data, error } = await client
    .from('categories')
    .insert({
      name: String(input.name).trim(),
      color: String(input.color ?? '#6366f1'),
      code: input.code ?? null,
      sort_order: Number(input.sort_order ?? 0),
      is_active: input.is_active ?? true,
    })
    .select()
    .maybeSingle()
  if (error) throw new Error(`Gagal membuat kategori: ${error.message}`)
  return data as CategoryRow
}

export async function updateCategory(
  env: Env,
  id: string,
  input: Partial<CategoryRow>,
): Promise<CategoryRow> {
  validateCategory(input)
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (input.name !== undefined) patch.name = String(input.name).trim()
  if (input.color !== undefined) patch.color = String(input.color)
  if (input.code !== undefined) patch.code = input.code
  if (input.sort_order !== undefined) patch.sort_order = input.sort_order
  if (input.is_active !== undefined) patch.is_active = input.is_active

  const client = await createUncachedClient(env)
  const { data, error } = await client
    .from('categories')
    .update(patch)
    .eq('id', id)
    .select()
    .maybeSingle()
  if (error) throw new Error(`Gagal memperbarui kategori: ${error.message}`)
  if (!data) throw new Error('Kategori tidak ditemukan.')
  return data as CategoryRow
}

/** Soft delete: kategori tetap ada untuk data lama, tapi tidak muncul lagi. */
export async function deactivateCategory(env: Env, id: string): Promise<CategoryRow> {
  return updateCategory(env, id, { is_active: false })
}

// ------------------------------------------------------- kelola akun

export interface UserListItem {
  id: string
  email: string
  role: 'owner' | 'admin'
  display_name: string | null
  is_active: boolean
  is_password_temporary: boolean
  last_login_at: string | null
  created_at: string
}

export async function listUsers(env: Env): Promise<UserListItem[]> {
  const client = await createUncachedClient(env)
  const { data, error } = await client
    .from('users')
    .select(
      'id, email, role, display_name, is_active, is_password_temporary, last_login_at, created_at',
    )
    .order('created_at', { ascending: true })
  if (error) throw new Error(`Gagal membaca akun: ${error.message}`)
  return (data ?? []) as UserListItem[]
}

export async function createUser(
  env: Env,
  input: { email: string; password: string; role: string; displayName?: string },
): Promise<UserListItem> {
  const email = input.email.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Format email tidak valid.')
  if (input.password.length < 8) throw new Error('Password minimal 8 karakter.')
  if (input.role !== 'owner' && input.role !== 'admin') {
    throw new Error('Role harus owner atau admin.')
  }

  const passwordHash = await hashPassword(input.password)
  const client = await createUncachedClient(env)

  const { data, error } = await client
    .from('users')
    .insert({
      email,
      password_hash: passwordHash,
      role: input.role,
      display_name: input.displayName ?? null,
      // Password baru dari owner SELALU sementara: admin wajib menggantinya
      // saat login pertama. Ini mencegah owner lupa dengan akun yang
      // dibuat lewat dashboard.
      is_password_temporary: true,
    })
    .select(
      'id, email, role, display_name, is_active, is_password_temporary, last_login_at, created_at',
    )
    .maybeSingle()

  if (error) {
    if (/duplicate key|already exists/i.test(error.message)) {
      throw new Error(`Email ${email} sudah terdaftar.`)
    }
    throw new Error(`Gagal membuat akun: ${error.message}`)
  }
  return data as UserListItem
}

/**
 * Reset password admin ke password sementara bawaan dan tandai sebagai
 * sementara.
 *
 * Password ini disengaja berupa konstanta di dalam kode (PRD scrambling
 * menyebutnya eksplisit), dan TIDAK PERNAH masuk ke respons maupun log â€”
 * frontend menampilkannya sebagai teks yang harus disampaikan ke admin
 * di depan. Admin wajib menggantinya saat login berikutnya.
 */
export async function resetUserPassword(env: Env, id: string): Promise<UserListItem> {
  const hash = await hashPassword(DEFAULT_TEMP_PASSWORD)
  const client = await createUncachedClient(env)

  const { data, error } = await client
    .from('users')
    .update({
      password_hash: hash,
      is_password_temporary: true,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select(
      'id, email, role, display_name, is_active, is_password_temporary, last_login_at, created_at',
    )
    .maybeSingle()

  if (error) throw new Error(`Gagal mereset password: ${error.message}`)
  if (!data) throw new Error('Akun tidak ditemukan.')

  // Cabut seluruh sesi lama agar reset benar-benar berlaku.
  await client.rpc('revoke_all_refresh_tokens', { p_user_id: id })

  return data as UserListItem
}

export async function setUserActive(
  env: Env,
  id: string,
  isActive: boolean,
  actingUserId: string,
): Promise<UserListItem> {
  if (id === actingUserId) {
    throw new Error('Anda tidak dapat menonaktifkan akun Anda sendiri.')
  }
  const client = await createUncachedClient(env)
  const { data, error } = await client
    .from('users')
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select(
      'id, email, role, display_name, is_active, is_password_temporary, last_login_at, created_at',
    )
    .maybeSingle()

  if (error) throw new Error(`Gagal mengubah status akun: ${error.message}`)
  if (!data) throw new Error('Akun tidak ditemukan.')
  if (!isActive) {
    await client.rpc('revoke_all_refresh_tokens', { p_user_id: id })
  }
  return data as UserListItem
}

/** Password sementara yang dipakai owner saat mereset akun admin. */
export const DEFAULT_TEMP_PASSWORD = '#Pass123'