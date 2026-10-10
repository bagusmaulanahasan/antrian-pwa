/**
 * Mock Cloudflare Worker untuk E2E test frontend.
 *
 * Berbeda dengan mock-supabase.mjs, ini mengembalikan HTML/JS untuk halaman
 * Route dev sehingga frontend bisa menguji alur login, guard, dan ganti
 * password terhadap Worker yang benar-benar berjalan (workerd).
 *
 * Jalankan: node scripts/mock-worker.mjs
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { TEST_HASH, TEST_PASSWORD } from './test-fixtures.mjs'

const WORKER_PORT = 8789
const MOCK_PG_PORT = 54323
const BASE = `http://127.0.0.1:${WORKER_PORT}`

// ---------------------------------------------------------------- state
const state = {
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
  ],
  refreshTokens: [],
  seq: 0,
}

function resetState() {
  state.users = [
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
  ]
  state.refreshTokens = []
  state.seq = 0
}

// ------------------------------------------------------- mock PostgREST
const pg = createClient(`http://127.0.0.1:${MOCK_PG_PORT}`, 'x', {
  auth: { persistSession: false },
})

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

const http = await import('node:http')

const // Mock PostgREST untuk auth-e2e. Sengaja sederhana: endpoint yang dipakai
// Worker untuk alur auth saja. state di-share dengan mock-supabase.mjs lewat
// nilai yang sama lewat resetState().
mockPg = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${MOCK_PG_PORT}`)
  const path = url.pathname
  if (path === '/control/reset') {
    resetState()
    return json(res, 200, { ok: true })
  }

  // Halaman yang dirender (AdminDashboardView) memanggil endpoint antrian
  // sesaat setelah mount. Mock di sini sengaja fokus pada alur auth, jadi
  // kategori & antrian dikembalikan kosong — bukan 500, supaya test auth tidak
  // gagal karena endpoint yang memang tidak diuji.
  if (path === '/rest/v1/categories') {
    return json(res, 200, [])
  }
  if (path === '/rest/v1/queue_entries') {
    return json(res, 200, [])
  }
  if (path === '/rest/v1/settings') {
    return json(res, 200, [{ key: 'reset_hour', value: 0 }])
  }
  if (path.startsWith('/rest/v1/rpc/')) {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const args = raw ? JSON.parse(raw) : {}
    const fn = path.slice('/rest/v1/rpc/'.length)
    if (fn === 'store_refresh_token') {
      if (typeof args.p_token_hash !== 'string' || args.p_token_hash.length !== 64) {
        return json(res, 400, { code: '22023', message: 'token_hash harus 64 karakter' })
      }
      const row = {
        id: `rt-${++state.seq}`,
        user_id: args.p_user_id,
        token_hash: args.p_token_hash,
        expires_at: args.p_expires_at,
        user_agent: args.p_user_agent ?? null,
        revoked_at: null,
      }
      state.refreshTokens.push(row)
      return json(res, 200, row.id)
    }
    if (fn === 'revoke_refresh_token') {
      let n = 0
      for (const t of state.refreshTokens) {
        if (t.token_hash === args.p_token_hash && !t.revoked_at) {
          t.revoked_at = new Date().toISOString()
          n++
        }
      }
      return json(res, 200, n > 0)
    }
    if (fn === 'revoke_all_refresh_tokens') {
      let n = 0
      for (const t of state.refreshTokens) {
        if (t.user_id === args.p_user_id && !t.revoked_at) {
          t.revoked_at = new Date().toISOString()
          n++
        }
      }
      return json(res, 200, n)
    }
    return json(res, 404, { code: '42883', message: `function ${fn} does not exist` })
  }
  if (!path.startsWith('/rest/v1/')) return json(res, 404, { message: 'mock-pg: 404' })

  const table = path.slice('/rest/v1/'.length).split('?')[0]
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = raw ? JSON.parse(raw) : {}

  const filters = {}
  for (const [k, v] of url.searchParams.entries()) {
    if (['select', 'limit', 'order'].includes(k)) continue
    filters[k] = String(v).replace(/^eq\./, '')
  }

  if (table === 'users') {
    let rows = state.users
    if (filters.email) rows = rows.filter((u) => u.email === filters.email)
    if (filters.id) rows = rows.filter((u) => u.id === filters.id)

    if (req.method === 'GET') {
      const select = url.searchParams.get('select')
      if (!select) return json(res, 200, rows.length)
      const cols = select.split(',').map((s) => s.trim())
      return json(
        res,
        200,
        rows.map((u) => Object.fromEntries(cols.filter((c) => c in u).map((c) => [c, u[c]]))),
      )
    }
    if (req.method === 'PATCH') {
      const target = rows[0]
      if (!target) return json(res, 200, [])
      Object.assign(target, body)
      return json(res, 200, [target])
    }
  }

  if (table === 'refresh_tokens') {
    let rows = state.refreshTokens
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
        rows.map((t) => Object.fromEntries(cols.filter((c) => c in t).map((c) => [c, t[c]]))),
      )
    }
    if (req.method === 'POST') {
      const row = { id: `rt-${++state.seq}`, revoked_at: null, ...body }
      state.refreshTokens.push(row)
      return json(res, 201, [row])
    }
    if (req.method === 'PATCH') {
      for (const t of rows) Object.assign(t, body)
      return json(res, 200, rows.map(() => ({})))
    }
  }

  return json(res, 404, { message: `mock-pg: ${req.method} ${path}` })
})

// ------------------------------------------------------------- harness
const children = new Set()
let exitCode = 1

function start(label, nodeArgs, cwd) {
  const child = spawn(process.execPath, nodeArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
    windowsHide: true,
  })
  child.stdout.on('data', (d) => process.stdout.write(`[${label}] ${d}`))
  child.stderr.on('data', (d) => {
    const s = String(d)
    if (/Ready on|Using secrets|Starting local/.test(s)) return
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
    await new Promise((r) => setTimeout(r, 2500))
  }
  throw new Error(`timeout menunggu ${url} (${last})`)
}

// --------------------------------------------------------- E2E helpers
let browser = null

/**
 * Halaman baru dengan cookie bersih.
 *
 * Cookie DIBERSIHKAN setiap kali: tanpa itu, sesi dari test sebelumnya
 * terbawa ke test berikutnya (satu profil browser = satu cookie jar), dan
 * test yang niat login sebagai admin malah langsung terpental ke dashboard.
 */
