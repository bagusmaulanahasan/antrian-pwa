/**
 * E2E Dashboard TV.
 *
 * TV tidak punya akun â€” ia membaca langsung dari Supabase memakai anon key.
 * Yang diuji:
 *   - layar kunci PIN benar-benar menahan dashboard
 *   - badge koneksi, nomor dilayani, dan urutan antrean (pending di atas)
 *   - pembaruan real-time saat ada perubahan data
 *   - tombol "Aktifkan Suara" (Web Speech API di Chrome headless)
 *
 * Jalankan: node scripts/tv-e2e.mjs
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
import { listen as startMock, state as mockState, server as mockServer } from './mock-supabase.mjs'

const MOCK_PG_PORT = 54326
const APP_PORT = 5197
const APP_BASE = `http://127.0.0.1:${APP_PORT}`
const PIN = '1234'

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
    if (/Ready on|Starting local|Local Explorer|^\s*$/.test(s)) return
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
  await page.setViewport({ width: 1920, height: 1080 })
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

/** Isi antrian langsung di state mock (melewati Worker â€” TV tidak memakainya). */
function seedQueue(entries) {
  mockState.queueEntries.length = 0
  for (const e of entries) mockState.queueEntries.push(e)
}

function makeEntry(number, status, name, categoryId, extra = {}) {
  return {
    id: `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`,
    queue_date: '',
    number,
    customer_name: name,
    category_id: categoryId,
    status,
    priority: 0,
    print_status: 'printed',
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
    ...extra,
  }
}

async function unlock(page, pin = PIN) {
  await page.waitForSelector(testid('tv-pin-input'), { timeout: 20000 })
  await page.type(testid('tv-pin-input'), pin)
  await page.click(testid('tv-pin-submit'))
}

