/**
 * Lapisan tipis di atas Web Bluetooth untuk printer ESC/POS.
 *
 * Alur:
 *  1. `requestDevice()` memunculkan chooser — WAJIB dipanggil dari gestur
 *     pengguna (klik), kalau tidak browser menolaknya.
 *  2. Device yang sama bisa dipakai ulang di kunjungan berikutnya tanpa
 *     chooser lagi, selama `navigator.bluetooth.getDevices()` mengembalikannya
 *     dan izin tidak dicabut.
 *  3. Menulis dipecah per chunk karena GATT MTU Bluetooth hanya ~512 byte;
 *     menulis lebih besar tanpa dipecah diam-diam gagal di sebagian printer.
 */

export type PrinterFlavor = 'generic' | 'epson' | 'compatible'

export type PrinterStatus =
  | { state: 'idle' }
  | { state: 'connecting'; deviceName: string }
  | { state: 'connected'; deviceName: string }
  | { state: 'error'; message: string }

const WRITE_CHUNK_SIZE = 180 // aman di bawah MTU characteristic default (512)

interface BluetoothDeviceLike {
  name?: string | null
  gatt?: {
    connect(): Promise<{
      getPrimaryService(service: string): Promise<{
        getCharacteristic(char: string): Promise<{ writeValue(data: BufferSource): Promise<void> }>
      }>
    }>
  }
}

interface BluetoothApi {
  requestDevice(options: { filters: unknown[]; optionalServices?: string[] }): Promise<BluetoothDeviceLike>
  getDevices(): Promise<BluetoothDeviceLike[]>
}

function getBluetooth(): BluetoothApi | null {
  const nav = navigator as Navigator & { bluetooth?: BluetoothApi }
  return nav.bluetooth ?? null
}

export function isBluetoothSupported(): boolean {
  return getBluetooth() !== null
}

/**
 * Alasan kenapa Web Bluetooth tidak bisa dipakai, untuk ditampilkan ke user.
 * Penting: tidak semua browser mendukungnya — Safari dan Firefox belum, dan
 * Chrome hanya di Android/ChromeOS/Desktop dalam konteks secure.
 */
export function bluetoothUnavailableReason(): string | null {
  if (isBluetoothSupported()) return null
  const ua = navigator.userAgent
  if (/iPhone|iPad|iPod/i.test(ua)) {
    return 'Safari di iOS belum mendukung Web Bluetooth. Gunakan Chrome di Android, atau cetak dari perangkat lain.'
  }
  if (/Firefox/i.test(ua)) {
    return 'Firefox belum mendukung Web Bluetooth. Gunakan Chrome atau Edge.'
  }
  return 'Browser ini belum mendukung Web Bluetooth. Gunakan Chrome atau Edge, dan pastikan halaman diakses lewat HTTPS atau localhost.'
}

/** Cari printer yang sudah pernah disambungkan sebelumnya. */
export async function findKnownPrinter(): Promise<BluetoothDeviceLike | null> {
  const api = getBluetooth()
  if (!api) return null
  try {
    const devices = await api.getDevices()
    return devices[0] ?? null
  } catch {
    return null
  }
}

/**
 * Minta pengguna memilih printer.
 *
 * Filter dipakai longgar supaya printer thermal yang tidak mengiklankan
 * UUID ESC/POS tetap bisa dipilih.
 */
export async function requestPrinter(): Promise<BluetoothDeviceLike> {
  const api = getBluetooth()
  if (!api) {
    throw new Error(bluetoothUnavailableReason() ?? 'Web Bluetooth tidak tersedia.')
  }

  return api.requestDevice({
    filters: [],
    optionalServices: [
      '000018f0-0000-1000-8000-00805f9b34fb', // Generic Access Profile
      '0000ff00-0000-1000-8000-00805f9b34fb', // SPP UUID lama yang dipakai printer
    ],
  })
}

