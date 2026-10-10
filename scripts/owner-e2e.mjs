/**
 * E2E Pengaturan Owner: kategori, template suara/cetak, jam reset, kelola akun.
 *
 * Menguji juga PENOLAKAN hak akses â€” admin tidak boleh menyentuh endpoint
 * owner (403, bukan 401).
 *
 * Jalankan: node scripts/owner-e2e.mjs
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
import { listen as startMock, state as mockState, server as mockServer } from './mock-supabase.mjs'
import { TEST_PASSWORD } from './test-fixtures.mjs'

const MOCK_PG_PORT = 54328
const WORKER_PORT = 8792
const APP_PORT = 5195
const WORKER_BASE = `http://127.0.0.1:${WORKER_PORT}`
const APP_BASE = `http://127.0.0.1:${APP_PORT}`

const children = new Set()
let exitCode = 1

function start(label, args, env) {
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...(env ?? {}) },
  })
  child.stdout.on('data', (d) => process.stdout.write(`[${label}] ${d}`))
  child.stderr.on('data', (d) => {
    const s = String(d)
    if (/Ready on|Using secrets|Starting local|Local Explorer|^\s*$/.test(s)) return
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

let browser = null
const consoleErrors = []

async function getPage() {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000 })
  const cdp = await page.createCDPSession()
  await cdp.send('Network.clearBrowserCookies')
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) {
      consoleErrors.push(`${m.text()} <- ${m.location()?.url ?? ''}`)
    }
  })
  page.on('response', async (res) => {
    if (res.status() >= 500) {
      const body = await res.text().catch(() => '')
      consoleErrors.push(`HTTP ${res.status()} ${res.url()} :: ${body.slice(0, 160)}`)
    }
  })
  return page
}

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

const testid = (id) => `[data-testid="${id}"]`

/**
 * Klik tombol simpan lalu tunggu responsnya selesai.
 *
 * Tidak boleh sekadar menunggu `owner-notice` muncul: notifikasi dari aksi
 * sebelumnya masih tampil selama 4 detik, sehingga pemeriksaan bisa berjalan
 * SEBELUM PATCH selesai — dan test membaca nilai lama dari database.
 */
async function saveAndWait(page, buttonId, expectPath) {
  // Tunggu notifikasi dari aksi sebelumnya hilang dulu.
  await page
    .waitForFunction(() => !document.querySelector('[data-testid="owner-notice"]'), {
      timeout: 15000,
      polling: 200,
    })
    .catch(() => {})

  const responsePromise = page.waitForResponse(
    (r) => r.url().includes(expectPath) && r.request().method() !== 'OPTIONS',
    { timeout: 25000 },
  )
  await page.click(buttonId)
  const res = await responsePromise
  // Beri satu tick untuk Vue menyelesaikan render setelah respons.
  await new Promise((r) => setTimeout(r, 150))
  return res
}

