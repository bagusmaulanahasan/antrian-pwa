/**
 * API operasional antrian (Worker).
 *
 * Semua penulisan database terjadi DI SINI memakai service_role, bukan dari
 * browser. Alasannya:
 *   - policy RLS menolak anon menulis, jadi frontend tidak bisa langsung
 *     INSERT ke `queue_entries`
 *   - perubahan status punya aturan bisnis (mis. hanya boleh ada satu
 *     `serving` per hari) yang tidak bisa dijamin dari sisi klien
 *
 * Operasi memakai `service_role`, yang melewati RLS sepenuhnya — sehingga
 * INSERT/UPDATE langsung ke PostgREST berhasil tanpa bergantung pada policy.
 */
import type { Env } from './http'
import { createUncachedClient } from './supabaseAdmin'

export interface QueueEntry {
  id: string
  queue_date: string
  number: number
  customer_name: string
  category_id: string | null
  status: 'waiting' | 'serving' | 'pending' | 'done' | 'cancelled'
  priority: number
  print_status: 'printed' | 'pending' | 'failed'
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

export interface QueueActionResult {
  ok: boolean
  entry?: QueueEntry
  entries?: QueueEntry[]
  error?: string
}

/** Tanggal antrian aktif (WIB), mengikuti jam reset harian. */
export function getQueueDate(resetHour: number, now = new Date()): string {
  const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000)
  if (resetHour > 0 && wib.getUTCHours() < resetHour) {
    wib.setUTCDate(wib.getUTCDate() - 1)
  }
  return wib.toISOString().slice(0, 10)
}

type Client = Awaited<ReturnType<typeof createUncachedClient>>

/** Ambil nilai reset_hour dari tabel settings (default 0). */
async function getResetHour(client: Client): Promise<number> {
  const { data } = await client.from('settings').select('value').eq('key', 'reset_hour').maybeSingle()
  const raw = (data as { value?: unknown } | null)?.value
  const n = typeof raw === 'number' ? raw : Number(raw ?? 0)
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : 0
}

/** Daftar kategori aktif, urut. */
export async function listCategories(env: Env): Promise<unknown[]> {
  const client = await createUncachedClient(env)
  const { data, error } = await client
    .from('categories')
    .select('id, name, color, code, sort_order, is_active')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
  if (error) throw new Error(`Gagal membaca kategori: ${error.message}`)
  return data ?? []
}

/**
 * Daftar antrian untuk satu tanggal.
 * `priority desc, number asc` membuat nomor yang diprioritaskan (panggil
 * ulang) muncul paling atas.
 */
export async function listQueue(
  env: Env,
  date?: string,
): Promise<{ date: string; entries: QueueEntry[]; counts: Record<string, number> }> {
  const client = await createUncachedClient(env)
  const queueDate = date ?? getQueueDate(await getResetHour(client))
  const { data, error } = await client
    .from('queue_entries')
    .select(
      'id, queue_date, number, customer_name, category_id, status, priority, print_status, printed_at, print_attempts, served_at, served_by, completed_at, cancelled_at, recalled_at, notes, created_at, updated_at',
    )
    .eq('queue_date', queueDate)
    .order('priority', { ascending: false })
    .order('number', { ascending: true })

  if (error) throw new Error(`Gagal membaca antrian: ${error.message}`)

  const entries = (data ?? []) as QueueEntry[]
  const counts: Record<string, number> = {
    waiting: 0,
    serving: 0,
    pending: 0,
    done: 0,
    cancelled: 0,
  }
  for (const e of entries) counts[e.status] = (counts[e.status] ?? 0) + 1

  return { date: queueDate, entries, counts }
}

/**
 * Tambah satu antrian.
 *
 * Memakai RPC `create_queue_entry` supaya penomoran tetap atomik — kalau
 * angka dihitung dari aplikasi, dua admin yang klik bersamaan bisa mendapat
 * nomor sama.
 */
