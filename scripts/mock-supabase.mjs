/**
 * Mock Supabase REST/Auth untuk menguji jalur kode diagnostik tanpa project nyata.
 *
 * Menghormati toggle lewat query/header:
 *   - FORCE_RLS_ERROR=1   → SELECT ditolak 42501 (simulasikan policy SELECT hilang)
 *   - FORCE_MISSING_TABLE=1 → SELECT ditolak 42P01 (tabel belum dibuat)
 *
 * Jalankan: node scripts/mock-supabase.mjs
 */
import http from 'node:http'

const PORT = Number(process.env.MOCK_PORT ?? 54321)
// Bentuk JWT agar lolos validasi bentuk di frontend (3 bagian dipisah titik).
const ANON = process.env.MOCK_ANON_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.bW9jay1zaWduYXR1cmU'

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

const server = http.createServer((req, res) => {
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

    if (table === 'queue_entries' && req.method === 'POST') {
      // RLS menutup jalur tulis untuk anon — inilah perilaku yang diharapkan.
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
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-supabase] http://localhost:${PORT} (anon key: ${ANON})`)
})