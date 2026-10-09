<script setup lang="ts">
import { CheckCircle2, CircleAlert, CircleDashed, CircleSlash, FlaskConical, TriangleAlert } from 'lucide-vue-next'
import { onMounted, ref, watch } from 'vue'
import {
  preflightHint,
  runConnectionDiagnostics,
  summarize,
  type CheckResult,
  type CheckStatus,
  type DiagnosticReport,
} from '@/lib/diagnostics'
import { envStatus } from '@/lib/supabaseConfig'

const statusWeight: Record<CheckStatus, number> = { pass: 0, warn: 1, fail: 2, skip: 3, running: 1, pending: 4 }

const running = ref(false)
const report = ref<DiagnosticReport | null>(null)
const error = ref<string | null>(null)
const autoRan = ref(false)

const icons: Record<CheckStatus, typeof CheckCircle2> = {
  pass: CheckCircle2,
  warn: TriangleAlert,
  fail: CircleAlert,
  skip: CircleSlash,
  running: CircleDashed,
  pending: CircleDashed,
}

const badgeClass: Record<CheckStatus, string> = {
  pass: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  warn: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  fail: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  skip: 'bg-slate-100 text-slate-600 ring-slate-500/20',
  running: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  pending: 'bg-slate-50 text-slate-500 ring-slate-400/20',
}

const statusLabel: Record<CheckStatus, string> = {
  pass: 'LULUS',
  warn: 'PERINGATAN',
  fail: 'GAGAL',
  skip: 'DILEWATI',
  running: 'BERJALAN',
  pending: 'MENUNGGU',
}

const sortedResults = ref<CheckResult[]>([])

function applyReport(r: DiagnosticReport) {
  report.value = r
  sortedResults.value = [...r.results].sort(
    (a, b) => statusWeight[a.status] - statusWeight[b.status],
  )
}

async function runTests() {
  if (running.value) return
  running.value = true
  error.value = null
  report.value = null
  try {
    applyReport(await runConnectionDiagnostics())
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    running.value = false
  }
}

onMounted(() => {
  if (!autoRan.value) {
    autoRan.value = true
    void runTests()
  }
})

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('id-ID', { hour12: false })
}

const counts = ref<Record<string, number>>({})

function recomputeCounts() {
  const c: Record<string, number> = { pass: 0, warn: 0, fail: 0, skip: 0 }
  for (const r of sortedResults.value) c[r.status] = (c[r.status] ?? 0) + 1
  counts.value = c
}
watch(sortedResults, recomputeCounts, { deep: true, immediate: true })
</script>

