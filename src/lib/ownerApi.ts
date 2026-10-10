/**
 * Klien API pengaturan Owner (frontend).
 */

import { apiRequest, type ApiBase } from './api'

export interface Category {
  id: string
  name: string
  color: string
  code: string | null
  sort_order: number
  is_active: boolean
}

export interface OwnerUser {
  id: string
  email: string
  role: 'owner' | 'admin'
  display_name: string | null
  is_active: boolean
  is_password_temporary: boolean
  last_login_at: string | null
  created_at: string
}

export interface PrintTemplate {
  placeName?: string
  address?: string
  phone?: string
  logoUrl?: string | null
  template: string
}

export interface VoiceTemplate {
  text: string
  rate: number
  volume: number
  repeat: number
}

export interface SettingsBundle {
  reset_hour?: number
  print_template?: PrintTemplate
  voice_template?: VoiceTemplate
  tv_pin_hash?: string | null
}

const get = (): ApiBase => ({ method: 'GET' })

// ------------------------------------------------------------ kategori
export function fetchOwnerCategories() {
  return apiRequest<{ categories: Category[] }>('/api/admin/categories', get())
}

export function createCategory(input: {
  name: string
  color: string
  code?: string | null
  sort_order?: number
}) {
  return apiRequest<{ category: Category }>('/api/admin/categories', {
    method: 'POST',
    body: input,
  })
}

export function updateCategory(id: string, input: Partial<Category>) {
  return apiRequest<{ category: Category }>(`/api/admin/categories/${id}`, {
    method: 'PATCH',
    body: input,
  })
}

export function deactivateCategory(id: string) {
  return apiRequest<{ category: Category }>(`/api/admin/categories/${id}`, {
    method: 'DELETE',
  })
}

// ------------------------------------------------------------ pengaturan
export function fetchSettings() {
  return apiRequest<{ settings: SettingsBundle }>('/api/settings', get())
}

export function saveSetting(key: string, value: unknown) {
  return apiRequest<{ setting: { key: string; value: unknown } }>('/api/settings', {
    method: 'PATCH',
    body: { key, value },
  })
}

// ------------------------------------------------------------ akun
export function fetchUsers() {
  return apiRequest<{ users: OwnerUser[] }>('/api/admin/users', get())
}

export function createUser(input: {
  email: string
  password: string
  role: 'owner' | 'admin'
  displayName?: string
}) {
  return apiRequest<{ user: OwnerUser; temporaryPassword: string }>('/api/admin/users', {
    method: 'POST',
    body: input,
  })
}

export function resetUserPassword(id: string) {
  return apiRequest<{ user: OwnerUser; temporaryPassword: string }>(
    `/api/admin/users/${id}/reset-password`,
    { method: 'POST' },
  )
}

export function setUserActive(id: string, isActive: boolean) {
  return apiRequest<{ user: OwnerUser }>(`/api/admin/users/${id}/active`, {
    method: 'POST',
    body: { isActive },
  })
}