/**
 * Generator byte ESC/POS 58mm.
 *
 * Printer thermal datang dalam beberapa dialek:
 *  - ESC/POS resmi (Epson): header `1B 40`, dan teks memakai `{ESC}/`
 *  - Chinese/Generik (58mm tanpa margin): yang paling umum di retail
 *
 * Mode `compatible` (default) mengirim `{ESC}/` di awal baris agar printer
 * resmi tahu posisi awal baris — tanpa itu, beberapa printer menggeser
 * seluruh teks ke kanan.
 *
 * Semua fungsi mengembalikan Uint8Array supaya bisa dikirim langsung lewat
 * Web Bluetooth `writeValue()`.
 */

const ESC = 0x1b
const GS = 0x1d
const LF = 0x0a

/** Lebar kertas 58mm ≈ 32 karakter dengan font A. */
export const LINE_WIDTH = 32

export type PrinterFlavor = 'generic' | 'epson' | 'compatible'

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values)
}

/** Inisialisasi printer. */
function init(flavor: PrinterFlavor): Uint8Array {
  switch (flavor) {
    case 'epson':
      return bytes(ESC, 0x40) // ESC @
    case 'generic':
      return bytes(ESC, 0x74, 0x10, 0x1b, 0x74, 0x01, 0x1b, 0x52, 0x01)
    default:
      return bytes(ESC, 0x40, ESC, 0x74, 0x10)
  }
}

/**
 * Potong teks ke lebar kertas, dengan cuplikan `{ Placeholder }` yang tidak
 * boleh terpotong di tengah (mis. `{nomor}`).
 */
export function wrapText(text: string, width = LINE_WIDTH): string[] {
  const lines: string[] = []

  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      lines.push('')
      continue
    }

    // Pecah berdasarkan placeholder dulu, lalu gabung kembali.
    const tokens: string[] = []
    const placeholderPattern = /\{[a-zA-Z0-9_]+\}/g
    let lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = placeholderPattern.exec(paragraph)) !== null) {
      if (match.index > lastIndex) {
        tokens.push(...breakLongWord(paragraph.slice(lastIndex, match.index), width))
      }
      tokens.push(match[0])
      lastIndex = match.index + match[0].length
    }
    if (lastIndex < paragraph.length) {
      tokens.push(...breakLongWord(paragraph.slice(lastIndex), width))
    }

    // Susun ulang jadi baris selebar mungkin, tanpa memecah placeholder.
    let current = ''
    for (const token of tokens) {
      if (current.length === 0) {
        current = token
      } else if (current.length + token.length <= width) {
        current += token
      } else {
        lines.push(current)
        current = token
      }
    }
    if (current.length > 0) lines.push(current)
  }

  return lines
}

/** Pecah kata yang lebih panjang dari lebar kertas. */
function breakLongWord(text: string, width: number): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > width) {
    out.push(rest.slice(0, width))
    rest = rest.slice(width)
  }
  if (rest.length > 0) out.push(rest)
  return out
}

/** Baris rata tengah (untuk judul tempat). */
export function center(text: string, width = LINE_WIDTH): Uint8Array {
  const pad = Math.max(0, Math.floor((width - text.length) / 2))
  return encode(' '.repeat(pad) + text + '\n')
}

/** Baris rata kiri-kanan (untuk "No: 12" dsb). */
export function leftRight(left: string, right: string, width = LINE_WIDTH): Uint8Array {
  const gap = Math.max(1, width - left.length - right.length)
  return encode(left + ' '.repeat(gap) + right + '\n')
}

/** Teks tebal. */
export function bold(text: string): Uint8Array {
  return concat([
    bytes(ESC, 0x45, 0x01), // ESC E 1
    encode(text + '\n'),
    bytes(ESC, 0x45, 0x00), // ESC E 0
  ])
}

/**
 * Pemisah garis. Printer thermal tidak punya karakter ━, jadi memakai
 * karakter yang pasti tersedia di semua font code page default.
 */
export function divider(width = LINE_WIDTH): Uint8Array {
  return encode('-'.repeat(width) + '\n')
}

