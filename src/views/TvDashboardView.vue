<script setup lang="ts">
import { Loader2, Volume2, Wifi, WifiOff } from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  fetchTvSnapshot,
  subscribeToQueue,
  type ConnectionState,
  type TvEntry,
  type TvSnapshot,
} from '@/lib/tv'
import { isSupabaseConfigured } from '@/lib/supabaseConfig'
import { getTvPin, isTvPinConfigured, TV_PIN_MISSING_MESSAGE } from '@/lib/tvConfig'
import { getQueueDate } from '@/lib/types'
import {
  Announcer,
  DEFAULT_VOICE_TEMPLATE,
  isSpeechSupported,
  renderTemplate,
  type VoiceTemplate,
} from '@/lib/speech'

// ---------------------------------------------------------------- state
const snapshot = ref<TvSnapshot | null>(null)
const connection = ref<ConnectionState>('connecting')
const loadError = ref<string | null>(null)
const lastUpdate = ref<string | null>(null)

const voiceEnabled = ref(false)
const speaking = ref(false)
const voiceError = ref<string | null>(null)

const voiceTemplate = ref<VoiceTemplate>({ ...DEFAULT_VOICE_TEMPLATE })

/**
 * Kode PIN untuk membuka dashboard TV.
 *
 * PRD menyebut PIN ini "verifikasi ringan" — keamanan data sebenarnya
 * datang dari RLS yang hanya mengizinkan SELECT lewat anon key. PIN
 * hanya mencegah layarTv dibuka tanpa disengaja.
 *
 * Nilainya datang dari env (di-inline saat build), bukan ditulis di sini,
 * supaya bisa diganti per deployment tanpa menyentuh kode.
 */
const PIN = ref(getTvPin())

const pinInput = ref('')
const pinError = ref<string | null>(null)
const unlocked = ref(false)

/** PIN wajib dikonfigurasi; tanpa itu layar TV tidak boleh terbuka. */
const pinConfigured = isTvPinConfigured()

let subscription: { unsubscribe(): Promise<void> } | null = null
let announcer: Announcer | null = null

// -------------------------------------------------------------- computed
const categories = computed(() => snapshot.value?.categories ?? [])
const categoryOf = (id: string | null) =>
  categories.value.find((c) => c.id === id)?.name ?? 'Umum'
const categoryColor = (id: string | null) =>
  categories.value.find((c) => c.id === id)?.color ?? '#94a3b8'

const serving = computed<TvEntry | null>(
  () => snapshot.value?.entries.find((e) => e.status === 'serving') ?? null,
)

/** Nomor pending tampil paling atas, lalu menunggu — sesuai PRD. */
const queue = computed(() => {
  const rank: Record<string, number> = { pending: 0, waiting: 1, serving: 2 }
  return (snapshot.value?.entries ?? [])
    .filter((e) => rank[e.status] !== undefined)
    .sort((a, b) => {
      if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status]
      if (a.priority !== b.priority) return b.priority - a.priority
      return a.number - b.number
    })
})

const waitingCount = computed(
  () => snapshot.value?.entries.filter((e) => e.status === 'waiting').length ?? 0,
)

/** Koneksi internet dari browser — badge hijau/merah sesuai PRD. */
const online = ref(typeof navigator === 'undefined' ? true : navigator.onLine)

const connectionLabel = computed(() => {
  switch (connection.value) {
    case 'live':
      return 'Terhubung'
    case 'polling':
      return 'Terhubung (penyegaran berkala)'
    case 'connecting':
      return 'Menghubungkan…'
    default:
      return 'Terputus'
  }
})

const speechSupported = isSpeechSupported()

// --------------------------------------------------------------- methods
async function load(): Promise<void> {
  try {
    const data = await fetchTvSnapshot(getQueueDate())
    snapshot.value = data
    lastUpdate.value = data.updatedAt
    loadError.value = null
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : 'Gagal memuat data antrian.'
    connection.value = 'error'
  }
}

async function onSubmitPin(): Promise<void> {
  // Tanpa PIN yang dikonfigurasi, layar TV tidak bisa dibuka sama sekali.
  // Membuka bebas justru lebih buruk daripada menampilkan pesan konfigurasi.
  if (!isTvPinConfigured()) {
    pinError.value = TV_PIN_MISSING_MESSAGE
    return
  }

  const value = pinInput.value.trim()
  if (value !== PIN.value) {
    pinError.value = 'Kode PIN salah.'
    pinInput.value = ''
    return
  }
  pinError.value = null
  unlocked.value = true
  await start()
}

/** Aktifkan suara — harus dipicu klik pengguna (kebijakan autoplay browser). */
async function onEnableVoice(): Promise<void> {
  if (!speechSupported) {
    voiceError.value = 'Browser ini tidak mendukung Web Speech API.'
    return
  }
  voiceError.value = null
  try {
    announcer ??= new Announcer((s) => (speaking.value = s))
    await announcer.init()
    announcer.speakTest(voiceTemplate.value)
    voiceEnabled.value = true
  } catch (err) {
    voiceError.value = err instanceof Error ? err.message : 'Gagal mengaktifkan suara.'
  }
}

