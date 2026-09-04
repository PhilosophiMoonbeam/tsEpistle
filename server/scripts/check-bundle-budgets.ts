import { readdir, readFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import path from 'node:path'

export interface ManifestChunk {
  assets?: string[]
  css?: string[]
  dynamicImports?: string[]
  file: string
  imports?: string[]
  isEntry?: boolean
  name?: string
  src?: string
}

export type Manifest = Record<string, ManifestChunk>
export interface Measurement {
  gzipBytes: number
  rawBytes: number
}
export interface ManifestFiles {
  assets: Set<string>
  scripts: Set<string>
  styles: Set<string>
}
export interface Budget {
  actual: number
  limit: number
  name: string
}
export interface LoginBundleGraph {
  initialChunks: Set<string>
  initialFiles: ManifestFiles
  loginKey: string
  sceneKey: string
  sceneOnlyChunks: Set<string>
  sceneOnlyFiles: ManifestFiles
}
export interface LoginBundleMeasurements {
  directJavascript: Measurement
  directStyles: Measurement
  initialForbiddenFiles: string[]
  lazyScene: Measurement
}

const KiB = 1024
const APP_SOURCE = 'client/index-app.ts'
const LOGIN_SOURCE = 'client/components/login.vue'
const LOGO_PARTICLE_SCENE_SOURCE = 'client/components/login-logo/LogoParticleScene.vue'

/**
 * Clean commit 16fa062, production Vite output. Raw bytes were recorded
 * alongside reproducible `gzip -9 -n` measurements so the gzip deltas have
 * an auditable, timestamp-free provenance.
 */
export const LOGIN_DIRECT_BASELINE = {
  commit: '16fa062',
  command: 'gzip -9 -n',
  javascript: { rawBytes: 25_911, gzipBytes: 5_878 },
  styles: { rawBytes: 9_822, gzipBytes: 2_019 }
} as const

const LOGIN_JAVASCRIPT_GZIP_DELTA_LIMIT = 5 * KiB
const LOGIN_CSS_GZIP_DELTA_LIMIT = 2 * KiB
const LOGO_SCENE_RAW_LIMIT = 950 * KiB
const LOGO_SCENE_GZIP_LIMIT = 260 * KiB

export function findManifestKey(manifest: Manifest, source: string): string {
  if (manifest[source]) return source
  const matches = Object.entries(manifest)
    .filter(([, chunk]) => chunk.src === source)
    .map(([key]) => key)
  if (matches.length !== 1) {
    throw new Error(matches.length === 0 ? `Missing Vite manifest source: ${source}` : `Ambiguous Vite manifest source ${source}: ${matches.join(', ')}`)
  }
  return matches[0]!
}

export function collectManifestClosure(manifest: Manifest, entryKeys: readonly string[], includeDynamicImports = false): Set<string> {
  const visited = new Set<string>()

  function collect(chunkKey: string): void {
    if (visited.has(chunkKey)) return
    const chunk = manifest[chunkKey]
    if (!chunk) throw new Error(`Missing Vite manifest chunk: ${chunkKey}`)
    visited.add(chunkKey)
    for (const importedChunk of chunk.imports ?? []) collect(importedChunk)
    if (includeDynamicImports) {
      for (const importedChunk of chunk.dynamicImports ?? []) collect(importedChunk)
    }
  }

  for (const entryKey of entryKeys) collect(entryKey)
  return visited
}

function addManifestFile(files: ManifestFiles, relativePath: string): void {
  if (/\.css(?:$|\?)/i.test(relativePath)) files.styles.add(relativePath)
  else if (/\.[cm]?js(?:$|\?)/i.test(relativePath)) files.scripts.add(relativePath)
  else files.assets.add(relativePath)
}

export function collectManifestFiles(manifest: Manifest, chunkKeys: Iterable<string>): ManifestFiles {
  const files: ManifestFiles = {
    assets: new Set<string>(),
    scripts: new Set<string>(),
    styles: new Set<string>()
  }
  for (const chunkKey of chunkKeys) {
    const chunk = manifest[chunkKey]
    if (!chunk) throw new Error(`Missing Vite manifest chunk: ${chunkKey}`)
    addManifestFile(files, chunk.file)
    for (const stylesheet of chunk.css ?? []) addManifestFile(files, stylesheet)
    for (const asset of chunk.assets ?? []) addManifestFile(files, asset)
  }
  return files
}

export function subtractManifestFiles(files: ManifestFiles, excluded: ManifestFiles): ManifestFiles {
  return {
    assets: new Set([...files.assets].filter(file => !excluded.assets.has(file))),
    scripts: new Set([...files.scripts].filter(file => !excluded.scripts.has(file))),
    styles: new Set([...files.styles].filter(file => !excluded.styles.has(file)))
  }
}

function allManifestFiles(files: ManifestFiles): Set<string> {
  return new Set([...files.scripts, ...files.styles, ...files.assets])
}

export function buildLoginBundleGraph(manifest: Manifest): LoginBundleGraph {
  const appKey = findManifestKey(manifest, APP_SOURCE)
  const loginKey = findManifestKey(manifest, LOGIN_SOURCE)
  const sceneKey = findManifestKey(manifest, LOGO_PARTICLE_SCENE_SOURCE)
  // Both roots are fetched before the login UI is usable. Dynamic edges are
  // intentionally excluded; the scene is an enhancement, never initial work.
  const initialChunks = collectManifestClosure(manifest, [appKey, loginKey])
  const sceneChunks = collectManifestClosure(manifest, [sceneKey], true)
  const sceneOnlyChunks = new Set([...sceneChunks].filter(chunkKey => !initialChunks.has(chunkKey)))
  const initialFiles = collectManifestFiles(manifest, initialChunks)
  // Subtract by emitted filename too: different manifest keys may alias a
  // shared hashed chunk or stylesheet.
  const sceneOnlyFiles = subtractManifestFiles(collectManifestFiles(manifest, sceneOnlyChunks), initialFiles)
  return { initialChunks, initialFiles, loginKey, sceneKey, sceneOnlyChunks, sceneOnlyFiles }
}

const FORBIDDEN_INITIAL_CHUNK_PATTERN = /LogoParticleScene|(?:^|[/_.@-])tres(?:js)?(?:[/_.@-]|$)|(?:^|[/_.@-])three(?:[/_.@-]|$)|shader/i

export function findForbiddenLoginInitialFiles(manifest: Manifest, initialChunks: Iterable<string>, initialFiles: ManifestFiles): string[] {
  const violations = new Set<string>()
  for (const chunkKey of initialChunks) {
    const chunk = manifest[chunkKey]
    if (!chunk) throw new Error(`Missing Vite manifest chunk: ${chunkKey}`)
    const identity = [chunkKey, chunk.src, chunk.name, chunk.file].filter(Boolean).join('\n')
    if (FORBIDDEN_INITIAL_CHUNK_PATTERN.test(identity)) violations.add(chunk.file)
  }
  for (const asset of initialFiles.assets) {
    if (/particle/i.test(asset) || FORBIDDEN_INITIAL_CHUNK_PATTERN.test(asset)) violations.add(asset)
  }
  return [...violations].sort()
}

export function buildLoginBundleBudgets(measurements: LoginBundleMeasurements): Budget[] {
  return [
    {
      name: 'login direct JavaScript delta from 16fa062 (gzip)',
      actual: measurements.directJavascript.gzipBytes,
      limit: LOGIN_DIRECT_BASELINE.javascript.gzipBytes + LOGIN_JAVASCRIPT_GZIP_DELTA_LIMIT
    },
    {
      name: 'login direct CSS delta from 16fa062 (gzip)',
      actual: measurements.directStyles.gzipBytes,
      limit: LOGIN_DIRECT_BASELINE.styles.gzipBytes + LOGIN_CSS_GZIP_DELTA_LIMIT
    },
    {
      name: 'login initial scene/Tres/Three/shader/particle assets',
      actual: measurements.initialForbiddenFiles.length,
      limit: 0
    },
    {
      name: 'lazy login particle scene reachable-only closure (raw)',
      actual: measurements.lazyScene.rawBytes,
      limit: LOGO_SCENE_RAW_LIMIT
    },
    {
      name: 'lazy login particle scene reachable-only closure (gzip)',
      actual: measurements.lazyScene.gzipBytes,
      limit: LOGO_SCENE_GZIP_LIMIT
    }
  ]
}

export function findBudgetFailures(budgets: readonly Budget[]): string[] {
  return budgets.filter(budget => budget.actual > budget.limit).map(budget => budget.name)
}

export async function checkBundleBudgets(assetsDirectory = path.resolve('assets')): Promise<void> {
  const manifest = JSON.parse(await readFile(path.join(assetsDirectory, '.vite', 'manifest.json'), 'utf8')) as Manifest
  const measurementCache = new Map<string, Measurement>()

  async function measureFile(relativePath: string): Promise<Measurement> {
    const cached = measurementCache.get(relativePath)
    if (cached) return cached
    const contents = await readFile(path.join(assetsDirectory, relativePath))
    const measurement = {
      rawBytes: contents.byteLength,
      gzipBytes: gzipSync(contents, { level: 9 }).byteLength
    }
    measurementCache.set(relativePath, measurement)
    return measurement
  }

  async function measureFiles(relativePaths: Iterable<string>): Promise<Measurement> {
    let rawBytes = 0
    let gzipBytes = 0
    for (const relativePath of new Set(relativePaths)) {
      const measurement = await measureFile(relativePath)
      rawBytes += measurement.rawBytes
      gzipBytes += measurement.gzipBytes
    }
    return { rawBytes, gzipBytes }
  }

  async function measureManifestFiles(files: ManifestFiles): Promise<Measurement> {
    return await measureFiles(allManifestFiles(files))
  }

  const appKey = findManifestKey(manifest, APP_SOURCE)
  const setupKey = findManifestKey(manifest, 'client/index-setup.ts')
  const appFiles = collectManifestFiles(manifest, collectManifestClosure(manifest, [appKey]))
  const setupFiles = collectManifestFiles(manifest, collectManifestClosure(manifest, [setupKey]))
  const graph = buildLoginBundleGraph(manifest)
  const directLoginFiles = collectManifestFiles(manifest, [graph.loginKey])
  const [appScripts, appStyles, setupScripts, setupStyles, directJavascript, directStyles, loginInitial, lazyScene] = await Promise.all([
    measureFiles(appFiles.scripts),
    measureFiles(appFiles.styles),
    measureFiles(setupFiles.scripts),
    measureFiles(setupFiles.styles),
    measureFiles(directLoginFiles.scripts),
    measureFiles(directLoginFiles.styles),
    measureManifestFiles(graph.initialFiles),
    measureManifestFiles(graph.sceneOnlyFiles)
  ])
  const initialForbiddenFiles = findForbiddenLoginInitialFiles(manifest, graph.initialChunks, graph.initialFiles)
  const javascriptFiles = (await readdir(path.join(assetsDirectory, 'js'))).filter(file => file.endsWith('.js')).map(file => `js/${file}`)
  const allJavascript = await measureFiles(javascriptFiles)
  let largestJavascriptChunk = 0
  for (const file of javascriptFiles) {
    const measurement = await measureFile(file)
    largestJavascriptChunk = Math.max(largestJavascriptChunk, measurement.rawBytes)
  }

  console.log(
    `MEASURE login direct JavaScript: ${directJavascript.rawBytes} raw bytes, ${directJavascript.gzipBytes} gzip-9-n bytes ` +
      `(16fa062 baseline: ${LOGIN_DIRECT_BASELINE.javascript.rawBytes} raw, ${LOGIN_DIRECT_BASELINE.javascript.gzipBytes} gzip)`
  )
  console.log(
    `MEASURE login direct CSS: ${directStyles.rawBytes} raw bytes, ${directStyles.gzipBytes} gzip-9-n bytes ` +
      `(16fa062 baseline: ${LOGIN_DIRECT_BASELINE.styles.rawBytes} raw, ${LOGIN_DIRECT_BASELINE.styles.gzipBytes} gzip)`
  )
  console.log(
    `MEASURE login initial closure: ${graph.initialChunks.size} chunks, ${allManifestFiles(graph.initialFiles).size} files, ` +
      `${loginInitial.rawBytes} raw bytes, ${loginInitial.gzipBytes} gzip-9-n bytes`
  )
  console.log(
    `MEASURE lazy login particle scene reachable-only closure: ${graph.sceneOnlyChunks.size} chunks, ` +
      `${allManifestFiles(graph.sceneOnlyFiles).size} files, ${lazyScene.rawBytes} raw bytes, ${lazyScene.gzipBytes} gzip-9-n bytes`
  )
  if (initialForbiddenFiles.length > 0) {
    console.log(`MEASURE forbidden login initial files: ${initialForbiddenFiles.join(', ')}`)
  }

  const budgets: Budget[] = [
    { name: 'application initial JavaScript (raw)', actual: appScripts.rawBytes, limit: 2_000 * KiB },
    { name: 'application initial JavaScript (gzip)', actual: appScripts.gzipBytes, limit: 480 * KiB },
    { name: 'application initial CSS (raw)', actual: appStyles.rawBytes, limit: 1_024 * KiB },
    { name: 'application initial CSS (gzip)', actual: appStyles.gzipBytes, limit: 175 * KiB },
    { name: 'setup initial JavaScript (raw)', actual: setupScripts.rawBytes, limit: 900 * KiB },
    { name: 'setup initial JavaScript (gzip)', actual: setupScripts.gzipBytes, limit: 340 * KiB },
    { name: 'setup initial CSS (raw)', actual: setupStyles.rawBytes, limit: 1_000 * KiB },
    { name: 'setup initial CSS (gzip)', actual: setupStyles.gzipBytes, limit: 170 * KiB },
    { name: 'largest JavaScript chunk (raw)', actual: largestJavascriptChunk, limit: 1_400 * KiB },
    { name: 'all JavaScript chunks (raw)', actual: allJavascript.rawBytes, limit: 12 * 1_024 * KiB },
    ...buildLoginBundleBudgets({
      directJavascript,
      directStyles,
      initialForbiddenFiles,
      lazyScene
    })
  ]

  for (const budget of budgets) {
    const status = budget.actual <= budget.limit ? 'PASS' : 'FAIL'
    const unit = budget.name.endsWith('assets') ? ' files' : ' KiB'
    const actual = unit === ' files' ? String(budget.actual) : (budget.actual / KiB).toFixed(1)
    const limit = unit === ' files' ? String(budget.limit) : (budget.limit / KiB).toFixed(1)
    console.log(`${status} ${budget.name}: ${actual}${unit} / ${limit}${unit}`)
  }
  const failures = findBudgetFailures(budgets)
  if (failures.length > 0) {
    throw new Error(`Production bundle budgets exceeded: ${failures.join(', ')}`)
  }
}

if (import.meta.main) await checkBundleBudgets()
