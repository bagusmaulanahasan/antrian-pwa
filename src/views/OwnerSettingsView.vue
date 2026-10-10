<script setup lang="ts">
import {
  AlertTriangle,
  Check,
  Copy,
  Loader2,
  LogOut,
  Plus,
  Save,
  Trash2,
  Tv,
  Users,
} from 'lucide-vue-next'
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  createCategory,
  createUser,
  deactivateCategory,
  fetchOwnerCategories,
  fetchSettings,
  fetchUsers,
  resetUserPassword,
  saveSetting,
  setUserActive,
  updateCategory,
  type Category,
  type OwnerUser,
  type PrintTemplate,
  type VoiceTemplate,
} from '@/lib/ownerApi'
import { authUser, isAuthenticated, logout } from '@/stores/auth'

const router = useRouter()
const me = authUser

type Tab = 'kategori' | 'suara' | 'cetak' | 'akun'

const tab = ref<Tab>('kategori')
const loading = ref(true)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)

// ------------------------------------------------------------- kategori
const categories = ref<Category[]>([])
const newCategory = ref({ name: '', color: '#6366f1', code: '' })
const savingCategory = ref(false)

const activeCategories = computed(() => categories.value.filter((c) => c.is_active))
const inactiveCategories = computed(() => categories.value.filter((c) => !c.is_active))

// ---------------------------------------------------------- pengaturan
const resetHour = ref<number>(0)
const voice = ref<VoiceTemplate>({
  text: 'Nomor antrian {nomor}, atas nama {nama}, kategori {kategori}, silakan menuju ke depan.',
  rate: 1,
  volume: 1,
  repeat: 1,
})
const print = ref<PrintTemplate>({
  placeName: '',
  address: '',
  phone: '',
  template: '{tempat}\n{alamat}\n\nNomor: {nomor}\nNama: {nama}\nKategori: {kategori}\n{tanggal}',
})
const savingSetting = ref<string | null>(null)

// ---------------------------------------------------------------- akun
const users = ref<OwnerUser[]>([])
const newUser = ref({ email: '', password: '', displayName: '' })
const savingUser = ref(false)
const revealedPassword = ref<string | null>(null)

function flash(message: string): void {
  notice.value = message
  setTimeout(() => {
    if (notice.value === message) notice.value = null
  }, 4000)
}

async function reload() {
  try {
    error.value = null
    const [cat, settings, userList] = await Promise.all([
      fetchOwnerCategories(),
      fetchSettings(),
      fetchUsers(),
    ])
    categories.value = cat.categories
    users.value = userList.users

    const s = settings.settings
    if (typeof s.reset_hour === 'number') resetHour.value = s.reset_hour
    if (s.voice_template) voice.value = { ...voice.value, ...s.voice_template }
    if (s.print_template) print.value = { ...print.value, ...s.print_template }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Gagal memuat pengaturan.'
  } finally {
    loading.value = false
  }
}

// ----------------------------------------------------------- kategori
async function onAddCategory() {
  if (!newCategory.value.name.trim()) return
  savingCategory.value = true
  try {
    await createCategory({
      name: newCategory.value.name.trim(),
      color: newCategory.value.color,
      code: newCategory.value.code.trim() || null,
      sort_order: categories.value.length,
    })
    newCategory.value = { name: '', color: '#6366f1', code: '' }
    flash('Kategori ditambahkan.')
    await reload()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Gagal menambah kategori.'
  } finally {
    savingCategory.value = false
  }
}

async function onCategoryColor(id: string, color: string) {
  try {
    await updateCategory(id, { color })
    await reload()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Gagal mengubah warna.'
  }
}

async function onCategoryName(id: string, name: string) {
  if (!name.trim()) return
  try {
    await updateCategory(id, { name: name.trim() })
    flash('Nama kategori diperbarui.')
    await reload()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Gagal mengubah nama.'
  }
}

async function onDeactivateCategory(c: Category) {
  try {
    await deactivateCategory(c.id)
    flash(`Kategori "${c.name}" dinonaktifkan.`)
    await reload()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Gagal menonaktifkan kategori.'
  }
}

