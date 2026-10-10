/**
 * Unit test untuk logika murni frontend yang tidak butuh browser.
 *
 * Fokus: generator ESC/POS (kelengkapan byte & pemenggalan teks), tanggal,
 * dan tanggal antrian (reset harian WIB).
 *
 * Jalankan: node --experimental-strip-types --test src/test/*.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  LINE_WIDTH,
  buildTicket,
  center,
  divider,
  fontSize,
  formatIndonesianDate,
  leftRight,
  truncate,
  wrapText,
  type TicketData,
} from '../lib/escpos.ts'
import { getQueueDate } from '../lib/types.ts'

/** Roti menjadi string yang mudah dibaca, dengan byte kontrol ditampilkan. */
function decode(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => {
      if (b === 0x1b) return '<ESC>'
      if (b === 0x1d) return '<GS>'
      if (b === 0x0a) return '\\n'
      return String.fromCharCode(b)
    })
    .join('')
}

const SAMPLE: TicketData = {
  placeName: 'Klinik Sehat Bersama',
  address: 'Jl. Merdeka No. 45, Bandung',
  phone: 'Telp: 0812-3456-7890',
  number: 42,
  customerName: 'Budi Santoso',
  categoryName: 'Rawat Jalan',
  date: 'Kamis, 9 Oktober 2026',
}

describe('wrapText', () => {
  it('mempertahankan baris baru dari teks asli', () => {
    assert.deepEqual(wrapText('satu\ndua\ntiga'), ['satu', 'dua', 'tiga'])
  })

  it('membungkus teks panjang pada lebar kertas', () => {
    const long = 'a'.repeat(80)
    const lines = wrapText(long)
    assert.equal(lines.join('').length, 80, 'tidak ada karakter yang hilang')
    for (const l of lines) {
      assert.ok(l.length <= LINE_WIDTH, `baris "${l}" melebihi ${LINE_WIDTH}`)
    }
  })

  it('tidak memecah placeholder {nama} di tengah', () => {
    // Teks panjang supaya placeholder benar-benar jatuh di batas baris.
    const text = `${'a'.repeat(LINE_WIDTH)} {nama} ${'b'.repeat(LINE_WIDTH)} {nomor}`
    const lines = wrapText(text)
    for (const l of lines) {
      assert.doesNotMatch(l, /\{[a-zA-Z0-9_]*$/, `placeholder terpotong di baris "${l}"`)
    }
    const joined = lines.join('')
    assert.ok(joined.includes('{nama}'), 'placeholder {nama} utuh')
    assert.ok(joined.includes('{nomor}'), 'placeholder {nomor} utuh')
  })

  it('mempertahankan placeholder utuh walau baris penuh', () => {
    const lines = wrapText(`${'x'.repeat(30)} {nama}`)
    const joined = lines.join('')
    assert.ok(joined.includes('{nama}'), 'placeholder pindah ke baris berikutnya, bukan terpotong')
  })
})

describe('truncate', () => {
  it('memotong dengan elipsis bila kelewat panjang', () => {
    const out = truncate('Nama Sangat Panjang Sekali', 10)
    assert.equal(out.length, 10)
    assert.ok(out.endsWith('…'))
  })

  it('tidak mengubah teks yang cukup pendek', () => {
    assert.equal(truncate('  Budi  ', 20), 'Budi')
  })
})

describe('pemformat baris', () => {
  it('center menengahkan teks', () => {
    // (32 - 3) / 2 = 14 spasi
    assert.equal(decode(center('ABC')), `${' '.repeat(14)}ABC\\n`)
  })

  it('leftRight menyisipkan spasi yang tepat', () => {
    const text = decode(leftRight('Nama', 'Budi'))
    assert.ok(text.startsWith('Nama'))
    assert.ok(text.endsWith('Budi\\n'))
    assert.equal(text.replace('\\n', '').length, LINE_WIDTH)
  })

  it('leftRight tetap menyisakan minimal satu spasi', () => {
    const text = decode(leftRight('Nama Panjang', 'Nilai Panjang'))
    assert.ok(text.length > 0)
    assert.ok(text.includes(' '), 'ada spasi pemisah')
  })

  it('divider menghasilkan garis penuh', () => {
    assert.equal(decode(divider()), `${'-'.repeat(LINE_WIDTH)}\\n`)
  })
})

describe('fontSize', () => {
  it('size 2 memakai GS ! 0x11 (double)', () => {
    assert.deepEqual(Array.from(fontSize(2)), [0x1d, 0x21, 0x11])
  })

  it('size 0 mengembalikan GS ! 0x00 (normal)', () => {
    assert.deepEqual(Array.from(fontSize(0)), [0x1d, 0x21, 0x00])
  })
})

describe('buildTicket', () => {
  it('memuat data pelanggan dan nomor', () => {
    const out = decode(buildTicket(SAMPLE))
    assert.ok(out.includes('42'), 'nomor tiket ada')
    assert.ok(out.includes('Budi'), 'nama pelanggan ada')
    assert.ok(out.includes('Rawat Jalan'), 'kategori ada')
    assert.ok(out.includes('KLINIK SEHAT BERSAMA'), 'nama tempat ada')
  })

  it('memotong kertas di akhir dengan partial cut', () => {
    const out = decode(buildTicket(SAMPLE))
    assert.ok(out.includes('<GS>V'), 'perintah potong GS V ada')
  })

  it('mengembalikan ukuran font ke normal sebelum potong kertas', () => {
    // Tanpa ini printer memotong dengan ketebalan yang tidak sesuai.
    const out = decode(buildTicket(SAMPLE))
    const resetIndex = out.indexOf('<GS>!\x00')
    const cutIndex = out.indexOf('<GS>V')
    assert.ok(resetIndex > -1, 'GS ! 0 ada (reset font)')
    assert.ok(cutIndex > resetIndex, 'reset font terjadi SEBELUM potong kertas')
  })

  it('memulai dengan ESC @ (init printer)', () => {
    const bytes = buildTicket(SAMPLE)
    assert.deepEqual(Array.from(bytes.slice(0, 2)), [0x1b, 0x40])
  })

  it('menghasilkan byte non-null dan berukuran wajar', () => {
    const bytes = buildTicket(SAMPLE)
    assert.ok(bytes.length > 100, `tiket cukup panjang (${bytes.length} byte)`)
    assert.ok(bytes.length < 2000, `tiket tidak melebihi MTU total (${bytes.length} byte)`)
    assert.ok(bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255), 'semua byte valid')
  })

  it('bervariasi menurut dialect printer', () => {
    const epson = Array.from(buildTicket(SAMPLE, 'epson').slice(0, 2))
    assert.deepEqual(epson, [0x1b, 0x40])
    const generic = Array.from(buildTicket(SAMPLE, 'generic').slice(0, 2))
    assert.deepEqual(generic, [0x1b, 0x74], 'dialek generic mengirim ESC t')
  })

  it('berfungsi tanpa data opsional', () => {
    const minimal = buildTicket({
      number: 1,
      customerName: 'Anonim',
      categoryName: 'Umum',
      date: '2026-10-09',
    })
    assert.ok(minimal.length > 0)
    assert.ok(decode(minimal).includes('Anonim'))
  })

  it('menangani nama pelanggan sangat panjang tanpa error', () => {
    const long = buildTicket({ ...SAMPLE, customerName: 'x'.repeat(500) })
    assert.ok(long.length > 0, 'tidak melempar error')
  })

  it('menangani karakter non-ASCII tanpa rusak', () => {
    const out = decode(buildTicket({ ...SAMPLE, customerName: 'Budi Santoso — Ñoño 中文' }))
    assert.ok(out.includes('Budi'), 'nama tetap terbaca')
  })
})

