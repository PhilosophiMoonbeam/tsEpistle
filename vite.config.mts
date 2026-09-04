import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vite'
import vuetify from 'vite-plugin-vuetify'
import { copyPrismAssets, provisionDevelopmentAssets } from './server/helpers/vite-assets.ts'

const root = import.meta.dirname

export function runtimeAssetsPlugin(command: 'build' | 'serve', projectRoot = root): Plugin {
  return command === 'serve'
    ? {
        name: 'wiki-runtime-assets',
        async configureServer() {
          await provisionDevelopmentAssets(projectRoot)
        }
      }
    : {
        name: 'wiki-runtime-assets',
        async closeBundle() {
          await copyPrismAssets(projectRoot)
        }
      }
}

export default defineConfig(({ command }) => ({
  base: command === 'serve' ? '/' : '/_assets/',
  publicDir: resolve(root, 'client/static'),
  plugins: [vue({ template: { transformAssetUrls: false } }), vuetify({ autoImport: true }), runtimeAssetsPlugin(command)],
  resolve: {
    alias: {
      '@': resolve(root, 'client'),
      // Server Pug views provide the root component template mounted by client-app.ts.
      vue: 'vue/dist/vue.esm-bundler.js'
    },
    dedupe: ['@codemirror/state', '@codemirror/view']
  },
  css: {
    preprocessorOptions: {
      scss: {
        additionalData: (source: string, filename: string) =>
          filename.endsWith('/client/scss/global.scss') || filename.endsWith('/client/scss/app.scss') ? source : `@use "@/scss/global.scss" as *;\n${source}`
      }
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    cors: true,
    origin: 'http://127.0.0.1:5173'
  },
  build: {
    outDir: resolve(root, 'assets'),
    emptyOutDir: true,
    manifest: true,
    sourcemap: true,
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      input: {
        app: resolve(root, 'client/index-app.ts'),
        setup: resolve(root, 'client/index-setup.ts')
      },
      output: {
        entryFileNames: 'js/[name]-[hash].js',
        chunkFileNames: 'js/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  },
  define: {
    __VUE_OPTIONS_API__: true,
    __VUE_PROD_DEVTOOLS__: false,
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false
  }
}))
