/**
 * Normalisasi karakter Unicode di file teks.
 *
 * Setelah penulisan berulang kali lewat beberapa editor, karakter tanda baca
 * kurung miring dan beberapa karakter lain bisa rusak menjadi U+FFFD. File ini
 * menyapanya kembali ke ASCII agar diff di git tetap terbaca.
 *
 * Jalankan: node scripts/normalize-text.mjs <file...>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'

const REPLACEMENTS = [
  [/[‘’‛]/g, "'"],
  [/[“”„]/g, '"'],
  [/[—–−]/g, '-'],
  [/…/g, '...'],
  [/→/g, '->'],
  [/ /g, ' '],
  [/�/g, '-'],
]

function normalize(text) {
  let out = text
  for (const [pattern, replacement] of REPLACEMENTS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('Penggunaan: node scripts/normalize-text.mjs <file> [file...]')
  process.exit(1)
}

for (const file of files) {
  const before = readFileSync(file, 'utf8')
  const after = normalize(before)
  if (before !== after) {
    writeFileSync(file, after, 'utf8')
    console.log(`dibersihkan: ${file}`)
  } else {
    console.log(`sudah bersih: ${file}`)
  }
}