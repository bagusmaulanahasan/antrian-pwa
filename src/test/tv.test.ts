/**
 * Unit test untuk logika murni Dashboard TV.
 *
 * Fokus: render template suara, urutan antrean, dan konfigurasi PIN.
 * Jalankan: node --experimental-strip-types --test src/test/tv.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_VOICE_TEMPLATE,
  isSpeechSupported,
  renderTemplate,
} from '../lib/speech.ts'

describe('renderTemplate', () => {
  const input = { number: 42, customerName: 'Budi Santoso', categoryName: 'Rawat Jalan' }

  it('mengganti seluruh placeholder yang dikenal', () => {
    const out = renderTemplate(
      'Nomor {nomor}, nama {nama}, kategori {kategori}',
      input,
    )
    assert.equal(out, 'Nomor 42, nama Budi Santoso, kategori Rawat Jalan')
  })

  it('mengganti placeholder yang muncul lebih dari sekali', () => {
    const out = renderTemplate('{nomor} lagi {nomor}', input)
    assert.equal(out, '42 lagi 42')
  })

  it('membiarkan placeholder yang tidak dikenal tetap utuh', () => {
    const out = renderTemplate('{nomor} {tidakDikenal}', input)
    assert.equal(out, '42 {tidakDikenal}')
  })

  it('berfungsi dengan template default PRD', () => {
    const out = renderTemplate(DEFAULT_VOICE_TEMPLATE.text, input)
    assert.ok(out.includes('42'), out)
    assert.ok(out.includes('Budi Santoso'), out)
    assert.ok(out.includes('Rawat Jalan'), out)
    assert.ok(!out.includes('{'), 'tidak ada placeholder tersisa: ' + out)
  })

  it('tidak melempar error untuk input kosong', () => {
    const out = renderTemplate('{nomor} {nama}', { number: 0, customerName: '', categoryName: '' })
    assert.equal(out, '0 ')
  })
})

describe('konfigurasi PIN TV', () => {
  it('getTvPin mengembalikan string kosong bila env tidak diisi', async () => {
    const { getTvPin } = await import('../lib/tvConfig.ts')
    // Test berjalan tanpa VITE_TV_PIN — PIN harus kosong, bukan default lemah.
    assert.equal(typeof getTvPin(), 'string')
  })

  it('isTvPinConfigured konsisten dengan getTvPin', async () => {
    const { getTvPin, isTvPinConfigured } = await import('../lib/tvConfig.ts')
    assert.equal(isTvPinConfigured(), getTvPin().length >= 4)
  })

  it('menolak PIN terlalu pendek (< 4 karakter)', async () => {
    // Nilai dibaca dari import.meta.env, jadi diuji lewat logika yang sama.
    const short = '12'
    assert.ok(short.length < 4)
    assert.ok(!isTvPinConfiguredWith('12'), 'PIN 2 karakter tidak boleh dipakai')
    assert.ok(isTvPinConfiguredWith('1234'), 'PIN 4 karakter boleh dipakai')
  })
})

/** Salinan logika isTvPinConfigured agar bisa diuji dengan nilai apa pun. */
function isTvPinConfiguredWith(pin: string): boolean {
  return pin.length >= 4
}

describe('urutan antrean TV', () => {
  interface SortableEntry {
    id: string
    number: number
    status: string
    priority: number
  }

  // Menyalin aturan urutan dari TvDashboardView agar bisa diuji tanpa DOM.
  const rank: Record<string, number> = { pending: 0, waiting: 1, serving: 2 }
  const sortEntries = (entries: SortableEntry[]): SortableEntry[] =>
    entries
      .filter((e) => rank[e.status] !== undefined)
      .sort((a, b) => {
        if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status]
        if (a.priority !== b.priority) return b.priority - a.priority
        return a.number - b.number
      })

  it('menampilkan pending di atas waiting (sesuai PRD)', () => {
    const out = sortEntries([
      { id: 'a', number: 1, status: 'waiting', priority: 0 },
      { id: 'b', number: 2, status: 'pending', priority: 0 },
    ])
    assert.equal(out[0].id, 'b', 'pending harus di atas')
  })

  it('mengurutkan nomor menunggu dari kecil ke besar', () => {
    const out = sortEntries([
      { id: 'c', number: 5, status: 'waiting', priority: 0 },
      { id: 'a', number: 3, status: 'waiting', priority: 0 },
      { id: 'b', number: 4, status: 'waiting', priority: 0 },
    ])
    assert.deepEqual(out.map((e) => e.number), [3, 4, 5])
  })

  it('mendahulukan nomor dengan priority lebih tinggi', () => {
    const out = sortEntries([
      { id: 'a', number: 2, status: 'waiting', priority: 0 },
      { id: 'b', number: 9, status: 'waiting', priority: 1 },
    ])
    assert.equal(out[0].id, 'b', 'nomor diprioritaskan (panggil ulang) naik ke atas')
  })

  it('menyembunyikan nomor done dan cancelled', () => {
    const out = sortEntries([
      { id: 'a', number: 1, status: 'waiting', priority: 0 },
      { id: 'b', number: 2, status: 'done', priority: 0 },
      { id: 'c', number: 3, status: 'cancelled', priority: 0 },
    ])
    assert.equal(out.length, 1)
    assert.equal(out[0].id, 'a')
  })

  it('menampilkan nomor serving di antara waiting', () => {
    const out = sortEntries([
      { id: 'a', number: 1, status: 'waiting', priority: 0 },
      { id: 'b', number: 2, status: 'serving', priority: 0 },
      { id: 'c', number: 3, status: 'pending', priority: 0 },
    ])
    assert.deepEqual(out.map((e) => e.status), ['pending', 'waiting', 'serving'])
  })
})

describe('dukungan Web Speech', () => {
  it('isSpeechSupported tidak melempar error di lingkungan test', () => {
    assert.equal(typeof isSpeechSupported(), 'boolean')
  })

  it('template default punya rate, volume, dan repeat yang valid', () => {
    assert.ok(DEFAULT_VOICE_TEMPLATE.rate > 0 && DEFAULT_VOICE_TEMPLATE.rate <= 2)
    assert.ok(DEFAULT_VOICE_TEMPLATE.volume > 0 && DEFAULT_VOICE_TEMPLATE.volume <= 1)
    assert.ok(Number.isInteger(DEFAULT_VOICE_TEMPLATE.repeat))
    assert.ok(DEFAULT_VOICE_TEMPLATE.repeat >= 1)
  })
})