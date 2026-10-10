/**
 * Mock Supabase REST/Auth untuk menguji jalur kode diagnostik tanpa project nyata.
 *
 * Menghormati toggle lewat query/header:
 *   - FORCE_RLS_ERROR=1   â†’ SELECT ditolak 42501 (simulasikan policy SELECT hilang)
 *   - FORCE_MISSING_TABLE=1 â†’ SELECT ditolak 42P01 (tabel belum dibuat)
 *
 * Jalankan: node scripts/mock-supabase.mjs
 */
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEST_HASH, TEST_PASSWORD } from './test-fixtures.mjs'

const PORT = Number(process.env.MOCK_PORT ?? 54321)
// Bentuk JWT agar lolos validasi bentuk di frontend (3 bagian dipisah titik).
const ANON = process.env.MOCK_ANON_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.bW9jay1zaWduYXR1cmU'

/**
 * State in-memory. Seed sengaja dibuat realistis: satu owner dengan password
 * permanen, satu admin dengan password sementara, satu akun nonaktif.
* `password_hash` memakai argon2id dari TEST_PASSWORD (lihat test-fixtures.mjs).
 */
/**
 * UUID v4 semu. Wajib berbentuk UUID supaya mock mencerminkan skema Postgres
 * — route Worker memvalidasi format id sebelum meneruskan.
 */
