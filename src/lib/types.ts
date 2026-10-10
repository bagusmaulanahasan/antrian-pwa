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
/**
 * Tanggal antrian aktif (WIB).
 *
 * `now` boleh berupa Date atau string ISO — parameter `now` pada test
 * multibahasa perlu deterministik.
 */
export function getQueueDate(resetHour = 0, now: Date | string = new Date()): string {
  // Reset jam di luar 0..23 berarti data rusak. Tanpa clamp di sini, nilai
  // seperti 99 akan membuat perbandingan `jam < 99` selalu benar dan
  // antrian tampak bergeser satu hari, tanpa error apa pun.
  const hour =
    Number.isFinite(resetHour) && resetHour >= 0 && resetHour <= 23 ? Math.floor(resetHour) : 0

  const base = typeof now === 'string' ? new Date(now) : now
  const wib = new Date(base.getTime() + 7 * 60 * 60 * 1000)

  if (hour > 0 && wib.getUTCHours() < hour) {
    wib.setUTCDate(wib.getUTCDate() - 1)
  }
  return wib.toISOString().slice(0, 10)
}