function onDisableVoice(): void {
  announcer?.cancel()
  voiceEnabled.value = false
}

/**
 * Umumkan nomor yang baru dilayani.
 *
 * Dipicu HANYA saat nomor serving berubah — bukan setiap render — supaya
 * pengumuman tidak berulang tiap polling.
 */
const lastAnnounced = ref<string | null>(null)

watch(
  serving,
  async (current, previous) => {
    if (!current) {
      lastAnnounced.value = null
      return
    }
    if (current.id === previous?.id) return
    if (current.id === lastAnnounced.value) return

    lastAnnounced.value = current.id
    if (!voiceEnabled.value || !announcer) return

    const text = renderTemplate(voiceTemplate.value.text, {
      number: current.number,
      customerName: current.customer_name,
      categoryName: categoryOf(current.category_id),
    })
    announcer.enqueue(text, voiceTemplate.value)
  },
  { deep: false },
)

async function start(): Promise<void> {
  await load()
  subscription?.unsubscribe()
  subscription = subscribeToQueue(
    getQueueDate(),
    () => {
      void load()
    },
    (state) => {
      connection.value = state
    },
  )
}

function onOnline() {
  online.value = true
}
function onOffline() {
  online.value = false
}

onMounted(() => {
  const onOnline = () => (online.value = true)
  const onOffline = () => (online.value = false)
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)

  // Halaman TV boleh dibuka tanpa login, tapi tetap perlu konfigurasi Supabase.
  if (!isSupabaseConfigured) {
    loadError.value = 'Supabase belum dikonfigurasi. Isi VITE_SUPABASE_URL di .env.'
    connection.value = 'error'
    return
  }
  void start()
})

onBeforeUnmount(() => {
  window.removeEventListener('online', onOnline)
  window.removeEventListener('offline', onOffline)
  void subscription?.unsubscribe()
  announcer?.dispose()
})
</script>