/**
 * Set ukuran font via GS !.
 * `2` = double width + double height (untuk nomor tiket).
 * `0` = normal.
 */
export function fontSize(size: 0 | 2): Uint8Array {
  return bytes(GS, 0x21, size === 2 ? 0x11 : 0x00)
}

/** Select code page (0 = PC437/ANSI default). */
export function codePage(page = 0): Uint8Array {
  return bytes(ESC, 0x74, page)
}

/**
 * Baris dengan penanda awal `{ESC}/` bila flavor `compatible`.
 * Tanpa ini beberapa printer resmi menggeser teks ke tengah baris.
 */
function line(text: string, flavor: PrinterFlavor): Uint8Array {
  const prefix = flavor === 'compatible' ? bytes(ESC, 0x2f) : new Uint8Array(0)
  return concat([prefix, encode(text + '\n')])
}

export interface TicketData {
  placeName?: string
  address?: string
  phone?: string
  number: number
  customerName: string
  categoryName: string
  date: string
}

/** Waktu dalam Bahasa Indonesia, format panjang. */
export function formatIndonesianDate(isoDate: string, now = new Date()): string {
  const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']
  const months = [
    'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
  ]

  // Tanggal antrian bisa berbeda dari hari ini kalau jam reset sudah lewat.
  const [y, m, d] = isoDate.split('-').map(Number)
  const date = Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)
    ? new Date(Date.UTC(y, m - 1, d, 7))
    : now

  return `${days[date.getUTCDay()]}, ${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`
}

/**
 * Bangun byte tiket lengkap.
 *
 * Urutan perintah penting: inisialisasi dulu, lalu set ukuran font, baru isi,
 * lalu potong kertas di akhir. Ukuran font HARUS dikembalikan ke normal
 * (GS ! 0) sebelum potong — kalau tidak, printer akan memotong dengan
 * ketebalan yang tidak/areDimensions salah.
 */
export function buildTicket(data: TicketData, flavor: PrinterFlavor = 'compatible'): Uint8Array {
  const chunks: Uint8Array[] = [init(flavor), codePage(0)]

  // Double width/height
  chunks.push(fontSize(2))

  if (data.placeName) {
    for (const l of wrapText(data.placeName.toUpperCase())) {
      const pad = Math.max(0, Math.floor((LINE_WIDTH - l.length) / 2))
      chunks.push(line(' '.repeat(pad) + l, flavor))
    }
  }

  if (data.address) {
    for (const l of wrapText(data.address)) chunks.push(line(l, flavor))
  }
  if (data.phone) chunks.push(line(data.phone, flavor))

  chunks.push(divider())

  // Nomor dibuat besar — ini yang paling penting dibaca pelanggan.
  chunks.push(fontSize(2))
  const numberText = String(data.number)
  const pad = Math.max(0, Math.floor((LINE_WIDTH - numberText.length) / 2))
  chunks.push(bold(' '.repeat(pad) + numberText))
  // Kembalikan font ke normal.
  chunks.push(bytes(GS, 0x21, 0x00))

  chunks.push(divider())

  chunks.push(leftRight('Nama', truncate(data.customerName, 18)))
  chunks.push(leftRight('Kategori', truncate(data.categoryName, 12)))
  chunks.push(leftRight('Tanggal', data.date))

  chunks.push(divider(), line('Terima kasih', flavor), line('Silakan menunggu dipanggil', flavor))

  // Potong kertas (partial cut) dan majukan gulungan 3 baris.
  chunks.push(bytes(LF, LF, LF), bytes(GS, 0x56, 0x00))

  return concat(chunks)
}

/** Potong teks dengan elipsis bila kelewat panjang. */
export function truncate(text: string, max: number): string {
  const clean = text.trim()
  if (clean.length <= max) return clean
  return clean.slice(0, Math.max(0, max - 1)) + '…'
}

/** Estimate jumlah byte untuk memeriksa batas buffer Bluetooth (~512 byte/mTU). */
export function estimateBytes(data: Uint8Array): number {
  return data.length
}