<template>
  <div class="min-h-screen bg-slate-100 py-8 px-4">
    <div class="mx-auto max-w-4xl space-y-6">
      <!-- Header -->
      <header class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-indigo-600">
              <FlaskConical class="h-4 w-4" />
              Halaman developer
            </div>
            <h1 class="mt-1 text-2xl font-bold text-slate-900">Test Koneksi Supabase</h1>
            <p class="mt-1 text-sm text-slate-600">
              Diagnosa lengkap: environment, keterjangkauan jaringan, RLS, Realtime, dan backend Worker.
            </p>
          </div>
          <RouterLink
            to="/"
            class="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Kembali ke beranda
          </RouterLink>
        </div>

        <div class="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            :disabled="running"
            class="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
            @click="runTests"
          >
            <CircleDashed v-if="running" class="h-4 w-4 animate-spin" />
            <span v-else class="h-4 w-4" />
            {{ running ? 'Menjalankan pemeriksaan…' : 'Jalankan Ulang' }}
          </button>
          <RouterLink
            to="/"
            class="inline-flex items-center rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-900"
          >
            Buka Aplikasi
          </RouterLink>
        </div>
      </header>

      <!-- Ringkasan -->
      <section
        v-if="report"
        class="rounded-xl border p-5 shadow-sm"
        :class="report.ok ? 'border-emerald-200 bg-emerald-50' : 'border-rose-200 bg-rose-50'"
      >
        <div class="flex items-start gap-3">
          <CheckCircle2 v-if="report.ok" class="mt-0.5 h-6 w-6 shrink-0 text-emerald-600" />
          <CircleAlert v-else class="mt-0.5 h-6 w-6 shrink-0 text-rose-600" />
          <div class="min-w-0">
            <p
              class="text-base font-bold"
              :class="report.ok ? 'text-emerald-900' : 'text-rose-900'"
            >
              {{ summarize(report) }}
            </p>
            <p class="mt-1 text-sm" :class="report.ok ? 'text-emerald-800' : 'text-rose-800'">
              Diperiksa pukul {{ formatTime(report.checkedAt) }} WIB.
            </p>
            <div class="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
              <span class="rounded-full bg-emerald-100 px-2.5 py-1 text-emerald-800">
                {{ counts.pass ?? 0 }} lulus
              </span>
              <span class="rounded-full bg-amber-100 px-2.5 py-1 text-amber-800">
                {{ counts.warn ?? 0 }} peringatan
              </span>
              <span class="rounded-full bg-rose-100 px-2.5 py-1 text-rose-800">
                {{ counts.fail ?? 0 }} gagal
              </span>
              <span class="rounded-full bg-slate-200 px-2.5 py-1 text-slate-700">
                {{ counts.skip ?? 0 }} dilewati
              </span>
            </div>
          </div>
        </div>
      </section>

      <section v-if="error" class="rounded-xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-800">
        <p class="font-bold">Pemeriksaan gagal dijalankan</p>
        <pre class="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-xs">{{ error }}</pre>
      </section>

      <!-- Config env -->
      <section class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 class="text-lg font-semibold text-slate-900">Environment</h2>
        <dl class="mt-3 grid gap-2 text-sm sm:grid-cols-[14rem_1fr]">
          <dt class="font-medium text-slate-500">VITE_SUPABASE_URL</dt>
          <dd class="break-all font-mono text-slate-800">{{ envStatus.url || '(kosong)' }}</dd>
          <dt class="font-medium text-slate-500">VITE_SUPABASE_ANON_KEY</dt>
          <dd class="break-all font-mono text-slate-800">
            {{ envStatus.anonKey ? `${envStatus.anonKey.slice(0, 8)}•••• (${envStatus.anonKey.length} karakter)` : '(kosong)' }}
          </dd>
          <dt class="font-medium text-slate-500">VITE_API_BASE_URL</dt>
          <dd class="break-all font-mono text-slate-800">{{ envStatus.apiBaseUrl || '(kosong)' }}</dd>
          <dt class="font-medium text-slate-500">Mode</dt>
          <dd class="font-mono text-slate-800">{{ envStatus.isDev ? 'development' : 'production' }}</dd>
        </dl>

        <div v-if="preflightHint()" class="mt-4 rounded-lg bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-600/20">
          <p class="font-semibold">Isi .env terlebih dahulu</p>
          <p class="mt-1">{{ preflightHint() }}</p>
        </div>
      </section>

      <!-- Hasil pemeriksaan -->
      <section
        v-if="running && !report"
        class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <div class="flex items-center gap-3 text-sm text-slate-600">
          <CircleDashed class="h-5 w-5 animate-spin text-indigo-600" />
          Menghubungi Supabase dan memeriksa setiap tabel…
        </div>
        <ul class="mt-4 space-y-2">
          <li
            v-for="i in 6"
            :key="i"
            class="h-8 animate-pulse rounded bg-slate-100"
          />
        </ul>
      </section>

      <section v-if="report" class="space-y-3">
        <article
          v-for="r in sortedResults"
          :key="r.key"
          class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="flex min-w-0 items-start gap-3">
              <component :is="icons[r.status]" class="mt-0.5 h-5 w-5 shrink-0" :class="{
                'text-emerald-600': r.status === 'pass',
                'text-amber-600': r.status === 'warn',
                'text-rose-600': r.status === 'fail',
                'text-slate-400': r.status === 'skip',
              }" />
              <div class="min-w-0">
                <h3 class="font-semibold text-slate-900">{{ r.name }}</h3>
                <p class="mt-1 text-sm text-slate-700">{{ r.detail }}</p>
                <p v-if="r.errorCode" class="mt-1 font-mono text-xs text-rose-700">
                  Kode: {{ r.errorCode }}
                </p>
              </div>
            </div>
            <span
              class="shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ring-1"
              :class="badgeClass[r.status]"
            >
              {{ statusLabel[r.status] }}
            </span>
          </div>

          <p
            v-if="r.hint"
            class="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700 ring-1 ring-slate-200"
          >
            <span class="font-semibold">Cara memperbaiki: </span>{{ r.hint }}
          </p>

          <details v-if="r.data" class="mt-3">
            <summary class="cursor-pointer text-xs font-semibold text-indigo-600">Lihat data mentah</summary>
            <pre class="mt-2 max-h-64 overflow-auto rounded-lg bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">{{ JSON.stringify(r.data, null, 2) }}</pre>
          </details>
        </article>
      </section>

      <footer class="pb-6 text-center text-xs text-slate-500">
        Halaman ini hanya untuk pengembangan. Jalankan dengan <code class="font-mono">npm run dev</code>.
      </footer>
    </div>
  </div>
</template>