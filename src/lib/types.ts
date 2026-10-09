/** Tipe baris database — cerminan schema.sql */

export type UserRole = 'owner' | 'admin'
export type QueueStatus = 'waiting' | 'serving' | 'pending' | 'done' | 'cancelled'
export type PrintStatus = 'printed' | 'pending' | 'failed'

export interface Category {
  id: string
  name: string
  color: string
  code: string | null
  sort_order: number
  is_active: boolean
  created_at: string
  updated_at: string
}

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
  served_by: string | null
  completed_at: string | null
  cancelled_at: string | null
  recalled_at: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface SettingRow {
  key: string
  value: unknown
  updated_at: string
  updated_by: string | null
}

/** Tanggal antrian aktif (WIB), mengikuti jam reset harian. */
export function getQueueDate(resetHour = 0, now = new Date()): string {
  const wibOffsetMs = 7 * 60 * 60 * 1000
  const wib = new Date(now.getTime() + wibOffsetMs)
  if (resetHour > 0 && wib.getUTCHours() < resetHour) {
    wib.setUTCDate(wib.getUTCDate() - 1)
  }
  return wib.toISOString().slice(0, 10)
}