/**
 * Menjalankan seluruh suite verifikasi satu per satu, dengan jeda di antaranya.
 *
 * `npm run verify` merantai semuanya dalam satu proses shell. Itu cepat,
 * tapi pada mesin kecil (RAM 8 GB tanpa pagefile) build Vite + Chrome headless
 * + workerd yang berjalan beruntun bisa membuat Windows kehabisan memori
 * commit â€” gejalanya `VirtualAlloc ... failed with errno=1455` atau
 * `Zone Allocation failed`, yang sama sekali tidak berkaitan dengan kode.
 *
 * Versi ini menjalankan tiap suite sebagai proses terpisah dan menunggu
 *>jeda, sehingga memori dilepas sepenuhnya di antara suite.
 *
 * Jalankan: node scripts/run-verify.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import process from 'node:process'

/** Jeda antar suite (detik) â€” memberi waktu OS mengembalikan memori. */
const GAP_SECONDS = Number(process.env.VERIFY_GAP ?? 6)

const SUITES = [
  { name: 'typecheck', args: ['run', 'typecheck'] },
  { name: 'unit test', args: ['run', 'test:unit'] },
  { name: 'worker integration', args: ['run', 'test:worker'] },
  { name: 'queue integration', args: ['run', 'test:queue'] },
  { name: 'e2e auth', args: ['run', 'test:e2e:auth'] },
  { name: 'e2e admin', args: ['run', 'test:e2e:admin'] },
  { name: 'e2e tv', args: ['run', 'test:e2e:tv'] },
  { name: 'e2e owner', args: ['run', 'test:e2e:owner'] },
  { name: 'smoke: mock normal', args: ['run', 'smoke:mock'] },
  { name: 'smoke: rls ditolak', args: ['run', 'smoke:mock:rls'] },
  { name: 'smoke: tabel hilang', args: ['run', 'smoke:mock:notable'] },
  { name: 'smoke: grant bocor', args: ['run', 'smoke:mock:rpcopen'] },
  { name: 'build produksi', args: ['run', 'build'] },
  { name: 'aset PWA', args: ['run', 'assets:verify'] },
]

/**
 * Lokasi npm CLI.
 *
 * npm di-install secara global (bukan di node_modules project), jadi
 * `node_modules/npm/bin/npm-cli.js` tidak ada. Cari lewat lokasi npm global,
 * lalu jatuh ke `npm.cmd` yang ada di PATH.
 */
function resolveNpm() {
  const candidates = [
    process.env.npm_execpath,
    process.env.NPM_CLI_JS,
    'C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js',
  ].filter(Boolean)

  for (const c of candidates) {
    if (existsSync(c)) return { type: 'node', file: c }
  }

  // `where npm` untuk menemukan npm.cmd di PATH.
  return { type: 'cmd', file: 'npm.cmd' }
}

const npm = resolveNpm()

function run(suite, onOutput) {
  return new Promise((resolve) => {
    const spawnOpts = {
      // 'inherit' tidak bisa ditangkap, jadi pakai pipe lalu tulis ulang ke
      // stdout supaya output tetap terlihat sekaligus bisa diperiksa.
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
    const child =
      npm.type === 'node'
        ? spawn(process.execPath, [npm.file, ...suite.args], spawnOpts)
        : spawn(npm.file, suite.args, { ...spawnOpts, shell: true })

    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', (chunk) => {
        onOutput(String(chunk))
        process.stdout.write(chunk)
      })
    }
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

const failed = []
const start = Date.now()

console.log(`Menjalankan ${SUITES.length} suite (jeda ${GAP_SECONDS}s di antaranya)\n`)

/** Suite gagal karena kehabisan memori, bukan karena kode. */
const MEMORY_FAILURE_MARKERS = [
  /out of memory/i,
  /VirtualAlloc .* failed/i,
  /JS heap out of memory/i,
  /Allocation failed/i,
  /Zone Allocation failed/i,
]

let lastOutput = ''

function looksLikeMemoryFailure() {
  // Exit code 1 dipakai juga untuk kegagalan biasa, jadi penentunya adalah
  // isi output, bukan code.
  return MEMORY_FAILURE_MARKERS.some((m) => m.test(lastOutput))
}

/** Berapa kali mencoba lagi sebelum menyerah. */
const MAX_RETRIES = 2
/** Jeda tambahan sebelum mencoba lagi (detik) â€” memori harus sempat dilepas. */
const RETRY_PAUSE_SECONDS = 20

for (const [i, suite] of SUITES.entries()) {
  const n = String(i + 1).padStart(2, '0')
  console.log(`\n${'='.repeat(64)}`)
  console.log(`[${n}/${SUITES.length}] ${suite.name}`)
  console.log('='.repeat(64))

  let code = 1
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    lastOutput = ''
    code = await run(suite, (chunk) => {
      lastOutput += chunk
    })

    if (code === 0) break

    if (looksLikeMemoryFailure() && attempt < MAX_RETRIES) {
      console.log(
        `\n>>> ${suite.name} kehabisan memori (percobaan ${attempt + 1}/${MAX_RETRIES + 1}), ` +
          `menunggu ${RETRY_PAUSE_SECONDS}s lalu mencoba lagi`,
      )
      await new Promise((r) => setTimeout(r, RETRY_PAUSE_SECONDS * 1000))
      continue
    }
    break
  }

  if (code !== 0) {
    failed.push(`${suite.name} (exit ${code})`)
    console.log(`\n>>> ${suite.name} GAGAL (exit ${code})`)
    if (looksLikeMemoryFailure()) {
      console.log(
        '    Penyebab: kehabisan memori, bukan kegagalan kode. ' +
          'Aktifkan pagefile Windows lalu jalankan ulang.',
      )
    }
    // Lanjut saja: laporan lengkap lebih berguna daripada berhenti di tengah.
  }

  if (i < SUITES.length - 1) {
    await new Promise((r) => setTimeout(r, GAP_SECONDS * 1000))
  }
}

const minutes = ((Date.now() - start) / 60000).toFixed(1)
console.log(`\n${'='.repeat(64)}`)
if (failed.length === 0) {
  console.log(`SEMUA SUITE LULUS (${minutes} menit)`)
} else {
  console.log(`${failed.length} SUITE GAGAL (${minutes} menit):`)
  for (const f of failed) console.log(`  - ${f}`)
}
console.log('='.repeat(64))

process.exit(failed.length === 0 ? 0 : 1)