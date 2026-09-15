import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import templateCompilerOptions from '@tresjs/core/template-compiler-options'
import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import vuetify from 'vite-plugin-vuetify'
import { copyGraphiqlAssets, copyPrismAssets, provisionDevelopmentAssets } from './server/helpers/vite-assets.ts'

const root = import.meta.dirname
const PWA_RELEASE_PLACEHOLDER = '__TSEPISTLE_PWA_RELEASE__'
const PWA_RELEASE_UNAVAILABLE = 'unavailable'
const PWA_RELEASE_PATTERN = /^[0-9a-f]{40}$/u

const readPwaRelease = (): string => {
  const configured = process.env.WIKI_BUILD_REVISION
  let revision: unknown = configured
  if (revision === undefined || revision === '') {
    try {
      const parsed: unknown = JSON.parse(readFileSync(resolve(root, 'server/.build-metadata.json'), 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !('revision' in parsed)) return PWA_RELEASE_UNAVAILABLE
      revision = parsed.revision
    } catch {
      return PWA_RELEASE_UNAVAILABLE
    }
  }
  return typeof revision === 'string' && PWA_RELEASE_PATTERN.test(revision) ? revision : PWA_RELEASE_UNAVAILABLE
}

const pwaRelease = readPwaRelease()
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
const PWA_RELEASE_ID = '__TSEPISTLE_PWA_RELEASE__';
const SAFETY_REQUEST = 'PWA_RELOAD_SAFETY_REQUEST';
const SAFETY_REPORT = 'PWA_RELOAD_SAFETY';
const RETIREMENT_NOTICE = 'PWA_RETIREMENT_NOTICE';
const RETIREMENT_WORKER_ID = 'retirement';
const RETIREMENT_RELEASE = 'retirement';
const ROUND_TIMEOUT_MS = 2000;

const bounded = (promise, timeoutMs) => Promise.race([
  promise,
  new Promise(resolve => setTimeout(() => resolve(undefined), timeoutMs))
]);
const nonce = () => {
  if (self.crypto && typeof self.crypto.randomUUID === 'function') return self.crypto.randomUUID();
  return String(Date.now()) + '-' + Math.random().toString(36).slice(2);
};
const inScope = client => {
  try {
    const scope = new URL(self.registration.scope);
    const url = new URL(client.url);
    const prefix = scope.pathname.endsWith('/') ? scope.pathname : scope.pathname + '/';
    return url.origin === scope.origin && (url.pathname === scope.pathname || url.pathname.startsWith(prefix));
  } catch {
    return false;
  }
};
const removeOwnedCaches = async () => {
  try {
    const names = await bounded(self.caches.keys(), ROUND_TIMEOUT_MS);
    if (!Array.isArray(names)) return;
    await bounded(
      Promise.all(names.filter(name => CACHE_NAME_PATTERN.test(name)).map(name => self.caches.delete(name).catch(() => false))),
      ROUND_TIMEOUT_MS
    );
  } catch {
    // Retirement still unregisters if Cache Storage is unavailable.
  }
};

let retirementRound = null;
self.addEventListener('message', event => {
  const message = event.data;
  const round = retirementRound;
  if (
    !round ||
    !message ||
    message.type !== SAFETY_REPORT ||
    message.workerId !== RETIREMENT_WORKER_ID ||
    message.release !== RETIREMENT_RELEASE ||
    (message.roundNonce !== round.roundNonce && message.nonce !== round.roundNonce) ||
    typeof message.safe !== 'boolean'
  ) return;
  const source = event.source;
  if (!source || !round.clients.some(client => client.id === source.id)) return;
  round.reports.set(source.id, message.safe);
  if (round.clients.every(client => round.reports.has(client.id))) round.resolve();
});

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const cleanup = removeOwnedCaches();
    const unregister = Promise.resolve()
      .then(() => self.registration.unregister())
      .then(() => true)
      .catch(() => false);
    let clients = [];
    try {
      if (typeof self.clients.claim === 'function') await bounded(self.clients.claim(), ROUND_TIMEOUT_MS);
      const listed = await bounded(self.clients.matchAll({ type: 'window' }), ROUND_TIMEOUT_MS);
      clients = Array.isArray(listed) ? listed.filter(inScope) : [];
    } catch {
      clients = [];
    }
    const roundNonce = nonce();
    let resolveReports;
    const reportsComplete = new Promise(resolve => {
      resolveReports = resolve;
    });
    retirementRound = { roundNonce, clients, reports: new Map(), resolve: resolveReports };
    if (clients.length === 0) resolveReports();
    for (const client of clients) {
      try {
        client.postMessage({ type: RETIREMENT_NOTICE, release: PWA_RELEASE_ID });
        client.postMessage({
          type: SAFETY_REQUEST,
          workerId: RETIREMENT_WORKER_ID,
          release: RETIREMENT_RELEASE,
          roundNonce
        });
      } catch {
        // A missing report keeps this client unsafe.
      }
    }

    const [unregistered] = await Promise.all([unregister, cleanup]);
    const completedRound = retirementRound;
    await bounded(reportsComplete, ROUND_TIMEOUT_MS);
    retirementRound = null;
    if (!unregistered) return;
    await Promise.all(
      clients
        .filter(client => completedRound?.reports.get(client.id) === true)
        .map(client =>
          bounded(Promise.resolve().then(() => client.navigate(client.url)).catch(() => undefined), ROUND_TIMEOUT_MS)
        )
    );
  })());
});
`
function tombstoneArtifactPlugin(release: string): Plugin {
  return {
    name: 'tsepistle-pwa-tombstone-artifact',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'sw-tombstone.js',
        source: PWA_TOMBSTONE_SOURCE.replaceAll(PWA_RELEASE_PLACEHOLDER, release)
      })
    }
  }
}
const PWA_RELEASE_LITERAL_PATTERN = /(['"])__TSEPISTLE_PWA_RELEASE__\1/gu

function pwaReleaseArtifactPlugin(release: string): Plugin {
  return {
    name: 'tsepistle-pwa-release-artifacts',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replaceAll(PWA_RELEASE_PLACEHOLDER, release)
    },
    renderChunk(code) {
      if (!code.includes(PWA_RELEASE_PLACEHOLDER)) return null
      return {
        code: code.replace(PWA_RELEASE_LITERAL_PATTERN, JSON.stringify(release)),
        map: null
      }
    }
  }
}

function normalizeManifestPath(value: string): string {
  return value
    .split(/[?#]/, 1)[0]
    .replace(/^\/+/, '')
    .replace(/^_assets\//, '')
}

function manifestURL(path: string, offlinePath: string): string {
  return path === offlinePath ? '/_offline' : `/_assets/${path}`
}

async function offlineManifestTransform(entries: OfflinePrecacheEntry[]) {
  const manifestPath = resolve(root, 'assets/.vite/manifest.json')
  const buildManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ViteBuildManifest
  const offlineEntryKey = Object.keys(buildManifest).find(key => key === 'client/offline.html' || buildManifest[key]?.src === 'client/offline.html')
  if (!offlineEntryKey) throw new Error('The neutral offline entry is missing from the Vite build manifest.')
  const offlineEntry = buildManifest[offlineEntryKey]
  if (!offlineEntry || typeof offlineEntry.file !== 'string') throw new Error('The neutral offline output is missing from the Vite build manifest.')
  const offlinePath = normalizeManifestPath(typeof offlineEntry.src === 'string' ? offlineEntry.src : offlineEntryKey)
  if (offlinePath !== 'client/offline.html') throw new Error('The neutral offline source is not the expected document.')

  const visitedKeys = new Set<string>()
  const closure = new Set<string>([offlinePath])
  const visit = (key: string): void => {
    if (visitedKeys.has(key)) return
    visitedKeys.add(key)
    const entry = buildManifest[key]
    if (!entry || typeof entry.file !== 'string') throw new Error(`The neutral offline dependency ${key} is missing from the Vite build manifest.`)
    closure.add(normalizeManifestPath(entry.file))
    for (const asset of [...(entry.css ?? []), ...(entry.assets ?? [])]) {
      if (typeof asset === 'string') closure.add(normalizeManifestPath(asset))
    }
    for (const imported of [...(entry.imports ?? []), ...(entry.dynamicImports ?? [])]) {
      if (typeof imported !== 'string') throw new Error(`The neutral offline dependency ${key} contains an invalid import.`)
      visit(imported)
    }
  }
  visit(offlineEntryKey)

  const offlineDocuments = entries.filter(entry => normalizeManifestPath(entry.url) === offlinePath)
  if (offlineDocuments.length !== 1) throw new Error('The neutral offline document must have one precache entry.')
  const available = new Map<string, OfflinePrecacheEntry>()
  for (const entry of entries) {
    const pathName = normalizeManifestPath(entry.url)
    if (available.has(pathName)) throw new Error(`The neutral offline closure has duplicate precache entry ${pathName}.`)
    available.set(pathName, entry)
  }
  for (const pathName of closure) {
    if (!available.has(pathName)) throw new Error(`The neutral offline dependency ${pathName} is not included in the precache glob.`)
  }

  return {
    manifest: [...closure]
      .map(pathName => available.get(pathName)!)
      .map(entry => ({ ...entry, url: manifestURL(normalizeManifestPath(entry.url), offlinePath) }))
      .sort((left, right) => left.url.localeCompare(right.url))
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
        globPatterns: ['client/offline.html', 'js/**/*.js', 'assets/**/*'],
        globDirectory: resolve(root, 'assets'),
        buildPlugins: { vite: [pwaReleaseArtifactPlugin(pwaRelease)] },
        injectionPoint: 'globalThis.__WB_MANIFEST',
        manifestTransforms: [offlineManifestTransform]
      }
    }),
    pwaReleaseArtifactPlugin(pwaRelease),
    tombstoneArtifactPlugin(pwaRelease),
    runtimeAssetsPlugin(command)
  ],
  resolve: {
    alias: {
      '@': resolve(root, 'client'),
      // Server Pug views provide the root component template mounted by client-app.ts.
      vue: 'vue/dist/vue.esm-bundler.js'
    },
    dedupe: ['@codemirror/state', '@codemirror/view', 'katex']
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
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
    __TSEPISTLE_PWA_RELEASE__: JSON.stringify(pwaRelease)
  }
}))
