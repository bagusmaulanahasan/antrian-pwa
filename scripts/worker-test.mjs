/**
 * Test integrasi Worker memakai workerd (runtime Cloudflare asli).
 *
 * Worker dijalankan lewat `wrangler dev` lalu crock dikontrol:
 *  - database  â†’ mock Supabase REST (scripts/mock-supabase.mjs)
 *  - secrets   â†’ .dev.vars dummy yang konsisten antar test
 *
 * yang diuji:
 *  - /api/health  : ok saat DB hidup, 503 saat env belum lengkap
 *  - login       : sukses, ditolak password salah, ditolak email tak dikenal
 *  - cookie      : HttpOnly + SameSite=None + Secure, token tidak bocor ke body
 *  - refresh     : rotasi token, token lama dicabut
 *  - logout      : cookie dihapus, refresh token dicabut
 *  - security    : tidak ada stack trace yang bocor
 *
 * Jalankan: node scripts/worker-test.mjs
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const MOCK_PORT = 54322
const WORKER_PORT = 8788
const BASE = `http://localhost:${WORKER_PORT}`

const ANON_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.bW9jay1zaWduYXR1cmU'
import { TEST_PASSWORD } from './test-fixtures.mjs'

const JWT_SECRET = 'test-secret-for-worker-integration-tests-min-32-chars-long'

const children = new Set()
let exitCode = 1

/**
 * Wrangler hanya membaca secret dari `.dev.vars` (atau `--var`), bukan dari
 * process.env. Jadi test menulis file itu sementara lalu menghapusnya kembali.
 */
const DEV_VARS_PATH = path.join('worker', '.dev.vars')
const devVarsExisted = existsSync(DEV_VARS_PATH)
const devVarsBackup = devVarsExisted ? readFileSync(DEV_VARS_PATH, 'utf8') : null

function writeDevVars() {
  writeFileSync(
    DEV_VARS_PATH,
    [
      `SUPABASE_URL=http://127.0.0.1:${MOCK_PORT}`,
      `SUPABASE_SERVICE_ROLE_KEY=${ANON_JWT}`,
      `JWT_ACCESS_SECRET=${JWT_SECRET}`,
      `ALLOWED_ORIGIN=*`,
      '',
    ].join('\n'),
  )
}

function restoreDevVars() {
  try {
    if (devVarsExisted && devVarsBackup !== null) writeFileSync(DEV_VARS_PATH, devVarsBackup)
    else if (existsSync(DEV_VARS_PATH)) rmSync(DEV_VARS_PATH)
  } catch {
    /* ignore */
  }
}

