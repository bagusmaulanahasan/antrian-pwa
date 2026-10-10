<script setup lang="ts">
import {
  AlertTriangle,
  BellRing,
  Check,
  ChevronRight,
  ClipboardList,
  Clock,
  LogOut,
  Plus,
  Printer,
  RefreshCw,
  RotateCcw,
  SkipForward,
  Square,
  Tv,
  UserPlus,
  X,
} from 'lucide-vue-next'
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  callNext,
  createQueueEntry,
  fetchCategories,
  fetchQueue,
  markPrinted,
  recallEntry,
  setQueueStatus,
  STATUS_CLASS,
  STATUS_LABEL,
  type Category,
  type QueueEntry,
  type QueueSnapshot,
} from '@/lib/queueApi'
import { authUser, isAuthenticated, logout, mustChangePassword } from '@/stores/auth'
import { getQueueDate } from '@/lib/types'
import { formatIndonesianDate, buildTicket, truncate } from '@/lib/escpos'
import {
  bluetoothUnavailableReason,
  disconnectPrinter,
  findKnownPrinter,
  isBluetoothSupported,
  loadPrinterPreference,
  requestPrinter,
  savePrinterPreference,
  writeToPrinter,
  type PrinterFlavor,
} from '@/lib/bluetooth'

const router = useRouter()
const user = authUser

// ------------------------------------------------------------- state
const loading = ref(true)
const loadError = ref<string | null>(null)
const categories = ref<Category[]>([])
const snapshot = ref<QueueSnapshot | null>(null)

const categoryName = (id: string | null) =>
  categories.value.find((c) => c.id === id)?.name ?? 'Umum'

const counts = computed(() => snapshot.value?.counts ?? {
  waiting: 0, serving: 0, pending: 0, done: 0, cancelled: 0,
})

const entries = computed(() => snapshot.value?.entries ?? [])

/** Nomor yang sedang dilayani — ditampilkan besar di panel utama. */
const serving = computed(() => entries.value.find((e) => e.status === 'serving') ?? null)

/** Menunggu + pending, nomor `pending` selalu di atas sesuai PRD. */
const queueList = computed(() => {
  const order: Record<string, number> = { pending: 0, waiting: 1, serving: 2, done: 3, cancelled: 4 }
  return entries.value
    .filter((e) => e.status === 'waiting' || e.status === 'pending' || e.status === 'serving')
    .sort((a, b) => {
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status]
      if (a.priority !== b.priority) return b.priority - a.priority
      return a.number - b.number
    })
})

const todayLabel = computed(() =>
  snapshot.value ? formatIndonesianDate(snapshot.value.date) : formatIndonesianDate(getQueueDate()),
)

// ------------------------------------------------- printer (Bluetooth)
const printerName = ref<string | null>(null)
const printerError = ref<string | null>(null)
const printing = ref(false)
const printProgress = ref<{ sent: number; total: number } | null>(null)
const bluetoothSupported = isBluetoothSupported()
const bluetoothReason = bluetoothUnavailableReason()

// -------------------------------------------- dialog pendaftaran pelanggan
const showRegister = ref(false)
const registerCategoryId = ref<string | null>(null)
const customerName = ref('')
const submitting = ref(false)
const registerError = ref<string | null>(null)

/** Entri yang tiketnya gagal cetak → offered "Cetak Ulang". */
const failedPrints = ref<QueueEntry[]>([])

const canSubmit = computed(
  () => !submitting.value && customerName.value.trim().length > 0,
)

// ------------------------------------------------------------- methods
async function reload() {
  try {
    loadError.value = null
    const [queue, cat] = await Promise.all([fetchQueue(), fetchCategories()])
    snapshot.value = queue
    categories.value = cat.categories
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : 'Gagal memuat data antrian.'
  } finally {
    loading.value = false
  }
}

async function withBusy(fn: () => Promise<void>) {
  try {
    await fn()
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : 'Terjadi kesalahan.'
  }
}

