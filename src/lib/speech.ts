/**
 * Pengumuman suara untuk Dashboard TV (Web Speech API).
 *
 * Batasan penting browser yang harus ditangani:
 *  - `speechSynthesis.speak()` hanya berjalan setelah ada interaksi pengguna
 *    (kebijakan autoplay). Karena itu TV menampilkan tombol "Aktifkan Suara".
 *  - Chrome membatalkan suara pada halaman tak terlihat (`visibilityState`).
* TV sering disembunyikan, jadi pengumuman yang terjadwal diulang saat
 *    halaman kembali terlihat.
 *  - Beberapa browser (Chrome lama) membatalkan `speechSynthesis` bila halaman
 *    di-refresh. `onend` + jeda pendek menjaga antrean tetap hidup.
 */

export interface VoiceTemplate {
  text: string
  rate: number
  volume: number
  repeat: number
}

export const DEFAULT_VOICE_TEMPLATE: VoiceTemplate = {
  text: 'Nomor antrian {nomor}, atas nama {nama}, kategori {kategori}, silakan menuju ke depan.',
  rate: 1,
  volume: 1,
  repeat: 1,
}

export interface AnnounceInput {
  number: number
  customerName: string
  categoryName: string
}

/** Ganti placeholder pada template. Placeholder yang tidak dikenal dibiarkan utuh. */
export function renderTemplate(template: string, input: AnnounceInput): string {
  return template
    .replace(/\{nomor\}/g, String(input.number))
    .replace(/\{nama\}/g, input.customerName)
    .replace(/\{kategori\}/g, input.categoryName)
}

export function isSpeechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

export class Announcer {
  private queue: string[] = []
  private speaking = false
  private voice: SpeechSynthesisVoice | null = null
  private unsubscribers: Array<() => void> = []
  private readonly onState?: (speaking: boolean) => void

  // Parameter property (`constructor(private x)`) tidak didukung mode strip-only
  // milik Node, jadi ditulis eksplisit agar modul bisa diuji tanpa build.
  constructor(onState?: (speaking: boolean) => void) {
    this.onState = onState
  }

  /** Pilih suara Indonesia kalau tersedia; lebih mudah dipahami pengguna. */
  async init(): Promise<void> {
    if (!isSpeechSupported()) return

    await new Promise<void>((resolve) => {
      const pick = () => {
        const voices = window.speechSynthesis.getVoices()
        if (voices.length > 0) {
          this.voice =
            voices.find((v) => v.lang?.toLowerCase().startsWith('id')) ??
            voices.find((v) => v.lang?.toLowerCase().startsWith('in')) ??
            voices[0] ??
            null
          resolve()
        }
      }
      pick()
      // some browser mengisi daftar suara secara asinkron.
      window.speechSynthesis.onvoiceschanged = pick
      setTimeout(resolve, 1500)
    })

    // Halaman TV sering tersembunyi; Chrome membatalkan suara saat halaman
    // tak terlihat, jadi penguinuman diulang saat kembali terlihat.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && this.queue.length > 0) {
        this.drain()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    this.unsubscribers.push(() => document.removeEventListener('visibilitychange', onVisible))

    const onBeforeUnload = () => window.speechSynthesis.cancel()
    window.addEventListener('beforeunload', onBeforeUnload)
    this.unsubscribers.push(() => window.removeEventListener('beforeunload', onBeforeUnload))
  }

  /** Masukkan teks ke antrean. `repeat` mengulang pengumuman. */
  enqueue(text: string, template: VoiceTemplate = DEFAULT_VOICE_TEMPLATE): void {
    const trimmed = text.trim()
    if (!trimmed) return
    const repeat = Math.max(1, Math.min(5, Math.floor(template.repeat)))
    for (let i = 0; i < repeat; i++) this.queue.push(trimmed)
    this.drain()
  }

  private drain(): void {
    if (this.speaking || this.queue.length === 0 || !isSpeechSupported()) return
    if (document.visibilityState === 'hidden') return

    this.speaking = true
    this.onState?.(true)
    this.speakNext()
  }

  private speakNext(): void {
    const text = this.queue.shift()
    if (!text) {
      this.speaking = false
      this.onState?.(false)
      return
    }

    const utterance = new SpeechSynthesisUtterance(text)
    if (this.voice) utterance.voice = this.voice
    utterance.lang = this.voice?.lang ?? 'id-ID'
    utterance.rate = 1
    utterance.volume = 1

    const finish = () => {
      // Chrome kadang berhenti memproses antrean tanpa memanggil onend
      // bila dua utterance dimulai pada satu tick.
      setTimeout(() => this.speakNext(), 120)
    }
    utterance.onend = finish
    utterance.onerror = finish

    try {
      window.speechSynthesis.speak(utterance)
    } catch {
      this.speaking = false
      this.onState?.(false)
    }
  }

  /** Hentikan pengumuman dan kosongkan antrean. */
  cancel(): void {
    this.queue = []
    if (isSpeechSupported()) window.speechSynthesis.cancel()
    this.speaking = false
    this.onState?.(false)
  }

  /** Uji suara dengan kalimat pendek (dipakai tombol "Aktifkan Suara"). */
  speakTest(template: VoiceTemplate = DEFAULT_VOICE_TEMPLATE): void {
    this.enqueue('Suara pengumuman aktif.', template)
  }

  dispose(): void {
    this.cancel()
    for (const fn of this.unsubscribers) fn()
    this.unsubscribers = []
  }

  get pendingCount(): number {
    return this.queue.length
  }
}