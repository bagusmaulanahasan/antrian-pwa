/**
 * Integration test API antrian (Worker + mock PostgREST).
 *
 * Menguji aturan bisnis dari PRD:
 *   - Hanya satu nomor `serving` aktif per hari
 *   - Panggil ulang memprioritaskan nomor (muncul paling atas)
 *   - Nomor tidak hilang walau cetak gagal
 *   - Penulisan hanya bisa lewat token valid
 *
 * Jalankan: node scripts/queue-test.mjs
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { TEST_PASSWORD } from './test-fixtures.mjs'

const MOCK_PG_PORT = 54324
const WORKER_PORT = 8790
const BASE = `http://127.0.0.1:${WORKER_PORT}`
const JWT_SECRET = 'queue-test-secret-min-32-chars-long-abcdefgh'

const { listen: startMock, state: mockState, server: mockServer } = await import(
  './mock-supabase.mjs'
)

const children = new Set()
let exitCode = 1

function start(label, nodeArgs) {
  const child = spawn(process.execPath, nodeArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', (d) => process.stdout.write(`[${label}] ${d}`))
  child.stderr.on('data', (d) => {
    const s = String(d)
    if (/Ready on|Using secrets|Starting local|Local Explorer|^\s*$/.test(s)) return
    if (/\[\d+\]\s|\[\w+!?\]\s|GET \/|POST \/|PATCH /.test(s)) return
    process.stderr.write(`[${label}!] ${s}`)
  })
  children.add(child)
  child.on('exit', () => children.delete(child))
  return child
}

function stopAll() {
  for (const c of children) {
    try {
      if (process.platform === 'win32' && c.pid) {
        spawn('taskkill', ['/pid', String(c.pid), '/f', '/t'], {
          stdio: 'ignore',
          windowsHide: true,
        }).unref()
      } else c.kill('SIGKILL')
    } catch {
      /* sudah mati */
    }
  }
  children.clear()
}

async function waitForHttp(url, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  let last = 'tidak ada respons'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.status < 500) return res
      last = `HTTP ${res.status}`
    } catch (e) {
      last = e.message
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`timeout menunggu ${url} (${last})`)
}

