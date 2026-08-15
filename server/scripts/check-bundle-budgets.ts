import { readdir, readFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import path from 'node:path'

interface ManifestChunk {
  css?: string[]
  file: string
  imports?: string[]
  isEntry?: boolean
}

type Manifest = Record<string, ManifestChunk>
interface Measurement {
  gzipBytes: number
  rawBytes: number
}
interface Budget {
  actual: number
  limit: number
  name: string
}

const KiB = 1024
const assetsDirectory = path.resolve('assets')
const manifest = JSON.parse(
  await readFile(path.join(assetsDirectory, '.vite', 'manifest.json'), 'utf8')
) as Manifest
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
  for (const relativePath of relativePaths) {
    const measurement = await measureFile(relativePath)
    rawBytes += measurement.rawBytes
    gzipBytes += measurement.gzipBytes
  }
  return { rawBytes, gzipBytes }
}

function collectInitialFiles(entryName: string) {
  const scripts = new Set<string>()
  const styles = new Set<string>()
  const visited = new Set<string>()

  function collect(chunkName: string) {
    if (visited.has(chunkName)) return
    visited.add(chunkName)
    const chunk = manifest[chunkName]
    if (!chunk) throw new Error(`Missing Vite manifest chunk: ${chunkName}`)
    scripts.add(chunk.file)
    for (const stylesheet of chunk.css ?? []) styles.add(stylesheet)
    for (const importedChunk of chunk.imports ?? []) collect(importedChunk)
  }

  collect(entryName)
  return { scripts, styles }
}

const appFiles = collectInitialFiles('client/index-app.ts')
const setupFiles = collectInitialFiles('client/index-setup.ts')
const [appScripts, appStyles, setupScripts, setupStyles] = await Promise.all([
  measureFiles(appFiles.scripts),
  measureFiles(appFiles.styles),
  measureFiles(setupFiles.scripts),
  measureFiles(setupFiles.styles)
])
const javascriptFiles = (await readdir(path.join(assetsDirectory, 'js')))
  .filter(file => file.endsWith('.js'))
  .map(file => `js/${file}`)
const allJavascript = await measureFiles(javascriptFiles)
let largestJavascriptChunk = 0
for (const file of javascriptFiles) {
  const measurement = await measureFile(file)
  largestJavascriptChunk = Math.max(largestJavascriptChunk, measurement.rawBytes)
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
  { name: 'all JavaScript chunks (raw)', actual: allJavascript.rawBytes, limit: 12 * 1_024 * KiB }
]

const failures: string[] = []
for (const budget of budgets) {
  const status = budget.actual <= budget.limit ? 'PASS' : 'FAIL'
  console.log(`${status} ${budget.name}: ${(budget.actual / KiB).toFixed(1)} KiB / ${(budget.limit / KiB).toFixed(1)} KiB`)
  if (status === 'FAIL') failures.push(budget.name)
}
if (failures.length > 0) {
  throw new Error(`Production bundle budgets exceeded: ${failures.join(', ')}`)
}
