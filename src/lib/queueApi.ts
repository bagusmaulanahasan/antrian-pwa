/**
 * Klien API antrian (frontend).
 *
 * Semua operasi tulis lewat Worker — bukan langsung ke Supabase — karena
 * policy RLS menutup jalur tulis untuk anon, dan aturan bisnis (satu nomor
 * serving, penomoran atomik) hanya bisa dijamin di server.
 */

import { apiRequest, ApiError, type ApiBase } from './api'

export type QueueStatus = 'waiting' | 'serving' | 'pending' | 'done' | 'cancelled'
export type PrintStatus = 'printed' | 'pending' | 'failed'

export interface QueueEntry {
  id: string
  queue_date: string
  number: number
  customer_name: string
  category_id: string | null
  status: QueueStatus
  priority: number
  print_status: PrintStatus
  printed_at: string | null
  print_attempts: number
  served_at: string | null
  completed_at: string | null
  recalled_at: string | null
  created_at: string
  updated_at: string
}

export interface Category {
  id: string
  name: string
  color: string
  code: string | null
  sort_order: number
  is_active: boolean
}

export interface QueueSnapshot {
  date: string
  entries: QueueEntry[]
  counts: Record<QueueStatus, number>
}

const base = (): ApiBase => ({ method: 'GET' })

export function fetchQueue(date?: string) {
  const qs = date ? `?date=${encodeURIComponent(date)}` : ''
  return apiRequest<QueueSnapshot>(`/api/queue${qs}`, base())
}

export function fetchCategories() {
  return apiRequest<{ categories: Category[] }>('/api/queue/categories', base())
}

export function createQueueEntry(input: {
  customerName: string
  categoryId: string | null
  printStatus?: PrintStatus
}) {
  return apiRequest<{ entry: QueueEntry }>('/api/queue', {
    method: 'POST',
    body: input,
  })
}

export function callNext() {
  return apiRequest<{ ok: boolean; entry?: QueueEntry }>('/api/queue/next', {
    method: 'POST',
  })
}

export function setQueueStatus(id: string, status: QueueStatus) {
  return apiRequest<{ entry: QueueEntry }>(`/api/queue/${id}`, {
    method: 'PATCH',
    body: { status },
  })
}

export function recallEntry(id: string) {
  return apiRequest<{ entry: QueueEntry }>(`/api/queue/${id}/recall`, {
    method: 'POST',
  })
}

export function markPrinted(id: string, printed: boolean) {
  return apiRequest<{ entry: QueueEntry }>(`/api/queue/${id}/print`, {
    method: 'POST',
    body: { printed },
  })
}

/** Label status dalam Bahasa Indonesia, untuk UI. */
export const STATUS_LABEL: Record<QueueStatus, string> = {
  waiting: 'Menunggu',
  serving: 'Dilayani',
  pending: 'Pending',
  done: 'Selesai',
  cancelled: 'Dibatalkan',
}

/** Kelas warna badge per status. */
export const STATUS_CLASS: Record<QueueStatus, string> = {
  waiting: 'bg-amber-100 text-amber-800 ring-amber-600/20',
  serving: 'bg-indigo-100 text-indigo-800 ring-indigo-600/20',
  pending: 'bg-purple-100 text-purple-800 ring-purple-600/20',
  done: 'bg-emerald-100 text-emerald-800 ring-emerald-600/20',
  cancelled: 'bg-slate-100 text-slate-600 ring-slate-500/20',
}

export { ApiError }