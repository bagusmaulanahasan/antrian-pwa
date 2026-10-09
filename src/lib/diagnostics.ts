import { initSupabase, resetSupabaseForDiagnostics } from './supabase'
import { envStatus } from './supabaseConfig'

export type CheckStatus = 'pending' | 'running' | 'pass' | 'warn' | 'fail' | 'skip'

export interface CheckResult {
  key: string
  name: string
  status: CheckStatus
  detail: string
  data?: Record<string, unknown>
  errorCode?: string
  hint?: string
}

export interface DiagnosticReport {
  ok: boolean
  checkedAt: string
  results: CheckResult[]
}

function describeError(err: unknown): { message: string; code?: string } {
  if (typeof err === 'object' && err !== null) {
    const e = err as { message?: unknown; code?: unknown }
    return {
      message: typeof e.message === 'string' ? e.message : JSON.stringify(err),
      code: typeof e.code === 'string' ? e.code : undefined,
    }
  }
  return { message: String(err) }
}

/** Petakan error PostgREST / jaringan ke petunjuk perbaikan yang konkret. */
function hintForError(code: string | undefined, message: string): string | undefined {
  const m = message.toLowerCase()
  switch (code) {
    case 'PGRST301':
      return 'JWT ditolak. API key tidak cocok dengan project pada VITE_SUPABASE_URL.'
    case '42501':
      return 'Akses ditolak oleh RLS. Policy SELECT untuk role anon belum dibuat di schema.sql.'
    case '42P01':
      return 'Relasi tidak ada. Tabel belum dibuat — jalankan schema.sql di Supabase SQL Editor.'
    case '42703':
      return 'Kolom tidak ada. Schema di project berbeda dari schema.sql atau migrasi belum lengkap.'
    case 'PGRST205':
      return 'Kolom tidak ditemukan di tabel. Periksa apakah schema.sql versi terbaru sudah dijalankan.'
    default:
      break
  }
  if (m.includes('failed to fetch') || m.includes('networkerror') || m.includes('load failed')) {
    return 'Request tidak sampai ke server. Periksa URL, koneksi internet, dan CORS (Dashboard > API > CORS).'
  }
  if (m.includes('jwt') || m.includes('signature')) {
    return 'API key tidak valid untuk project ini. Salin ulang anon key dari Dashboard > API.'
  }
  if (m.includes('does not exist')) {
    return 'Object database tidak ditemukan. Pastikan schema.sql sudah dijalankan lengkap.'
  }
  return undefined
}

const pass = (key: string, name: string, detail: string, data?: Record<string, unknown>): CheckResult => ({
  key,
  name,
  status: 'pass',
  detail,
  ...(data ? { data } : {}),
})

const fail = (
  key: string,
  name: string,
  detail: string,
  errorCode?: string,
  hint?: string,
): CheckResult => ({
  key,
  name,
  status: 'fail',
  detail,
  ...(errorCode ? { errorCode } : {}),
  ...(hint ? { hint } : {}),
})

const warn = (key: string, name: string, detail: string, hint?: string): CheckResult => ({
  key,
  name,
  status: 'warn',
  detail,
  ...(hint ? { hint } : {}),
})

const skip = (key: string, name: string, detail: string, hint?: string): CheckResult => ({
  key,
  name,
  status: 'skip',
  detail,
  ...(hint ? { hint } : {}),
})

/**
 * Jalankan rangkaian pemeriksaan koneksi Supabase.
 *
 * Setiap pemeriksaan independen — kegagalan satu tidak menghentikan yang lain,
 * sehingga laporan menampilkan SELURUH masalah dalam satu kali jalan.
 */
