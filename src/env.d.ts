/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __SUPABASE_URL__: string
declare const __SUPABASE_ANON_KEY__: string
declare const __API_BASE_URL__: string
declare const __IS_DEV__: boolean

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_API_BASE_URL?: string
  readonly VITE_TV_PIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}