// -------------------------------------------------------- pengaturan
async function onSaveResetHour() {
  savingSetting.value = 'reset_hour'
  try {
    await saveSetting('reset_hour', Number(resetHour.value))
    flash('Jam reset harian disimpan.')
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Gagal menyimpan jam reset.'
  } finally {
    savingSetting.value = null
  }
}

async function onSaveVoice() {
  savingSetting.value = 'voice_template'
  try {
    await saveSetting('voice_template', {
      text: voice.value.text,
      rate: Number(voice.value.rate),
      volume: Number(voice.value.volume),
      repeat: Number(voice.value.repeat),
    })
    flash('Template suara disimpan.')
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Gagal menyimpan template suara.'
  } finally {
    savingSetting.value = null
  }
}

async function onSavePrint() {
  savingSetting.value = 'print_template'
  try {
    await saveSetting('print_template', {
      placeName: print.value.placeName ?? '',
      address: print.value.address ?? '',
      phone: print.value.phone ?? '',
      logoUrl: null,
      template: print.value.template,
    })
    flash('Template cetak disimpan.')
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Gagal menyimpan template cetak.'
  } finally {
    savingSetting.value = null
  }
}

/** Pratinjau tiket menggunakan template yang sedang diedit. */
const printPreview = computed(() => {
  const replace = (text: string) =>
    text
      .replace(/\{tempat\}/g, print.value.placeName || 'Nama Tempat')
      .replace(/\{alamat\}/g, print.value.address || 'Alamat Lokasi')
      .replace(/\{telepon\}/g, print.value.phone || '')
      .replace(/\{nomor\}/g, 'A-001')
      .replace(/\{nama\}/g, 'Budi Santoso')
      .replace(/\{kategori\}/g, activeCategories.value[0]?.name ?? 'Rawat Jalan')
      .replace(/\{tanggal\}/g, 'Kamis, 9 Oktober 2026')
  return print.value.template.split('\n').map(replace)
})

// -------------------------------------------------------------- akun
async function onCreateUser() {
  if (!newUser.value.email.trim() || !newUser.value.password) return
  savingUser.value = true
  try {
    const res = await createUser({
      email: newUser.value.email.trim(),
      password: newUser.value.password,
      role: 'admin',
      displayName: newUser.value.displayName.trim() || undefined,
    })
    revealedPassword.value = res.temporaryPassword
    newUser.value = { email: '', password: '', displayName: '' }
    flash('Akun admin dibuat.')
    await reload()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Gagal membuat akun.'
  } finally {
    savingUser.value = false
  }
}

async function onResetPassword(user: OwnerUser) {
  try {
    const res = await resetUserPassword(user.id)
    revealedPassword.value = res.temporaryPassword
    flash(`Password ${user.email} direset.`)
    await reload()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Gagal mereset password.'
  }
}

async function onToggleActive(user: OwnerUser) {
  try {
    await setUserActive(user.id, !user.is_active)
    flash(`Akun ${user.email} ${user.is_active ? 'dinonaktifkan' : 'diaktifkan'}.`)
    await reload()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Gagal mengubah status akun.'
  }
}

async function onLogout() {
  await logout()
  await router.push({ name: 'login' })
}

onMounted(async () => {
  if (!isAuthenticated.value) {
    await router.push({ name: 'login', query: { redirect: '/owner' } })
    return
  }
  await reload()
})
</script>

