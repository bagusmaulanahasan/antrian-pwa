<script setup lang="ts">
import { AlertTriangle, ArrowLeft, Check, Loader2, Lock } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { authError, authUser, changePassword, clearAuthError, logout } from '@/stores/auth'
import { homeRouteFor } from '@/router'

const route = useRoute()
const router = useRouter()

const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const submitting = ref(false)
const done = ref(false)

const isForced = computed(() => route.query.force === '1')
const user = authUser

const MIN_LENGTH = 8

const newPasswordError = computed(() => {
  if (!newPassword.value) return null
  if (newPassword.value.length < MIN_LENGTH) return `Password minimal ${MIN_LENGTH} karakter.`
  if (newPassword.value === currentPassword.value) return 'Password baru harus berbeda dari yang lama.'
  return null
})

const confirmError = computed(() => {
  if (!confirmPassword.value) return null
  if (confirmPassword.value !== newPassword.value) return 'Konfirmasi tidak cocok.'
  return null
})

const canSubmit = computed(
  () =>
    !submitting.value &&
    currentPassword.value.length > 0 &&
    newPassword.value.length >= MIN_LENGTH &&
    newPassword.value !== currentPassword.value &&
    newPassword.value === confirmPassword.value,
)

/** Skor kekuatan sederhana — hanya untuk memberi feedback visual. */
const strength = computed(() => {
  const p = newPassword.value
  if (!p) return { label: '', class: '' }
  let score = 0
  if (p.length >= MIN_LENGTH) score++
  if (p.length >= 12) score++
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) score++
  if (/\d/.test(p)) score++
  if (/[^A-Za-z0-9]/.test(p)) score++
  if (score <= 2) return { label: 'Lemah', class: 'bg-rose-500' }
  if (score <= 3) return { label: 'Cukup', class: 'bg-amber-500' }
  if (score <= 4) return { label: 'Kuat', class: 'bg-lime-500' }
  return { label: 'Sangat kuat', class: 'bg-emerald-500' }
})

async function onSubmit() {
  if (!canSubmit.value) return
  clearAuthError()
  submitting.value = true
  const ok = await changePassword(currentPassword.value, newPassword.value)
  submitting.value = false

  if (ok) {
    done.value = true
    currentPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
  }
}

async function onLogout() {
  await logout()
  await router.push({ name: 'login' })
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10">
    <div class="w-full max-w-md">
      <div class="mb-6 text-center">
        <div
          class="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-slate-800 text-white"
        >
          <Lock class="h-5 w-5" />
        </div>
        <h1 class="mt-3 text-xl font-bold text-slate-900">Ganti Password</h1>
        <p v-if="user" class="mt-1 text-sm text-slate-600">
          {{ user.email }} · <span class="uppercase">{{ user.role }}</span>
        </p>
      </div>

      <!-- Password wajib diganti (dipaksa owner) -->
      <div
        v-if="isForced && !done"
        class="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
        data-testid="force-notice"
      >
        <div class="flex items-start gap-2">
          <AlertTriangle class="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p class="font-semibold">Password sementara aktif</p>
            <p class="mt-1">
              Owner mereset password Anda. Anda <strong>wajib</strong> membuat password baru
              sebelum bisa memakai aplikasi.
            </p>
          </div>
        </div>
      </div>

      <!-- Sukses -->
      <div
        v-if="done"
        class="rounded-xl border border-emerald-200 bg-emerald-50 p-6 text-center"
        data-testid="password-changed"
      >
        <div
          class="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-600 text-white"
        >
          <Check class="h-6 w-6" />
        </div>
        <p class="mt-3 font-semibold text-emerald-900">Password berhasil diganti</p>
        <p class="mt-1 text-sm text-emerald-800">
          Sesi di perangkat lain sudah dikeluarkan. Silakan lanjut.
        </p>
        <button
          type="button"
          class="mt-4 w-full rounded-lg bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700"
          data-testid="password-continue"
          @click="router.push(homeRouteFor(user?.role))"
        >
          Lanjutkan
        </button>
      </div>

      <form
        v-else
        class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
        data-testid="change-password-form"
        novalidate
        @submit.prevent="onSubmit"
      >
        <div class="space-y-4">
          <div>
            <label for="current" class="block text-sm font-medium text-slate-700">
              Password saat ini
            </label>
            <input
              id="current"
              v-model="currentPassword"
              type="password"
              name="current-password"
              autocomplete="current-password"
              :disabled="submitting"
              data-testid="current-password"
              class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50"
              placeholder="••••••••"
            />
          </div>

          <div>
            <label for="new" class="block text-sm font-medium text-slate-700">Password baru</label>
            <input
              id="new"
              v-model="newPassword"
              type="password"
              name="new-password"
              autocomplete="new-password"
              :disabled="submitting"
              data-testid="new-password"
              class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50"
              placeholder="Minimal 8 karakter"
            />
            <div v-if="newPassword" class="mt-2">
              <div class="h-1.5 overflow-hidden rounded-full bg-slate-200">
                <div
                  class="h-full transition-all"
                  :class="[strength.class, newPassword.length >= 8 ? 'w-2/5' : 'w-1/5', newPassword.length >= 12 ? 'w-3/5' : '', newPassword.length >= 16 ? 'w-4/5' : '', newPassword.length >= 20 ? 'w-full' : '']"
                />
              </div>
              <p class="mt-1 text-xs text-slate-500">Kekuatan: {{ strength.label }}</p>
            </div>
            <p v-if="newPasswordError" class="mt-1 text-xs text-rose-600" data-testid="new-password-error">
              {{ newPasswordError }}
            </p>
          </div>

          <div>
            <label for="confirm" class="block text-sm font-medium text-slate-700">
              Konfirmasi password baru
            </label>
            <input
              id="confirm"
              v-model="confirmPassword"
              type="password"
              name="confirm-password"
              autocomplete="new-password"
              :disabled="submitting"
              data-testid="confirm-password"
              class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50"
              placeholder="Ulangi password baru"
            />
            <p v-if="confirmError" class="mt-1 text-xs text-rose-600" data-testid="confirm-password-error">
              {{ confirmError }}
            </p>
          </div>

          <div
            v-if="authError"
            class="rounded-lg bg-rose-50 p-3 text-sm text-rose-800 ring-1 ring-rose-600/20"
            data-testid="change-password-error"
            role="alert"
          >
            {{ authError }}
          </div>

          <button
            type="submit"
            :disabled="!canSubmit"
            data-testid="change-password-submit"
            class="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Loader2 v-if="submitting" class="h-4 w-4 animate-spin" />
            {{ submitting ? 'Menyimpan…' : 'Simpan Password Baru' }}
          </button>
        </div>
      </form>

      <div class="mt-4 flex items-center justify-between text-sm">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 text-slate-600 hover:text-slate-900"
          data-testid="logout-from-change-password"
          @click="onLogout"
        >
          <ArrowLeft class="h-4 w-4" />
          Keluar
        </button>
        <RouterLink
          v-if="!isForced"
          to="/admin"
          class="text-slate-600 hover:text-slate-900"
        >
          Kembali ke dashboard
        </RouterLink>
      </div>
    </div>
  </div>
</template>