/** Beberapa printer thermal tidak mengekspos UUID standar. */
const WRITE_CHARACTERISTICS = [
  '0000ff02-0000-1000-8000-00805f9b34fb',
  '0000ae30-0000-1000-8000-00805f9b34fb',
  '00002af1-0000-1000-8000-00805f9b34fb',
]

const SP_SERVICE = '0000ff00-0000-1000-8000-00805f9b34fb'
const GAP_SERVICE = '00001800-0000-1000-8000-00805f9b34fb'

/**
 * Tulis byte ke printer.
 *
 * Dicoba characteristic SPP lebih dulu (paling umum), lalu fallback ke GAP.
 */
export async function writeToPrinter(
  device: BluetoothDeviceLike,
  data: Uint8Array,
  onProgress?: (sent: number, total: number) => void,
): Promise<void> {
  if (!device.gatt) {
    throw new Error('Perangkat Bluetooth tidak memiliki antarmuka GATT.')
  }

  const server = await device.gatt.connect()
  let lastError: Error | null = null

  // SPP dulu.
  try {
    const service = await server.getPrimaryService(SP_SERVICE)
    for (const charUuid of WRITE_CHARACTERISTICS) {
      try {
        const characteristic = await service.getCharacteristic(charUuid)
        await writeChunked(characteristic, data, onProgress)
        return
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
      }
    }
  } catch (err) {
    lastError = err instanceof Error ? err : new Error(String(err))
  }

  // Fallback: Generic Attribute Profile.
  try {
    const service = await server.getPrimaryService(GAP_SERVICE)
    const characteristic = await service.getCharacteristic(
      '00002af1-0000-1000-8000-00805f9b34fb',
    )
    await writeChunked(characteristic, data, onProgress)
    return
  } catch (err) {
    lastError = err instanceof Error ? err : new Error(String(err))
  }

  throw new Error(
    `Tidak menemukan characteristic tulis pada printer. Pastikan printer dalam mode pairing. ` +
      `Detail: ${lastError?.message ?? 'tidak diketahui'}`,
  )
}

async function writeChunked(
  characteristic: { writeValue(data: BufferSource): Promise<void> },
  data: Uint8Array,
  onProgress?: (sent: number, total: number) => void,
): Promise<void> {
  const total = data.length
  let sent = 0

  while (sent < total) {
    const end = Math.min(sent + WRITE_CHUNK_SIZE, total)
    // Slice disalin karena sebagian implementasi menolak Uint8Array yang
    // merupakan view dari buffer lebih besar.
    await characteristic.writeValue(data.slice(sent, end))
    sent = end
    onProgress?.(sent, total)
    // Jeda singkat agar buffer printer sempat menerima seluruh chunk sebelum
    // chunk berikutnya dikirim; tanpa ini printer 58mm sering kehilangan byte.
    await new Promise((r) => setTimeout(r, 12))
  }
}

/** Coba putuskan GATT. Aman dipanggil berulang. */
export async function disconnectPrinter(device: BluetoothDeviceLike): Promise<void> {
  if (device.gatt && 'disconnect' in device.gatt) {
    const gatt = device.gatt as { disconnect?(): void; connected?: boolean }
    if (gatt.connected) gatt.disconnect?.()
  }
}

/**
 * Simpan preferensi printer di localStorage agar tidak perlu memilih ulang
 * (memilih ulang hanya mungkin setelah gestur pengguna).
 */
const STORAGE_KEY = 'antrian.printer'

export interface SavedPrinter {
  name: string
  flavor: PrinterFlavor
  savedAt: string
}

export function savePrinterPreference(name: string, flavor: PrinterFlavor): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ name, flavor, savedAt: new Date().toISOString() }),
    )
  } catch {
    // localStorage bisa diblokir (mode privat) — bukan kondisi fatal.
  }
}

export function loadPrinterPreference(): SavedPrinter | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SavedPrinter
    return parsed?.name ? parsed : null
  } catch {
    return null
  }
}