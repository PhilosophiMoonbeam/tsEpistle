import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import templateCompilerOptions from '@tresjs/core/template-compiler-options'
import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import vuetify from 'vite-plugin-vuetify'
import { copyGraphiqlAssets, copyPrismAssets, provisionDevelopmentAssets } from './server/helpers/vite-assets.ts'

const root = import.meta.dirname
type OfflinePrecacheEntry = {
  url: string
  revision: string | null
  integrity?: string
  size: number
}

type ViteManifestChunk = {
  file: string
  src?: string
  name?: string
  imports?: string[]
  dynamicImports?: string[]
  css?: string[]
  assets?: string[]
}

type ViteBuildManifest = Record<string, ViteManifestChunk>

const PWA_TOMBSTONE_CACHE_NAME_PATTERN = /^tsepistle-pwa-precache-v1-[0-9a-f]{16}$/u

const PWA_TOMBSTONE_SOURCE = `/*
 * Explicit rollback artifact. Deploy this file at /sw.js only during an
 * approved rollback. It is intentionally never registered by the application.
 */
const CACHE_NAME_PATTERN = ${PWA_TOMBSTONE_CACHE_NAME_PATTERN};

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const cacheNames = await self.caches.keys();
    await Promise.all(cacheNames.filter(name => CACHE_NAME_PATTERN.test(name)).map(name => self.caches.delete(name)));
    await self.clients.claim();
    const controlledClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await Promise.all(controlledClients.map(client => client.navigate(client.url).catch(() => undefined)));
    await self.registration.unregister();
  })());
});
`

function tombstoneArtifactPlugin(): Plugin {
  return {
    name: 'tsepistle-pwa-tombstone-artifact',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'sw-tombstone.js', source: PWA_TOMBSTONE_SOURCE })
    }
  }
}

function normalizeManifestPath(value: string): string {
  return value
    .split(/[?#]/, 1)[0]
    .replace(/^\/+/, '')
    .replace(/^_assets\//, '')
}

function manifestURL(path: string): string {
  return path === 'client/offline.html' ? '/_offline' : `/_assets/${path}`
}

async function offlineManifestTransform(entries: OfflinePrecacheEntry[]) {
  const manifestPath = resolve(root, 'assets/.vite/manifest.json')
  const buildManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ViteBuildManifest
  const offlineEntryKey = Object.keys(buildManifest).find(key => key === 'client/offline.html' || buildManifest[key]?.src === 'client/offline.html')
  if (!offlineEntryKey) throw new Error('The neutral offline entry is missing from the Vite build manifest.')

  const visitedKeys = new Set<string>()
  const closure = new Set<string>()
  const visit = (key: string): void => {
    if (visitedKeys.has(key)) return
    visitedKeys.add(key)
    const entry = buildManifest[key]
    if (!entry) throw new Error(`The neutral offline dependency ${key} is missing from the Vite build manifest.`)
    closure.add(normalizeManifestPath(entry.file))
    for (const asset of [...(entry.css ?? []), ...(entry.assets ?? [])]) closure.add(normalizeManifestPath(asset))
    for (const imported of [...(entry.imports ?? []), ...(entry.dynamicImports ?? [])]) visit(imported)
  }
  visit(offlineEntryKey)

  const offlineDocuments = entries.filter(entry => normalizeManifestPath(entry.url) === 'client/offline.html')
  if (offlineDocuments.length !== 1) throw new Error('The neutral offline document must have one precache entry.')

  return {
    manifest: entries
      .filter(entry => {
        const path = normalizeManifestPath(entry.url)
        return path === 'client/offline.html' || closure.has(path)
      })
      .map(entry => ({ ...entry, url: manifestURL(normalizeManifestPath(entry.url)) }))
  }
}

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
          await copyGraphiqlAssets(projectRoot)
        }
      }
}

export default defineConfig(({ command }) => ({
  base: command === 'serve' ? '/' : '/_assets/',
  publicDir: resolve(root, 'client/static'),
  plugins: [
    vue({
      template: {
        ...templateCompilerOptions.template,
        transformAssetUrls: false
      }
    }),
    vuetify({ autoImport: true }),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'client',
      filename: 'service-worker.ts',
      scope: '/',
      manifest: false,
      injectRegister: false,
      injectManifest: {
        rollupFormat: 'iife',
        swDest: resolve(root, 'assets/service-worker.js'),
        globDirectory: resolve(root, 'assets'),
        globPatterns: ['client/offline.html', 'js/*.js', 'assets/*.css'],
        injectionPoint: 'globalThis.__WB_MANIFEST',
        manifestTransforms: [offlineManifestTransform]
      }
    }),
    tombstoneArtifactPlugin(),
    runtimeAssetsPlugin(command)
  ],
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
        setup: resolve(root, 'client/index-setup.ts'),
        offline: resolve(root, 'client/offline.html')
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
