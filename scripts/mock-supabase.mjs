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
const mockState = {
  refreshSeq: 0,
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
    return json(res, 404, { code: '42883', message: `function ${fn} does not exist` })
  }

  // REST tabel
  if (path.startsWith('/rest/v1/')) {
    const table = path.slice('/rest/v1/'.length).split('?')[0]

//Helper: baca body JSON sebelum menghasilkan respons.
    const readBody = async () => {
      let raw = ''
      for await (const chunk of req) raw += chunk
      try {
        return JSON.parse(raw || '{}')
      } catch {
        return {}
      }
    }

    if (table === 'users') {
      // Bangun WHERE dari query PostgREST: users?select=..&email=eq.x&id=eq.y
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
          id: `rt-${++mockState.refreshSeq}`,
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
      return json(res, 200, [
        { id: '11111111-1111-1111-1111-111111111111', name: 'Rawat Jalan', color: '#6366f1', sort_order: 1, is_active: true },
        { id: '22222222-2222-2222-2222-222222222222', name: 'Rawat inap', color: '#10b981', sort_order: 2, is_active: true },
      ])
    }
    if (table === 'queue_entries') {
      return json(res, 200, [
        { id: '33333333-3333-3333-3333-333333333333', queue_date: '2026-10-09', number: 1, customer_name: 'Budi', status: 'waiting', print_status: 'printed' },
      ])
    }
    if (table === 'settings') {
      return json(res, 200, [
        { key: 'reset_hour', updated_at: '2026-10-09T00:00:00Z' },
        { key: 'voice_template', updated_at: '2026-10-09T00:00:00Z' },
      ])
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



