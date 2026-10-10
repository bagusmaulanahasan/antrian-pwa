<script setup lang="ts">
import { LogOut, Settings } from 'lucide-vue-next'
import { useRouter } from 'vue-router'
import { authUser, logout } from '@/stores/auth'
import { homeRouteFor } from '@/router'

const router = useRouter()
const user = authUser

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
          class="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-lg font-bold text-emerald-700"
        >
          {{ (user.display_name || user.email).charAt(0).toUpperCase() }}
        </div>
        <h1 class="mt-3 text-lg font-bold text-slate-900">Pengaturan Owner</h1>
        <p class="mt-1 text-sm text-slate-600">{{ user.email }}</p>

        <div class="mt-5 space-y-2 text-left text-sm text-slate-600">
          <p class="rounded-lg bg-slate-50 px-3 py-2">Kategori antrian (warna, urutan)</p>
          <p class="rounded-lg bg-slate-50 px-3 py-2">Template suara &amp; cetak 58mm</p>
          <p class="rounded-lg bg-slate-50 px-3 py-2">Jam reset harian</p>
          <p class="rounded-lg bg-slate-50 px-3 py-2">Kelola akun admin &amp; dashboard TV</p>
        </div>

        <div class="mt-6 flex gap-2">
          <button
            type="button"
            class="flex flex-1 items-center justify-center gap-2 rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-900"
            data-testid="header-logout"
            @click="onLogout"
          >
            <LogOut class="h-4 w-4" />
            Keluar
          </button>
          <RouterLink
            to="/change-password"
            class="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"
          >
            <Settings class="h-4 w-4" />
            Password
          </RouterLink>
        </div>

        <RouterLink
          :to="homeRouteFor(user?.role)"
          class="mt-3 inline-block text-xs text-slate-500 underline"
        >
          Buka dashboard admin
        </RouterLink>
      </template>
    </div>
  </div>
</template>