import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')

  // Expose non-secret config to the client bundle. Secrets (service_role key)
  // are intentionally NOT exposed here — they belong in the Cloudflare Worker.
  const supabaseUrl = env.VITE_SUPABASE_URL ?? ''
  const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY ?? ''
  const apiBaseUrl = env.VITE_API_BASE_URL ?? ''

  return {
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    define: {
      __SUPABASE_URL__: JSON.stringify(supabaseUrl),
      __SUPABASE_ANON_KEY__: JSON.stringify(supabaseAnonKey),
      __API_BASE_URL__: JSON.stringify(apiBaseUrl),
      __IS_DEV__: JSON.stringify(mode !== 'production'),
    },
    server: {
      host: true,
      port: 5173,
      proxy: {
        '/api': {
          target: 'https://antrian-api.bagusmaulana0320.workers.dev',
          changeOrigin: true,
          secure: true,
        },
      },
    },
    plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'robots.txt'],
      manifest: {
        name: 'Sistem Antrian PWA',
        short_name: 'Antrian',
        description: 'Aplikasi manajemen sistem antrian dengan cetak tiket dan dashboard TV real-time',
        theme_color: '#4f46e5',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        lang: 'id',
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: '/pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        // API Worker dan Supabase tidak boleh di-cache service worker.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/(storage|realtime)\/.*/i,
            handler: 'NetworkOnly',
          },
        ],
      },
    })
    ]
  }
})
