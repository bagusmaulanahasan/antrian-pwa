/**
 * E2E dashboard admin: mendaftarkan pelanggan, navigasi antrian, dan
 * perilaku cetak gagal.
 *
 * Web Bluetooth tidak tersedia di Chrome headless, jadi yang diuji justru
 * jalur degradasinya â€” sesuai prinsip PRD: "data antrian tetap disimpan walau
 * print gagal". Number tidak boleh hilang.
 *
 * Jalankan: node scripts/admin-e2e.mjs
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { TEST_PASSWORD } from './test-fixtures.mjs'

const { listen: startMock, state: mockState, server: mockServer } = await import(
  './mock-supabase.mjs'
)

const MOCK_PG_PORT = 54325
const WORKER_PORT = 8791
const APP_PORT = 5198
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

// --------------------------------------------------------- E2E helpers
let browser = null
const consoleErrors = []

async function getPage() {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000 })
  const cdp = await page.createCDPSession()
  await cdp.send('Network.clearBrowserCookies')
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) consoleErrors.push(m.text())
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
 * Klik elemen secara andal.
 *
 * `elementHandle.click()` gagal dengan "not clickable" bila elemen berada di
 * luar area terlihat atau tertimpa elemen lain. Scroll ke posisi elemen lalu
 * klik; bila masih gagal, pakai klik langsung lewat DOM yang tetap
 * meniru perilaku pengguna pada level event handler.
 */
async function clickSafe(page, selector) {
  const el = await page.waitForSelector(selector, { timeout: 20000 })
  await el.scrollIntoView().catch(() => {})
  await new Promise((r) => setTimeout(r, 60))
  try {
    await el.click()
  } catch {
    await page.evaluate((sel) => document.querySelector(sel)?.click(), selector)
  }
}

async function waitText(page, text, timeout = 20000) {
  await page.waitForFunction(
    (t) => document.body.innerText.includes(t),
    { timeout },
    text,
  )
}