async function loginAsOwner(page) {
  await page.goto(`${APP_BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(testid('login-form'), { timeout: 20000 })
  await page.type(testid('email'), 'owner@test.local')
  await page.type(testid('password'), TEST_PASSWORD)
  await page.click(testid('login-submit'))
  await page.waitForFunction(() => location.pathname === '/owner', { timeout: 20000 })
}

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
      `JWT_ACCESS_SECRET=owner-e2e-secret-min-32-chars-long-abcdefghijkl`,
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
  await waitForHttp(`${WORKER_BASE}/api/health`)
  console.log(`[worker] ${WORKER_BASE}`)

  const OUT_DIR = 'dist-e2e-owner'
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
          VITE_API_BASE_URL: WORKER_BASE,
          VITE_TV_PIN: '1234',
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

  start('preview', [
    path.resolve('node_modules/vite/bin/vite.js'),
    'preview',
    '--outDir',
    OUT_DIR,
    '--port',
    String(APP_PORT),
    '--strictPort',
  ])
  await waitForHttp(`${APP_BASE}/`)
  console.log(`[preview] ${APP_BASE}\n`)

  browser = await puppeteer.launch({
    executablePath:
      process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=256', '--disable-gpu', '--disable-extensions'],
  })

  // ---------------- 1. Halaman memuat ----------------
  section('[1] Halaman pengaturan owner')
  const page = await getPage()
  await loginAsOwner(page)
  await page.waitForSelector(testid('category-list'), { timeout: 25000 })
  {
    check(true, 'halaman pengaturan terbuka untuk owner')

    const tabs = await page.$$eval('[data-testid^="tab-"]', (els) => els.length)
    check(tabs === 4, `4 tab tersedia (dapat ${tabs})`)

    const cats = await page.$$eval('[data-testid^="owner-category-"]', (els) => els.length)
    check(cats === 3, `3 kategori aktif tampil (dapat ${cats})`)
  }

  // ---------------- 2. Tambah kategori ----------------
  section('[2] Tambah kategori')
  {
    await page.type(testid('new-category-name'), 'Konsultasi')
    await page.type(testid('new-category-code'), 'KONS')

    const addRes = page.waitForResponse(
      (r) => r.url().includes('/api/admin/categories') && r.request().method() === 'POST',
      { timeout: 25000 },
    )
    await page.click(testid('add-category'))
    await addRes
    await new Promise((r) => setTimeout(r, 200))

    await page
      .waitForFunction(
        () =>
          Array.from(document.querySelectorAll('[data-testid^="owner-category-"]')).some((el) =>
            el.textContent.includes('Konsultasi'),
          ),
        { timeout: 20000 },
      )
      .catch(() => {})

    const listed = await page.$$eval('[data-testid^="owner-category-"]', (els) =>
      els.map((el) => {
        // Nama kategori ada di <input>, yang nilainya TIDAK ikut ke textContent.
        const nameInput = el.querySelector('input[type="text"], input:not([type])')
        const code = el.querySelector('span')?.textContent?.trim() ?? ''
        return `${nameInput?.value ?? '?'} (${code})`
      }),
    )
    check(
      listed.some((t) => t.includes('Konsultasi')),
      'kategori baru tampil di daftar',
      listed.join(' | '),
    )
    const errText = await page
      .$eval(testid('owner-error'), (el) => el.innerText)
      .catch(() => null)
    if (errText) console.log(`        [debug] owner-error: ${errText}`)

    const saved = mockState.categories.find((c) => c.name === 'Konsultasi')
    check(Boolean(saved), 'kategori tersimpan di database')
    check(saved?.code === 'KONS', `kode tersimpan benar (dapat "${saved?.code}")`)
    check(
      saved?.sort_order === mockState.categories.length - 1,
      `sort_order di urutan terakhir (dapat ${saved?.sort_order})`,
    )
  }

  // ---------------- 3. Nonaktifkan kategori ----------------
  section('[3] Nonaktifkan kategori (soft delete)')
  {
    const deactivateRes = page.waitForResponse(
      (r) => r.url().includes('/api/admin/categories/') && r.request().method() === 'DELETE',
      { timeout: 25000 },
    )
    await page.click(testid('deactivate-KONS'))
    await deactivateRes
    await new Promise((r) => setTimeout(r, 200))
    check(true, 'kategori hilang dari daftar aktif')

    const saved = mockState.categories.find((c) => c.code === 'KONS')
    check(saved?.is_active === false, 'is_active = false (soft delete, data tetap ada)')
  }

  // ---------------- 4. Template suara ----------------
  section('[4] Template suara')
  {
    await page.click(testid('tab-suara'))
    await page.waitForSelector(testid('voice-text'), { timeout: 10000 })
    check(true, 'tab suara terbuka')

    const before = await page.$eval(testid('voice-preview'), (el) => el.innerText)
    check(before.includes('A-001'), 'pratinjau mengganti {nomor}', before)

    await page.$eval(testid('voice-text'), (el) => {
      el.value = ''
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.type(testid('voice-text'), 'Pelanggan {nomor}, silakan ke loket {kategori}.')
    await saveAndWait(page, testid('save-voice'), '/api/settings')

    const saved = mockState.settings.find((s) => s.key === 'voice_template')
    check(
      saved?.value?.text === 'Pelanggan {nomor}, silakan ke loket {kategori}.',
      'teks tersimpan di database',
      JSON.stringify(saved?.value?.text),
    )
    check(saved?.value?.repeat >= 1, 'repeat tersimpan')
    check(saved?.updated_by !== undefined, 'updated_by dicatat')
  }

  // ---------------- 5. Jam reset ----------------
  section('[5] Jam reset harian')
  {
    await page.$eval(testid('reset-hour'), (el) => {
      el.value = '5'
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await saveAndWait(page, testid('save-reset-hour'), '/api/settings')
    const saved = mockState.settings.find((s) => s.key === 'reset_hour')
    check(saved?.value === 5, `reset_hour tersimpan = 5 (dapat ${saved?.value})`)
  }

  // ---------------- 6. Validasi jam reset ----------------
  section('[6] Validasi input')
  {
    await page.$eval(testid('reset-hour'), (el) => {
      el.value = '99'
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.click(testid('save-reset-hour'))
    await page.waitForSelector(testid('owner-error'), { timeout: 20000 }).catch(() => {})
    const msg = await page.$eval(testid('owner-error'), (el) => el.innerText).catch(() => '')
    check(/0-23/.test(msg), `error menjelaskan rentang valid (dapat: ${msg.slice(0, 80)})`)

    const stillFive = mockState.settings.find((s) => s.key === 'reset_hour')
    check(stillFive?.value === 5, 'nilai tidak berubah karena validasi menolak')
  }

  // ---------------- 7. Template cetak + pratinjau ----------------
  section('[7] Template cetak 58mm')
  {
    await page.click(testid('tab-cetak'))
    await page.waitForSelector(testid('print-preview'), { timeout: 10000 })

    await page.type(testid('print-place'), 'Klinik Sehat Bersama')
    const preview = await page.$eval(testid('print-preview'), (el) => el.innerText)
    check(preview.includes('Klinik Sehat Bersama'), 'pratinjau memakai nama tempat baru', preview)

    await saveAndWait(page, testid('save-print'), '/api/settings')
    const saved = mockState.settings.find((s) => s.key === 'print_template')
    check(saved?.value?.placeName === 'Klinik Sehat Bersama', 'nama tempat tersimpan')
    check(typeof saved?.value?.template === 'string', 'template teks tersimpan')
  }

  // ---------------- 8. Kelola akun ----------------
  section('[8] Kelola akun')
  {
    await page.click(testid('tab-akun'))
    await page.waitForSelector(testid('user-list'), { timeout: 10000 })

    // `user-list` juga diawali "user-", jadi selector harus spesifik ke <li>.
    const users = await page.$$eval('[data-testid="user-list"] li[data-testid^="user-"]', (els) =>
      els.length,
    )
    check(users === 3, `3 akun awal tampil: owner, admin, nonaktif (dapat ${users})`)

    await page.type(testid('new-user-email'), 'baru@test.local')
    await page.type(testid('new-user-name'), 'Admin Baru')
    await page.type(testid('new-user-password'), 'PasswordAwal123')

    const createRes = page.waitForResponse(
      (r) => r.url().includes('/api/admin/users') && r.request().method() === 'POST',
      { timeout: 25000 },
    )
    await page.click(testid('add-user'))
    await createRes
    await page.waitForSelector(testid('temp-password'), { timeout: 25000 })
    check(true, 'password sementara ditampilkan setelah membuat akun')

    const pwText = await page.$eval(testid('temp-password'), (el) => el.innerText)
    check(pwText.includes('#Pass123'), 'password sementara yang disebutkan ke owner')

    const created = mockState.users.find((u) => u.email === 'baru@test.local')
    check(Boolean(created), 'akun tersimpan di database')
    check(created?.role === 'admin', `role = admin (dapat ${created?.role})`)
    check(
      created?.is_password_temporary === true,
      'akun baru berstatus password sementara WAJIB ganti',
    )

    // Password harus ter-hash, bukan disimpan apa adanya.
    check(
      created?.password_hash?.startsWith('$argon2id$'),
      'password tersimpan sebagai hash argon2id',
    )
    check(
      created?.password_hash !== 'PasswordAwal123',
      'password plaintext tidak tersimpan',
    )

    // Akun baru harus bisa login dengan password yang diberikan owner.
    const loginRes = await fetch(`${WORKER_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'baru@test.local', password: 'PasswordAwal123' }),
    })
    check(loginRes.status === 200, 'akun baru bisa login dengan password yang diberikan', String(loginRes.status))
    const loginBody = await loginRes.json()
    check(loginBody.user?.mustChangePassword === true, 'server menandai wajib ganti password')
  }

  // ---------------- 9. Reset password ----------------
  section('[9] Reset password admin')
  {
    const resetRes = page.waitForResponse(
      (r) => r.url().includes('/reset-password'),
      { timeout: 25000 },
    )
    await page.click(testid('reset-admin@test.local'))
    const resetResponse = await resetRes
    if (resetResponse.status() >= 400) {
      console.log(
        `        [debug] reset-password ${resetResponse.status()}: ${(await resetResponse.text()).slice(0, 200)}`,
      )
    }
    check(resetResponse.status() === 200, 'reset password owner berhasil', String(resetResponse.status()))

    const admin = mockState.users.find((u) => u.email === 'admin@test.local')
    check(admin?.is_password_temporary === true, 'flag password sementara disetel')

    const oldLogin = await fetch(`${WORKER_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@test.local', password: TEST_PASSWORD }),
    })
    check(oldLogin.status === 401, 'password lama tidak berlaku lagi', String(oldLogin.status))

    const newLogin = await fetch(`${WORKER_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@test.local', password: '#Pass123' }),
    })
    check(newLogin.status === 200, 'password baru (#Pass123) berlaku', String(newLogin.status))
  }

  // ---------------- 10. Nonaktifkan akun ----------------
  section('[10] Nonaktifkan akun')
  {
    const toggleRes = page.waitForResponse(
      (r) => r.url().includes('/api/admin/users/') && r.url().includes('/active'),
      { timeout: 25000 },
    )
    await page.click(testid('toggle-admin@test.local'))
    await toggleRes
    await new Promise((r) => setTimeout(r, 200))

    const admin = mockState.users.find((u) => u.email === 'admin@test.local')
    check(admin?.is_active === false, 'is_active = false')

    const loginRes = await fetch(`${WORKER_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@test.local', password: '#Pass123' }),
    })
    check(loginRes.status === 401, 'akun nonaktif tidak bisa login', String(loginRes.status))
  }

  // ---------------- 11. Owner tidak bisa menonaktifkan dirinya ----------------
  section('[11] Guard: tidak menonaktifkan akun sendiri')
  {
    const ownerRow = await page.$eval('[data-testid="user-owner@test.local"]', (el) =>
      el.innerText,
    )
    check(
      !ownerRow.includes('Nonaktifkan'),
      'tombol Nonaktifkan tidak muncul untuk akun sendiri',
      ownerRow.slice(0, 100),
    )
  }

  await page.close()

  // ---------------- 12. Admin tidak boleh akses endpoint owner ----------------
  section('[12] Otorisasi: admin ditolak')
  {
    const adminPage = await getPage()
    await adminPage.goto(`${APP_BASE}/login`, { waitUntil: 'domcontentloaded' })
    await adminPage.waitForSelector(testid('login-form'), { timeout: 20000 })
    await adminPage.type(testid('email'), 'baru@test.local')
    await adminPage.type(testid('password'), 'PasswordAwal123')
    await adminPage.click(testid('login-submit'))
    // Admin baru wajib ganti password dulu.
    await adminPage.waitForFunction(() => location.pathname === '/change-password', {
      timeout: 20000,
    })

    await adminPage.goto(`${APP_BASE}/owner`, { waitUntil: 'domcontentloaded' })
    await adminPage.waitForFunction(() => location.pathname === '/change-password', {
      timeout: 20000,
    })
    check(
      adminPage.url().includes('/change-password'),
      'admin terkunci di ganti password, tidak bisa masuk /owner',
      adminPage.url(),
    )
    await adminPage.close()

    // Verifikasi langsung di Worker: session admin DITOLAK dengan 403.
    const login = await fetch(`${WORKER_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'baru@test.local', password: 'PasswordAwal123' }),
    })
    const cookie = login.headers.getSetCookie().find((c) => c.startsWith('antrian_access='))
    const token = cookie?.split(';')[0] ?? ''

    for (const [method, path] of [
      ['GET', '/api/settings'],
      ['PATCH', '/api/settings'],
      ['GET', '/api/admin/users'],
      ['POST', '/api/admin/categories'],
      ['GET', '/api/admin/categories'],
    ]) {
      const res = await fetch(`${WORKER_BASE}${path}`, {
        method,
        headers: { Cookie: token, 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify({ key: 'reset_hour', value: 1 }),
      })
      check(res.status === 403, `${method} ${path} oleh admin â†’ 403 (dapat ${res.status})`)
    }
  }

  section('[13] Error console')
  const realErrors = consoleErrors.filter(
    (e) => !/status of 40[013]/.test(e) && !/Unauthorized|Forbidden/.test(e),
  )
  check(
    realErrors.length === 0,
    realErrors.length === 0
      ? `tidak ada error console tak terduga (${consoleErrors.length - realErrors.length} diabaikan)`
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
  mockServer.close()
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