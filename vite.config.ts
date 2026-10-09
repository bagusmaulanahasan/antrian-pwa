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
    },
    plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'robots.txt'],
      manifest: {
        name: 'Sistem Antrian PWA',
        short_name: 'Antrian',
        theme_color: '#ffffff',
        icons: [
          {
            src: '/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          }
        ]
      }
    })
    ]
  }
})