export async function createQueueEntry(
  env: Env,
  input: { customerName: string; categoryId: string | null; printStatus?: string },
): Promise<QueueEntry> {
  const client = await createUncachedClient(env)
  const date = getQueueDate(await getResetHour(client))
  const printStatus = input.printStatus === 'printed' ? 'printed' : 'pending'

  const { data, error } = await client.rpc('create_queue_entry', {
    p_customer_name: input.customerName,
    p_category_id: input.categoryId,
    p_queue_date: date,
    p_print_status: printStatus,
  })

  if (error) throw new Error(`Gagal membuat antrian: ${error.message}`)
  if (!data) throw new Error('Fungsi create_queue_entry tidak mengembalikan data.')
  return data as QueueEntry
}

/** Perbarui status cetak — dipakai saat tiket berhasil dicetak ulang. */
export async function markPrinted(env: Env, id: string, printed: boolean): Promise<QueueEntry> {
  const client = await createUncachedClient(env)
  const { data, error } = await client
    .from('queue_entries')
    .update(
      printed
        ? { print_status: 'printed', printed_at: new Date().toISOString() }
        : { print_status: 'failed' },
    )
    .eq('id', id)
    .select()
    .single()
  if (error) throw new Error(`Gagal memperbarui status cetak: ${error.message}`)
  return data as QueueEntry
}

/**
 * Tandai nomor `serving` yang ada sebagai selesai, lalu ambil yang berikutnya.
 *
 * Aturan bisnis dari PRD: hanya boleh ada SATU nomor serving aktif per hari.
 * Index unik parsial `idx_queue_single_serving` menegakkan ini di level
 * database, jadi urutan operasi di sini penting: selesaikan dulu yang lama,
 * baru promoting yang baru.
 */
export async function callNext(
  env: Env,
  userId: string,
): Promise<QueueActionResult> {
  const client = await createUncachedClient(env)
  const date = getQueueDate(await getResetHour(client))

  // Selesaikan nomor serving yang sedang berjalan (bila ada).
  const { error: completeError } = await client
    .from('queue_entries')
    .update({ status: 'done', completed_at: new Date().toISOString() })
    .eq('queue_date', date)
    .eq('status', 'serving')
  if (completeError) return { ok: false, error: `Gagal menyelesaikan nomor sebelumnya: ${completeError.message}` }

  // Ambil waiting paling atas. Nomor dengan priority > 0 (panggil ulang)
  // didahulukan lewat urutan query.
  const { data: next, error: nextError } = await client
    .from('queue_entries')
    .update({ status: 'serving', served_at: new Date().toISOString(), served_by: userId })
    .eq('queue_date', date)
    .eq('status', 'waiting')
    .order('priority', { ascending: false })
    .order('number', { ascending: true })
    .limit(1)
    .select()
    .maybeSingle()

  if (nextError) return { ok: false, error: `Gagal mengambil nomor berikutnya: ${nextError.message}` }
  if (!next) return { ok: true, entry: undefined }

  return { ok: true, entry: next as QueueEntry }
}

/** Ubah status satu nomor. */
export async function setStatus(
  env: Env,
  id: string,
  status: QueueEntry['status'],
  userId?: string,
): Promise<QueueActionResult> {
  const client = await createUncachedClient(env)
  const now = new Date().toISOString()

  const patch: Record<string, unknown> = { status, updated_at: now }
  if (status === 'serving') {
    patch.served_at = now
    if (userId) patch.served_by = userId
  } else if (status === 'done') patch.completed_at = now
  else if (status === 'cancelled') patch.cancelled_at = now

  const { data, error } = await client
    .from('queue_entries')
    .update(patch)
    .eq('id', id)
    .select()
    .maybeSingle()

  if (error) return { ok: false, error: `Gagal mengubah status: ${error.message}` }
  if (!data) return { ok: false, error: 'Nomor antrian tidak ditemukan.' }
  return { ok: true, entry: data as QueueEntry }
}

/**
 * Panggil ulang: kembalikan nomor ke `waiting` dengan prioritas tinggi
 * supaya muncul paling atas di daftar.
 */
export async function recall(
  env: Env,
  id: string,
): Promise<QueueActionResult> {
  const client = await createUncachedClient(env)
  const { data, error } = await client
    .from('queue_entries')
    .update({
      status: 'waiting',
      priority: 1,
      recalled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .maybeSingle()

  if (error) return { ok: false, error: `Gagal memanggil ulang: ${error.message}` }
  if (!data) return { ok: false, error: 'Nomor antrian tidak ditemukan.' }
  return { ok: true, entry: data as QueueEntry }
}