<template>
  <div class="min-h-screen bg-slate-100">
    <header class="border-b border-slate-200 bg-white">
      <div class="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div>
          <h1 class="text-lg font-bold text-slate-900">Pengaturan Owner</h1>
          <p class="text-xs text-slate-500">
            {{ me?.display_name || 'Owner' }}
            <span v-if="me?.email" class="text-slate-400"> · {{ me.email }}</span>
          </p>
        </div>
        <div class="flex items-center gap-2">
          <RouterLink
            to="/tv"
            class="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <Tv class="h-3.5 w-3.5" />
            Dashboard TV
          </RouterLink>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-900"
            data-testid="owner-logout"
            @click="onLogout"
          >
            <LogOut class="h-3.5 w-3.5" />
            Keluar
          </button>
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-5xl space-y-5 px-4 py-6">
      <div
        v-if="error"
        class="flex items-start gap-2 rounded-xl bg-rose-50 p-4 text-sm text-rose-800 ring-1 ring-rose-600/20"
        data-testid="owner-error"
        role="alert"
      >
        <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
        <span>{{ error }}</span>
      </div>

      <div
        v-if="notice"
        class="flex items-center gap-2 rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800 ring-1 ring-emerald-600/20"
        data-testid="owner-notice"
      >
        <Check class="h-4 w-4" />
        {{ notice }}
      </div>

      <!-- Password sementara -->
      <div
        v-if="revealedPassword"
        class="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
        data-testid="temp-password"
      >
        <p class="font-semibold">Password sementara</p>
        <p class="mt-1">
          Sampaikan password ini kepada admin. Akun WAJIB mengganti password saat login pertama.
        </p>
        <code class="mt-2 block rounded-lg bg-white px-3 py-2 font-mono text-base font-bold tracking-wider">
          {{ revealedPassword }}
        </code>
        <button
          type="button"
          class="mt-2 text-xs font-medium underline"
          @click="revealedPassword = null"
        >
          Saya sudah mencatatnya
        </button>
      </div>

      <!-- Tab -->
      <nav class="flex flex-wrap gap-2" data-testid="owner-tabs">
        <button
          v-for="t in ([
            { id: 'kategori', label: 'Kategori' },
            { id: 'suara', label: 'Suara' },
            { id: 'cetak', label: 'Cetak' },
            { id: 'akun', label: 'Akun' },
          ] as const)"
          :key="t.id"
          type="button"
          class="rounded-lg px-4 py-2 text-sm font-medium transition"
          :class="
            tab === t.id
              ? 'bg-indigo-600 text-white'
              : 'bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50'
          "
          :data-testid="`tab-${t.id}`"
          @click="tab = t.id"
        >
          {{ t.label }}
        </button>
      </nav>

      <div v-if="loading" class="py-16 text-center text-sm text-slate-500">Memuat pengaturan…</div>

      <template v-else>
        <!-- ================= KATEGORI ================= -->
        <section v-if="tab === 'kategori'" class="space-y-4">
          <div class="rounded-xl border border-slate-200 bg-white p-5">
            <h2 class="font-semibold text-slate-900">Kategori Antrian</h2>
            <p class="mt-1 text-sm text-slate-600">
              Urutan menentukan urutan tampil. Menonaktifkan kategori menyembunyikannya dari
              dashboard tanpa menghapus data antrian lama.
            </p>

            <ul class="mt-4 space-y-2" data-testid="category-list">
              <li
                v-for="c in activeCategories"
                :key="c.id"
                class="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 px-4 py-3"
                :data-testid="`owner-category-${c.code ?? c.id}`"
              >
                <input
                  type="color"
                  :value="c.color"
                  class="h-9 w-9 cursor-pointer rounded border border-slate-300"
                  :aria-label="`Warna ${c.name}`"
                  @change="onCategoryColor(c.id, ($event.target as HTMLInputElement).value)"
                />
                <input
                  :value="c.name"
                  class="min-w-40 flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  :aria-label="`Nama kategori ${c.name}`"
                  @change="onCategoryName(c.id, ($event.target as HTMLInputElement).value)"
                />
                <span class="rounded bg-slate-100 px-2 py-0.5 text-xs font-mono text-slate-600">
                  {{ c.code ?? '—' }}
                </span>
                <button
                  type="button"
                  class="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  :data-testid="`deactivate-${c.code ?? c.id}`"
                  @click="onDeactivateCategory(c)"
                >
                  <Trash2 class="h-3.5 w-3.5" />
                  Nonaktifkan
                </button>
              </li>
            </ul>

            <p v-if="!activeCategories.length" class="mt-4 text-sm text-slate-500">
              Belum ada kategori aktif.
            </p>
          </div>

          <div class="rounded-xl border border-slate-200 bg-white p-5">
            <h3 class="flex items-center gap-2 font-semibold text-slate-900">
              <Plus class="h-4 w-4 text-indigo-600" />
              Tambah Kategori
            </h3>
            <form class="mt-3 flex flex-wrap items-end gap-3" @submit.prevent="onAddCategory">
              <div class="min-w-48 flex-1">
                <label class="block text-xs font-medium text-slate-600">Nama</label>
                <input
                  v-model="newCategory.name"
                  type="text"
                  maxlength="60"
                  data-testid="new-category-name"
                  class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  placeholder="Contoh: Rawat Jalan"
                />
              </div>
              <div>
                <label class="block text-xs font-medium text-slate-600">Kode</label>
                <input
                  v-model="newCategory.code"
                  type="text"
                  maxlength="20"
                  data-testid="new-category-code"
                  class="mt-1 w-28 rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  placeholder="RJ"
                />
              </div>
              <div>
                <label class="block text-xs font-medium text-slate-600">Warna</label>
                <input
                  v-model="newCategory.color"
                  type="color"
                  class="mt-1 h-9 w-16 cursor-pointer rounded border border-slate-300"
                />
              </div>
              <button
                type="submit"
                :disabled="savingCategory || !newCategory.name.trim()"
                data-testid="add-category"
                class="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
              >
                <Loader2 v-if="savingCategory" class="h-4 w-4 animate-spin" />
                Tambah
              </button>
            </form>
          </div>

          <div v-if="inactiveCategories.length" class="rounded-xl border border-slate-200 bg-white p-5">
            <h3 class="text-sm font-semibold text-slate-700">Kategori nonaktif</h3>
            <ul class="mt-2 flex flex-wrap gap-2">
              <li
                v-for="c in inactiveCategories"
                :key="c.id"
                class="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600"
              >
                {{ c.name }}
              </li>
            </ul>
          </div>
        </section>

        <!-- ================= SUARA ================= -->
        <section v-else-if="tab === 'suara'" class="space-y-4">
          <div class="rounded-xl border border-slate-200 bg-white p-5">
            <h2 class="font-semibold text-slate-900">Template Suara</h2>
            <p class="mt-1 text-sm text-slate-600">
              Placeholder yang tersedia: <code class="font-mono">{nomor}</code>,
              <code class="font-mono">{nama}</code>,
              <code class="font-mono">{kategori}</code>.
            </p>

            <div class="mt-4 space-y-4">
              <div>
                <label class="block text-sm font-medium text-slate-700">Teks pengumuman</label>
                <textarea
                  v-model="voice.text"
                  rows="3"
                  maxlength="400"
                  data-testid="voice-text"
                  class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>

              <div class="grid gap-4 sm:grid-cols-3">
                <div>
                  <label class="block text-sm font-medium text-slate-700">
                    Kecepatan ({{ voice.rate }})
                  </label>
                  <input
                    v-model.number="voice.rate"
                    type="range"
                    min="0.5"
                    max="2"
                    step="0.1"
                    data-testid="voice-rate"
                    class="mt-2 w-full"
                  />
                </div>
                <div>
                  <label class="block text-sm font-medium text-slate-700">
                    Volume ({{ Math.round(voice.volume * 100) }}%)
                  </label>
                  <input
                    v-model.number="voice.volume"
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    data-testid="voice-volume"
                    class="mt-2 w-full"
                  />
                </div>
                <div>
                  <label class="block text-sm font-medium text-slate-700">Pengulangan</label>
                  <input
                    v-model.number="voice.repeat"
                    type="number"
                    min="1"
                    max="5"
                    data-testid="voice-repeat"
                    class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div class="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
                <p class="font-medium">Pratinjau:</p>
                <p class="mt-1" data-testid="voice-preview">
                  {{
                    voice.text
                      .replace(/\{nomor\}/g, 'A-001')
                      .replace(/\{nama\}/g, 'Budi Santoso')
                      .replace(/\{kategori\}/g, activeCategories[0]?.name ?? 'Rawat Jalan')
                  }}
                </p>
              </div>

              <button
                type="button"
                :disabled="savingSetting === 'voice_template'"
                data-testid="save-voice"
                class="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
                @click="onSaveVoice"
              >
                <Loader2 v-if="savingSetting === 'voice_template'" class="h-4 w-4 animate-spin" />
                <Save v-else class="h-4 w-4" />
                Simpan Template Suara
              </button>
            </div>
          </div>

          <div class="rounded-xl border border-slate-200 bg-white p-5">
            <h2 class="font-semibold text-slate-900">Jam Reset Harian</h2>
            <p class="mt-1 text-sm text-slate-600">
              Nomor antrian mulai dari 1 lagi setiap hari pada jam ini (WIB).
            </p>
            <div class="mt-3 flex flex-wrap items-end gap-3">
              <div>
                <label class="block text-xs font-medium text-slate-600">Jam (0-23)</label>
                <input
                  v-model.number="resetHour"
                  type="number"
                  min="0"
                  max="23"
                  data-testid="reset-hour"
                  class="mt-1 w-28 rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <button
                type="button"
                :disabled="savingSetting === 'reset_hour'"
                data-testid="save-reset-hour"
                class="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
                @click="onSaveResetHour"
              >
                <Loader2 v-if="savingSetting === 'reset_hour'" class="h-4 w-4 animate-spin" />
                <Save v-else class="h-4 w-4" />
                Simpan
              </button>
            </div>
          </div>
        </section>

        <!-- ================= CETAK ================= -->
        <section v-else-if="tab === 'cetak'" class="space-y-4">
          <div class="rounded-xl border border-slate-200 bg-white p-5">
            <h2 class="font-semibold text-slate-900">Template Cetak 58mm</h2>
            <p class="mt-1 text-sm text-slate-600">
              Placeholder: <code class="font-mono">{tempat}</code>,
              <code class="font-mono">{alamat}</code>,
              <code class="font-mono">{telepon}</code>,
              <code class="font-mono">{nomor}</code>,
              <code class="font-mono">{nama}</code>,
              <code class="font-mono">{kategori}</code>,
              <code class="font-mono">{tanggal}</code>.
            </p>

            <div class="mt-4 grid gap-4 lg:grid-cols-2">
              <div class="space-y-3">
                <div>
                  <label class="block text-xs font-medium text-slate-600">Nama Tempat</label>
                  <input
                    v-model="print.placeName"
                    type="text"
                    data-testid="print-place"
                    class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label class="block text-xs font-medium text-slate-600">Alamat</label>
                  <input
                    v-model="print.address"
                    type="text"
                    data-testid="print-address"
                    class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label class="block text-xs font-medium text-slate-600">Telepon</label>
                  <input
                    v-model="print.phone"
                    type="text"
                    data-testid="print-phone"
                    class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label class="block text-xs font-medium text-slate-600">Template</label>
                  <textarea
                    v-model="print.template"
                    rows="7"
                    maxlength="2000"
                    data-testid="print-template"
                    class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                  />
                </div>
                <button
                  type="button"
                  :disabled="savingSetting === 'print_template'"
                  data-testid="save-print"
                  class="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
                  @click="onSavePrint"
                >
                  <Loader2 v-if="savingSetting === 'print_template'" class="h-4 w-4 animate-spin" />
                  <Save v-else class="h-4 w-4" />
                  Simpan Template Cetak
                </button>
              </div>

              <!-- Pratinjau 58mm -->
              <div>
                <p class="text-xs font-medium text-slate-600">Pratinjau tiket (58mm)</p>
                <pre
                  class="mt-1 overflow-x-auto rounded-lg bg-slate-900 p-4 font-mono text-xs leading-relaxed text-slate-100"
                  data-testid="print-preview"
                >{{ printPreview.join('\n') }}</pre>
              </div>
            </div>
          </div>
        </section>

        <!-- ================= AKUN ================= -->
        <section v-else class="space-y-4">
          <div class="rounded-xl border border-slate-200 bg-white p-5">
            <h2 class="flex items-center gap-2 font-semibold text-slate-900">
              <Users class="h-4 w-4 text-indigo-600" />
              Kelola Akun
            </h2>
            <p class="mt-1 text-sm text-slate-600">
              Password baru dari owner selalu berstatus sementara — admin wajib menggantinya saat
              login pertama.
            </p>

            <ul class="mt-4 space-y-2" data-testid="user-list">
              <li
                v-for="u in users"
                :key="u.id"
                class="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 px-4 py-3"
                :data-testid="`user-${u.email}`"
              >
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-medium text-slate-900">
                    {{ u.display_name || u.email }}
                  </p>
                  <p class="truncate text-xs text-slate-500">{{ u.email }}</p>
                </div>

                <span
                  class="rounded-full px-2.5 py-1 text-xs font-semibold"
                  :class="
                    u.role === 'owner'
                      ? 'bg-indigo-100 text-indigo-800'
                      : 'bg-slate-100 text-slate-700'
                  "
                >
                  {{ u.role }}
                </span>

                <span
                  v-if="u.is_password_temporary"
                  class="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800"
                >
                  password sementara
                </span>
                <span
                  v-else-if="!u.is_active"
                  class="rounded-full bg-rose-100 px-2.5 py-1 text-xs font-semibold text-rose-700"
                >
                  nonaktif
                </span>

                <button
                  type="button"
                  class="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  :data-testid="`reset-${u.email}`"
                  @click="onResetPassword(u)"
                >
                  <Copy class="h-3.5 w-3.5" />
                  Reset Password
                </button>

                <button
                  v-if="u.id !== me?.id"
                  type="button"
                  class="rounded-lg border px-2.5 py-1.5 text-xs font-medium"
                  :class="
                    u.is_active
                      ? 'border-rose-300 text-rose-700 hover:bg-rose-50'
                      : 'border-emerald-300 text-emerald-700 hover:bg-emerald-50'
                  "
                  :data-testid="`toggle-${u.email}`"
                  @click="onToggleActive(u)"
                >
                  {{ u.is_active ? 'Nonaktifkan' : 'Aktifkan' }}
                </button>
              </li>
            </ul>
          </div>

          <div class="rounded-xl border border-slate-200 bg-white p-5">
            <h3 class="flex items-center gap-2 font-semibold text-slate-900">
              <Plus class="h-4 w-4 text-indigo-600" />
              Tambah Admin
            </h3>
            <form class="mt-3 flex flex-wrap items-end gap-3" @submit.prevent="onCreateUser">
              <div class="min-w-48 flex-1">
                <label class="block text-xs font-medium text-slate-600">Email</label>
                <input
                  v-model="newUser.email"
                  type="email"
                  data-testid="new-user-email"
                  class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  placeholder="admin@contoh.com"
                />
              </div>
              <div>
                <label class="block text-xs font-medium text-slate-600">Nama (opsional)</label>
                <input
                  v-model="newUser.displayName"
                  type="text"
                  data-testid="new-user-name"
                  class="mt-1 w-40 rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label class="block text-xs font-medium text-slate-600">Password sementara</label>
                <input
                  v-model="newUser.password"
                  type="text"
                  minlength="8"
                  data-testid="new-user-password"
                  class="mt-1 w-40 rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  placeholder="Minimal 8 karakter"
                />
              </div>
              <button
                type="submit"
                :disabled="savingUser || !newUser.email.trim() || !newUser.password"
                data-testid="add-user"
                class="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
              >
                <Loader2 v-if="savingUser" class="h-4 w-4 animate-spin" />
                Tambah
              </button>
            </form>
          </div>
        </section>
      </template>
    </main>
  </div>
</template>