/**
 * Verifikasi aset PWA di build produksi.
 *
 *Memastikan setiap file yang dirujuk manifest & index.html benar-benar ada
 * di dist/, dan manifest valid JSON dengan field wajib.
 *
 * Jalankan: node scripts/verify-assets.mjs
 */
import { existsSync, readFileSync, statSync } from 'node:fs'

const DIST = 'dist'
const failures = []

function assert(cond, message) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${message}`)
  if (!cond) failures.push(message)
}

function assertFile(rel, minBytes = 100) {
  const p = `${DIST}/${rel}`
  if (!existsSync(p)) {
    assert(false, `${rel} ada di dist/`)
    return
  }
  const size = statSync(p).size
  assert(size >= minBytes, `${rel} ada (${(size / 1024).toFixed(1)} KB)`)
}

console.log('Manifest')
const manifestPath = `${DIST}/manifest.webmanifest`
if (!existsSync(manifestPath)) {
  assert(false, 'manifest.webmanifest ada')
} else {
  assert(true, 'manifest.webmanifest ada')
  let m = null
  try {
    m = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assert(true, 'manifest.webmanifest valid JSON')
  } catch (e) {
    assert(false, `manifest.webmanifest valid JSON (${e.message})`)
  }
  if (m) {
    assert(Boolean(m.name), `manifest.name terisi ("${m.name}")`)
    assert(Boolean(m.short_name), `manifest.short_name terisi ("${m.short_name}")`)
    assert(m.display === 'standalone', `manifest.display = standalone (${m.display})`)
    assert(Boolean(m.start_url), `manifest.start_url terisi (${m.start_url})`)
    assert(Boolean(m.theme_color), `manifest.theme_color terisi (${m.theme_color})`)
    assert(Boolean(m.background_color), `manifest.background_color terisi (${m.background_color})`)

    const icons = Array.isArray(m.icons) ? m.icons : []
    assert(icons.length >= 2, `manifest punya minimal 2 ikon (${icons.length})`)
    assert(
      icons.some((i) => i.purpose === 'maskable'),
      'manifest punya ikon maskable',
    )
    assert(
      icons.some((i) => i.sizes === '192x192'),
      'manifest punya ikon 192x192',
    )
    assert(
      icons.some((i) => i.sizes === '512x512'),
      'manifest punya ikon 512x512',
    )
    for (const icon of icons) {
      assertFile(icon.src.replace(/^\//, ''))
    }
  }
}

console.log('\nService worker')
assertFile('sw.js', 500)
assertFile('registerSW.js', 50)

console.log('\nFavicon & aset lain')
assertFile('favicon.ico', 200)
assertFile('favicon.svg', 200)
assertFile('apple-touch-icon.png', 200)
assertFile('robots.txt', 10)

console.log('\nindex.html')
const html = readFileSync(`${DIST}/index.html`, 'utf8')
for (const [label, needle] of [
  ['link rel=icon svg', /favicon\.svg/],
  ['link rel=icon ico', /favicon\.ico/],
  ['apple-touch-icon', /apple-touch-icon\.png/],
  ['theme-color', /name="theme-color"/],
  ['viewport', /name="viewport"/],
]) {
  assert(needle.test(html), `index.html punya ${label}`)
}

console.log('\nStale reference check')
assert(
  !/vite\.svg/.test(html),
  'index.html tidak lagi merujuk vite.svg (template bawaan)',
)

console.log(`\n${failures.length === 0 ? 'SEMUA ASET PWA VALID' : `${failures.length} MASALAH ASET`}`)
for (const f of failures) console.log(`  - ${f}`)
process.exit(failures.length === 0 ? 0 : 1)