async function onRegister() {
  if (!canSubmit.value) return
  submitting.value = true
  registerError.value = null

  try {
    // Data disimpan DULU dengan print_status 'pending'. Kalau printer gagal,
    // nomor tetap ada — ini keputusan produk di PRD supaya pelanggan tidak
    // kehilangan nomor antrian.
    const { entry } = await createQueueEntry({
      customerName: customerName.value.trim(),
      categoryId: registerCategoryId.value,
      printStatus: 'pending',
    })

    // Baru coba cetak. Kegagalan di sini tidak membatalkan pendaftaran.
    const printed = await tryPrint(entry)

    if (printed) {
      await markPrinted(entry.id, true)
    } else {
      await markPrinted(entry.id, false)
      failedPrints.value = [...failedPrints.value, { ...entry, print_status: 'failed' }]
    }

    customerName.value = ''
    showRegister.value = false
    await reload()
  } catch (err) {
    registerError.value = err instanceof Error ? err.message : 'Gagal membuat antrian.'
  } finally {
    submitting.value = false
  }
}

function buildEntryBytes(entry: QueueEntry): Uint8Array {
  const prefs = loadPrinterPreference()
  return buildTicket(
    {
      number: entry.number,
      customerName: entry.customer_name,
      categoryName: categoryName(entry.category_id),
      date: formatIndonesianDate(entry.queue_date),
    },
    (prefs?.flavor ?? 'compatible') as PrinterFlavor,
  )
}

/** True bila tiket berhasil dicetak; error dicatat, tidak dilempar. */
async function tryPrint(entry: QueueEntry): Promise<boolean> {
  if (!bluetoothSupported) {
    printerError.value = bluetoothReason
    return false
  }

  printing.value = true
  printProgress.value = null
  try {
    let device = await findKnownPrinter()
    if (!device) {
      // requestDevice() HANYA boleh dipanggil dari gestur pengguna. Pemanggilan
      // otomatis akan ditolak browser dengan SecurityError.
      if (!navigator.userActivation?.isActive) {
        throw new Error(
          'Pilih printer lewat tombol "Hubungkan Printer" terlebih dahulu. Browser hanya mengizinkan pemilihan printer dari klik pengguna.',
        )
      }
      device = await requestPrinter()
      savePrinterPreference(device.name ?? 'Printer', loadPrinterPreference()?.flavor ?? 'compatible')
    }

    printerName.value = device.name ?? 'Printer'
    const bytes = buildEntryBytes(entry)
    await writeToPrinter(device as never, bytes, (sent, total) => {
      printProgress.value = { sent, total }
    })
    printerError.value = null
    return true
  } catch (err) {
    printerError.value = err instanceof Error ? err.message : 'Gagal mencetak tiket.'
    return false
  } finally {
    printing.value = false
    printProgress.value = null
  }
}

async function onConnectPrinter() {
  printerError.value = null
  try {
    const device = await requestPrinter()
    printerName.value = device.name ?? 'Printer'
    savePrinterPreference(
      printerName.value,
      loadPrinterPreference()?.flavor ?? 'compatible',
    )
  } catch (err) {
    printerError.value = err instanceof Error ? err.message : 'Gagal terhubung ke printer.'
  }
}

async function onDisconnectPrinter() {
  const device = await findKnownPrinter()
  if (device) await disconnectPrinter(device as never)
  printerName.value = null
}

async function onReprint(entry: QueueEntry) {
  const ok = await tryPrint(entry)
  if (ok) {
    await markPrinted(entry.id, true)
    failedPrints.value = failedPrints.value.filter((e) => e.id !== entry.id)
    await reload()
  }
}

async function onSkipPrint(entry: QueueEntry) {
  // Nomor tetap waiting dengan print_status 'failed'; admin bisa mencetak
  // ulang kapan saja lewat tombol di daftar.
  failedPrints.value = failedPrints.value.filter((e) => e.id !== entry.id)
  await reload()
}

