<script setup lang="ts">
import { onMounted } from 'vue'
import { RouterView } from 'vue-router'
import { initAuth } from '@/stores/auth'

onMounted(() => {
  // Pulihkan sesi saat aplikasi dimuat supaya route guard tidak
  // sempat menyimpulkan pengguna anonim.
  void initAuth()
})
</script>

<template>
  <RouterView />
</template>