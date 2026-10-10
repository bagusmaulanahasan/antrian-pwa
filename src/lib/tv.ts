/**
 * Pembaca data antrian untuk Dashboard TV.
 *
 * Berbeda dengan dashboard admin, TV tidak lewat Worker: ia membaca langsung
 * dari Supabase memakai anon key. Ini aman karena policy RLS hanya mengizinkan
 * SELECT — dan PRD memang begitu: TV tidak punya akun.
 *
 * Catatan: `queue_entries` harus masuk publication `supabase_realtime`
 * (lihat supabase/02_seed_and_fixes.sql). Tanpa itu `subscribe()` tetap
 * berhasil tetapi tidak pernah menerima event — gejala yang mudah
 * disalahartikan sebagai "realtime-nya rusak".
 */
import { getSupabase } from './supabase'

export type TvStatus = 'waiting' | 'serving' | 'pending' | 'done' | 'cancelled'

export interface TvEntry {
  id: string
  number: number
  customer_name: string
  category_id: string | null
  status: TvStatus
  priority: number
  queue_date: string
}

export interface TvCategory {
  id: string
  name: string
  color: string
}

export interface TvSnapshot {
  entries: TvEntry[]
  categories: TvCategory[]
  updatedAt: string
}

const SELECT_ENTRY =
  'id, number, customer_name, category_id, status, priority, queue_date'

/** Ambil seluruh data TV untuk satu tanggal. */
export async function fetchTvSnapshot(date: string): Promise<TvSnapshot> {
  const supabase = getSupabase()
  if (!supabase) {
    throw new Error('Supabase belum dikonfigurasi. Isi VITE_SUPABASE_URL di .env.')
  }

  const [queueRes, categoryRes] = await Promise.all([
    supabase.from('queue_entries').select(SELECT_ENTRY).eq('queue_date', date).limit(500),
    supabase.from('categories').select('id, name, color').eq('is_active', true),
  ])

  if (queueRes.error) throw new Error(`Gagal membaca antrian: ${queueRes.error.message}`)
  if (categoryRes.error) throw new Error(`Gagal membaca kategori: ${categoryRes.error.message}`)

  return {
    entries: (queueRes.data ?? []) as TvEntry[],
    categories: (categoryRes.data ?? []) as TvCategory[],
    updatedAt: new Date().toISOString(),
  }
}

export type ConnectionState = 'connecting' | 'live' | 'polling' | 'error'

export interface SubscriptionHandle {
  unsubscribe(): Promise<void>
}

/**
 * Berlangganan perubahan antrian.
 *
 * Strategi ganda: Realtime kalau tersedia, polling sebagai jaring pengaman.
 * Realtime prone terputus di TV yang menyala seharian (Wi-Fi-strengthEnabled
 * tidak ada di TV kabus), jadi polling 15 detik tetap dipertahankan.
 */
export function subscribeToQueue(
  date: string,
  onChange: (payload: { source: 'realtime' | 'poll' }) => void,
  onState: (state: ConnectionState) => void,
): SubscriptionHandle {
  const supabase = getSupabase()
  if (!supabase) {
    onState('error')
    return { unsubscribe: async () => {} }
  }

  onState('connecting')
  const channel = supabase.channel(`tv-queue-${date}`)

  channel.on(
    'postgres_changes',
    { event: '*', schema: 'public', table: 'queue_entries' },
    () => onChange({ source: 'realtime' }),
  )

  void channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      onState('live')
      // Muat sekali setelah berhasil berlangganan supaya layar tidak kosong
      // selama menunggu perubahan pertama.
      onChange({ source: 'realtime' })
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      onState('polling')
    }
  })

  // Realtime bisa "diam": tidak error, juga tidak SUBSCRIBED —misalnya saat
  // `queue_entries` belum masuk publication, atau WebSocket di-block firewall.
  // Tanpa jeda ini, badge akan menampilkan "Menghubungkan…" selamanya padahal
  // polling sedang bekerja. Batas waktu membuat pengguna melihat kondisi
  // sebenarnya: data tetap masuk, hanya lewat penyegaran berkala.
  const fallbackTimer = setTimeout(() => {
    if (channel.state !== 'joined') onState('polling')
  }, 6000)

  // Jaring pengaman: tetap polling meski Realtime sudah tersambung.
  const pollTimer = setInterval(() => {
    void (async () => {
      try {
        onChange({ source: 'poll' })
      } catch {
        onState('error')
      }
    })()
  }, 15_000)

  // Halaman TV boleh di-muat dalam keadaan tersembunyi; polling saat tab tidak
  // aktif hanya memboroskan daya tanpa manfaat.
  const onVisibility = () => {
    if (document.visibilityState === 'visible') onChange({ source: 'poll' })
  }
  document.addEventListener('visibilitychange', onVisibility)

  return {
    async unsubscribe() {
      clearTimeout(fallbackTimer)
      clearInterval(pollTimer)
      document.removeEventListener('visibilitychange', onVisibility)
      await supabase.removeChannel(channel)
    },
  }
}