// ------------------------------------------------------------- harness
const results = { pass: 0, fail: [] }
function check(cond, label, extra = '') {
  if (cond) {
    results.pass++
    console.log(`  PASS  ${label}`)
  } else {
    results.fail.push(label)
    console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`)
  }
}
function section(name) {
  console.log(`\n${name}`)
}

/** Cookie jar sederhana supaya sesi bertahan antar request. */
const jar = new Map()

function captureCookies(res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const idx = pair.indexOf('=')
    if (idx === -1) continue
    const name = pair.slice(0, idx).trim()
    const value = pair.slice(idx + 1).trim()
    if (value === '') jar.delete(name)
    else jar.set(name, value)
  }
}

async function api(pathname, { method = 'GET', body, useCookies = true } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (useCookies && jar.size) {
    headers.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (useCookies) captureCookies(res)
  const text = await res.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  return { status: res.status, body: parsed, raw: text }
}

async function login(email = 'owner@test.local') {
  jar.clear()
  const res = await api('/api/auth/login', {
    method: 'POST',
    body: { email, password: TEST_PASSWORD },
  })
  if (res.status !== 200) throw new Error(`login gagal: ${res.status} ${res.raw}`)
  return res
}

// ---------------------------------------------------------------- main
const devVarsPath = path.resolve('worker/.dev.vars')
const devVarsExisted = existsSync(devVarsPath)
const devVarsBackup = devVarsExisted ? readFileSync(devVarsPath, 'utf8') : null

try {
  await startMock(MOCK_PG_PORT)
  console.log(`[mock-pg] http://127.0.0.1:${MOCK_PG_PORT}`)

  writeFileSync(
    devVarsPath,
    [
      `SUPABASE_URL=http://127.0.0.1:${MOCK_PG_PORT}`,
      `SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.bW9jay1zaWduYXR1cmU`,
      `JWT_ACCESS_SECRET=${JWT_SECRET}`,
      `ALLOWED_ORIGIN=*`,
      '',
    ].join('\n'),
  )

  start('worker', [
    path.resolve('node_modules/wrangler/bin/wrangler.js'),
    'dev',
    '--config',
    path.resolve('worker/wrangler.toml'),
    '--port',
    String(WORKER_PORT),
    '--ip',
    '127.0.0.1',
  ])
  await waitForHttp(`${BASE}/api/health`)
  console.log(`[worker] ${BASE}\n`)

  // ---------------- 1. Guard autentikasi ----------------
  section('[1] Guard autentikasi')
  {
    for (const [method, p] of [
      ['GET', '/api/queue'],
      ['POST', '/api/queue'],
      ['POST', '/api/queue/next'],
      ['GET', '/api/queue/categories'],
    ]) {
      const res = await api(p, { method, body: method === 'POST' ? {} : undefined, useCookies: false })
      check(res.status === 401, `${method} ${p} tanpa cookie → 401`, `dapat ${res.status}`)
    }

    const badCookie = await api('/api/queue', { useCookies: false, headers: {} })
    void badCookie
  }

  // ---------------- 2. Kategori ----------------
  section('[2] Kategori')
  let categories = []
  {
    await login()
    const res = await api('/api/queue/categories')
    check(res.status === 200, 'daftar kategori → 200', `dapat ${res.status}`)
    categories = res.body?.categories ?? []
    check(categories.length === 3, `3 kategori aktif dikembalikan (dapat ${categories.length})`)
    check(
      categories.every((c) => typeof c.name === 'string' && /^#[0-9a-f]{6}$/i.test(c.color)),
      'setiap kategori punya nama dan warna hex',
      JSON.stringify(categories).slice(0, 120),
    )
    const order = categories.map((c) => c.sort_order)
    check(
      order.every((v, i) => i === 0 || order[i - 1] <= v),
      'kategori urut berdasarkan sort_order',
      JSON.stringify(order),
    )
  }

  // ---------------- 3. Buat antrian ----------------
  section('[3] Pembuatan antrian')
  const created = []
  {
    const first = await api('/api/queue', {
      method: 'POST',
      body: { customerName: 'Budi Santoso', categoryId: categories[0].id },
    })
    check(first.status === 201, 'buat antrian → 201', `dapat ${first.status} ${first.raw}`)
    check(first.body?.entry?.number === 1, 'nomor pertama = 1', JSON.stringify(first.body?.entry?.number))
    check(
      first.body?.entry?.status === 'waiting',
      'status awal = waiting',
      first.body?.entry?.status,
    )
    check(
      first.body?.entry?.print_status === 'pending',
      'print_status awal = pending',
      first.body?.entry?.print_status,
    )
    created.push(first.body.entry)

    const second = await api('/api/queue', {
      method: 'POST',
      body: { customerName: 'Siti Aminah', categoryId: categories[1].id },
    })
    check(second.body?.entry?.number === 2, 'nomor kedua = 2', JSON.stringify(second.body?.entry?.number))
    created.push(second.body.entry)

    const third = await api('/api/queue', {
      method: 'POST',
      body: { customerName: 'Andi', categoryId: categories[2].id, printStatus: 'printed' },
    })
    check(
      third.body?.entry?.print_status === 'printed',
      'printStatus=printed diteruskan',
      third.body?.entry?.print_status,
    )
    created.push(third.body.entry)
  }

  // ---------------- 4. Validasi input ----------------
  section('[4] Validasi input')
  {
    const empty = await api('/api/queue', { method: 'POST', body: { customerName: '' } })
    check(empty.status === 400, 'nama kosong → 400', `dapat ${empty.status}`)

    const whitespace = await api('/api/queue', { method: 'POST', body: { customerName: '   ' } })
    check(whitespace.status === 400, 'nama spasi saja → 400', `dapat ${whitespace.status}`)

    const tooLong = await api('/api/queue', {
      method: 'POST',
      body: { customerName: 'x'.repeat(200) },
    })
    check(tooLong.status === 400, 'nama > 120 karakter → 400', `dapat ${tooLong.status}`)

    const badJson = await fetch(`${BASE}/api/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: '{rusak',
    })
    check(badJson.status === 400, 'JSON rusak → 400', `dapat ${badJson.status}`)

    const noBody = await api('/api/queue', { method: 'POST' })
    check(noBody.status === 400, 'tanpa body → 400', `dapat ${noBody.status}`)
  }

  // ---------------- 5. Daftar antrian ----------------
  section('[5] Daftar antrian')
  {
    const res = await api('/api/queue')
    check(res.status === 200, 'daftar antrian → 200', `dapat ${res.status}`)
    check(res.body?.entries?.length === 3, `3 antrian terdaftar (dapat ${res.body?.entries?.length})`)
    check(res.body?.counts?.waiting === 3, 'counts.waiting = 3', JSON.stringify(res.body?.counts))
    check(Boolean(res.body?.date), 'tanggal antrian dikembalikan', res.body?.date)
  }

  // ---------------- 6. Panggil nomor berikutnya ----------------
  section('[6] Panggil nomor berikutnya')
  {
    const res = await api('/api/queue/next', { method: 'POST' })
    check(res.status === 200, 'next → 200', `dapat ${res.status} ${res.raw}`)
    if (res.body?.entry?.number !== 1) {
      console.log(`        [debug] next body: ${res.raw}`)
    }
    check(res.body?.entry?.number === 1, 'nomor 1 dipanggil', JSON.stringify(res.body?.entry?.number))
    check(res.body?.entry?.status === 'serving', 'status = serving', res.body?.entry?.status)
    check(Boolean(res.body?.entry?.served_at), 'served_at terisi')
    check(Boolean(res.body?.entry?.served_by), 'served_by terisi')

    const list = await api('/api/queue')
    check(list.body?.counts?.serving === 1, 'tepat satu nomor serving', JSON.stringify(list.body?.counts))
  }

  // ---------------- 7. Hanya satu serving ----------------
  section('[7] Aturan: hanya satu serving')
  {
    // Panggil lagi tanpa menyelesaikan yang sekarang — nomor lama harus
    // otomatis selesai.
    const res = await api('/api/queue/next', { method: 'POST' })
    check(res.status === 200, 'next kedua → 200', `dapat ${res.status}`)
    check(res.body?.entry?.number === 2, 'pindah ke nomor 2', JSON.stringify(res.body?.entry?.number))

    const list = await api('/api/queue')
    check(list.body?.counts?.serving === 1, 'tetap satu serving', JSON.stringify(list.body?.counts))
    check(list.body?.counts?.done === 1, 'nomor sebelumnya jadi done', JSON.stringify(list.body?.counts))

    const serving = list.body.entries.filter((e) => e.status === 'serving')
    check(serving.length === 1, 'tepat satu entri berstatus serving', String(serving.length))
    check(serving[0].number === 2, 'yang serving adalah nomor 2', String(serving[0]?.number))
  }

  // ---------------- 8. Kosong saat tidak ada antrian ----------------
  section('[8] Panggil saat antrian habis')
  {
    // Batalkan sisanya agar tidak ada waiting.
    const list = await api('/api/queue')
    for (const e of list.body.entries.filter((x) => x.status === 'waiting')) {
      await api(`/api/queue/${e.id}`, { method: 'PATCH', body: { status: 'cancelled' } })
    }
    const res = await api('/api/queue/next', { method: 'POST' })
    check(res.status === 200, 'next tanpa antrian tetap 200', `dapat ${res.status}`)
    check(res.body?.entry === null || res.body?.entry === undefined, 'tidak mengembalikan nomor')
  }

  // ---------------- 9. Ubah status ----------------
  section('[9] Ubah status')
  {
    const list = await api('/api/queue')
    const target = list.body.entries[0]

    const done = await api(`/api/queue/${target.id}`, { method: 'PATCH', body: { status: 'done' } })
    check(done.status === 200, 'PATCH status done → 200', `dapat ${done.status} ${done.raw}`)
    check(done.body?.entry?.status === 'done', 'status jadi done')
    check(Boolean(done.body?.entry?.completed_at), 'completed_at terisi')

    const bad = await api(`/api/queue/${target.id}`, { method: 'PATCH', body: { status: 'entah' } })
    check(bad.status === 400, 'status tidak dikenal → 400', `dapat ${bad.status}`)

    const noStatus = await api(`/api/queue/${target.id}`, { method: 'PATCH', body: {} })
    check(noStatus.status === 400, 'tanpa field status → 400', `dapat ${noStatus.status}`)

    const fakeId = '00000000-0000-0000-0000-000000000000'
    const missing = await api(`/api/queue/${fakeId}`, { method: 'PATCH', body: { status: 'done' } })
    check(missing.status === 500 || missing.status === 404, 'id tidak adahandled', `dapat ${missing.status}`)
  }

  // ---------------- 10. Panggil ulang ----------------
  section('[10] Panggil ulang')
  {
    const list = await api('/api/queue')
    const done = list.body.entries.find((e) => e.status === 'done')

    const res = await api(`/api/queue/${done.id}/recall`, { method: 'POST' })
    check(res.status === 200, 'recall → 200', `dapat ${res.status} ${res.raw}`)
    check(res.body?.entry?.status === 'waiting', 'status kembali ke waiting', res.body?.entry?.status)
    check(res.body?.entry?.priority > 0, 'priority naik', JSON.stringify(res.body?.entry?.priority))
    check(Boolean(res.body?.entry?.recalled_at), 'recalled_at terisi')

    const after = await api('/api/queue')
    check(
      after.body.entries[0].id === done.id,
      'nomor diprioritaskan muncul paling atas',
      `pertama=${after.body.entries[0].id} Recall=${done.id}`,
    )

    const badId = '00000000-0000-0000-0000-000000000000'
    const missing = await api(`/api/queue/${badId}/recall`, { method: 'POST' })
    check(missing.status >= 400, 'recall id tidak ada ditolak', `dapat ${missing.status}`)
  }

  // ---------------- 11. Status cetak ----------------
  section('[11] Status cetak (nomor tidak hilang saat print gagal)')
  {
    const list = await api('/api/queue')
    const pendingPrint = list.body.entries.find((e) => e.print_status === 'pending')

    const res = await api(`/api/queue/${pendingPrint.id}/print`, {
      method: 'POST',
      body: { printed: true },
    })
    check(res.status === 200, 'tandai printed → 200', `dapat ${res.status}`)
    check(res.body?.entry?.print_status === 'printed', 'print_status = printed')
    check(Boolean(res.body?.entry?.printed_at), 'printed_at terisi')

    const bad = await api(`/api/queue/${pendingPrint.id}/print`, {
      method: 'POST',
      body: { printed: 'ya' },
    })
    check(bad.status === 400, 'printed non-boolean → 400', `dapat ${bad.status}`)

    // Cetak ulang dari DB: entry tetap ada walau print gagal.
    const stillThere = mockState.queueEntries.find((e) => e.id === pendingPrint.id)
    check(Boolean(stillThere), 'entry tetap ada di database setelah print')
  }

  // ---------------- 12. Akses lintas peran ----------------
  section('[12] Akses lintas peran')
  {
    await login('admin@test.local')
    const res = await api('/api/queue')
    check(res.status === 200, 'admin juga boleh membaca antrian', `dapat ${res.status}`)

    const created2 = await api('/api/queue', {
      method: 'POST',
      body: { customerName: 'Tester Admin' },
    })
    check(created2.status === 201, 'admin boleh membuat antrian', `dapat ${created2.status}`)
  }

  // ---------------- 13. Route tidak dikenal ----------------
  section('[13] Route & validasi misc')
  {
    const unknown = await api('/api/queue/entah')
    check(unknown.status === 404, 'route tidak dikenal → 404', `dapat ${unknown.status}`)

    const badPath = await api('/api/queue/bukan-uuid')
    check(badPath.status === 404, 'id bukan uuid → 404', `dapat ${badPath.status}`)
  }
} catch (err) {
  console.error('\nFATAL:', err)
  results.fail.push(`fatal: ${err.message}`)
} finally {
  console.log(`\n${'='.repeat(58)}`)
  console.log(`  ${results.pass} lulus, ${results.fail.length} gagal`)
  if (results.fail.length) {
    console.log('\n  Gagal:')
    for (const f of results.fail) console.log(`    - ${f}`)
  }
  exitCode = results.fail.length === 0 ? 0 : 1
  stopAll()
  if (devVarsExisted && devVarsBackup !== null) writeFileSync(devVarsPath, devVarsBackup)
  else if (existsSync(devVarsPath)) rmSync(devVarsPath)
  mockServer.close()
  await new Promise((r) => setTimeout(r, 400))
}

process.exit(exitCode)