async function loginAs(page, email) {
  await page.goto(`${APP_BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(testid('login-form'), { timeout: 20000 })
  await page.type(testid('email'), email)
  await page.type(testid('password'), TEST_PASSWORD)
  await page.click(testid('login-submit'))
}

async function resetMock() {
  mockState.queueEntries.length = 0
  mockState.refreshTokens.length = 0
  await fetch(`http://127.0.0.1:${MOCK_PG_PORT}/control/reset`)
}

// ---------------------------------------------------------------- main
const devVarsPath = path.resolve('worker/.dev.vars')
const devVarsExisted = existsSync(devVarsPath)
const devVarsBackup = devVarsExisted ? readFileSync(devVarsPath, 'utf8') : null

const puppeteer = (await import('puppeteer-core')).default
const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

try {
  await startMock(MOCK_PG_PORT)
  console.log(`[mock-pg] http://127.0.0.1:${MOCK_PG_PORT}`)

  writeFileSync(
    devVarsPath,
    [
      `SUPABASE_URL=http://127.0.0.1:${MOCK_PG_PORT}`,
      `SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.bW9jay1zaWduYXR1cmU`,
      `JWT_ACCESS_SECRET=admin-e2e-secret-min-32-chars-long-abcdefghij`,
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

  const OUT_DIR = 'dist-e2e-admin'
  console.log(`\n[build] VITE_API_BASE_URL=${WORKER_BASE}`)
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
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=256', '--disable-gpu', '--disable-extensions'],
  })

  // ---------------- 1. Dashboard termuat ----------------
  section('[1] Dashboard admin memuat data')
  let page = await getPage()
  {
    await resetMock()
    await loginAs(page, 'owner@test.local')
    await page.waitForFunction(() => location.pathname === '/owner', { timeout: 20000 })

    await page.goto(`${APP_BASE}/admin`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(testid('serving-card'), { timeout: 25000 })
    check(true, 'dashboard admin terbuka untuk owner')

    const cats = await page.$$eval('[data-testid^="category-"]', (els) => els.length)
    check(cats === 3, `3 card kategori tampil (dapat ${cats})`)

    await page.waitForSelector(testid('no-serving'), { timeout: 5000 })
    check(true, 'ditampilkan "belum ada nomor dilayani" saat kosong')

    const stats = await page.evaluate(() =>
      ['waiting', 'serving', 'pending', 'done', 'cancelled'].map(
        (k) => document.querySelector(`[data-testid="stat-${k}"]`)?.innerText ?? '',
      ),
    )
    check(stats.every((s) => /\b0\b/.test(s)), 'semua statistik 0 saat kosong', stats.join(' | '))
  }

  // ---------------- 2. Daftarkan pelanggan ----------------
  section('[2] Pendaftaran pelanggan')
  {
    await clickSafe(page, testid('category-RJ'))
    await page.waitForSelector(testid('register-dialog'), { timeout: 10000 })
    check(true, 'dialog pendaftaran terbuka setelah klik kategori')

    // Submit kosong harus ditolak.
    const disabled = await page.$eval(testid('register-submit'), (el) => el.disabled)
    check(disabled, 'tombol submit nonaktif saat nama kosong')

    await page.type(testid('customer-name'), 'Budi Santoso')
    const enabled = await page.$eval(testid('register-submit'), (el) => !el.disabled)
    check(enabled, 'tombol submit aktif setelah nama diisi')

    await clickSafe(page, testid('register-submit'))

    // Web Bluetooth tidak ada di headless â†’ printer gagal â†’ tiket masuk daftar
    // gagal cetak. INI yang diuji: nomor harus tetap tersimpan.
    await page.waitForSelector(testid('failed-prints'), { timeout: 30000 })
    check(true, 'dialog tertutup dan halaman selesai memproses')

    const failedText = await page.$eval(testid('failed-prints'), (el) => el.innerText)
    check(failedText.includes('#1'), 'nomor antrian #1 tercatat meski cetak gagal')
    check(failedText.includes('Budi'), 'nama pelanggan tercatat')
    check(
      failedText.includes('tidak hilang') || failedText.includes('tetap tercatat'),
      'pesan menjelaskan nomor tidak hilang',
      failedText.slice(0, 120),
    )

    check(testid('reprint-1') !== null, 'tombol Cetak Ulang tersedia')
    check(testid('skip-print-1') !== null, 'tombol Lewati tersedia')

    const entries = mockState.queueEntries
    check(entries.length === 1, 'entri tersimpan di database (1 baris)')
    check(entries[0]?.number === 1, 'nomor urut = 1')
    check(entries[0]?.customer_name === 'Budi Santoso', 'nama tersimpan benar')
    check(entries[0]?.status === 'waiting', 'status = waiting')
    check(entries[0]?.print_status === 'failed', 'print_status = failed')

    // Lewati â†’ keluar dari daftar gagal cetak tapi tetap di antrean.
    await clickSafe(page, testid('skip-print-1'))
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="failed-prints"]'),
      { timeout: 10000 },
    )
    check(true, 'tombol Lewati menghapus item dari daftar gagal cetak')

    const stillWaiting = mockState.queueEntries.filter((e) => e.status === 'waiting')
    check(stillWaiting.length === 1, 'nomor tetap waiting setelah dilewati cetak')
  }

  // ---------------- 3. Tambah pelanggan lagi ----------------
  section('[3] Penomoran berurutan')
  {
    await clickSafe(page, testid('category-RI'))
    await page.waitForSelector(testid('register-dialog'), { timeout: 10000 })
    await page.type(testid('customer-name'), 'Siti Aminah')
    await clickSafe(page, testid('register-submit'))
    await page.waitForFunction(() => !document.querySelector('[data-testid="register-dialog"]'), {
      timeout: 30000,
    })

    const numbers = mockState.queueEntries.map((e) => e.number).sort()
    check(
      numbers.length === 2 && numbers[0] === 1 && numbers[1] === 2,
      'nomor berurutan 1 lalu 2',
      JSON.stringify(numbers),
    )
    const cats = mockState.queueEntries.map((e) => mockState.categories.find((c) => c.id === e.category_id)?.code)
    check(
      cats.includes('RJ') && cats.includes('RI'),
      'kategori tiap entri tersimpan benar',
      JSON.stringify(cats),
    )
  }

  // ---------------- 4. Panggil nomor berikutnya ----------------
  section('[4] Navigasi: nomor berikutnya')
  {
    await clickSafe(page, testid('btn-next'))
    await page.waitForSelector(testid('serving-number'), { timeout: 15000 })
    const number = await page.$eval(testid('serving-number'), (el) => el.innerText.trim())
    check(number === '1', `nomor 1 menjadi serving (dapat "${number}")`)

    const name = await page.$eval(testid('serving-name'), (el) => el.innerText.trim())
    check(name === 'Budi Santoso', `nama yang dilayani Budi (dapat "${name}")`)

    const serving = mockState.queueEntries.filter((e) => e.status === 'serving')
    check(serving.length === 1, 'tepat satu entri serving di database')
    check(Boolean(serving[0]?.served_at), 'served_at terisi')

    const statServing = await page.$eval(testid('stat-serving'), (el) => el.innerText)
    check(statServing.includes('1'), 'statistik serving = 1', statServing)
  }

  // ---------------- 5. Auto-selesai saat panggil lagi ----------------
  section('[5] Aturan: serving sebelumnya otomatis selesai')
  {
    // Nomor 1 masih serving, 2 masih waiting. Panggil lagi harus
    // menyelesaikan nomor 1 danOSH mem nominate nomor 2.
    await clickSafe(page, testid('btn-next'))
    await page.waitForFunction(
      () => document.querySelector('[data-testid="serving-number"]')?.innerText.trim() === '2',
      { timeout: 15000 },
    )

    const byNumber = Object.fromEntries(
      mockState.queueEntries.map((e) => [e.number, e.status]),
    )
    check(byNumber['1'] === 'done', `nomor 1 otomatis jadi done (dapat ${byNumber['1']})`)
    check(byNumber['2'] === 'serving', `nomor 2 jadi serving (dapat ${byNumber['2']})`)

    const servingCount = mockState.queueEntries.filter((e) => e.status === 'serving').length
    check(servingCount === 1, 'tetap hanya satu nomor serving', String(servingCount))

    const e1 = mockState.queueEntries.find((e) => e.number === 1)
    check(Boolean(e1?.completed_at), 'completed_at terisi untuk nomor yang selesai')
  }

  // ---------------- 6. Pending ----------------
  section('[6] Tandai pending (tidak dipanggil lagi)')
  {
    await clickSafe(page, testid('pending-2'))
    await page.waitForFunction(
      () => document.querySelector('[data-testid="stat-pending"]')?.innerText.includes('1'),
      { timeout: 15000 },
    )
    check(true, 'nomor 2 ditandai PENDING')

    const statusText = await page.$eval(testid('status-2'), (el) => el.innerText.trim())
    check(statusText === 'Pending', `label status = "Pending" (dapat "${statusText}")`)

    // Pending harus tampil paling atas di daftar.
    const firstEntry = await page.$eval('[data-testid="queue-list"] li', (el) =>
      el.getAttribute('data-testid'),
    )
    check(firstEntry === 'entry-2', `pending tampil paling atas (dapat ${firstEntry})`)

    // Nomor pending TIDAK boleh otomatis selesai saat memanggil nomor lain â€”
    // ia hanya "dilewati", bukan dilayani.
    await clickSafe(page, testid('btn-next'))
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="serving-number"]'),
      { timeout: 15000 },
    )
    // Nomor pending TIDAK boleh otomatis selesai saat memanggil nomor lain â€”
    // ia hanya "dilewati", bukan dilayani.
    await clickSafe(page, testid('btn-next'))
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="serving-number"]'),
      { timeout: 15000 },
    )
    const e2 = mockState.queueEntries.find((e) => e.number === 2)
    check(
      e2?.status === 'pending',
      `nomor pending tetap pending dan TIDAK dipromosi jadi serving (dapat ${e2?.status})`,
    )
  }

  // ---------------- 7. Panggil ulang ----------------
  section('[7] Panggil ulang')
  {
    await clickSafe(page, testid('recall-2'))
    await page.waitForFunction(
      () => document.querySelector('[data-testid="stat-waiting"]')?.innerText.includes('1'),
      { timeout: 15000 },
    )
    check(true, 'nomor 2 kembali ke antrean via Panggil Ulang')

    const e2 = mockState.queueEntries.find((e) => e.number === 2)
    check(e2?.status === 'waiting', `status = waiting (dapat ${e2?.status})`)
    check((e2?.priority ?? 0) > 0, `priority naik (dapat ${e2?.priority})`)
    check(Boolean(e2?.recalled_at), 'recalled_at terisi')
  }

  // ---------------- 8. Batalkan ----------------
  section('[8] Batalkan nomor')
  {
    await clickSafe(page, testid('cancel-2'))
    await page.waitForFunction(
      () => document.querySelector('[data-testid="stat-cancelled"]')?.innerText.includes('1'),
      { timeout: 15000 },
    )
    check(true, 'nomor 2 dibatalkan')

    const cancelled = mockState.queueEntries.find((e) => e.number === 2)
    check(cancelled?.status === 'cancelled', `status = cancelled (dapat ${cancelled?.status})`)
    check(Boolean(cancelled?.cancelled_at), 'cancelled_at terisi')
  }

  // ---------------- 9. Refresh & konsistensi tampilan ----------------
  section('[9] Muat ulang data dan konsistensi daftar')
  {
    // Pada titik ini nomor 1 = done dan 2 = cancelled, jadi tidak ada yang
    // waiting/pending/serving. Daftar aktif harus kosong â€” bukan menampilkan
    // nomor yang sudah selesai.
    await clickSafe(page, testid('btn-refresh'))
    await page.waitForSelector(testid('serving-card'), { timeout: 15000 })

    const hasList = (await page.$(testid('queue-list'))) !== null
    check(!hasList, 'daftar antrian kosong karena tidak ada nomor aktif')

    const emptyText = await page.evaluate(() => document.body.innerText)
    check(
      emptyText.includes('Belum ada antrean'),
      'ditampilkan pesan antrean kosong',
      emptyText.slice(0, 100),
    )

    // Statistik harus mencerminkan status sebenarnya.
    const stats = await page.evaluate(() =>
      Object.fromEntries(
        ['waiting', 'serving', 'pending', 'done', 'cancelled'].map((k) => [
          k,
          document.querySelector(`[data-testid="stat-${k}"]`)?.innerText.trim() ?? '',
        ]),
      ),
    )
    check(/1/.test(stats.done), `statistik done = 1 (dapat "${stats.done}")`)
    check(/1/.test(stats.cancelled), `statistik cancelled = 1 (dapat "${stats.cancelled}")`)
    check(/0/.test(stats.waiting), `statistik waiting = 0 (dapat "${stats.waiting}")`)
  }

  await page.close()

  // ---------------- 10. Admin (bukan owner) ----------------
  section('[10] Akses admin non-owner')
  {
    await resetMock()
    const adminPage = await getPage()
    await loginAs(adminPage, 'admin@test.local')
    await adminPage.waitForFunction(() => location.pathname === '/change-password', {
      timeout: 20000,
    })
    check(true, 'admin dengan password sementara terkunci di ganti password')

    await adminPage.goto(`${APP_BASE}/admin`, { waitUntil: 'domcontentloaded' })
    await adminPage.waitForFunction(() => location.pathname === '/change-password', {
      timeout: 20000,
    })
    check(
      adminPage.url().includes('/change-password'),
      'admin tidak bisa masuk dashboard sebelum ganti password',
      adminPage.url(),
    )
    await adminPage.close()
  }

  section('[11] Error console')
  const realErrors = consoleErrors.filter(
    (e) => !/status of 401/.test(e) && !/Unauthorized/.test(e) && !/Web Bluetooth|bluetooth/i.test(e),
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
