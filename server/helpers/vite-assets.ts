import fs from 'node:fs'
import { cp, mkdir } from 'node:fs/promises'
import path from 'node:path'

type Manifest = Record<string, unknown>
interface ManifestChunk extends Record<string, unknown> {
  file?: unknown
  isEntry?: unknown
}
interface CollectEntryOptions {
  dev?: boolean
  origin?: string
}
interface CollectedEntry {
  client: string | null
  css: string[]
  file: string
  preloads: string[]
}
const manifestPath = path.join(process.cwd(), 'assets/.vite/manifest.json')
let cachedManifest: Manifest | null = null
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
export const copyPrismAssets = async (root: string): Promise<void> => {
  const output = path.resolve(root, 'assets/js/prism')
  await mkdir(output, { recursive: true })
  await cp(path.resolve(root, 'node_modules/prismjs/components'), output, { recursive: true })
}

export const provisionDevelopmentAssets = async (root: string): Promise<void> => {
  const output = path.resolve(root, 'assets')
  await mkdir(output, { recursive: true })
  await cp(path.resolve(root, 'client/static'), output, { recursive: true })
  await copyPrismAssets(root)
}

const loadManifest = (): Manifest => {
  if (!cachedManifest) {
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    if (!isObject(parsed) || Array.isArray(parsed)) throw new Error('Vite asset manifest is invalid.')
    cachedManifest = parsed
  }
  return cachedManifest
}
const collectEntry = (source: string, { dev = false, origin = 'http://127.0.0.1:5173' }: CollectEntryOptions = {}): CollectedEntry => {
  if (dev) {
    const viteOrigin = new URL(origin).origin
    return { client: viteOrigin + '/@vite/client', css: [], file: viteOrigin + '/' + source, preloads: [] }
  }
  const manifest = loadManifest()
  const entry = manifest[source] as ManifestChunk | undefined
  if (!entry || !entry.isEntry || typeof entry.file !== 'string') throw new Error('Vite asset manifest is missing entry ' + source + '.')
  const css = new Set<string>()
  const preloads = new Set<string>()
  const visited = new Set<string>()
  const visit = (key: string): void => {
    if (visited.has(key)) return
    visited.add(key)
    const chunk = manifest[key]
    if (!isObject(chunk)) return
    if (Array.isArray(chunk.css)) for (const file of chunk.css) if (typeof file === 'string') css.add('/_assets/' + file)
    if (Array.isArray(chunk.imports))
      for (const importedKey of chunk.imports) {
        if (typeof importedKey !== 'string') continue
        const imported = manifest[importedKey]
        if (isObject(imported) && typeof imported.file === 'string') preloads.add('/_assets/' + imported.file)
        visit(importedKey)
      }
  }
  visit(source)
  return { client: null, css: [...css], file: '/_assets/' + entry.file, preloads: [...preloads] }
}

export default { collectEntry }