async function onNext() {
  await withBusy(async () => {
    await callNext()
    await reload()
  })
}

async function onStatus(entry: QueueEntry, status: QueueEntry['status']) {
  await withBusy(async () => {
    await setQueueStatus(entry.id, status)
    await reload()
  })
}

async function onRecall(entry: QueueEntry) {
  await withBusy(async () => {
    await recallEntry(entry.id)
    await reload()
  })
}

async function onLogout() {
  await logout()
  await router.push({ name: 'login' })
}

function openRegister(categoryId: string | null) {
  registerCategoryId.value = categoryId
  registerError.value = null
  showRegister.value = true
}

// Persisten: tutup dialog bila terautentikasi berubah.
watch(mustChangePassword, (v) => {
  if (v) router.push('/change-password')
})

onMounted(async () => {
  if (!isAuthenticated.value) {
    await router.push({ name: 'login', query: { redirect: '/admin' } })
    return
  }
  const known = await findKnownPrinter()
  printerName.value = known?.name ?? null
  await reload()
})
</script>

<template>
  <div class="min-h-screen bg-slate-100">
    <!-- Header -->
    <header class="border-b border-slate-200 bg-white">
      <div class="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div>
          <h1 class="text-lg font-bold text-slate-900">Dashboard Admin</h1>
          <p class="text-xs text-slate-500">{{ todayLabel }}</p>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <span
            v-if="printerName"
            class="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-600/20"
            data-testid="printer-status"
          >
            <Printer class="h-3.5 w-3.5" />
            {{ printerName }}
          </span>
          <button
            v-if="printerName"
            type="button"
            class="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            data-testid="printer-disconnect"
            @click="onDisconnectPrinter"
          >
            Putuskan
          </button>
          <button
            v-else
            type="button"
            class="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-900 disabled:opacity-60"
            :disabled="!bluetoothSupported || printing"
            data-testid="printer-connect"
            @click="onConnectPrinter"
          >
            Hubungkan Printer
          </button>

          <RouterLink
            to="/tv"
            class="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <Tv class="mr-1 inline h-3.5 w-3.5" />
            TV
          </RouterLink>

          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            data-testid="admin-logout"
            @click="onLogout"
          >
            <LogOut class="h-3.5 w-3.5" />
            {{ user?.display_name || 'Keluar' }}
          </button>
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-6xl space-y-5 px-4 py-6">
      <!-- Pesan -->
      <div
        v-if="loadError"
        class="flex items-start gap-2 rounded-xl bg-rose-50 p-4 text-sm text-rose-800 ring-1 ring-rose-600/20"
        data-testid="load-error"
        role="alert"
      >
        <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
        <span>{{ loadError }}</span>
      </div>

      <div
        v-if="printerError"
        class="flex items-start justify-between gap-2 rounded-xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-600/20"
        data-testid="printer-error"
        role="alert"
      >
        <div class="flex items-start gap-2">
          <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
          <span>{{ printerError }}</span>
        </div>
        <button type="button" class="text-amber-700 hover:text-amber-900" @click="printerError = null">
          <X class="h-4 w-4" />
        </button>
      </div>

      <!-- Tiket gagal cetak -->
      <section
        v-if="failedPrints.length"
        class="rounded-xl border border-amber-300 bg-amber-50 p-4"
        data-testid="failed-prints"
      >
        <div class="flex items-start gap-2">
          <AlertTriangle class="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div class="min-w-0 flex-1">
            <p class="font-semibold text-amber-900">
              {{ failedPrints.length }} tiket gagal dicetak
            </p>
            <p class="mt-0.5 text-sm text-amber-800">
              Nomor antrian tetap tercatat dan pelanggan tetap dalam antrean. Cetak ulang
              tiketnya saat printer siap.
            </p>

            <ul class="mt-3 space-y-2">
              <li
                v-for="entry in failedPrints"
                :key="entry.id"
                class="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white px-3 py-2 text-sm"
              >
                <span class="font-medium">
                  #{{ entry.number }} — {{ truncate(entry.customer_name, 30) }}
                </span>
                <div class="flex gap-2">
                  <button
                    type="button"
                    class="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-60"
                    :disabled="printing"
                    :data-testid="`reprint-${entry.number}`"
                    @click="onReprint(entry)"
                  >
                    <Printer class="h-3.5 w-3.5" />
                    Cetak Ulang
                  </button>
                  <button
                    type="button"
                    class="rounded-lg border border-amber-300 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100"
                    :data-testid="`skip-print-${entry.number}`"
                    @click="onSkipPrint(entry)"
                  >
                    Lewati
                  </button>
                </div>
              </li>
            </ul>
          </div>
        </div>
      </section>

      <div v-if="loading" class="flex items-center justify-center gap-2 py-20 text-sm text-slate-500">
        <span class="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600" />
        Memuat antrian…
      </div>

      <template v-else>
        <!-- Nomor dilayani -->
        <section
          class="rounded-xl border p-5"
          :class="serving ? 'border-indigo-300 bg-indigo-50' : 'border-slate-200 bg-white'"
          data-testid="serving-card"
        >
          <div class="flex flex-wrap items-center justify-between gap-4">
            <div class="min-w-0">
              <p class="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Sedang Dilayani
              </p>
              <template v-if="serving">
                <p class="mt-1 text-6xl font-black tracking-tight text-indigo-700" data-testid="serving-number">
                  {{ serving.number }}
                </p>
                <p class="mt-1 text-lg font-semibold text-slate-800" data-testid="serving-name">
                  {{ serving.customer_name }}
                </p>
                <p class="text-sm text-slate-600">
                  {{ categoryName(serving.category_id) }}
                </p>
              </template>
              <p v-else class="mt-2 text-sm text-slate-500" data-testid="no-serving">
                Belum ada nomor yang sedang dilayani.
              </p>
            </div>

            <button
              type="button"
              class="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-60"
              data-testid="btn-next"
              @click="onNext"
            >
              <ChevronRight class="h-4 w-4" />
              Nomor Berikutnya
            </button>
          </div>
        </section>

        <!-- Statistik -->
        <section class="grid grid-cols-2 gap-3 sm:grid-cols-5" data-testid="stats">
          <div
            v-for="key in (['waiting', 'serving', 'pending', 'done', 'cancelled'] as const)"
            :key="key"
            class="rounded-xl border border-slate-200 bg-white p-3 text-center"
            :data-testid="`stat-${key}`"
          >
            <p class="text-2xl font-bold text-slate-900">{{ counts[key] }}</p>
            <p class="text-xs text-slate-500">{{ STATUS_LABEL[key] }}</p>
          </div>
        </section>

        <!-- Kategori: klik untuk mendaftarkan pelanggan -->
        <section class="rounded-xl border border-slate-200 bg-white p-5">
          <h2 class="flex items-center gap-2 font-semibold text-slate-900">
            <Plus class="h-4 w-4 text-indigo-600" />
            Tambah Antrian
          </h2>
          <p class="mt-1 text-sm text-slate-600">
            Pilih kategori, lalu masukkan nama pelanggan. Tiket dicetak otomatis.
          </p>

          <div v-if="categories.length" class="mt-4 grid gap-3 sm:grid-cols-3">
            <button
              v-for="cat in categories"
              :key="cat.id"
              type="button"
              class="group relative overflow-hidden rounded-xl border-2 p-4 text-left transition hover:shadow-md"
              :style="{ borderColor: cat.color, backgroundColor: `${cat.color}0d` }"
              :data-testid="`category-${cat.code ?? cat.id}`"
              @click="openRegister(cat.id)"
            >
              <div class="flex items-center justify-between">
                <span class="font-semibold" :style="{ color: cat.color }">{{ cat.name }}</span>
                <span
                  v-if="counts.waiting"
                  class="rounded-full bg-white px-2 py-0.5 text-xs font-bold"
                  :style="{ color: cat.color }"
                >
                  {{ snapshot?.entries.filter((e) => e.category_id === cat.id && (e.status === 'waiting' || e.status === 'pending')).length }}
                </span>
              </div>
              <p class="mt-1 text-xs text-slate-500">{{ cat.code ?? '—' }}</p>
              <span
                class="mt-3 inline-flex items-center gap-1 text-xs font-semibold"
                :style="{ color: cat.color }"
              >
                <UserPlus class="h-3.5 w-3.5" />
                Daftar Pelanggan
              </span>
            </button>
          </div>

          <p v-else class="mt-4 rounded-lg bg-slate-50 p-4 text-sm text-slate-600">
            Belum ada kategori aktif. Owner perlu menambahkannya di halaman pengaturan.
          </p>
        </section>

        <!-- Daftar antrian -->
        <section class="rounded-xl border border-slate-200 bg-white">
          <div class="flex items-center justify-between border-b border-slate-200 px-5 py-3">
            <h2 class="flex items-center gap-2 font-semibold text-slate-900">
              <ClipboardList class="h-4 w-4 text-slate-500" />
              Daftar Antrian
            </h2>
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              data-testid="btn-refresh"
              @click="reload"
            >
              <RefreshCw class="h-3.5 w-3.5" />
              Muat ulang
            </button>
          </div>

          <div v-if="!queueList.length" class="p-8 text-center text-sm text-slate-500">
            Belum ada antrean. Klik salah satu kategori di atas untuk mendaftarkan pelanggan.
          </div>

          <ul v-else class="divide-y divide-slate-100" data-testid="queue-list">
            <li
              v-for="entry in queueList"
              :key="entry.id"
              class="flex flex-wrap items-center gap-3 px-5 py-3"
              :data-testid="`entry-${entry.number}`"
            >
              <!-- Nomor -->
              <div class="flex w-16 shrink-0 items-center justify-center">
                <span
                  class="text-xl font-bold"
                  :class="entry.status === 'serving' ? 'text-indigo-700' : 'text-slate-900'"
                >
                  {{ entry.number }}
                </span>
              </div>

              <!-- Nama + info -->
              <div class="min-w-0 flex-1">
                <p class="truncate font-medium text-slate-900">{{ entry.customer_name }}</p>
                <p class="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span
                    class="rounded-full px-2 py-0.5 font-medium ring-1"
                    :class="STATUS_CLASS[entry.status]"
                    :data-testid="`status-${entry.number}`"
                  >
                    {{ STATUS_LABEL[entry.status] }}
                  </span>
                  <span>{{ categoryName(entry.category_id) }}</span>
                  <span
                    v-if="entry.print_status !== 'printed'"
                    class="inline-flex items-center gap-1 text-amber-700"
                  >
                    <Printer class="h-3 w-3" />
                    belum dicetak
                  </span>
                  <span v-if="entry.priority > 0" class="text-purple-700">
                    diprioritaskan
                  </span>
                </p>
              </div>

              <!-- Aksi -->
              <div class="flex flex-wrap gap-1.5">
                <button
                  v-if="entry.status === 'waiting'"
                  type="button"
                  class="inline-flex items-center gap-1 rounded-lg bg-indigo-50 px-2.5 py-1.5 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-600/20 hover:bg-indigo-100"
                  :data-testid="`serve-${entry.number}`"
                  @click="onStatus(entry, 'serving')"
                >
                  <BellRing class="h-3.5 w-3.5" />
                  Panggil
                </button>

                <button
                  v-if="entry.status === 'serving'"
                  type="button"
                  class="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-600/20 hover:bg-emerald-100"
                  :data-testid="`done-${entry.number}`"
                  @click="onStatus(entry, 'done')"
                >
                  <Check class="h-3.5 w-3.5" />
                  Selesai
                </button>

                <button
                  v-if="entry.status === 'serving' || entry.status === 'waiting'"
                  type="button"
                  class="inline-flex items-center gap-1 rounded-lg bg-purple-50 px-2.5 py-1.5 text-xs font-semibold text-purple-700 ring-1 ring-purple-600/20 hover:bg-purple-100"
                  :data-testid="`pending-${entry.number}`"
                  @click="onStatus(entry, 'pending')"
                >
                  <SkipForward class="h-3.5 w-3.5" />
                  Pending
                </button>

                <button
                  v-if="entry.print_status !== 'printed'"
                  type="button"
                  class="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  :data-testid="`print-${entry.number}`"
                  :disabled="printing"
                  @click="onReprint(entry)"
                >
                  <Printer class="h-3.5 w-3.5" />
                  Cetak
                </button>

                <button
                  v-if="entry.status === 'pending' || entry.status === 'done'"
                  type="button"
                  class="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  :data-testid="`recall-${entry.number}`"
                  @click="onRecall(entry)"
                >
                  <RotateCcw class="h-3.5 w-3.5" />
                  Panggil Ulang
                </button>

                <button
                  v-if="entry.status !== 'cancelled' && entry.status !== 'done'"
                  type="button"
                  class="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50"
                  :data-testid="`cancel-${entry.number}`"
                  @click="onStatus(entry, 'cancelled')"
                >
                  <Square class="h-3.5 w-3.5" />
                  Batal
                </button>
              </div>
            </li>
          </ul>
        </section>
      </template>
    </main>

    <!-- Dialog pendaftaran -->
    <div
      v-if="showRegister"
      class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
      data-testid="register-dialog"
      @click.self="showRegister = false"
    >
      <div class="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <div class="flex items-start justify-between">
          <div>
            <h2 class="font-semibold text-slate-900">Nama Pelanggan</h2>
            <p
              v-if="registerCategoryId"
              class="mt-0.5 text-sm"
              :style="{ color: categoryName(registerCategoryId) === 'Umum' ? undefined : categories.find((c) => c.id === registerCategoryId)?.color }"
            >
              {{ categoryName(registerCategoryId) }}
            </p>
          </div>
          <button
            type="button"
            class="rounded p-1 text-slate-400 hover:bg-slate-100"
            data-testid="register-close"
            @click="showRegister = false"
          >
            <X class="h-5 w-5" />
          </button>
        </div>

        <form class="mt-4 space-y-4" @submit.prevent="onRegister">
          <div>
            <label for="customer-name" class="block text-sm font-medium text-slate-700">
              Nama Lengkap
            </label>
            <input
              id="customer-name"
              v-model="customerName"
              type="text"
              maxlength="120"
              autocomplete="off"
              :disabled="submitting || printing"
              data-testid="customer-name"
              class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50"
              placeholder="Nama lengkap pelanggan"
            />
          </div>

          <div
            v-if="registerError"
            class="rounded-lg bg-rose-50 p-3 text-sm text-rose-800 ring-1 ring-rose-600/20"
            data-testid="register-error"
          >
            {{ registerError }}
          </div>

          <div v-if="printing" class="rounded-lg bg-sky-50 p-3 text-sm text-sky-900" data-testid="printing-status">
            <div class="flex items-center gap-2">
              <Printer class="h-4 w-4 animate-pulse" />
              Mencetak tiket…
            </div>
            <div v-if="printProgress" class="mt-2 h-1.5 overflow-hidden rounded-full bg-sky-200">
              <div
                class="h-full bg-sky-600 transition-all"
                :style="{ width: `${(printProgress.sent / printProgress.total) * 100}%` }"
              />
            </div>
          </div>

          <button
            type="submit"
            :disabled="!canSubmit"
            data-testid="register-submit"
            class="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Printer class="h-4 w-4" />
            {{ submitting ? 'Memproses…' : 'Daftar & Cetak Tiket' }}
          </button>

          <p class="flex items-start gap-1.5 text-xs text-slate-500">
            <Clock class="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Bila printer gagal, nomor tetap tersimpan dan bisa dicetak ulang.
          </p>
        </form>
      </div>
    </div>
  </div>
</template>