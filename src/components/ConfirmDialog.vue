<script setup lang="ts">
/**
 * Dialog konfirmasi untuk aksi yang merusak atau sulit dibatalkan.
 *
 * Pakai elemen `<dialog>` native supaya fokus terperangkap di dalam dialog
 * dan tombol Esc menutupnya secara bawaan browser — tanpa harus menulis
 * focus trap sendiri.
 *
 * Tutup dengan Escape atau klik area gelap di luar kotak dialog. Klik di
 * dalam kotak tidak menutup, supaya tidak batal secara tidak sengaja.
 */
import { ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    /** Tampilkan dialog. */
    open: boolean
    title: string
    /** Isi pesan; boleh memuat nama objek yang terdampak. */
    message: string
    /** Label tombol konfirmasi. */
    confirmLabel?: string
    /** Label tombol batal. */
    cancelLabel?: string
    /** Tandai sebagai aksi merusak — tombol konfirmasi memakai warna merah. */
    destructive?: boolean
  }>(),
  {
    confirmLabel: 'Ya, lanjutkan',
    cancelLabel: 'Batal',
    destructive: false,
  },
)

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

const dialogEl = ref<HTMLDialogElement | null>(null)

watch(
  () => props.open,
  async (isOpen) => {
    const el = dialogEl.value
    if (!el) return
    if (isOpen && !el.open) {
      await el.showModal()
    } else if (!isOpen && el.open) {
      el.close()
    }
  },
)

/** Escape menekan cancel, bukan menutup dialog secara diam-diam. */
function onCancel(event: Event) {
  event.preventDefault()
  emit('cancel')
}

/** Klik pada backdrop mengarahkan target ke elemen dialog itu sendiri. */
function onClick(event: MouseEvent) {
  if (event.target === dialogEl.value) emit('cancel')
}
</script>

<template>
  <dialog
    ref="dialogEl"
    class="m-auto w-[min(28rem,92vw)] rounded-xl border border-slate-200 bg-white p-0 shadow-xl backdrop:bg-slate-900/40"
    data-testid="confirm-dialog"
    aria-labelledby="confirm-dialog-title"
    @cancel="onCancel"
    @click="onClick"
  >
    <div class="p-5">
      <h2 id="confirm-dialog-title" class="text-base font-bold text-slate-900">
        {{ title }}
      </h2>
      <p class="mt-2 text-sm text-slate-600">{{ message }}</p>
    </div>

    <div
      class="flex flex-wrap justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3"
    >
      <button
        type="button"
        class="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
        data-testid="confirm-cancel"
        @click="emit('cancel')"
      >
        {{ cancelLabel }}
      </button>
      <button
        type="button"
        class="rounded-lg px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-60"
        :class="
          destructive ? 'bg-rose-600 hover:bg-rose-700' : 'bg-indigo-600 hover:bg-indigo-700'
        "
        data-testid="confirm-accept"
        @click="emit('confirm')"
      >
        {{ confirmLabel }}
      </button>
    </div>
  </dialog>
</template>