let uuidSeq = 0
function newUuid() {
  uuidSeq++
  const hex = uuidSeq.toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${hex}`
}

const mockState = {
  queueEntries: [],
  settings: [
    { key: 'reset_hour', value: 0, updated_at: '2026-10-09T00:00:00.000Z', updated_by: null },
    { key: 'tv_pin_hash', value: null, updated_at: '2026-10-09T00:00:00.000Z', updated_by: null },
    {
      key: 'print_template',
      value: {
        placeName: 'Nama Tempat',
        address: 'Alamat Lokasi',
        phone: '',
        logoUrl: null,
        template:
          '{tempat}\\n{alamat}\\n\\nNomor: {nomor}\\nNama: {nama}\\nKategori: {kategori}\\n{tanggal}',
      },
      updated_at: '2026-10-09T00:00:00.000Z',
      updated_by: null,
    },
    {
      key: 'voice_template',
      value: {
        text: 'Nomor antrian {nomor}, atas nama {nama}, kategori {kategori}, silakan menuju ke depan.',
        rate: 1.0,
        volume: 1.0,
        repeat: 1,
      },
      updated_at: '2026-10-09T00:00:00.000Z',
      updated_by: null,
    },
  ],
  categories: [
    { id: 'aaaa1111-1111-1111-1111-111111111111', name: 'Rawat Jalan', color: '#6366f1', code: 'RJ', sort_order: 1, is_active: true },
    { id: 'bbbb2222-2222-2222-2222-222222222222', name: 'Rawat Inap', color: '#10b981', code: 'RI', sort_order: 2, is_active: true },
    { id: 'cccc3333-3333-3333-3333-333333333333', name: 'Laboratorium', color: '#f59e0b', code: 'LAB', sort_order: 3, is_active: true },
  ],
  users: [
    {
      id: '11111111-1111-1111-1111-111111111111',
      email: 'owner@test.local',
      password_hash: TEST_HASH,
      role: 'owner',
      is_password_temporary: false,
      display_name: 'Owner Test',
      is_active: true,
    },
    {
      id: '22222222-2222-2222-2222-222222222222',
      email: 'admin@test.local',
      password_hash: TEST_HASH,
      role: 'admin',
      is_password_temporary: true,
      display_name: 'Admin Test',
      is_active: true,
    },
    {
      id: '33333333-3333-3333-3333-333333333333',
      email: 'nonaktif@test.local',
      password_hash: TEST_HASH,
      role: 'admin',
      is_password_temporary: false,
      display_name: 'Nonaktif',
      is_active: false,
    },
  ],
  refreshTokens: [],
}

/**
 * Implementasi function `security definer` yang dipakai Worker.
 * Menggantikan bagian SQL yang tidak bisa dieksekusi di mock.
 */
async function handleRpc(fn, res, url, req) {
  const readBody = async () => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    try {
      return JSON.parse(raw || '{}')
    } catch {
      return {}
    }
  }

  if (fn === 'store_refresh_token') {
    const a = await readBody()
    if (typeof a.p_token_hash !== 'string' || a.p_token_hash.length !== 64) {
      return json(res, 400, {
        code: '22023',
        message: 'token_hash harus berupa SHA-256 hex (64 karakter)',
      })
    }
    const row = {
      id: newUuid(),
      user_id: a.p_user_id,
      token_hash: a.p_token_hash,
      expires_at: a.p_expires_at,
      user_agent: a.p_user_agent ?? null,
      revoked_at: null,
    }
    mockState.refreshTokens.push(row)
    return json(res, 200, row.id)
  }

  if (fn === 'revoke_refresh_token') {
    const a = await readBody()
    let n = 0
    for (const t of mockState.refreshTokens) {
      if (t.token_hash === a.p_token_hash && !t.revoked_at) {
        t.revoked_at = new Date().toISOString()
        n++
      }
    }
    return json(res, 200, n > 0)
  }

  if (fn === 'revoke_all_refresh_tokens') {
    const a = await readBody()
    let n = 0
    for (const t of mockState.refreshTokens) {
      if (t.user_id === a.p_user_id && !t.revoked_at) {
        t.revoked_at = new Date().toISOString()
        n++
      }
    }
    return json(res, 200, n)
  }

  if (fn === 'create_queue_entry') {
    const a = await readBody()
    const date = a.p_queue_date
    const max = mockState.queueEntries
      .filter((e) => e.queue_date === date)
      .reduce((m, e) => Math.max(m, e.number), 0)
    const entry = {
      id: newUuid(),
      queue_date: date,
      number: max + 1,
      customer_name: a.p_customer_name,
      category_id: a.p_category_id ?? null,
      status: 'waiting',
      priority: 0,
      print_status: a.p_print_status ?? 'pending',
      printed_at: null,
      print_attempts: 0,
      served_at: null,
      served_by: null,
      completed_at: null,
      cancelled_at: null,
      recalled_at: null,
      notes: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    mockState.queueEntries.push(entry)
    return json(res, 201, entry)
  }

  return json(res, 404, { code: '42883', message: `function ${fn} does not exist` })
}

const json = (res, status, body, extraHeaders = {}) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
    'content-range': '0-9/*',
    ...extraHeaders,
  })
  res.end(payload)
}

async function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname

  if (req.method === 'OPTIONS') return json(res, 204, {})

  // Root REST
  if (path === '/rest/v1/' || path === '/rest/v1') {
    // Supabase modern membalas 401 untuk spec root. Mock meniru perilaku itu.
    return json(res, 401, { message: 'Unauthorized', hint: 'OpenAPI spec tidak tersedia untuk role ini' })
  }

  if (path === '/auth/v1/health') {
    return json(res, 200, { name: 'GoTrue', version: 'mock', db: 'up' })
  }

  // RPC
  if (path.startsWith('/rest/v1/rpc/')) {
    const fn = path.slice('/rest/v1/rpc/'.length)
    if (fn === 'next_queue_number') {
      // Simulasikan kebocoran grant: function terbuka untuk anon.
      if (process.env.MOCK_RPC_OPEN === '1') {
        return json(res, 200, 1)
      }
      return json(res, 401, { code: '42501', message: 'permission denied for function next_queue_number' })
    }

    // Refresh token: hanya service_role yang boleh (mock mengabaikan peran
    // dan menandai presence apikey sebagai ganti service_role).
    if (fn === 'store_refresh_token' || fn === 'revoke_refresh_token' || fn === 'revoke_all_refresh_tokens') {
      if (!req.headers.apikey) {
        return json(res, 401, { code: '42501', message: 'permission denied' })
      }
      return handleRpc(fn, res, url, req)
    }

    if (fn === 'create_queue_entry') {
      return handleRpc(fn, res, url, req)
    }

    return json(res, 404, { code: '42883', message: `function ${fn} does not exist` })
  }

  // REST tabel
  if (path.startsWith('/rest/v1/')) {
    const table = path.slice('/rest/v1/'.length).split('?')[0]

/**
 * Evaluasi satu ekspresi filter PostgREST terhadap nilai baris.
 * Mendukung: eq./neq./gt./gte./lt./lte., is.null, not.is.null.
 */
const applyOp = (value, expr) => {
  const m = /^(eq|neq|gt|gte|lt|lte)\.(.*)$/.exec(expr)
  if (m) {
    const [, op, target] = m
    const lhs = typeof value === 'string' ? value.toLowerCase() : value
    const rhs = typeof target === 'string' ? target.toLowerCase() : target
    switch (op) {
      case 'eq': return lhs === rhs
      case 'neq': return lhs !== rhs
      case 'gt': return value > target
      case 'gte': return value >= target
      case 'lt': return value < target
      case 'lte': return value <= target
      default: return true
    }
  }
  if (expr === 'is.null') return value === null
  if (expr === 'not.is.null') return value !== null
  return true
}

// Helper: baca body JSON sebelum menghasilkan respons.
    const readBody = async () => {
      let raw = ''
      for await (const chunk of req) raw += chunk
      try {
        return JSON.parse(raw || '{}')
      } catch {
        return {}
      }
    }

    if (table === 'settings' && (req.method === 'PATCH' || req.method === 'POST')) {
      const patch = await readBody()
      const key = url.searchParams.get('key')?.replace(/^eq\./, '')
      const target = mockState.settings.find((s) => s.key === key)
      if (target) {
        Object.assign(target, patch, { updated_at: new Date().toISOString() })
        return json(res, 200, [target])
      }
      return json(res, 200, [])
    }

    if (table === 'users') {
      // Bangun WHERE dari query PostgREST: users?select=..&email=eq.x&id=eq.y
      // Filter `is.null` sengaja dibiarkan apa adanya agar mock tetap bisa
      // mereproduksi update massal `revoke_all_refresh_tokens`.
      const filters = {}
      for (const [k, v] of url.searchParams.entries()) {
        if (['select', 'limit', 'order'].includes(k)) continue
        filters[k] = v.replace(/^eq\./, '')
      }
      let rows = mockState.users
      if (filters.email) rows = rows.filter((u) => u.email.toLowerCase() === String(filters.email).toLowerCase())
      if (filters.id) rows = rows.filter((u) => u.id === filters.id)
      if (filters.role) rows = rows.filter((u) => u.role === filters.role)

      const select = url.searchParams.get('select')
      if (req.method === 'GET') {
        if (!select) return json(res, 200, rows.length)
        const cols = select.split(',').map((s) => s.trim())
        return json(
          res,
          200,
          rows.map((u) => {
            const out = {}
            for (const c of cols) if (c in u) out[c] = u[c]
            return out
          }),
        )
      }
      if (req.method === 'PATCH') {
        const patch = await readBody()
        const target = rows[0]
        if (!target) return json(res, 200, [])
        Object.assign(target, patch)
        return json(res, 200, [target])
      }
    }

    if (table === 'refresh_tokens') {
      const filters = {}
      for (const [k, v] of url.searchParams.entries()) {
        if (['select', 'limit', 'order'].includes(k)) continue
        filters[k] = v.replace(/^eq\./, '')
      }
      let rows = mockState.refreshTokens
      if (filters.token_hash) rows = rows.filter((t) => t.token_hash === filters.token_hash)
      if (filters.id) rows = rows.filter((t) => t.id === filters.id)
      if (filters.user_id) rows = rows.filter((t) => t.user_id === filters.user_id)
      if (filters.revoked_at) {
        rows = rows.filter((t) => applyOp(t.revoked_at, filters.revoked_at))
      }

      if (req.method === 'GET') {
        const select = url.searchParams.get('select')
        if (!select) return json(res, 200, rows.length)
        const cols = select.split(',').map((s) => s.trim())
        return json(
          res,
          200,
          rows.map((t) => {
            const out = {}
            for (const c of cols) if (c in t) out[c] = t[c]
            return out
          }),
        )
      }
      if (req.method === 'POST') {
        const row = {
          id: newUuid(),
          revoked_at: null,
          ...(await readBody()),
        }
        mockState.refreshTokens.push(row)
        return json(res, 201, [row])
      }
      if (req.method === 'PATCH') {
        const patch = await readBody()
        for (const t of rows) Object.assign(t, patch)
        return json(res, 200, rows.map(() => ({})))
      }
    }

    if (table === 'queue_entries' && req.method === 'POST') {
      // RLS menutup jalur tulis untuk anon â€” inilah perilaku yang diharapkan.
      return json(res, 403, {
        code: '42501',
        message: 'new row violates row-level security policy for table "queue_entries"',
        details: null,
        hint: null,
      })
    }

    if (process.env.FORCE_RLS_ERROR === '1') {
      return json(res, 401, { code: '42501', message: 'permission denied for table ' + table })
    }
    if (process.env.FORCE_MISSING_TABLE === '1') {
      return json(res, 404, {
        code: '42P01',
        message: `relation "public.${table}" does not exist`,
        details: null,
        hint: null,
      })
    }

    if (table === 'categories') {
      const select = url.searchParams.get('select')
      const isActive = url.searchParams.get('is_active')?.replace(/^eq\./, '')
      let rows = mockState.categories
      if (isActive !== null && isActive !== undefined) {
        rows = rows.filter((c) => c.is_active === (isActive === 'true'))
      }
      if (!select) return json(res, 200, rows.length)
      const cols = select.split(',').map((s) => s.trim())
      return json(
        res,
        200,
        rows.map((c) => Object.fromEntries(cols.filter((k) => k in c).map((k) => [k, c[k]]))),
      )
    }

    if (table === 'queue_entries') {
      // Bangun WHERE dari query PostgREST (eq./in./gt./is.null).
      const filters = {}
      for (const [k, v] of url.searchParams.entries()) {
        if (['select', 'limit', 'order', 'Prefer', 'Range'].includes(k)) continue
        filters[k] = v
      }

/**
 * Kolom `queue_entries` sesuai schema.sql. Dipakai untuk memvalidasi payload
 * INSERT/UPDATE — PostgREST menolak kolom yang tidak dikenal (PGRST204), dan
 * mock harus meniru perilaku itu agar salah ketik ketahuan saat test.
 */
const QUEUE_ENTRY_COLUMNS = [
  'id',
  'queue_date',
  'number',
  'customer_name',
  'category_id',
  'status',
  'priority',
  'print_status',
  'printed_at',
  'print_attempts',
  'served_at',
  'served_by',
  'completed_at',
  'cancelled_at',
  'recalled_at',
  'notes',
  'created_at',
  'updated_at',
]

const applyOp = (value, expr) => {
        const m = /^(eq|neq|gt|gte|lt|lte)\.(.*)$/.exec(expr)
        if (m) {
          const [, op, target] = m
          const lhs = typeof value === 'string' ? value.toLowerCase() : value
          const rhs = typeof target === 'string' ? target.toLowerCase() : target
          switch (op) {
            case 'eq': return lhs === rhs
            case 'neq': return lhs !== rhs
            case 'gt': return value > target
            case 'gte': return value >= target
            case 'lt': return value < target
            case 'lte': return value <= target
            default: return true
          }
        }
        if (expr === 'is.null') return value === null
        if (expr === 'not.is.null') return value !== null
        return true
      }

      let rows = mockState.queueEntries
      for (const [key, expr] of Object.entries(filters)) {
        rows = rows.filter((r) => applyOp(r[key], expr))
      }

      const sortKey = url.searchParams.get('order')
      if (sortKey) {
        for (const clause of sortKey.split(',')) {
          const [col, dirRaw] = clause.split('.')
          const dir = (dirRaw ?? 'asc').toLowerCase() === 'desc' ? -1 : 1
          rows = [...rows].sort((a, b) => {
            const av = a[col]
            const bv = b[col]
            if (av === bv) return 0
            if (av === null || av === undefined) return 1
            if (bv === null || bv === undefined) return -1
            return (av < bv ? -1 : 1) * dir
          })
        }
      }

      const limitParam = url.searchParams.get('limit')
      if (limitParam) {
        const n = Number(limitParam)
        if (Number.isFinite(n) && n > 0) rows = rows.slice(0, n)
      }

      const project = (row, select) => {
        // `select=*` berarti semua kolom — bentuk yang sama seperti tanpa
        // parameter select sama sekali.
        if (!select || select === '*') return { ...row }
        const cols = select.split(',').map((s) => s.trim())
        return Object.fromEntries(cols.filter((k) => k in row).map((k) => [k, row[k]]))
      }

      const applySelect = (list) => {
        const select = url.searchParams.get('select')
        if (!select) return list
        return list.map((r) => project(r, select))
      }

      // `.maybeSingle()` / `.single()` di supabase-js memakai Accept header ini;
      // PostgREST lalu mengembalikan objek tunggal, bukan array. Kalau mock
      // selalu mengirim array, pemanggil akan selalu menerima null.
      const wantsSingleObject = (req.headers.accept ?? '').includes(
        'application/vnd.pgrst.object',
      )

      if (req.method === 'PATCH' || req.method === 'POST') {
        let raw = ''
        for await (const chunk of req) raw += chunk
        let patch
        try {
          patch = JSON.parse(raw || '{}')
        } catch {
          return json(res, 400, { message: 'body JSON tidak valid' })
        }

        const hasFilter = Object.keys(filters).length > 0
        if (!hasFilter) {
          const created = {
            id: newUuid(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...patch,
          }
          mockState.queueEntries.push(created)
          return json(res, 201, applySelect([created]))
        }

        // Kolom yang tidak ada di tabel harus DITOLAK — sama seperti PostgREST
        // yang membalas PGRST204. Ini penting: tanpa ini, salah ketik nama kolom
        // akan lolos diam-diam dan bug baru muncul jauh dari sumbernya.
        const unknownCols = Object.keys(patch).filter((k) => !QUEUE_ENTRY_COLUMNS.includes(k))
        if (unknownCols.length > 0) {
          return json(res, 400, {
            code: 'PGRST204',
            message: `Could not find the '${unknownCols[0]}' column of 'queue_entries' in the schema cache`,
          })
        }

        for (const row of rows) Object.assign(row, patch, { updated_at: new Date().toISOString() })
        const projected = rows.map((r) => project(r, url.searchParams.get('select')))
        if (wantsSingleObject) {
          if (projected.length === 0) return json(res, 406, { code: 'PGRST116', message: 'no rows' })
          if (projected.length > 1) {
            return json(res, 406, {
              code: 'PGRST116',
              message: 'JSON object requested, multiple (or no) rows returned',
            })
          }
          return json(res, 200, projected[0])
        }
        return json(res, 200, projected)
      }

      if (!url.searchParams.get('select')) return json(res, 200, rows.length)
      const projectedRows = applySelect(rows)
      if (wantsSingleObject) {
        if (projectedRows.length === 0) return json(res, 406, { code: 'PGRST116', message: 'no rows' })
        if (projectedRows.length > 1) {
          return json(res, 406, {
            code: 'PGRST116',
            message: 'JSON object requested, multiple (or no) rows returned',
          })
        }
        return json(res, 200, projectedRows[0])
      }
      return json(res, 200, projectedRows)
    }

    if (table === 'settings') {
      const filters = {}
      for (const [k, v] of url.searchParams.entries()) {
        if (['select', 'limit', 'order'].includes(k)) continue
        filters[k] = v.replace(/^eq\./, '')
      }
      let rows = mockState.settings
      for (const [key, value] of Object.entries(filters)) {
        rows = rows.filter((r) => r[key] === value)
      }
      const select = url.searchParams.get('select')
      if (!select) return json(res, 200, rows.length)
      const cols = select.split(',').map((s) => s.trim())
      return json(
        res,
        200,
        rows.map((r) => Object.fromEntries(cols.filter((k) => k in r).map((k) => [k, r[k]]))),
      )
    }
    return json(res, 404, { code: '42P01', message: `relation "public.${table}" does not exist` })
  }

  // Realtime websocket
  if (path === '/realtime/v1/websocket') {
    res.writeHead(426, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 426, message: 'Upgrade Required' }))
    return
  }

return json(res, 404, { message: 'mock: route tidak dikenal ' + path })
}

/**
 * Server mock. Dijalankan hanya bila file ini adalah entry point.
 * Saat di-`import` (dipakai worker-test.mjs), server TIDAK di-listen supaya
 * test bisa memilih sendiri listen pada port yang dipakai.
 */
const server = http.createServer((req, res) => {
  void handle(req, res).catch((err) => {
    if (!res.headersSent) json(res, 500, { message: `mock error: ${err.message}` })
  })
})

export const state = mockState
export { server }

/** Jalankan mock pada port tertentu (dipakai test). */
export function listen(port = PORT) {
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`[mock-supabase] http://localhost:${port}`)
      resolve(server)
    })
  })
}

// Deteksi entry point secara andal lintas platform: bandingkan path absolut
// dengan suffix dari import.meta.url, bukan string `file://` yang bisa beda
// format di Windows.
const selfPath = fileURLToPath(import.meta.url)
const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (selfPath === entryPath) void listen()



