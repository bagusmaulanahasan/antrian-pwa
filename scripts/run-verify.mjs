/**
 * Menjalankan seluruh suite verifikasi satu per satu, dengan jeda di antaranya.
 *
 * `npm run verify` merantai semuanya dalam satu proses shell. Itu cepat,
 * tapi pada mesin kecil (RAM 8 GB tanpa pagefile) build Vite + Chrome headless
 * + workerd yang berjalan beruntun bisa membuat Windows kehabisan memori
 * commit — gejalanya `VirtualAlloc ... failed with errno=1455` atau
 * `Zone Allocation failed`, yang sama sekali tidak berkaitan dengan kode.
 *
 * Versi ini menjalankan tiap suite sebagai proses terpisah dan menunggu
 *>jeda, sehingga memori dilepas sepenuhnya di antara suite.
 *
 * Jalankan: node scripts/run-verify.mjs
 */
import { spawn } from 'node:child_process'
import process from 'node:process'

/** Jeda antar suite (detik) — memberi waktu OS mengembalikan memori. */
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

function run(suite) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['node_modules/npm/bin/npm-cli.js', ...suite.args], {
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
      shell: true,
    })
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

const failed = []
const start = Date.now()

console.log(`Menjalankan ${SUITES.length} suite (jeda ${GAP_SECONDS}s di antaranya)\n`)

for (const [i, suite] of SUITES.entries()) {
  const n = String(i + 1).padStart(2, '0')
  console.log(`\n${'='.repeat(64)}`)
  console.log(`[${n}/${SUITES.length}] ${suite.name}`)
  console.log('='.repeat(64))

  const code = await run(suite)
  if (code !== 0) {
    failed.push(`${suite.name} (exit ${code})`)
    console.log(`\n>>> ${suite.name} GAGAL (exit ${code})`)
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