async function getPage() {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  const client = await page.createCDPSession()
  await client.send('Network.clearBrowserCookies')
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const text = m.text()
    if (text.includes('favicon')) return
    // Sertakan URL agar 500 yang lolos tidak datang tanpa konteks.
    const location = m.location?.()?.url
    consoleErrors.push(location ? `${text} <- ${location}` : text)
  })
  page.on('requestfailed', (req) => {
    const f = req.failure()
    consoleErrors.push(`requestfailed: ${req.url()} (${f?.errorText})`)
  })
  page.on('response', async (res) => {
    if (res.status() >= 500) {
      const body = await res.text().catch(() => '')
      consoleErrors.push(`HTTP ${res.status()} ${res.url()} :: ${body.slice(0, 200)}`)
    }
  })
  return page
}

const consoleErrors = []

const results = { pass: 0, fail: [] }
function check(cond, label, extra = '') {
  if (cond) {
    results.pass++
    console.log(`  PASS  ${label}`)
  } else {
    results.fail.push(label)
    console.log(`  FAIL  ${label}${extra ? ` â€” ${extra}` : ''}`)
  }
}
function section(name) {
  console.log(`\n${name}`)
}

async function resetMock() {
  await fetch(`http://127.0.0.1:${MOCK_PG_PORT}/control/reset`)
}

