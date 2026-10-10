/**
 * Test CLI `hash-password`.
 *
 * Insiden: `npm run hash-password ... --temp` TIDAK mengirim `--temp`
 * ke script. npm memakainya sebagai flag miliknya sendiri, sehingga
 * script berjalan normal, hash-nya valid, tapi `is_password_temporary`
 * diam-diam menjadi false. Akun owner terbentuk dengan password
 * permanen tanpa peringatan.
 *
 * Perbaikan: `temp` juga diterima sebagai argumen POSITIONAL, karena
 * argumen tanpa tanda `-` tidak dimakan npm.
 *
 * Test ini sengaja memanggil lewat `npm run`, bukan `node` langsung,
 * karena justru lapisan npm itu yang jadi sumber bug.
 *
 * Jalankan: npm run test:unit
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PASSWORD = 'TestPass123'

/**
 * Panggil npm lewat `npm-cli.js`, persis cara npm menjalankan script-nya
 * sendiri. Node memblokir spawn `.cmd` langsung demi keamanan, jadi
 * `shell: true` (yang memicu DEP0190) tidak diperlukan.
 *
 * `npm_execpath` hanya terisi saat test dijalankan via `npm run`. Kalau
 * file ini dieksekusi langsung, cari `npm-cli.js` di samping binary node.
 */
function resolveNpmCli(): string | null {
  if (process.env.npm_execpath) return process.env.npm_execpath
  const candidate = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return existsSync(candidate) ? candidate : null
}

const NODE_BIN = process.env.npm_node_execpath || process.execPath
const NPM_CLI = resolveNpmCli()

/** Jalankan CLI lewat `npm run` agar lapisan npm ikut teruji. */
function runNpm(args: string[]): { status: number | null; output: string } {
  const npmArgs = ['run', 'hash-password', '--silent', ...args]
  const command = NPM_CLI ? NODE_BIN : 'npm'
  const argv = NPM_CLI ? [NPM_CLI, ...npmArgs] : npmArgs

  const result = spawnSync(command, argv, {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 60_000,
    // Hanya dipakai kalau `npm-cli.js` tidak ditemukan sama sekali.
    shell: !NPM_CLI,
  })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/** Jalankan CLI lewat `npm run` dan pastikan keluar dengan sukses. */
function runViaNpm(args: string[]): string {
  const { status, output } = runNpm(args)
  if (status !== 0) {
    assert.fail(`CLI keluar dengan status ${status}:\n${output}`)
  }
  return output
}

/**
 * Ambil nilai boolean yang dicetak sebagai baris `  true,` / `  false,`
 * di dalam blok SQL — itulah kolom `is_password_temporary`.
 */
function temporaryFlag(output: string): 'true' | 'false' | null {
  const section = output.split('=== SQL untuk Supabase SQL Editor ===')[1] ?? ''
  const match = section.match(/^\s*(true|false),\s*$/m)
  return (match?.[1] as 'true' | 'false' | undefined) ?? null
}

describe('CLI hash-password', () => {
  it('argumen posisional `temp` menghasilkan is_password_temporary = true', () => {
    const out = runViaNpm([PASSWORD, 'posisional@example.com', 'owner', 'temp'])
    assert.equal(
      temporaryFlag(out),
      'true',
      'argumen posisional "temp" harus mengaktifkan password sementara',
    )
  })

  it('`--temp` setelah tanda `--` tetap berfungsi', () => {
    const npmArgs = [
      'run', 'hash-password', '--silent', '--',
      PASSWORD, 'dashdash@example.com', 'owner', '--temp',
    ]
    const result = spawnSync(
      NPM_CLI ? NODE_BIN : 'npm',
      NPM_CLI ? [NPM_CLI, ...npmArgs] : npmArgs,
      { encoding: 'utf8', cwd: ROOT, timeout: 60_000 },
    )
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`
    assert.equal(result.status, 0, `CLI gagal:\n${out}`)
    assert.equal(temporaryFlag(out), 'true', 'bentuk "-- --temp" harus tetap berfungsi')
  })

  it('owner tanpa `temp` memberi peringatan dan menghasilkan false', () => {
    const out = runViaNpm([PASSWORD, 'peringatan@example.com', 'owner'])
    assert.match(out, /PERINGATAN/, 'owner tanpa temp harus diberi peringatan tegas')
    assert.equal(temporaryFlag(out), 'false')
  })

  it('peringatan menyertakan perintah perbaikan yang benar', () => {
    const out = runViaNpm([PASSWORD, 'saran@example.com', 'owner'])
    assert.match(out, /owner temp/, 'peringatan harus memberi contoh perintah yang benar')
  })

  it('peran admin tanpa `temp` tidak diperingatkan', () => {
    const out = runViaNpm([PASSWORD, 'admin@example.com', 'admin'])
    assert.doesNotMatch(
      out,
      /PERINGATAN/,
      'peringatan hanya relevan untuk akun bootstrap owner',
    )
    assert.equal(temporaryFlag(out), 'false')
  })
})