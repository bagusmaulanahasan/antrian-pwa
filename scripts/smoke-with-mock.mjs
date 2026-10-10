/**
 * Menjalankan smoke test terhadap Supabase mock, lewat jalur PRODUCTION.
 *
 * Strategi: `vite build` (env di-inline saat build) lalu `vite preview`.
 * Ini menghindari masalah re-optimize dependency pada dev server dan
 * sekaligus menguji bundle yang benar-benar akan dipakai user.
 *
 * Jalankan:
 *   node scripts/smoke-with-mock.mjs                 -> srvctl: semua pass, verdict connected
 *   node scripts/smoke-with-mock.mjs --rls-error     -> SELECT ditolak 42501 (verdict disconnected)
 *   node scripts/smoke-with-mock.mjs --missing-table -> tabel belum ada 42P01 (verdict disconnected)
 */
import { spawn } from 'node:child_process'
import process from 'node:process'

const MOCK_PORT = Number(process.env.MOCK_PORT ?? 54321)
const PREVIEW_PORT = Number(process.env.PREVIEW_PORT ?? 5174)
const OUT_DIR = 'dist-smoke'
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.bW9jay1zaWduYXR1cmU'

const args = process.argv.slice(2)
const mockEnv = {}
let expectVerdict = 'connected'
// 403 = probe RLS, 401 = root REST spec + probe grant RPC (keduanya normal).
let allowHttpStatus = '403,401'
  // Mock tidak mengimplementasikan RPC, jadi probe grant berakhir 404.
if (args.includes('--rpc-open')) {
  mockEnv.MOCK_RPC_OPEN = '1'
  expectVerdict = 'disconnected'
}
if (args.includes('--rls-error')) {
  mockEnv.FORCE_RLS_ERROR = '1'
  expectVerdict = 'disconnected'
  allowHttpStatus += ',404'
}
if (args.includes('--missing-table')) {
  mockEnv.FORCE_MISSING_TABLE = '1'
  expectVerdict = 'disconnected'
  allowHttpStatus += ',404'
}

const children = new Set()

function start(label, nodeArgs, env) {
  const child = spawn(process.execPath, nodeArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    windowsHide: true,
    // shell:false â†’ child.pid adalah proses node itu sendiri, mudah di-kill.
  })
  const prefix = `[${label}] `
  child.stdout.on('data', (d) => process.stdout.write(prefix + d))
  child.stderr.on('data', (d) => process.stderr.write(`${prefix}! ${d}`))
  children.add(child)
  child.on('exit', () => children.delete(child))
  return child
}

function stop(child) {
  if (!child || child.exitCode !== null) return
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], {
        stdio: 'ignore',
        windowsHide: true,
      }).unref()
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    /* proses sudah mati */
  }
}

function stopAll() {
  for (const c of children) stop(c)
  children.clear()
}

/** Gagal cepat kalau port sudah dipakai â€” supaya tidak diam-diam menguji server lama. */
async function assertPortFree(port, label) {
  try {
    await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1500) })
  } catch {
    return // tidak ada yang mendengar â†’ port bebas
  }
  throw new Error(
    `Port ${port} (${label}) sedang dipakai proses lain. ` +
      `Hentikan server lama terlebih dahulu, atau set ${label === 'mock' ? 'MOCK_PORT' : 'PREVIEW_PORT'}.`,
  )
}

async function waitForHttp(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  let lastErr = 'tidak ada respons'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.status < 500) return true
      lastErr = `HTTP ${res.status}`
    } catch (err) {
      lastErr = err.message
    }
    await new Promise((r) => setTimeout(r, 2500))
  }
  throw new Error(`timeout menunggu ${url} (${lastErr})`)
}

function runToCompletion(label, nodeArgs, env) {
  return new Promise((resolve, reject) => {
    const child = start(label, nodeArgs, env)
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

let exitCode = 1
try {
  await assertPortFree(MOCK_PORT, 'mock')
  await assertPortFree(PREVIEW_PORT, 'preview')

  // --- 1. Mock Supabase ---
  start('mock', ['scripts/mock-supabase.mjs'], { MOCK_PORT: String(MOCK_PORT), ...mockEnv })
  await waitForHttp(`http://localhost:${MOCK_PORT}/rest/v1/`)
  console.log('\n=== mock supabase siap ===\n')

  // --- 2. Build production dengan env yang menunjuk ke mock ---
  console.log('=== build production (env di-inline) ===\n')
  const buildCode = await runToCompletion(
    'build',
    ['node_modules/vite/bin/vite.js', 'build', '--outDir', OUT_DIR, '--emptyOutDir', '--logLevel', 'warn'],
    {
      VITE_SUPABASE_URL: `http://localhost:${MOCK_PORT}`,
      VITE_SUPABASE_ANON_KEY: ANON,
      VITE_API_BASE_URL: '',
    },
  )
  if (buildCode !== 0) throw new Error(`vite build gagal (exit ${buildCode})`)

  // --- 3. Preview server ---
  start(
    'preview',
    [
      'node_modules/vite/bin/vite.js',
      'preview',
      '--outDir',
      OUT_DIR,
      '--port',
      String(PREVIEW_PORT),
      '--strictPort',
    ],
    {},
  )
  await waitForHttp(`http://localhost:${PREVIEW_PORT}/`)
  console.log('\n=== preview server siap ===\n')

  // --- 4. Smoke test ---
  exitCode = await runToCompletion('smoke', ['scripts/smoke-test.mjs'], {
    SMOKE_BASE_URL: `http://localhost:${PREVIEW_PORT}`,
    SMOKE_EXPECT_VERDICT: expectVerdict,
    SMOKE_ALLOW_HTTP_STATUS: allowHttpStatus,
    // Mock tidak mendukung upgrade WebSocket realtime.
    SMOKE_ALLOW_WS_ERROR: '1',
    // Preview menyajikan build produksi, jadi route devOnly memang diblokir
    // dan justru itu yang diverifikasi smoke test.
    SMOKE_EXPECT_DEV_PAGE: '0',
  })
} catch (err) {
  console.error('\nsmoke-with-mock gagal:', err)
  exitCode = 1
} finally {
  stopAll()
  // Beri jeda agar taskkill sempat bekerja sebelum proses parent menutup.
  await new Promise((r) => setTimeout(r, 500))
}

process.exit(exitCode)