async function submitLogin(page, email, password) {
  await page.waitForSelector('[data-testid="login-form"]', { timeout: 15000 })
  await page.$eval('[data-testid="email"]', (el) => {
    el.value = ''
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.$eval('[data-testid="password"]', (el) => {
    el.value = ''
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.type('[data-testid="email"]', email)
  await page.type('[data-testid="password"]', password)
  await page.click('[data-testid="login-submit"]')
}

// ---------------------------------------------------------------- main
const wranglerBin = path.resolve('node_modules/wrangler/bin/wrangler.js')
const devVarsPath = path.resolve('worker/.dev.vars')
const devVarsExisted = existsSync(devVarsPath)
const devVarsBackup = devVarsExisted ? readFileSync(devVarsPath, 'utf8') : null

const puppeteer = (await import('puppeteer-core')).default
const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

try {
  // 1. mock PostgREST
  await new Promise((resolve) =>
    mockPg.listen(MOCK_PG_PORT, '127.0.0.1', () => {
      console.log(`[mock-pg] http://127.0.0.1:${MOCK_PG_PORT}`)
      resolve()
    }),
  )

  // 2. Worker asli
  writeFileSync(
    devVarsPath,
    [
      `SUPABASE_URL=http://127.0.0.1:${MOCK_PG_PORT}`,
      `SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.bW9jay1zaWduYXR1cmU`,
      `JWT_ACCESS_SECRET=e2e-secret-for-frontend-tests-min-32-chars-long`,
      '',
    ].join('\n'),
  )
  start(
    'worker',
    [
      wranglerBin,
      'dev',
      '--config',
      path.resolve('worker/wrangler.toml'),
      '--port',
      String(WORKER_PORT),
      '--ip',
      '127.0.0.1',
    ],
    process.cwd(),
  )
  await waitForHttp(`${BASE}/api/health`)
  console.log(`[worker] ${BASE}`)

  // 3. Build frontend dengan VITE_API_BASE_URL â†’ worker
  const OUT_DIR = 'dist-e2e'
  console.log('\n[build] frontend dengan VITE_API_BASE_URL=' + BASE)
  // Batasi heap: `vite build` + workbox (generateSW) Borongan bisa melebihi
  // batas default Node dan membuat test gagal dengan OOM yang tidak terkait
  // dengan kode.
  const buildCode = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        path.resolve('node_modules/vite/bin/vite.js'),
        'build',
        '--outDir',
        OUT_DIR,
        '--emptyOutDir',
        '--logLevel',
        'warn',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          VITE_API_BASE_URL: BASE,
          VITE_SUPABASE_URL: 'http://127.0.0.1:54399',
          VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.e30',
        },
      },
    )
    child.stdout.on('data', (d) => process.stdout.write(`[build] ${d}`))
    child.stderr.on('data', (d) => process.stderr.write(`[build!] ${d}`))
    child.on('exit', (c) => resolve(c ?? 1))
  })
  if (buildCode !== 0) throw new Error(`vite build gagal (exit ${buildCode})`)

  // 4. Preview server untuk frontend
  const APP_PORT = 5199
  start(
    'preview',
    [
      path.resolve('node_modules/vite/bin/vite.js'),
      'preview',
      '--outDir',
      OUT_DIR,
      '--port',
      String(APP_PORT),
      '--strictPort',
    ],
    process.cwd(),
  )
  const APP = `http://127.0.0.1:${APP_PORT}`
  await waitForHttp(`${APP}/`)
  console.log(`[preview] ${APP}`)

  // 5. Browser
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=256', '--disable-gpu', '--disable-extensions'],
  })

  // ---------------- login guard ----------------
  section('[1] Route guard: /admin tanpa login')
  {
    await resetMock()
    const page = await getPage()
    await page.goto(`${APP}/admin`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="login-form"]', { timeout: 15000 })
    check(page.url().includes('/login'), 'diarahkan ke /login', page.url())
    check(
      page.url().includes('redirect=%2Fadmin') || page.url().includes('redirect=/admin'),
      'tujuan asli disimpan di query redirect',
      page.url(),
    )
    await page.close()
  }

  // ---------------- login salah ----------------
  section('[2] Login dengan kredensial salah')
  {
    const page = await getPage()
    await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' })
    await submitLogin(page, 'owner@test.local', 'password-salah')
    await page.waitForSelector('[data-testid="login-error"]', { timeout: 15000 })
    const msg = await page.$eval('[data-testid="login-error"]', (el) => el.textContent?.trim())
    check(Boolean(msg), `pesan error tampil: "${msg}"`)
    check(page.url().includes('/login'), 'tetap di halaman login')
    await page.close()
  }

  // ---------------- login owner ----------------
  section('[3] Login owner â†’ dashboard')
  {
    const page = await getPage()
    await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' })
    await submitLogin(page, 'owner@test.local', TEST_PASSWORD)
    await page.waitForFunction(() => location.pathname === '/owner', { timeout: 20000 })
    check(true, 'owner diarahkan ke /owner')
    const text = await page.evaluate(() => document.body.innerText)
    check(text.includes('owner@test.local'), 'email owner tampil di halaman')
    check(
      text.toUpperCase().includes('OWNER'),
      'peran owner tampil',
      text.slice(0, 200),
    )
    await page.close()
  }

  // ---------------- owner tidak boleh buka /owner sebagai admin ----------------
  section('[4] Admin tidak punya akses ke /owner')
  {
    await resetMock()
    const page = await getPage()
    await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' })
    await submitLogin(page, 'admin@test.local', TEST_PASSWORD)
    // Admin punya password sementara â†’ harus dipaksa ganti password dulu.
    await page.waitForFunction(() => location.pathname === '/change-password', { timeout: 20000 })
    check(true, 'admin dengan password sementara dipaksa ganti password')
    const forced = await page.$('[data-testid="force-notice"]')
    check(forced !== null, 'peringatan password sementara tampil')

    // Coba akses /owner secara langsung â€” harus tetap terkunci.
    await page.goto(`${APP}/owner`, { waitUntil: 'domcontentloaded' })
    await page
      .waitForFunction(() => location.pathname === '/change-password', { timeout: 25000 })
      .catch(() => {})
    check(
      page.url().includes('/change-password'),
      '/owner tetap terkunci selama password belum diganti',
      page.url(),
    )

    // Setelah reload, guard memulihkan sesi lewat /api/auth/refresh. Pastikan
    // flag mustChangePassword ikut terpulihkan di sana — kalau tidak, sesi
    // yang sudah di-refresh terlihat "aman" dan /owner bisa dibuka.
    await page.goto(`${APP}/admin`, { waitUntil: 'domcontentloaded' })
    await page
      .waitForFunction(() => location.pathname === '/change-password', { timeout: 25000 })
      .catch(() => {})
    check(
      page.url().includes('/change-password'),
      'flag mustChangePassword bertahan setelah refresh sesi',
      page.url(),
    )
    await page.close()
  }

  // ---------------- ganti password ----------------
  section('[5] Ganti password')
  {
    const page = await getPage()
    await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' })
    await submitLogin(page, 'admin@test.local', TEST_PASSWORD)
    await page.waitForSelector('[data-testid="change-password-form"]', { timeout: 20000 })

    // validasi konfirmasi
    await page.type('[data-testid="current-password"]', TEST_PASSWORD)
    await page.type('[data-testid="new-password"]', 'PasswordBaru456!')
    await page.type('[data-testid="confirm-password"]', 'TidakCocok')
    await page.waitForSelector('[data-testid="confirm-password-error"]', { timeout: 5000 })
    check(true, 'error konfirmasi tidak cocok tampil')
    const disabled = await page.$eval(
      '[data-testid="change-password-submit"]',
      (el) => el.disabled,
    )
    check(disabled, 'tombol submit nonaktif saat validasi gagal')

    // password terlalu pendek
    await page.$eval('[data-testid="new-password"]', (el) => {
      el.value = ''
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.type('[data-testid="new-password"]', 'pendek')
    await page.waitForSelector('[data-testid="new-password-error"]', { timeout: 5000 })
    check(true, 'error password terlalu pendek tampil')

    // submit yang benar
    await page.$eval('[data-testid="new-password"]', (el) => {
      el.value = ''
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.$eval('[data-testid="confirm-password"]', (el) => {
      el.value = ''
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.type('[data-testid="new-password"]', 'PasswordBaru456!')
    await page.type('[data-testid="confirm-password"]', 'PasswordBaru456!')
    await page.click('[data-testid="change-password-submit"]')
    await page.waitForSelector('[data-testid="password-changed"]', { timeout: 25000 })
    check(true, 'sukses: password diganti')

    await page.click('[data-testid="password-continue"]')
    await page.waitForFunction(() => location.pathname === '/admin', { timeout: 15000 })
    check(true, 'setelah ganti password, sampai ke /admin')
    await page.close()
  }

  // ---------------- password baru berlaku ----------------
  section('[6] Password baru berlaku, yang lama ditolak')
  {
    await resetMock()
    // Reset mengembalikan fixture ke kondisi awal supaya setiap seksi test
    // tidak bergantung pada test sebelumnya.
    const page = await getPage()
    await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' })
    await submitLogin(page, 'admin@test.local', TEST_PASSWORD)
    await page.waitForFunction(() => location.pathname === '/change-password', { timeout: 20000 })
    check(true, 'setelah reset mock, password lama kembali berlaku (test terisolasi)')
    await page.close()
  }

  // ---------------- admin tidak boleh buka /owner setelah ganti password ----------------
  section('[7] Admin selesai ganti password â†’ /owner tetap menolak')
  {
    const page = await getPage()
    await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' })
    await submitLogin(page, 'admin@test.local', TEST_PASSWORD)
    await page.waitForSelector('[data-testid="change-password-form"]', { timeout: 20000 })
    await page.type('[data-testid="current-password"]', TEST_PASSWORD)
    await page.type('[data-testid="new-password"]', 'PasswordAdmin456!')
    await page.type('[data-testid="confirm-password"]', 'PasswordAdmin456!')
    await page.click('[data-testid="change-password-submit"]')
    await page.waitForSelector('[data-testid="password-changed"]', { timeout: 25000 })

    await page.click('[data-testid="password-continue"]')
    await page.waitForFunction(() => location.pathname === '/admin', { timeout: 15000 })

    await page.goto(`${APP}/owner`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => location.pathname === '/admin', { timeout: 15000 })
    check(page.url().endsWith('/admin'), 'admin dialihkan dari /owner ke /admin', page.url())
    await page.close()
  }

  // ---------------- sesi bertahan setelah refresh ----------------
  section('[8] Sesi bertahan setelah refresh halaman')
  {
    const page = await getPage()
    await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' })
    await submitLogin(page, 'owner@test.local', TEST_PASSWORD)
    await page.waitForFunction(() => location.pathname === '/owner', { timeout: 20000 })

    await page.goto(`${APP}/owner`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.body.innerText.includes('owner@test.local'), {
      timeout: 15000,
    })
    check(true, 'sesi owner bertahan setelah reload (cookie bekerja)')
    await page.close()
  }

  // ---------------- logout ----------------
  section('[9] Logout')
  {
    const page = await getPage()
    await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' })
    await submitLogin(page, 'owner@test.local', TEST_PASSWORD)
    await page.waitForFunction(() => location.pathname === '/owner', { timeout: 20000 })

    // Owner berada di halaman pengaturan, yang memakai testid `owner-logout`.
    await page.click('[data-testid="owner-logout"]')
    await page.waitForFunction(() => location.pathname === '/login', { timeout: 15000 })
    check(true, 'logout kembali ke halaman login')

    await page.goto(`${APP}/owner`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="login-form"]', { timeout: 15000 })
    check(page.url().includes('/login'), 'sesi tidak bisa dipakai lagi setelah logout', page.url())
    await page.close()
  }

  // ---------------- halaman login tidak bisa diakses saat sudah login ----------------
  section('[10] Redirect /login saat sudah terautentikasi')
  {
    const page = await getPage()
    await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' })
    await submitLogin(page, 'owner@test.local', TEST_PASSWORD)
    await page.waitForFunction(() => location.pathname === '/owner', { timeout: 20000 })

    await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => location.pathname === '/owner', { timeout: 15000 })
    check(page.url().endsWith('/owner'), '/login mengarahkan ke beranda peran', page.url())
    await page.close()
  }

  section('[11] Error console')
  // 401 dari /api/auth/me dan /api/auth/refresh adalah perilaku yang diharapkan:
  // halaman login mencoba memulihkan sesi padahal memang belum login. Browser
  // tetap mencatatnya di console, jadi diabaikan di sini.
  const realErrors = consoleErrors.filter(
    (e) => !/status of 401/.test(e) && !/Unauthorized/.test(e),
  )
  check(
    realErrors.length === 0,
    realErrors.length === 0
      ? `tidak ada error console tak terduga (${consoleErrors.length - realErrors.length} error 401 yang diharapkan)`
      : `error console: ${realErrors.slice(0, 5).join(' | ')}`,
  )
} catch (err) {
  console.error('\nFATAL:', err)
  results.fail.push(`fatal: ${err.message}`)
} finally {
  if (browser) await browser.close()
  stopAll()
  if (devVarsExisted && devVarsBackup !== null) writeFileSync(devVarsPath, devVarsBackup)
  else if (existsSync(devVarsPath)) rmSync(devVarsPath)
  mockPg.close()
  await new Promise((r) => setTimeout(r, 2500))

  console.log(`\n${'='.repeat(58)}`)
  console.log(`  ${results.pass} lulus, ${results.fail.length} gagal`)
  if (results.fail.length) {
    console.log('\n  Gagal:')
    for (const f of results.fail) console.log(`    - ${f}`)
  }
  exitCode = results.fail.length === 0 ? 0 : 1
}

process.exit(exitCode)
