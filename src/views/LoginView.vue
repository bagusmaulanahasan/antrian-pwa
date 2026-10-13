<script setup lang="ts">
import { AlertCircle, KeyRound, Loader2, Lock, Mail, WifiOff } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { isApiConfigured } from '@/lib/api'
import { authError, authStatus, authUser, clearAuthError, login } from '@/stores/auth'
import { homeRouteFor } from '@/router'

const router = useRouter()
const route = useRoute()

const email = ref('')
const password = ref('')
const showPassword = ref(false)
const submitting = ref(false)

const apiReady = isApiConfigured()
const busy = computed(() => submitting.value || authStatus.value === 'loading')

const canSubmit = computed(
  () =>
    !busy.value &&
    email.value.trim().length > 0 &&
    password.value.length > 0,
)

function validate(): string | null {
  const value = email.value.trim()
  if (!value) return 'Email wajib diisi.'
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return 'Format email tidak valid.'
  if (!password.value) return 'Password wajib diisi.'
  return null
}

async function onSubmit() {
  if (!canSubmit.value) return
  const problem = validate()
  if (problem) return

  clearAuthError()
  submitting.value = true
  const ok = await login(email.value.trim(), password.value)
  submitting.value = false

  if (ok) {
    password.value = ''
    // Hormati tujuan yang disimpan route guard (kalau ada), tapi tetap arahkan
    // owner ke dashboard owner.
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : null
    const fallback = homeRouteFor(authUser.value?.role)
    await router.push(redirect ?? fallback)
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10">
    <div class="w-full max-w-md">
      <div class="mb-6 text-center">
        <div
          class="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-600 text-lg font-bold text-white"
        >
          A
        </div>
        <h1 class="mt-3 text-xl font-bold text-slate-900">Sistem Antrian</h1>
        <p class="mt-1 text-sm text-slate-600">Masuk untuk melanjutkan</p>
      </div>

      <!-- Worker belum di-deploy -->
      <div
        v-if="!apiReady"
        class="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        data-testid="api-unavailable"
      >
        <div class="flex items-start gap-2">
          <WifiOff class="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p class="font-semibold">Worker API belum dikonfigurasi</p>
            <p class="mt-1">
              Isi <code class="font-mono">VITE_API_BASE_URL</code> di <code class="font-mono">.env</code>,
              lalu build ulang aplikasi. Nilai env di-inline saat build, jadi mengisi setelah
              build tidak berpengaruh.
            </p>
          </div>
        </div>
      </div>

      <form
        class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
        data-testid="login-form"
        novalidate
        @submit.prevent="onSubmit"
      >
        <div class="space-y-4">
          <div>
            <label for="email" class="block text-sm font-medium text-slate-700">Email</label>
            <div class="relative mt-1">
              <Mail class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                id="email"
                v-model="email"
                type="email"
                name="email"
                autocomplete="username"
                spellcheck="false"
                :disabled="busy || !apiReady"
                data-testid="email"
                class="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50"
                placeholder="nama@contoh.com"
              />
            </div>
          </div>

          <div>
            <label for="password" class="block text-sm font-medium text-slate-700">Password</label>
            <div class="relative mt-1">
              <Lock class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                id="password"
                v-model="password"
                :type="showPassword ? 'text' : 'password'"
                name="password"
                autocomplete="current-password"
                :disabled="busy || !apiReady"
                data-testid="password"
                class="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-16 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50"
                placeholder="••••••••"
              />
              <button
                type="button"
                :disabled="busy || !apiReady"
                data-testid="toggle-password"
                class="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-xs font-medium text-slate-500 hover:text-slate-700 disabled:opacity-50"
                @click="showPassword = !showPassword"
              >
                {{ showPassword ? 'Sembunyikan' : 'Lihat' }}
              </button>
            </div>
          </div>

          <div
            v-if="authError"
            class="flex items-start gap-2 rounded-lg bg-rose-50 p-3 text-sm text-rose-800 ring-1 ring-rose-600/20"
            data-testid="login-error"
            role="alert"
          >
            <AlertCircle class="mt-0.5 h-4 w-4 shrink-0" />
            <span>{{ authError }}</span>
          </div>

          <button
            type="submit"
            :disabled="!canSubmit"
            data-testid="login-submit"
            class="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Loader2 v-if="busy" class="h-4 w-4 animate-spin" />
            <KeyRound v-else class="h-4 w-4" />
            {{ busy ? 'Memproses…' : 'Masuk' }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>