try {
  await startMock(MOCK_PG_PORT)
  console.log(`[mock-pg] http://127.0.0.1:${MOCK_PG_PORT}`)

  // Tanggal antrian harus sama dengan yang dipakai frontend (WIB + reset 0).
  const queueDate = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)
  const catRJ = mockState.categories[0].id
  const catRI = mockState.categories[1].id

  seedQueue([
    makeEntry(1, 'serving', 'Budi Santoso', catRJ, { queue_date: queueDate }),
    makeEntry(2, 'waiting', 'Siti Aminah', catRI, { queue_date: queueDate }),
    makeEntry(3, 'pending', 'Andi Wijaya', catRJ, { queue_date: queueDate }),
    makeEntry(4, 'waiting', 'Dewi Lestari', catRI, { queue_date: queueDate }),
    makeEntry(5, 'done', 'Eko Prasetyo', catRJ, { queue_date: queueDate }),
  ])

  const OUT_DIR = 'dist-e2e-tv'
  console.log(`\n[build] mock supabase di ${MOCK_PG_PORT}`)
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
          // TV tidak butuh Worker - hanya Supabase.
          VITE_API_BASE_URL: '',
          VITE_TV_PIN: PIN,
          VITE_SUPABASE_URL: `http://127.0.0.1:${MOCK_PG_PORT}`,
          VITE_SUPABASE_ANON_KEY:
            'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.bW9jay1zaWduYXR1cmU',
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
    executablePath: process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=256', '--disable-gpu', '--disable-extensions'],
  })

  // ---------------- 1. Layar PIN ----------------
  section('[1] Kunci PIN')
  let page = await getPage()
  await page.goto(`${APP_BASE}/tv`, { waitUntil: 'domcontentloaded' })
  {
    await page.waitForSelector(testid('tv-pin-screen'), { timeout: 20000 })
    check(true, 'layar PIN tampil di /tv')

    const noDashboard = (await page.$(testid('tv-serving'))) === null
    check(noDashboard, 'dashboard belum tampil sebelum PIN dimasukkan')

    const submitEnabled = await page.$eval(testid('tv-pin-submit'), (el) => !el.disabled)
    check(submitEnabled, 'tombol buka aktif (PIN terkonfigurasi dari env)')

    // PIN salah harus ditolak.
    await unlock(page, '9999')
    await page.waitForSelector(testid('tv-pin-error'), { timeout: 10000 })
    check(true, 'PIN salah ditolak dengan pesan error')
    const stillLocked = (await page.$(testid('tv-serving'))) === null
    check(stillLocked, 'dashboard tetap terkunci setelah PIN salah')
  }

  // ---------------- 2. PIN benar ----------------
  section('[2] PIN benar & dashboard tampil')
  await page.reload({ waitUntil: 'domcontentloaded' })
  {
    await unlock(page)
    await page.waitForSelector(testid('tv-serving'), { timeout: 25000 })
    check(true, 'dashboard terbuka setelah PIN benar')

    const number = await page.$eval(testid('tv-serving-number'), (el) => el.innerText.trim())
    check(number === '1', `nomor dilayani = 1 (dapat "${number}")`)

    const name = await page.$eval(testid('tv-serving-name'), (el) => el.innerText.trim())
    check(name === 'Budi Santoso', `nama = Budi Santoso (dapat "${name}")`)

    const category = await page.$eval(testid('tv-serving-category'), (el) => el.innerText.trim())
    check(category === 'Rawat Jalan', `kategori = Rawat Jalan (dapat "${category}")`)
  }

  // ---------------- 3. Badge & status koneksi ----------------
  section('[3] Indikator koneksi')
  {
    // Badge tidak boleh menggantung di "Menghubungkanâ€¦" selamanya ketika
    // Realtime tidak tersedia â€” polling harus turun ke status yang jujur.
    await page
      .waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="tv-connection"]')
          if (!el) return false
          return !el.innerText.includes('Menghubungkan')
        },
        { timeout: 20000, polling: 300 },
      )
      .catch(() => {})

    const conn = await page.$eval(testid('tv-connection'), (el) =>
      el.innerText.replace(/\s+/g, ' ').trim(),
    )
    check(
      conn.includes('Terhubung'),
      `badge menunjukkan tersambung (dapat "${conn}")`,
    )
    check(
      !conn.includes('Menghubungkan'),
      'badge tidak menggantung di "Menghubungkanâ€¦" saat Realtime gagal',
      conn,
    )
    check(!conn.includes('Terputus'), 'badge tidak menunjukkan "Terputus" saat online')
  }

  // ---------------- 4. Urutan antrean ----------------
  section('[4] Urutan antrean (pending di atas)')
  {
    await page.waitForSelector(testid('tv-queue'), { timeout: 15000 })
    const ids = await page.$$eval('[data-testid="tv-queue"] li', (els) =>
      els.map((el) => el.getAttribute('data-testid')),
    )
    check(
      ids[0] === 'tv-entry-3',
      `nomor pending (3) tampil paling atas (dapat "${ids[0]}")`,
      ids.join(', '),
    )
    check(ids.includes('tv-entry-2'), 'nomor menunggu ikut tampil')
    check(ids.includes('tv-entry-4'), 'nomor menunggu kedua ikut tampil')
    check(
      !ids.includes('tv-entry-5'),
      'nomor selesai (done) tidak tampil di daftar',
      ids.join(', '),
    )

    const badges = await page.$$eval(testid('tv-pending-badge'), (els) => els.length)
    check(badges === 1, `tepat satu badge PENDING (dapat ${badges})`)

    const waitCount = await page.$eval(testid('tv-waiting-count'), (el) => el.innerText)
    check(/2/.test(waitCount), `jumlah menunggu = 2 (dapat "${waitCount.replace(/\s+/g, ' ')}")`)
  }

  // ---------------- 5. Tombol suara ----------------
  section('[5] Aktivasi suara')
  {
    const btn = await page.$(testid('tv-enable-voice'))
    check(btn !== null, 'tombol "Aktifkan Suara" tampil')

    if (btn) {
      await btn.click()
      await page
        .waitForSelector(testid('tv-disable-voice'), { timeout: 15000 })
        .catch(() => {})
      const active = (await page.$(testid('tv-disable-voice'))) !== null
      check(active, 'suara aktif â€” tombol berubah menjadi "Suara Aktif"')

      // Matikan lagi.
      const off = await page.$(testid('tv-disable-voice'))
      if (off) {
        await off.click()
        await page
          .waitForSelector(testid('tv-enable-voice'), { timeout: 10000 })
          .catch(() => {})
        check(
          (await page.$(testid('tv-enable-voice'))) !== null,
          'suara dapat dimatikan kembali',
        )
      }
    }
  }

  // ---------------- 6. Pembaruan real-time ----------------
  section('[6] Pembaruan saat data berubah')
  {
    // Tutup langganan lebih dulu supaya perubahan mock terlihat lewat reload
    // data yang dipicu Realtime ATAU polling â€” keduanya harus menampilkan
    // data terbaru, itu yang pengguna perceive sebagai "live".
    mockState.queueEntries[0].status = 'done'
    const newServing = makeEntry(6, 'serving', 'Rina Amelia', catRI, {
      queue_date: queueDate,
    })
    mockState.queueEntries.push(newServing)

    await page
      .waitForFunction(
        () =>
          document.querySelector('[data-testid="tv-serving-number"]')?.textContent?.trim() === '6',
        { timeout: 40000 },
      )
      .catch(() => {})
    const updated = await page.$eval(testid('tv-serving-number'), (el) => el.innerText.trim())
    check(updated === '6', `nomor dilayani ter-update ke 6 (dapat "${updated}")`)

    const updatedName = await page.$eval(testid('tv-serving-name'), (el) => el.innerText.trim())
    check(updatedName === 'Rina Amelia', `nama ter-update (dapat "${updatedName}")`)

    // Status badge masih hidup.
    const conn = await page.$eval(testid('tv-connection'), (el) => el.innerText)
    check(conn.includes('Terhubung'), 'koneksi tetap tersambung setelah pembaruan')
  }

  // ---------------- 7. Error saat data tidak terbaca ----------------
  section('[7] Kondisi gagal')
  {
    const errPage = await getPage()
    await errPage.goto(`${APP_BASE}/tv`, { waitUntil: 'domcontentloaded' })
    await unlock(errPage)
    // Matikan mock supaya request berikutnya gagal.
    mockServer.close()
    await errPage.reload({ waitUntil: 'domcontentloaded' })
    await unlock(errPage)
    await errPage
      .waitForSelector(testid('tv-error'), { timeout: 20000 })
      .catch(() => {})
    const errVisible = (await errPage.$(testid('tv-error'))) !== null
    check(errVisible, 'ditampilkan pesan error, bukan halaman kosong')
    await errPage.close()
  }

  section('[8] Error console')
  // Mock tidak mendukung WebSocket realtime (selalu 426), dan realtime memang
  // opsional â€” polling menjadi jaring pengaman. Error handshake karena itu
  // sudah diharapkan di lingkungan test.
  const realErrors = consoleErrors.filter(
    (e) =>
      !/status of 40[13]/.test(e) &&
      !/Failed to load resource/.test(e) &&
      !/ERR_CONNECTION/.test(e) &&
      !/WebSocket connection to/.test(e) &&
      !/426/.test(e),
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