export async function runConnectionDiagnostics(): Promise<DiagnosticReport> {
  const results: CheckResult[] = []
  const stamp = () => new Date().toISOString()

  // --- 1. Environment ---
  const envPass = envStatus.problems.length === 0
  results.push(
    envPass
      ? pass('env', 'Konfigurasi environment (.env)', 'URL dan anon key terbaca valid.', {
          'VITE_SUPABASE_URL': envStatus.url,
          'VITE_SUPABASE_ANON_KEY': `${envStatus.anonKey.slice(0, 8)}•••• (${envStatus.anonKey.length} karakter)`,
          'VITE_API_BASE_URL': envStatus.apiBaseUrl || '(kosong)',
          Mode: envStatus.isDev ? 'development' : 'production',
        })
      : fail(
          'env',
          'Konfigurasi environment (.env)',
          envStatus.problems.join(' '),
          undefined,
          envStatus.hints[0],
        ),
  )
  if (!envPass) return { ok: false, checkedAt: stamp(), results }

  // --- 2. Inisialisasi klien ---
  resetSupabaseForDiagnostics()
  const { client, error: initError } = initSupabase()
  results.push(
    client
      ? pass('init', 'Inisialisasi Supabase client', 'Klien berhasil dibuat dengan anon key.')
      : fail('init', 'Inisialisasi Supabase client', initError ?? 'Gagal membuat klien.'),
  )
  if (!client) return { ok: false, checkedAt: stamp(), results }

  // --- 3. Keterjangkauan REST API ---
  // PENTING: endpoint root `/rest/v1/` membalas 401 pada project Supabase modern
  // karena spec OpenAPI-nya butuh permission lebih tinggi. itu BUKAN tanda
  // kegagalan konfigurasi — selama server merespons, jaringan kita baik.
  // Yang dianggap gagal hanyalah kegagalan jaringan (TypeError / timeout).
  const restUrl = `${envStatus.url}/rest/v1/`
  const t0 = performance.now()
  try {
    const res = await fetch(restUrl, { headers: { apikey: envStatus.anonKey } })
    const ms = Math.round(performance.now() - t0)
    const reachable = true
    const note =
      res.status === 401
        ? ' Server menolak spec root (normal) — keterjangkauan tetap terkonfirmasi.'
        : ''
    results.push(
      reachable
        ? {
            key: 'reachability',
            name: 'Keterjangkauan REST API',
            status: res.status >= 500 ? 'fail' : 'pass',
            detail: `HTTP ${res.status} dalam ${ms} ms dari ${restUrl}.${note}`,
            hint:
              res.status >= 500
                ? 'Server Supabase mengembalikan 5xx. Cek status project di Dashboard.'
                : undefined,
            data: { url: restUrl, httpStatus: res.status, latencyMs: ms },
          }
        : fail(
            'reachability',
            'Keterjangkauan REST API',
            `HTTP ${res.status} dalam ${ms} ms.`,
            undefined,
            'Cek API key dan status project.',
          ),
    )
    if (res.status >= 500) return { ok: false, checkedAt: stamp(), results }
  } catch (err) {
    const { message } = describeError(err)
    results.push(
      fail(
        'reachability',
        'Keterjangkauan REST API',
        `${restUrl} tidak bisa dihubungi — ${message}`,
        undefined,
        hintForError(undefined, message),
      ),
    )
    return { ok: false, checkedAt: stamp(), results }
  }

  // --- 4. categories (RLS SELECT) ---
  try {
    const { data, error } = await client
      .from('categories')
      .select('id, name, color, sort_order, is_active')
      .limit(5)
    if (error) throw error
    const rows = (data ?? []) as unknown[]
    results.push(
      pass(
        'categories',
        'Tabel `categories` (RLS SELECT)',
        rows.length > 0
          ? `Berhasil membaca ${rows.length} baris. Policy SELECT untuk anon bekerja.`
          : 'Tabel dapat dibaca tetapi kosong. Belum ada kategori — wajar pada project baru.',
        { rowsReturned: rows.length, sample: data ?? [] },
      ),
    )
  } catch (err) {
    const { message, code } = describeError(err)
    results.push(
      fail('categories', 'Tabel `categories` (RLS SELECT)', message, code, hintForError(code, message)),
    )
  }

  // --- 5. queue_entries ---
  try {
    const { data, error } = await client
      .from('queue_entries')
      .select('id, queue_date, number, customer_name, status, print_status')
      .limit(5)
    if (error) throw error
    const rows = (data ?? []) as unknown[]
    results.push(
      pass('queue', 'Tabel `queue_entries`', `Berhasil membaca ${rows.length} baris.`, {
        rowsReturned: rows.length,
        sample: data ?? [],
      }),
    )
  } catch (err) {
    const { message, code } = describeError(err)
    results.push(fail('queue', 'Tabel `queue_entries`', message, code, hintForError(code, message)))
  }

  // --- 6. settings ---
  try {
    const { data, error } = await client.from('settings').select('key, updated_at').limit(10)
    if (error) throw error
    const rows = (data ?? []) as unknown as { key: string }[]
    if (rows.length > 0) {
      results.push(
        pass('settings', 'Tabel `settings`', `${rows.length} pengaturan terbaca.`, {
          keys: rows.map((r) => r.key),
        }),
      )
    } else {
      results.push(
        warn(
          'settings',
          'Tabel `settings`',
          'Tabel dapat dibaca tetapi kosong. Seed default di schema.sql belum dijalankan.',
          'Jalankan blok INSERT settings di schema.sql, atau isi lewat dashboard Owner.',
        ),
      )
    }
  } catch (err) {
    const { message, code } = describeError(err)
    results.push(fail('settings', 'Tabel `settings`', message, code, hintForError(code, message)))
  }

  // --- 7. RLS harus MENOLAK insert dari anon ---
  try {
    const probeName = `__diagnostic_${Date.now()}`
    const { error } = await client
      .from('queue_entries')
      .insert({
        queue_date: '1970-01-01',
        number: 999999,
        customer_name: probeName,
        print_status: 'pending',
      })
      .select()
    results.push(
      error
        ? pass(
            'rls-write',
            'Proteksi RLS (insert harus ditolak)',
            `INSERT dari anon key ditolak seperti seharusnya: ${error.message}${
              error.code ? ` [${error.code}]` : ''
            }`,
            { code: error.code },
          )
        : fail(
            'rls-write',
            'Proteksi RLS (insert harus ditolak)',
            'INSERT dari anon key BERHASIL. RLS tidak menutup jalur tulis — siapa pun bisa membuat antrian.',
            undefined,
            'Jalankan `revoke insert on queue_entries from anon;` dan pasang policy INSERT hanya untuk role authenticated.',
          ),
    )
  } catch (err) {
    const { message } = describeError(err)
    results.push(
      warn(
        'rls-write',
        'Proteksi RLS (insert harus ditolak)',
        `Permintaan tulis gagal di level jaringan: ${message}`,
        'Tidak dapat memastikan aturan RLS dari browser.',
      ),
    )
  }

  // --- 8. Realtime ---
  try {
    const channelName = `diagnostics-${Date.now()}`
    const channel = client.channel(channelName)
    const tJoin = performance.now()
    const joined = await Promise.race([
      new Promise<boolean>((resolve) => {
        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED') resolve(true)
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') resolve(false)
        })
      }),
      new Promise<boolean>((r) => setTimeout(() => r(false), 8000)),
    ])
    const joinMs = Math.round(performance.now() - tJoin)
    await client.removeChannel(channel)

    results.push(
      joined
        ? warn(
            'realtime',
            'Realtime subscription',
            `Berhasil SUBSCRIBE dalam ${joinMs} ms. Event belum diterima — normal bila tidak ada perubahan data saat pemeriksaan.`,
            'Pastikan tabel masuk publication: select * from pg_publication_tables where pubname = \'supabase_realtime\';',
          )
        : warn(
            'realtime',
            'Realtime subscription',
            `Tidak berhasil SUBSCRIBE dalam ${joinMs} ms. Dashboard TV tidak akan sinkron real-time.`,
            'Jalankan: alter publication supabase_realtime add table queue_entries;',
          ),
    )
  } catch (err) {
    const { message } = describeError(err)
    results.push(
      warn(
        'realtime',
        'Realtime subscription',
        `Realtime tidak bisa diuji: ${message}`,
        'Pastikan modul realtime termuat dan tabel masuk publication supabase_realtime.',
      ),
    )
  }

  // --- 8b. Kebocoran grant RPC ---
  // Postgres memberi EXECUTE default ke PUBLIC pada function baru. `security
  // definer` + default tersebut berarti anon bisa memanggil RPC yang seharusnya
  // hanya untuk authenticated/service_role (lihat schema.sql baris `grant execute`).
  const rpcFn = 'next_queue_number'
  try {
    const res = await fetch(`${envStatus.url}/rest/v1/rpc/${rpcFn}`, {
      method: 'POST',
      headers: {
        apikey: envStatus.anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_date: '1970-01-01' }),
    })
    if (res.ok) {
      results.push(
        fail(
          'rpc-grant',
          'Grant RPC (harus menutup untuk anon)',
          `POST /rpc/${rpcFn} dengan anon key BERHASIL (HTTP ${res.status}). ` +
            'Function ini terbuka untuk publik — siapa pun bisa memanggilnya.',
          undefined,
          'Tambahkan `revoke execute on function next_queue_number(date) from public;` lalu ' +
            'grant hanya ke authenticated dan service_role (lihat schema.sql).',
        ),
      )
    } else {
      results.push(
        pass(
          'rpc-grant',
          'Grant RPC (harus menutup untuk anon)',
          `POST /rpc/${rpcFn} ditolak dengan HTTP ${res.status}. Function hanya untuk role berwenang.`,
          { httpStatus: res.status },
        ),
      )
    }
  } catch (err) {
    const { message } = describeError(err)
    results.push(
      warn(
        'rpc-grant',
        'Grant RPC (harus menutup untuk anon)',
        `Tidak dapat menguji grant RPC: ${message}`,
      ),
    )
  }

  // --- 9. Auth health ---
  try {
    const res = await fetch(`${envStatus.url}/auth/v1/health`, {
      headers: { apikey: envStatus.anonKey },
    })
    results.push(
      res.ok
        ? pass('auth-health', 'Supabase Auth health', 'Endpoint /auth/v1/health merespons normal.')
        : warn(
            'auth-health',
            'Supabase Auth health',
            `HTTP ${res.status} dari /auth/v1/health.`,
            'Umumnya auth nonaktif pada project lama — aktifkan di Dashboard > Authentication > Providers > Email.',
          ),
    )
  } catch (err) {
    const { message } = describeError(err)
    results.push(warn('auth-health', 'Supabase Auth health', `Tidak dapat menghubungi /auth/v1/health: ${message}`))
  }

  // --- 10. Cloudflare Worker ---
  if (!envStatus.apiBaseUrl) {
    results.push(
      skip(
        'worker',
        'Cloudflare Worker (API auth)',
        'VITE_API_BASE_URL kosong — Worker belum dikonfigurasi.',
        'Isi VITE_API_BASE_URL setelah Worker di-deploy. Fitur login belum aktif tanpa itu.',
      ),
    )
  } else {
    const healthUrl = `${envStatus.apiBaseUrl.replace(/\/+$/, '')}/api/health`
    try {
      const res = await fetch(healthUrl)
      results.push(
        res.ok
          ? pass('worker', 'Cloudflare Worker (API auth)', `GET ${healthUrl} → HTTP ${res.status}.`)
          : warn('worker', 'Cloudflare Worker (API auth)', `GET ${healthUrl} → HTTP ${res.status}.`, 'Pastikan Worker memiliki route /api/health.'),
      )
    } catch (err) {
      const { message } = describeError(err)
      results.push(warn('worker', 'Cloudflare Worker (API auth)', `Worker tidak bisa dihubungi: ${message}`))
    }
  }

  const ok = !results.some((r) => r.status === 'fail')
  return { ok, checkedAt: stamp(), results }
}

/** Ringkasan satu kalimat untuk banner utama. */
export function summarize(report: DiagnosticReport): string {
  if (report.ok) return 'Supabase terhubung dan siap dipakai.'
  const fails = report.results.filter((r) => r.status === 'fail')
  const warns = report.results.filter((r) => r.status === 'warn')
  const parts = [`${fails.length} pemeriksaan gagal`]
  if (warns.length) parts.push(`${warns.length} peringatan`)
  return `Belum sepenuhnya terhubung — ${parts.join(', ')}.`
}

/** Petunjuk awal bila env kosong, ditampilkan sebelum pengguna menekan tombol. */
export function preflightHint(): string | null {
  if (envStatus.problems.length === 0) return null
  return envStatus.hints[0] ?? envStatus.problems[0] ?? null
}