import { cp, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import vuetify from 'vite-plugin-vuetify'

const root = import.meta.dirname

function copyRuntimeAssets (): Plugin {
  return {
    name: 'wiki-runtime-assets',
    async closeBundle () {
      const output = resolve(root, 'assets/js/prism')
      await mkdir(output, { recursive: true })
      await cp(resolve(root, 'node_modules/prismjs/components'), output, { recursive: true })
    }
  }
}

export default defineConfig(({ command }) => ({
  base: command === 'serve' ? '/' : '/_assets/',
  publicDir: resolve(root, 'client/static'),
  plugins: [
    vue({ template: { transformAssetUrls: false } }),
    vuetify({ autoImport: true }),
    copyRuntimeAssets()
  ],
  resolve: {
    alias: {
      '@': resolve(root, 'client'),
      // Server Pug views provide the root component template mounted by client-app.ts.
      vue: 'vue/dist/vue.esm-bundler.js',
      'uc.micro': resolve(root, 'node_modules/uc.micro')
    }
  },
  css: {
    preprocessorOptions: {
      scss: {
        additionalData: (source: string, filename: string) => (
          filename.endsWith('/client/scss/global.scss') || filename.endsWith('/client/scss/app.scss')
        )
          ? source
          : `@use "@/scss/global.scss" as *;\n${source}`
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
