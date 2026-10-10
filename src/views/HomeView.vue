<script setup lang="ts">
import { onMounted } from 'vue'
import { Activity, ArrowRight, FlaskConical, LayoutDashboard, LogIn, Tv } from 'lucide-vue-next'
import { envStatus, isSupabaseConfigured } from '@/lib/supabaseConfig'
import { apiBaseUrl, isApiConfigured } from '@/lib/api'
import { authUser, initAuth } from '@/stores/auth'

const apiUrl = apiBaseUrl()

onMounted(() => {
  void initAuth()
})

const modules = [
  {
    title: 'Dashboard Admin',
    description: 'Input pelanggan, cetak tiket Bluetooth, dan navigasi pemanggilan antrian.',
    to: '/admin',
    icon: LayoutDashboard,
  },
  {
    title: 'Dashboard TV',
    description: 'Layar kiosk real-time dengan pengumuman suara (Web Speech API).',
    to: '/tv',
    icon: Tv,
  },
  {
    title: 'Pengaturan Owner',
    description: 'Kategori, template suara & cetak, jam reset harian, dan kelola akun admin.',
    to: '/owner',
    icon: Activity,
  },
]
</script>

<template>
  <div class="min-h-screen bg-slate-100">
    <header class="border-b border-slate-200 bg-white px-6 py-4">
      <div class="mx-auto flex max-w-5xl items-center justify-between">
        <h1 class="text-xl font-bold text-slate-800">Sistem Antrian PWA</h1>
        <div class="flex items-center gap-2">
<RouterLink
          v-if="!authUser"
          to="/login"
          class="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
        >
          <LogIn class="h-4 w-4" />
          Masuk
        </RouterLink>
<RouterLink
          to="/dev/test-connection"
          data-testid="nav-test-connection"
          class="inline-flex items-center gap-2 rounded-lg bg-slate-800 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-900"
        >
          <FlaskConical class="h-4 w-4" />
          Test Koneksi
        </RouterLink>
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-5xl space-y-6 px-6 py-10">
      <!-- Status env -->
      <section
        class="rounded-xl border p-5"
        :class="isSupabaseConfigured ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'"
      >
        <h2 class="font-semibold" :class="isSupabaseConfigured ? 'text-emerald-900' : 'text-amber-900'">
          {{ isSupabaseConfigured ? 'Supabase terkonfigurasi' : 'Supabase belum dikonfigurasi' }}
        </h2>
        <p class="mt-1 text-sm" :class="isSupabaseConfigured ? 'text-emerald-800' : 'text-amber-800'">
          {{
            isSupabaseConfigured
              ? 'Environment terbaca. Verifikasi konektivitas melalui halaman test.'
              : envStatus.problems[0] ?? 'Isi .env terlebih dahulu.'
          }}
        </p>
        <RouterLink
          to="/dev/test-connection"
          class="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-indigo-700 hover:underline"
        >
          Buka diagnosis lengkap
          <ArrowRight class="h-4 w-4" />
        </RouterLink>
      </section>

      <!-- Worker status -->
      <section
        class="rounded-xl border p-5"
        :class="isApiConfigured() ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-white'"
      >
        <h2 class="font-semibold text-slate-900">
          Worker API {{ isApiConfigured() ? 'terkonfigurasi' : 'belum dikonfigurasi' }}
        </h2>
        <p class="mt-1 text-sm text-slate-600">
          <template v-if="isApiConfigured()">
            <code class="font-mono">{{ apiUrl }}</code>
          </template>
          <template v-else>
            Login dan seluruh fitur operasional membutuhkan Worker API. Isi
            <code class="font-mono">VITE_API_BASE_URL</code> lalu build ulang.
          </template>
        </p>
      </section>

      <!-- Modul -->
      <section class="grid gap-4 sm:grid-cols-3">
        <RouterLink
          v-for="m in modules"
          :key="m.title"
          :to="m.to"
          class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-indigo-300 hover:shadow"
        >
          <component :is="m.icon" class="h-6 w-6 text-indigo-600" />
          <h3 class="mt-3 font-semibold text-slate-900">{{ m.title }}</h3>
          <p class="mt-1 text-sm text-slate-600">{{ m.description }}</p>
          <span class="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-indigo-600">
            Buka
            <ArrowRight class="h-3 w-3" />
          </span>
        </RouterLink>
      </section>

      <!-- Sesi aktif -->
      <section v-if="authUser" class="rounded-xl border border-indigo-200 bg-indigo-50 p-5">
        <p class="text-sm text-indigo-900">
          Masuk sebagai <strong>{{ authUser.display_name || authUser.email }}</strong>
          <span class="ml-1 rounded bg-indigo-200 px-1.5 py-0.5 text-xs uppercase">
            {{ authUser.role }}
          </span>
        </p>
      </section>
    </main>
  </div>
</template>