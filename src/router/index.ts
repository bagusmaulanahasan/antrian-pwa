import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { authUser, initAuth, isAuthenticated, isOwner, mustChangePassword } from '@/stores/auth'
import HomeView from '@/views/HomeView.vue'
import LoginView from '@/views/LoginView.vue'
import TestConnectionView from '@/views/TestConnectionView.vue'

declare module 'vue-router' {
  interface RouteMeta {
    /** Halaman hanya untuk owner. */
    ownerOnly?: boolean
    /** Halaman hanya untuk pengguna yang sudah login. */
    requiresAuth?: boolean
    /** Halaman dev, disembunyikan dari navigasi produksi. */
    devOnly?: boolean
  }
}

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'home', component: HomeView },
  { path: '/login', name: 'login', component: LoginView, meta: { devOnly: false } },
  {
    path: '/admin',
    name: 'admin',
    component: () => import('@/views/AdminDashboardView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/owner',
    name: 'owner',
    component: () => import('@/views/OwnerSettingsView.vue'),
    meta: { requiresAuth: true, ownerOnly: true },
  },
  {
    path: '/change-password',
    name: 'change-password',
    component: () => import('@/views/ChangePasswordView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/tv',
    name: 'tv',
    component: () => import('@/views/TvDashboardView.vue'),
  },
  {
    path: '/dev/test-connection',
    name: 'test-connection',
    component: TestConnectionView,
    meta: { devOnly: true },
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
})

/** Route tujuan setelah login, sesuai peran pengguna. */
export function homeRouteFor(role: 'owner' | 'admin' | undefined): string {
  return role === 'owner' ? '/owner' : '/admin'
}

/**
 * Route guard.
 *
 * Urutan importance:
 *  1. Dev page di produksi → lempar ke beranda.
 *  2. Sesi dipulihkan sekali sebelum keputusan diambil.
 *  3. `mustChangePassword` → seluruh halaman terkunci, hanya boleh ke
 *     /change-password. Ini memaksa admin mengganti password hasil reset owner.
 *  4. Route butuh auth tapi belum login → /login (simpan tujuan).
 *  5. Route ownerOnly tapi bukan owner → /admin.
 */
router.beforeEach(async (to) => {
  if (to.meta.devOnly && import.meta.env.PROD) return { name: 'home' }

  // Pulihkan sesi lebih dulu untuk route mana pun yang butuh tahu status auth.
  // Tanpa ini, memuat penuh halaman di /login selalu tampak anonim walau
  // cookie masih valid.
  if (to.meta.requiresAuth || to.name === 'login') {
    await initAuth()
  }

  if (to.name === 'login' && isAuthenticated.value) {
    return { path: homeRouteFor(authUser.value?.role) }
  }

  if (to.meta.requiresAuth) {

    if (!isAuthenticated.value) {
      return { name: 'login', query: { redirect: to.fullPath } }
    }

    if (mustChangePassword.value && to.name !== 'change-password') {
      return { name: 'change-password', query: { force: '1' } }
    }

    if (to.meta.ownerOnly && !isOwner.value) {
      return { name: 'admin' }
    }
  }

  return true
})