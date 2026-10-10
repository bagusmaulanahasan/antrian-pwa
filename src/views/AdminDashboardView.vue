<script setup lang="ts">
import { Clock, LogOut, Tv } from 'lucide-vue-next'
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { authUser, initAuth, isAuthenticated, logout, mustChangePassword } from '@/stores/auth'
import { getQueueDate } from '@/lib/types'

const router = useRouter()
const user = authUser

const greeting = computed(() => {
  const hour = new Date().getHours()
  if (hour < 11) return 'Selamat pagi'
  if (hour < 15) return 'Selamat siang'
  if (hour < 18) return 'Selamat sore'
  return 'Selamat malam'
})

const queueDate = getQueueDate()

onMounted(async () => {
  await initAuth()
  if (!isAuthenticated.value) {
    await router.push({ name: 'login', query: { redirect: '/admin' } })
  }
})

async function onLogout() {
  await logout()
  await router.push({ name: 'login' })
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-slate-100 px-4">
    <div class="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
      <template v-if="user">
        <div
          class="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-indigo-100 text-lg font-bold text-indigo-700"
        >
          {{ (user.display_name || user.email).charAt(0).toUpperCase() }}
        </div>
        <p class="mt-3 text-sm text-slate-600">{{ greeting }}</p>
        <h1 class="text-lg font-bold text-slate-900">
          {{ user.display_name || user.email.split('@')[0] }}
        </h1>
        <p class="mt-1 text-xs uppercase tracking-wide text-slate-500">{{ user.role }}</p>

        <div
          v-if="mustChangePassword"
          class="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-600/20"
        >
          Password Anda perlu diganti sebelum melanjutkan.
          <RouterLink to="/change-password" class="ml-1 font-semibold underline">Ganti sekarang</RouterLink>
        </div>

        <div class="mt-4 flex flex-wrap justify-center gap-2 text-xs text-slate-600">
          <span class="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1.5">
            <Clock class="h-3.5 w-3.5" />
            {{ queueDate }}
          </span>
          <RouterLink
            to="/tv"
            class="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1.5 hover:bg-slate-200"
          >
            <Tv class="h-3.5 w-3.5" />
            Dashboard TV
          </RouterLink>
        </div>

        <button
          type="button"
          class="mt-6 inline-flex items-center gap-2 rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-900"
          data-testid="header-logout"
          @click="onLogout"
        >
          <LogOut class="h-4 w-4" />
          Keluar
        </button>
      </template>

      <div v-else class="flex items-center justify-center gap-2 py-6 text-sm text-slate-500">
        <span class="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600" />
        Memuat sesi…
      </div>
    </div>
  </div>
</template>