describe('formatIndonesianDate', () => {
  it('memformat tanggal antrian dalam Bahasa Indonesia', () => {
    const out = formatIndonesianDate('2026-10-09')
    assert.ok(out.includes('2026'), out)
    assert.ok(out.includes('Oktober'), out)
    assert.match(out, /^(Minggu|Senin|Selasa|Rabu|Kamis|Jumat|Sabtu), /, out)
  })

  it('fallback ke hari ini bila format tidak valid', () => {
    const out = formatIndonesianDate('bukan-tanggal')
    assert.ok(out.length > 0)
    assert.match(out, /\d{4}/, out)
  })
})

describe('getQueueDate', () => {
  it('mengembalikan tanggal WIB untuk reset_hour 0', () => {
    // 2026-10-09 10:00 UTC = 2026-10-09 17:00 WIB
    const now = new Date('2026-10-09T10:00:00Z')
    assert.equal(getQueueDate(0, now), '2026-10-09')
  })

  // Reset jam 3 WIB: hari antrian baru dimulai pukul 03:00 WIB setiap hari.
  it('sebelum jam reset → masih memakai tanggal antrian kemarin', () => {
    // 2026-10-09 21:00 UTC = 2026-10-10 04:00 WIB → sudah lewat jam 3, jadi
    // antrian hari ini (10 Oktober).
    assert.equal(getQueueDate(3, '2026-10-09T21:00:00Z'), '2026-10-10')

    // 2026-10-09 18:00 UTC = 2026-10-10 01:00 WIB → belum jam 3, jadi masih
    // menghitung sebagai antrian 9 Oktober.
    assert.equal(getQueueDate(3, '2026-10-09T18:00:00Z'), '2026-10-09')
  })

  it('tepat pada jam reset → berganti hari', () => {
    // 2026-10-09 20:00 UTC = 2026-10-10 03:00 WIB, tepat jam reset.
    assert.equal(getQueueDate(3, '2026-10-09T20:00:00Z'), '2026-10-10')
    // 2026-10-09 19:00 UTC = 2026-10-10 02:00 WIB, satu jam sebelumnya.
    assert.equal(getQueueDate(3, '2026-10-09T19:00:00Z'), '2026-10-09')
  })

  it('reset jam 0 berarti hari berganti pukul 00:00 WIB', () => {
    assert.equal(getQueueDate(0, '2026-10-09T17:00:00Z'), '2026-10-10') // 00:00 WIB
    assert.equal(getQueueDate(0, '2026-10-09T16:00:00Z'), '2026-10-09') // 23:00 WIB
  })

  it('mengabaikan reset_hour di luar rentang', () => {
    // Nilai di luar 0..23 harus diperlakukan sebagai 0, bukan membuat
    // perbandingan jam selalu benar (yang membuat antrian bergeser diam-diam).
    const sameAsZero = getQueueDate(0, '2026-10-09T10:00:00Z')
    assert.equal(getQueueDate(99, '2026-10-09T10:00:00Z'), sameAsZero)
    assert.equal(getQueueDate(-5, '2026-10-09T10:00:00Z'), sameAsZero)
    assert.equal(getQueueDate(NaN, '2026-10-09T10:00:00Z'), sameAsZero)
    assert.equal(getQueueDate(3.7, '2026-10-09T10:00:00Z'), getQueueDate(3, '2026-10-09T10:00:00Z'))
  })
})