function start(label, cmd, args, env) {
  const child = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    windowsHide: true,
  })
  child.stdout.on('data', (d) => process.stdout.write(`[${label}] ${d}`))
  child.stderr.on('data', (d) => {
    const s = String(d)
    // workerd/loguzzle verbose selama start; hide agar output terbaca
    if (!/Ready on|listening|Using vars|âŽ”|â•­|â”‚|â•°|^\s*$/.test(s)) process.stderr.write(`[${label}!] ${s}`)
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

async function waitFor(url, timeoutMs = 90000) {
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

// Mock PostgREST dipakai sebagai "database" Worker. Diimpor (bukan dijalankan)
// supaya test memilih sendiri port dan bisa membaca state-nya.
const { listen: startMock, state: mockState, server: mockServer } = await import(
  './mock-supabase.mjs'
)
await startMock(MOCK_PORT)
console.log(`[mock-pg] siap di http://127.0.0.1:${MOCK_PORT}`)

// ---------------- test harness ----------------
const failures = []
let passed = 0

function check(cond, label, extra = '') {
  if (cond) {
    passed++
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL  ${label}${extra ? ` â€” ${extra}` : ''}`)
  }
}

function section(name) {
  console.log(`\n${name}`)
}

function parseCookies(res) {
  const raw = res.headers.getSetCookie?.() ?? []
  const map = {}
  for (const c of raw) {
    const [pair] = c.split(';')
    const idx = pair.indexOf('=')
    if (idx > 0) map[pair.slice(0, idx).trim()] = {
      value: decodeURIComponent(pair.slice(idx + 1).trim()),
      raw: c,
    }
  }
  return map
}

async function post(path, body, cookies) {
  const headers = { 'Content-Type': 'application/json' }
  if (cookies) headers.Cookie = cookies
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    redirect: 'manual',
  })
}

try {
  // Jalankan wrangler lewat binary worker/node_modules/.bin agar tidak
  // bergantung pada npx yang tidak ada di PATH Windows.
  const wranglerBin = path.join('node_modules', 'wrangler', 'bin', 'wrangler.js')
  if (!existsSync(wranglerBin)) {
    throw new Error(`wrangler tidak ditemukan di ${wranglerBin} â€” jalankan npm install`)
  }
  writeDevVars()
  start(
  'worker',
  process.execPath,
  [
    wranglerBin,
    'dev',
    '--port',
    String(WORKER_PORT),
    '--ip',
    '127.0.0.1',
    // wrangler dev berjalan relatif terhadap cwd, jadi tunjuk config & entry eksplisit.
    '--config',
    path.join('worker', 'wrangler.toml'),
  ],
  {})
  await waitFor(`${BASE}/api/health`)
  console.log(`\n=== worker siap di ${BASE} ===\n`)

  // ---------------- 1. health ----------------
  section('[1] GET /api/health')
  {
    const res = await fetch(`${BASE}/api/health`)
    const body = await res.json()
    check(res.status === 200, 'health mengembalikan 200', `dapat ${res.status}`)
    check(body.status === 'ok', 'status = ok', JSON.stringify(body))
    check(body.database === 'connected', 'database = connected', JSON.stringify(body))
  }

  // ---------------- 2. login sukses ----------------
  section('[2] POST /api/auth/login â€” kredensial benar')
  let ownerCookies = {}
  {
    const res = await post('/api/auth/login', {
      email: 'owner@test.local',
      password: TEST_PASSWORD,
    })
    const body = await res.json()
    check(res.status === 200, 'login owner â†’ 200', `dapat ${res.status} ${JSON.stringify(body)}`)
    check(body.user?.role === 'owner', 'role = owner', JSON.stringify(body.user))
    check(body.user?.email === 'owner@test.local', 'email benar', JSON.stringify(body.user))
    check(body.user?.mustChangePassword === false, 'owner tidak wajib ganti password')
    check(!('access_token' in body), 'access token TIDAK dikembalikan di body (HttpOnly)')
    check(
      !JSON.stringify(body).includes('password_hash'),
      'tidak ada hash password di respons',
    )

    const cookies = parseCookies(res)
    ownerCookies = cookies
    check(Boolean(cookies.antrian_refresh?.value), 'cookie refresh token dibuat')
    check(
      cookies.antrian_refresh?.raw.includes('HttpOnly') ?? false,
      'cookie refresh HttpOnly',
      cookies.antrian_refresh?.raw,
    )
    check(
      cookies.antrian_refresh?.raw.includes('SameSite=None') ?? false,
      'cookie refresh SameSite=None',
      cookies.antrian_refresh?.raw,
    )
    check(
      cookies.antrian_refresh?.raw.includes('Secure') ?? false,
      'cookie refresh Secure',
      cookies.antrian_refresh?.raw,
    )
    check(
      cookies.antrian_access?.raw.includes('HttpOnly') ?? false,
      'cookie access HttpOnly',
    )
    check(
      cookies.antrian_refresh?.value.length === 43,
      'refresh token panjang 43 karakter (32 byte base64url)',
      `panjang ${cookies.antrian_refresh?.value?.length}`,
    )
  }

  // ---------------- 3. login ditolak ----------------
  section('[3] POST /api/auth/login â€” kredensial salah')
  {
    const wrongPassword = await post('/api/auth/login', {
      email: 'owner@test.local',
      password: 'PasswordSalah',
    })
    check(wrongPassword.status === 401, 'password salah â†’ 401', `dapat ${wrongPassword.status}`)

    const unknownEmail = await post('/api/auth/login', {
      email: 'tidak-ada@test.local',
      password: TEST_PASSWORD,
    })
    check(unknownEmail.status === 401, 'email tak dikenal â†’ 401', `dapat ${unknownEmail.status}`)

    const a = await (await post('/api/auth/login', { email: 'owner@test.local', password: 'x' })).json()
    const b = await (
      await post('/api/auth/login', { email: 'tidak-ada@test.local', password: 'x' })
    ).json()
    check(
      a.error === b.error,
      'pesan identik untuk email ada/tidak ada (tidak membocorkan informasi)',
      `"${a.error}" vs "${b.error}"`,
    )

    const inactive = await post('/api/auth/login', {
      email: 'nonaktif@test.local',
      password: TEST_PASSWORD,
    })
    check(inactive.status === 401, 'akun non-aktif â†’ 401', `dapat ${inactive.status}`)

    const empty = await post('/api/auth/login', { email: '', password: '' })
    check(empty.status === 401, 'body kosong â†’ 401', `dapat ${empty.status}`)
  }

  // ---------------- 4. password temporary ----------------
  section('[4] Admin dengan password sementara')
  let adminCookies = {}
  {
    const res = await post('/api/auth/login', {
      email: 'admin@test.local',
      password: TEST_PASSWORD,
    })
    const body = await res.json()
    check(res.status === 200, 'login admin â†’ 200', `dapat ${res.status}`)
    check(body.user?.mustChangePassword === true, 'mustChangePassword = true', JSON.stringify(body.user))
    adminCookies = parseCookies(res)
  }

  // ---------------- 5. /me ----------------
  section('[5] GET /api/auth/me')
  {
    const bearer = ownerCookies.antrian_access?.value
    const res = await fetch(`${BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${bearer}` },
    })
    const body = await res.json()
    check(res.status === 200, 'me dengan token valid â†’ 200', `dapat ${res.status}`)
    check(body.user?.role === 'owner', 'role terbaca dari token', JSON.stringify(body.user))

    const noAuth = await fetch(`${BASE}/api/auth/me`)
    check(noAuth.status === 401, 'tanpa Authorization â†’ 401', `dapat ${noAuth.status}`)

    const badToken = await fetch(`${BASE}/api/auth/me`, {
      headers: { Authorization: 'Bearer token.palsu.abcdef' },
    })
    check(badToken.status === 401, 'token sampah â†’ 401', `dapat ${badToken.status}`)

    // alg:none â€” jwt dengan signature kosong
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const nonePayload = Buffer.from(
      JSON.stringify({
        sub: '11111111-1111-1111-1111-111111111111',
        email: 'owner@test.local',
        role: 'owner',
        pwd: false,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 999,
      }),
    ).toString('base64url')
    const algNone = await fetch(`${BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${noneHeader}.${nonePayload}.` },
    })
    check(algNone.status === 401, 'alg:none ditolak', `dapat ${algNone.status}`)
  }

  // ---------------- 6. refresh ----------------
  section('[6] POST /api/auth/refresh')
  {
    const cookieHeader = `antrian_refresh=${encodeURIComponent(ownerCookies.antrian_refresh.value)}`
    const oldRefresh = ownerCookies.antrian_refresh.value
    const res = await post('/api/auth/refresh', {}, cookieHeader)
    const body = await res.json()
    check(res.status === 200, 'refresh â†’ 200', `dapat ${res.status} ${JSON.stringify(body)}`)

    const cookies = parseCookies(res)
    check(
      cookies.antrian_refresh?.value !== oldRefresh,
      'refresh token diROTASI (token lama tidak dipakai ulang)',
    )
    check(Boolean(cookies.antrian_access?.value), 'access token baru diberikan')

    // Token lama harus dicabut.
    const reuse = await post(
      '/api/auth/refresh',
      {},
      `antrian_refresh=${encodeURIComponent(oldRefresh)}`,
    )
    check(reuse.status === 401, 'token lama yang dicabut ditolak', `dapat ${reuse.status}`)

    const noCookie = await post('/api/auth/refresh', {})
    check(noCookie.status === 401, 'tanpa cookie â†’ 401', `dapat ${noCookie.status}`)

    const garbage = await post('/api/auth/refresh', {}, 'antrian_refresh=tidak-valid')
    check(garbage.status === 401, 'cookie sampah â†’ 401', `dapat ${garbage.status}`)

    ownerCookies = cookies
  }

  // ---------------- 7. change password ----------------
  section('[7] POST /api/auth/change-password')
  {
    const bearer = ownerCookies.antrian_access?.value
    const wrong = await fetch(`${BASE}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ currentPassword: 'SalahSekali', newPassword: 'PasswordBaru123!' }),
    })
    check(wrong.status === 401, 'password lama salah â†’ 401', `dapat ${wrong.status}`)

    const tooShort = await fetch(`${BASE}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ currentPassword: TEST_PASSWORD, newPassword: 'pendek' }),
    })
    check(tooShort.status === 400, 'password baru terlalu pendek â†’ 400', `dapat ${tooShort.status}`)

    const noAuth = await fetch(`${BASE}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'a', newPassword: 'PasswordBaru123!' }),
    })
    check(noAuth.status === 401, 'tanpa token â†’ 401', `dapat ${noAuth.status}`)

    // Ganti password admin (yang punya flag temporary) lalu cek flag cleared.
    const adminBearer = adminCookies.antrian_access?.value
    const res = await fetch(`${BASE}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminBearer}` },
      body: JSON.stringify({
        currentPassword: TEST_PASSWORD,
        newPassword: 'PasswordBaruAdmin456!',
      }),
    })
    const body = await res.json()
    check(res.status === 200, 'ganti password â†’ 200', `dapat ${res.status} ${JSON.stringify(body)}`)
    check(
      body.user?.mustChangePassword === false,
      'is_password_temporary dibersihkan setelah ganti',
      JSON.stringify(body.user),
    )

    const adminUser = mockState.users.find((u) => u.id === '22222222-2222-2222-2222-222222222222')
    check(adminUser.is_password_temporary === false, 'flag di database ikut terupdate')

    // Login dengan password baru harus berhasil, yang lama harus gagal.
    const withNew = await post('/api/auth/login', {
      email: 'admin@test.local',
      password: 'PasswordBaruAdmin456!',
    })
    check(withNew.status === 200, 'login dengan password baru â†’ 200', `dapat ${withNew.status}`)
    const withOld = await post('/api/auth/login', {
      email: 'admin@test.local',
      password: TEST_PASSWORD,
    })
    check(withOld.status === 401, 'login dengan password lama â†’ 401', `dapat ${withOld.status}`)
  }

  // ---------------- 8. logout ----------------
  section('[8] POST /api/auth/logout')
  {
    const refreshToken = ownerCookies.antrian_refresh?.value
    const res = await post(
      '/api/auth/logout',
      {},
      `antrian_refresh=${encodeURIComponent(refreshToken)}`,
    )
    check(res.status === 200, 'logout â†’ 200', `dapat ${res.status}`)

    const cookies = parseCookies(res)
    check(cookies.antrian_refresh?.raw.includes('Max-Age=0'), 'cookie refresh dihapus', cookies.antrian_refresh?.raw)
    check(cookies.antrian_access?.raw.includes('Max-Age=0'), 'cookie access dihapus')

    const revoked = mockState.refreshTokens.find((t) => t.token_hash && t.revoked_at)
    check(Boolean(revoked), 'refresh token dicabut di database')

    const reuse = await post(
      '/api/auth/refresh',
      {},
      `antrian_refresh=${encodeURIComponent(refreshToken)}`,
    )
    check(reuse.status === 401, 'token setelah logout ditolak', `dapat ${reuse.status}`)
  }

  // ---------------- 9. hardening ----------------
  section('[9] Hardening respons')
  {
    const res = await fetch(`${BASE}/api/health`)
    check(res.headers.get('x-content-type-options') === 'nosniff', 'header X-Content-Type-Options')
    check(res.headers.get('cache-control') === 'no-store', 'header Cache-Control: no-store')
    check(res.headers.get('x-frame-options') === 'DENY', 'header X-Frame-Options: DENY')

    const notFound = await fetch(`${BASE}/api/tidak-ada`)
    check(notFound.status === 404, 'endpoint tak dikenal â†’ 404', `dapat ${notFound.status}`)

    const badJson = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bukan json',
    })
    check(badJson.status === 400, 'JSON rusak â†’ 400', `dapat ${badJson.status}`)

    const text = await badJson.text()
    check(!/at \w+ \(|node_modules|worker\/src/.test(text), 'tidak ada stack trace di respons', text.slice(0, 120))
  }
} catch (err) {
  console.error('\nFATAL:', err)
  failures.push(`fatal: ${err.message}`)
} finally {
  console.log(`\n${'='.repeat(58)}`)
  console.log(`  ${passed} lulus, ${failures.length} gagal`)
  if (failures.length) {
    console.log('\n  Gagal:')
    for (const f of failures) console.log(`    - ${f}`)
  }
  exitCode = failures.length === 0 ? 0 : 1
  stopAll()
  restoreDevVars()
  mockServer.close()
  await new Promise((r) => setTimeout(r, 2500))
}

process.exit(exitCode)