<template>
  <!-- Layar kunci PIN -->
  <div
    v-if="!unlocked"
    class="flex min-h-screen items-center justify-center bg-slate-900 px-4"
    data-testid="tv-pin-screen"
  >
    <form
      class="w-full max-w-xs rounded-2xl bg-white/5 p-8 text-center ring-1 ring-white/10 backdrop-blur"
      @submit.prevent="onSubmitPin"
    >
      <div class="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-indigo-600">
        <Volume2 class="h-7 w-7 text-white" />
      </div>
      <h1 class="mt-4 text-lg font-bold text-white">Dashboard TV</h1>
      <p class="mt-1 text-sm text-slate-400">Masukkan kode PIN untuk membuka layar</p>

      <input
        v-model="pinInput"
        type="password"
        inputmode="numeric"
        :maxlength="Math.max(4, PIN.length)"
        autocomplete="off"
        placeholder="••••"
        :disabled="!pinConfigured"
        data-testid="tv-pin-input"
        class="mt-6 w-full rounded-xl border border-white/20 bg-white/10 px-4 py-3 text-center text-2xl tracking-[0.5em] text-white outline-none focus:border-indigo-400 disabled:opacity-50"
      />

      <p
        v-if="pinError"
        class="mt-2 text-sm text-rose-400"
        data-testid="tv-pin-error"
      >
        {{ pinError }}
      </p>

      <button
        type="submit"
        :disabled="!pinConfigured"
        class="mt-5 w-full rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
        data-testid="tv-pin-submit"
      >
        Buka Dashboard
      </button>

      <p
        v-if="!pinConfigured"
        class="mt-3 rounded-lg bg-amber-400/15 p-3 text-xs text-amber-200"
        data-testid="tv-pin-missing"
      >
        {{ TV_PIN_MISSING_MESSAGE }}
      </p>

      <p class="mt-6 text-xs text-slate-500">
        Layar ini hanya menampilkan data, tidak menyimpan informasi sensitif.
      </p>
    </form>
  </div>

  <!-- Dashboard -->
  <div v-else class="min-h-screen bg-slate-900 text-white">
    <!-- Header -->
    <header class="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-6 py-4">
      <div class="flex items-center gap-3">
        <h1 class="text-xl font-bold">Sistem Antrian</h1>
        <span
          class="rounded-full bg-white/10 px-3 py-1 text-xs font-semibold"
          data-testid="tv-waiting-count"
        >
          Menunggu: {{ waitingCount }}
        </span>
      </div>

      <div class="flex items-center gap-2">
        <!-- Status koneksi -->
        <span
          class="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold ring-1"
          :class="
            connection === 'error'
              ? 'bg-rose-500/20 text-rose-300 ring-rose-400/30'
              : 'bg-emerald-500/20 text-emerald-300 ring-emerald-400/30'
          "
          data-testid="tv-connection"
        >
          <WifiOff v-if="connection === 'error' || !online" class="h-3.5 w-3.5" />
          <Wifi v-else class="h-3.5 w-3.5" />
          {{ online ? connectionLabel : 'Terputus' }}
          <span v-if="online" class="opacity-70">
            · {{ connection === 'live' ? 'Wi-Fi/4G/5G' : 'jaringan' }}
          </span>
        </span>

        <!-- Suara -->
        <button
          v-if="!voiceEnabled"
          type="button"
          class="inline-flex items-center gap-2 rounded-full bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
          data-testid="tv-enable-voice"
          @click="onEnableVoice"
        >
          <Volume2 class="h-3.5 w-3.5" />
          Aktifkan Suara
        </button>
        <button
          v-else
          type="button"
          class="inline-flex items-center gap-2 rounded-full bg-emerald-600/30 px-4 py-1.5 text-xs font-semibold text-emerald-200 ring-1 ring-emerald-400/30 hover:bg-emerald-600/40"
          data-testid="tv-disable-voice"
          @click="onDisableVoice"
        >
          <Loader2 v-if="speaking" class="h-3.5 w-3.5 animate-spin" />
          <Volume2 v-else class="h-3.5 w-3.5" />
          {{ speaking ? 'Bersuara…' : 'Suara Aktif' }}
        </button>
      </div>
    </header>

    <!-- Error -->
    <div
      v-if="loadError"
      class="mx-6 mt-4 rounded-xl bg-rose-500/20 p-4 text-sm text-rose-200 ring-1 ring-rose-400/30"
      data-testid="tv-error"
    >
      {{ loadError }}
    </div>

    <div
      v-else-if="!snapshot"
      class="flex items-center justify-center gap-3 py-24 text-slate-400"
      data-testid="tv-loading"
    >
      <Loader2 class="h-5 w-5 animate-spin" />
      Memuat data antrian…
    </div>

    <main v-else class="grid gap-6 p-6 lg:grid-cols-[1fr_28rem]">
      <!-- Nomor dilayani -->
      <section
        class="flex min-h-[26rem] flex-col items-center justify-center rounded-3xl p-8"
        :class="serving ? 'bg-indigo-600' : 'bg-white/5 ring-1 ring-white/10'"
        data-testid="tv-serving"
      >
        <p class="text-sm font-semibold uppercase tracking-[0.3em] text-white/70">
          Nomor Sekarang
        </p>

        <template v-if="serving">
          <p
            class="mt-4 text-[11rem] font-black leading-none tracking-tight text-white"
            data-testid="tv-serving-number"
          >
            {{ serving.number }}
          </p>
          <p class="mt-4 text-3xl font-bold text-white" data-testid="tv-serving-name">
            {{ serving.customer_name }}
          </p>
          <span
            class="mt-3 rounded-full px-4 py-1.5 text-sm font-semibold text-white/90"
            :style="{ backgroundColor: categoryColor(serving.category_id) }"
            data-testid="tv-serving-category"
          >
            {{ categoryOf(serving.category_id) }}
          </span>
        </template>

        <p v-else class="mt-8 text-2xl text-white/40" data-testid="tv-no-serving">
          Belum ada nomor dipanggil
        </p>
      </section>

      <!-- Daftar antrian -->
      <section
        class="max-h-[calc(100vh-8rem)] overflow-hidden rounded-3xl bg-white/5 ring-1 ring-white/10"
      >
        <header class="border-b border-white/10 px-5 py-3">
          <h2 class="font-semibold">Antrean</h2>
        </header>

        <ul v-if="queue.length" class="divide-y divide-white/5 overflow-y-auto" data-testid="tv-queue">
          <li
            v-for="entry in queue"
            :key="entry.id"
            class="flex items-center gap-4 px-5 py-3.5"
            :class="entry.status === 'pending' ? 'bg-purple-500/20' : ''"
            :data-testid="`tv-entry-${entry.number}`"
          >
            <span
              class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-lg font-bold"
              :class="entry.status === 'pending' ? 'bg-purple-500/40 text-white' : 'bg-white/10 text-white'"
            >
              {{ entry.number }}
            </span>

            <div class="min-w-0 flex-1">
              <p class="truncate font-medium text-white">{{ entry.customer_name }}</p>
              <p class="text-xs text-white/50">{{ categoryOf(entry.category_id) }}</p>
            </div>

            <span
              v-if="entry.status === 'pending'"
              class="shrink-0 rounded-full bg-purple-400/30 px-2.5 py-1 text-xs font-bold text-purple-100"
              data-testid="tv-pending-badge"
            >
              PENDING
            </span>
          </li>
        </ul>

        <p v-else class="px-5 py-12 text-center text-sm text-white/40">
          Belum ada antrean hari ini.
        </p>
      </section>
    </main>

    <!-- Info -->
    <footer
      v-if="lastUpdate"
      class="px-6 pb-4 text-center text-xs text-white/30"
      data-testid="tv-last-update"
    >
      Diperbarui {{ new Date(lastUpdate).toLocaleTimeString('id-ID', { hour12: false }) }}
    </footer>
  </div>
</template>