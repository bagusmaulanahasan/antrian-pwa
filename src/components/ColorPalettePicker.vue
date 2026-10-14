<script lang="ts">
/**
 * Palet warna harus hidup di module scope: nilai default `defineProps()`
 * di-hoist keluar dari `setup()`, jadi tidak boleh merujuk variabel yang
 * dideklarasikan di dalam `<script setup>`.
 */
export interface ColorSwatch {
  /** Nama warna untuk pembaca layar (accessibility). */
  name: string
  /** Nilai warna, harus `#rrggbb`. */
  value: string
}

/**
 * Palet bawaan.
 *
 * Hue tersebar mengelilingi roda warna dengan jarak minimal ±15° satu sama
 * lain. Warna yang warnanya memang berkerabat (mis. oranye dan cokelat)
 * dipisahkan lewat tingkat kecerahan; abu-abu dipisahkan lewat saturasi.
 * Hasilnya: tidak ada dua warna yang tampak mirip saat berdampingan di
 * daftar kategori.
 *
 * Semuanya memakai shade `-600` atau lebih gelap supaya kontrasnya cukup
 * terhadap teks putih di dashboard admin dan tetap terbaca di layar TV.
 */
const DEFAULT_SWATCHES: ColorSwatch[] = [
  { name: 'Merah', value: '#dc2626' },
  { name: 'Pink', value: '#db2777' },
  { name: 'Magenta', value: '#c026d3' },
  { name: 'Violet', value: '#7c3aed' },
  { name: 'Indigo', value: '#4f46e5' },
  { name: 'Biru', value: '#2563eb' },
  { name: 'Biru Langit', value: '#0284c7' },
  { name: 'Toska', value: '#0d9488' },
  { name: 'Hijau', value: '#16a34a' },
  { name: 'Hijau Limau', value: '#65a30d' },
  { name: 'Kuning', value: '#ca8a04' },
  { name: 'Oranye', value: '#ea580c' },
  { name: 'Cokelat', value: '#92400e' },
  { name: 'Abu-abu', value: '#475569' },
]

export { DEFAULT_SWATCHES }
</script>

<script setup lang="ts">
/**
 * Pemilih warna siap-pilih untuk kategori antrian.
 *
 * Mengganti input `type="color"` bawaan browser, yang memaksa pengguna
 * membuka dialog eyedropper/atur RGB. Palet di sini cukup satu klik.
 *
 * Nilai yang dikeluarkan tetap `#rrggbb` supaya kompatibel dengan kolom
 * `categories.color` serta dashboard admin, dashboard TV, dan cetak tiket.
 */
import { computed, withDefaults } from 'vue'

const props = withDefaults(
  defineProps<{
    /** Warna terpilih saat ini. */
    modelValue: string
    /** Palet pengganti bawaan. Nilai harus `#rrggbb`. */
    swatches?: ColorSwatch[]
    /** Awalan `data-testid`, agar tiap pemakaian bisa diuji terpisah. */
    testIdPrefix?: string
    /** Label untuk pembaca layar pada kelompok warna. */
    label?: string
  }>(),
  {
    testIdPrefix: 'color',
    label: 'Pilihan warna',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const palette = computed<ColorSwatch[]>(() => props.swatches ?? DEFAULT_SWATCHES)

/** Bandingkan tanpa sensitivitas huruf agar pilihan lama tetap tersorot. */
function isSelected(value: string): boolean {
  return value.toLowerCase() === props.modelValue.trim().toLowerCase()
}
</script>

<template>
  <div role="radiogroup" :aria-label="label" class="flex flex-wrap items-center gap-1.5">
    <button
      v-for="swatch in palette"
      :key="swatch.value"
      type="button"
      role="radio"
      :aria-checked="isSelected(swatch.value)"
      :aria-label="swatch.name"
      :title="swatch.name"
      :data-testid="`${testIdPrefix}-${swatch.value.slice(1)}`"
      class="h-8 w-8 rounded-full border-2 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2"
      :class="
        isSelected(swatch.value)
          ? 'border-slate-900 shadow-sm'
          : 'border-slate-300 hover:border-slate-400'
      "
      :style="{ backgroundColor: swatch.value }"
      @click="emit('update:modelValue', swatch.value)"
    />

    <span
      v-if="modelValue && !palette.some((s) => isSelected(s.value))"
      class="flex h-8 items-center gap-1.5 rounded-lg bg-amber-50 px-2 text-xs text-amber-800 ring-1 ring-amber-600/20"
      data-testid="color-custom-warning"
    >
      Warna saat ini di luar palet
      <span
        class="inline-block h-4 w-4 rounded-full border border-slate-300 align-middle"
        :style="{ backgroundColor: modelValue }"
      />
    </span>
  </div>
</template>