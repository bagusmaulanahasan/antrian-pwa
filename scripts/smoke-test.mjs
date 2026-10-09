/**
 * Smoke test end-to-end untuk halaman /dev/test-connection.
 *
 * Menjalankan Chrome headless terhadap dev server / preview server untuk
 * memastikan:
 *  1. Beranda merender tanpa error console.
 *  2. Navigasi ke route /dev/test-connection via vue-router.
 *  3. Diagnosis benar-benar jalan dan menghasilkan kartu pemeriksaan.
 *
 * Env:
 *   SMOKE_BASE_URL       base URL server (default http://localhost:5173)
 *   SMOKE_EXPECT_VERDICT 'connected' | 'disconnected' | (kosong = bebas)
 *   SMOKE_HEADFUL        '1' untuk melihat browser
 *
 * Jalankan: node scripts/smoke-test.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:5173'
const SMOKE_EXPECT_VERDICT = process.env.SMOKE_EXPECT_VERDICT || null
const HEADFUL = process.env.SMOKE_HEADFUL === '1'
const ARTIFACT_DIR = 'smoke-artifacts'

const failures = []
const consoleErrors = []

function assert(cond, message) {
  if (cond) {
    console.log(`  PASS  ${message}`)
  } else {
    console.log(`  FAIL  ${message}`)
    failures.push(message)
  }
}

/** Cetak jejak kegagalan sedetail mungkin saat halaman gagal render. */
async function dumpFailureState(page, label) {
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  const text = await page.evaluate(() => document.body?.innerText ?? '(body tidak ada)').catch(() => '(gagal baca DOM)')
  writeFileSync(`${ARTIFACT_DIR}/${label}.html`, await page.content().catch(() => ''))
  writeFileSync(`${ARTIFACT_DIR}/${label}.txt`, text)
  await page.screenshot({ path: `${ARTIFACT_DIR}/${label}.png`, fullPage: true }).catch(() => {})
  console.log(`\n  !! Halaman gagal render — artefak disimpan ke ${ARTIFACT_DIR}/${label}.*`)
  console.log(`  !! DOM innerText (200 char pertama): ${JSON.stringify(text.slice(0, 200))}`)
  console.log(`  !! Error console (${consoleErrors.length}):`)
  for (const e of consoleErrors.slice(0, 20)) console.log(`       - ${e}`)
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: HEADFUL ? false : 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900'],
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))
  page.on('requestfailed', (req) => {
    const f = req.failure()
    // Abaikan request browser yang memang tidak ada (mis. manifest dev).
    if (!req.url().includes('favicon')) consoleErrors.push(`requestfailed: ${req.url()} (${f?.errorText})`)
  })

  // --- 1. Beranda ---
  console.log('\n[1] Beranda /')
  const resp = await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  assert(resp?.status() === 200, `HTTP 200 pada / (dapat ${resp?.status()})`)

  let mounted = true
  try {
    await page.waitForSelector('h1', { timeout: 8000 })
  } catch {
    mounted = false
    assert(false, 'Aplikasi ter-mount di beranda (h1 ditemukan)')
    await dumpFailureState(page, 'home-failed')
  }
  if (mounted) {
    assert(true, 'Aplikasi ter-mount di beranda (h1 ditemukan)')
    const heading = await page.$eval('h1', (el) => el.textContent?.trim())
    assert(heading === 'Sistem Antrian PWA', `Heading benar: "${heading}"`)
    const homeText = await page.evaluate(() => document.body.innerText)
    assert(
      homeText.includes('Supabase terkonfigurasi') || homeText.includes('Supabase belum dikonfigurasi'),
      'Banner status Supabase tampil di beranda',
    )
    assert(homeText.includes('Dashboard Admin'), 'Kartu modul aplikasi tampil')
  }

  // --- 2. Navigasi router ke halaman dev ---
  console.log('\n[2] Navigasi ke /dev/test-connection')
  if (mounted) {
    const link = await page.$('a[href="/dev/test-connection"]')
    assert(link !== null, 'Link ke halaman dev tersedia di beranda')
    if (link) {
      await Promise.all([
        page.waitForFunction(() => location.pathname === '/dev/test-connection', { timeout: 10000 }),
        link.click(),
      ])
    }
    assert(
      page.url().endsWith('/dev/test-connection'),
      `URL berpindah ke halaman dev (${new URL(page.url()).pathname})`,
    )
  }

  // --- 3. Diagnosis berjalan ---
  console.log('\n[3] Halaman diagnosis')
  let devMounted = mounted
  try {
    await page.waitForFunction(
      () => document.querySelector('h1')?.textContent?.includes('Test Koneksi Supabase') === true,
      { timeout: 8000 },
    )
  } catch {
    devMounted = false
    assert(false, 'Halaman /dev/test-connection ter-mount')
    await dumpFailureState(page, 'dev-page-failed')
  }
  if (devMounted) {
    assert(true, 'Halaman /dev/test-connection ter-mount')

    // Tunggu diagnosis selesai. Careyati balapan dengan onMounted: jangan pernah
    // memeriksa "spinner tidak ada" sebelum spinner sempat muncul, karena itu
    // akan lolos seketika dan membaca laporan yang belum ada.
    await page
      .waitForFunction(
        () => {
          const t = document.body.innerText
          return (
            t.includes('Diperiksa pukul') || t.includes('Pemeriksaan gagal dijalankan')
          )
        },
        { timeout: 90000, polling: 250 },
      )
      .catch(() => {})

    const bodyText = await page.evaluate(() => document.body.innerText)
    assert(bodyText.includes('Environment'), 'Panel Environment tampil')
    assert(/lulus|pemeriksaan gagal/.test(bodyText), 'Ringkasan hasil pemeriksaan tampil')

    const checks = await page.$$eval('article', (els) =>
      els.map((el) => ({
        name: el.querySelector('h3')?.textContent?.trim() ?? '?',
        badge: el.querySelector('span')?.textContent?.trim() ?? '?',
      })),
    )
    console.log('  Pemeriksaan yang dilaporkan:')
    for (const c of checks) console.log(`      - [${c.badge}] ${c.name}`)

    // Diagnosis boleh berhenti dini HANYA bila env memang belum lengkap.
    const envOnly = checks.length === 1 && checks[0].name === 'Konfigurasi environment (.env)'
    const expectedMin = envOnly ? 1 : 8
    assert(
      checks.length >= expectedMin,
      checks.length >= expectedMin
        ? `Jumlah kartu pemeriksaan ${checks.length} (>= ${expectedMin})`
        : envOnly
          ? `Diagnosis berhenti dini karena env kosong (1 kartu) — wajar`
          : `Jumlah kartu pemeriksaan ${checks.length}, diharapkan >= ${expectedMin}`,
    )

    if (!envOnly) {
      const names = checks.map((c) => c.name)
      const required = [
        'Inisialisasi Supabase client',
        'Keterjangkauan REST API',
        'Tabel `categories` (RLS SELECT)',
        'Tabel `queue_entries`',
        'Proteksi RLS (insert harus ditolak)',
        'Realtime subscription',
        'Supabase Auth health',
        'Grant RPC (harus menutup untuk anon)',
      ]
      for (const r of required) {
        assert(names.includes(r), `Pemeriksaan wajib hadir: ${r}`)
      }
    }

    const verdict = await page.evaluate(() => {
      const t = document.body.innerText
      if (t.includes('Supabase terhubung dan siap dipakai.')) return 'connected'
      if (t.includes('Belum sepenuhnya terhubung')) return 'disconnected'
      return 'unknown'
    })
    assert(verdict !== 'unknown', `Verdict terambil: ${verdict}`)
    if (SMOKE_EXPECT_VERDICT) {
      assert(
        verdict === SMOKE_EXPECT_VERDICT,
        `Verdict "${verdict}" (diharapkan "${SMOKE_EXPECT_VERDICT}")`,
      )
    }

    // --- 4. Tombol jalankan ulang ---
    console.log('\n[4] Tombol "Jalankan Ulang"')
    const buttons = await page.$$('button')
    let clicked = false
    for (const b of buttons) {
      const txt = await b.evaluate((el) => el.textContent?.trim())
      if (txt?.includes('Jalankan')) {
        await b.click()
        clicked = true
        break
      }
    }
    assert(clicked, 'Tombol "Jalankan Ulang" ditemukan dan diklik')
    if (clicked) {
      await page
        .waitForFunction(() => !document.body.innerText.includes('Menjalankan pemeriksaan'), {
          timeout: 60000,
        })
        .catch(() => {})
      const afterRerun = await page.$$eval('article', (els) => els.length)
      assert(afterRerun === checks.length, `Jumlah kartu stabil setelah jalankan ulang (${afterRerun})`)
    }
  }

  // --- 5. Error console ---
  console.log('\n[5] Error console')
  // Skenario diagnosa memang sengaja memicu HTTP error:
  //   403 → probe RLS membuktikan anon tidak boleh menulis
  //   401/404 → skenario policy SELECT hilang / tabel belum dibuat
  // WebSocket 426 hanya muncul saat backend mock (tidak mendukung realtime).
  const allowedStatuses = (process.env.SMOKE_ALLOW_HTTP_STATUS ?? '403')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const expectedPatterns = [
    ...allowedStatuses.map((s) => new RegExp(`status of ${s}\\b`)),
    ...(process.env.SMOKE_ALLOW_WS_ERROR === '1'
      ? [/WebSocket connection to/, /Unexpected response code/]
      : []),
  ]
  const isExpected = (e) =>
    expectedPatterns.some((p) => p.test(e)) ||
    e.includes('favicon') ||
    e.includes('Download the Vue Devtools')

  const realErrors = consoleErrors.filter((e) => !isExpected(e))
  const ignored = consoleErrors.length - realErrors.length
  assert(
    realErrors.length === 0,
    realErrors.length === 0
      ? `Tidak ada error console yang tak terduga (${ignored} error yang diharapkan diabaikan)`
      : `Error console tak terduga: ${realErrors.join(' | ')}`,
  )
} finally {
  await browser.close()
}

console.log(`\n${failures.length === 0 ? 'SEMUA SMOKE TEST LULUS' : `${failures.length} SMOKE TEST GAGAL`}`)
for (const f of failures) console.log(`  - ${f}`)
process.exit(failures.length === 0 ? 0 : 1)
