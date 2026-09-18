import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Knex } from 'knex'
import { z } from 'zod'
import { AgentRepositoryError, getOwnedAgentSession } from './repository.ts'
import { AGENT_PDF_MAX_PAGES, AGENT_PDF_PART_MAX_BYTES, type PreparedAgentPdf } from './pdf-preparation.ts'

export const AGENT_PDF_CACHE_TTL_MS = 6 * 3600_000
const ENTRY_BYTES = 300 * 1024 * 1024
const VERSION = 'pdf-v2-pikepdf9-250m-48m'
const sourceSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  ownerId: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().positive()
})
export type AgentPdfCacheSource = z.infer<typeof sourceSchema>
const manifestSchema = z.object({
  version: z.literal(VERSION),
  source: sourceSchema,
  createdAt: z.number().finite(),
  usedAt: z.number().finite(),
  pageCount: z.number().int().min(1).max(AGENT_PDF_MAX_PAGES),
  parts: z
    .array(
      z.object({
        filename: z.string().regex(/^part-[0-7]\.pdf$/),
        startPage: z.number().int().positive(),
        endPage: z.number().int().positive(),
        byteLength: z.number().int().positive().max(AGENT_PDF_PART_MAX_BYTES),
        sha256: z.string().regex(/^[a-f0-9]{64}$/)
      })
    )
    .min(1)
    .max(8)
})
type Manifest = z.infer<typeof manifestSchema>
type Entry = { key: string; manifest: Manifest; bytes: number; leases: number; retiring: boolean }
const keyFor = (source: AgentPdfCacheSource) =>
  createHash('sha256')
    .update(JSON.stringify([VERSION, source.ownerId, source.sessionId, source.id, source.sha256, source.byteLength]))
    .digest('hex')
const digest = async (path: string): Promise<string> => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
const unavailable = () => new AgentRepositoryError('AGENT_MEDIA_UNAVAILABLE', 'The original attachment is no longer available.', 404)

/** Regenerable private disk cache. Leases protect files until their provider upload completes. */
export class AgentPdfDiskCache {
  readonly root: string
  readonly db: Knex
  readonly globalBytes: number
  readonly ownerBytes: number
  readonly ttlMs: number
  readonly entries = new Map<string, Entry>()
  #loaded = false
  #tail: Promise<unknown> = Promise.resolve()
  #waiting = 0
  constructor(db: Knex, root: string, options: { globalBytes?: number; ownerBytes?: number; ttlMs?: number } = {}) {
    this.db = db
    this.root = root
    this.globalBytes = options.globalBytes ?? 2 * 1024 ** 3
    this.ownerBytes = options.ownerBytes ?? 1024 ** 3
    this.ttlMs = options.ttlMs ?? AGENT_PDF_CACHE_TTL_MS
  }
  async #serial<T>(work: () => Promise<T>): Promise<T> {
    this.#waiting++
    const result = this.#tail.catch(() => {}).then(work)
    this.#tail = result
    try {
      return await result
    } finally {
      this.#waiting--
    }
  }
  async #authorize(source: AgentPdfCacheSource): Promise<void> {
    await getOwnedAgentSession(this.db, source.ownerId, source.sessionId)
    const row = await this.db('agentMedia')
      .where({
        id: source.id,
        ownerId: source.ownerId,
        sessionId: source.sessionId,
        mimeType: 'application/pdf',
        sha256: source.sha256,
        byteLength: source.byteLength
      })
      .first('expiresAt')
    if (!row || (row.expiresAt !== null && new Date(row.expiresAt).valueOf() <= Date.now())) throw unavailable()
  }
  async #remove(entry: Entry): Promise<void> {
    entry.retiring = true
    if (entry.leases) return
    await rm(join(this.root, entry.key), { recursive: true, force: true })
    this.entries.delete(entry.key)
  }
  async #validFiles(entry: Entry): Promise<boolean> {
    try {
      let nextPage = 1
      for (const part of entry.manifest.parts) {
        if (part.startPage !== nextPage || part.endPage < nextPage || part.endPage > entry.manifest.pageCount) return false
        const path = join(this.root, entry.key, part.filename)
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink() || info.size !== part.byteLength || (info.mode & 0o777) !== 0o600 || (await digest(path)) !== part.sha256)
          return false
        nextPage = part.endPage + 1
      }
      return nextPage === entry.manifest.pageCount + 1 && entry.bytes <= ENTRY_BYTES
    } catch {
      return false
    }
  }
  async #load(): Promise<void> {
    if (this.#loaded) return
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const info = await lstat(this.root)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid private PDF cache directory')
    await chmod(this.root, 0o700)
    for (const name of await readdir(this.root)) {
      const path = join(this.root, name)
      try {
        if (!/^[a-f0-9]{64}$/.test(name)) {
          await rm(path, { recursive: true, force: true })
          continue
        }
        const directory = await lstat(path)
        const manifestInfo = await lstat(join(path, 'manifest.json'))
        if (
          !directory.isDirectory() ||
          directory.isSymbolicLink() ||
          (directory.mode & 0o777) !== 0o700 ||
          (manifestInfo.mode & 0o777) !== 0o600 ||
          !manifestInfo.isFile() ||
          manifestInfo.isSymbolicLink() ||
          manifestInfo.size > 16_384
        )
          throw new Error('Invalid cache manifest')
        const manifest = manifestSchema.parse(JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')))
        const entry: Entry = { key: name, manifest, bytes: manifest.parts.reduce((sum, part) => sum + part.byteLength, 0), leases: 0, retiring: false }
        if (keyFor(manifest.source) !== name || manifest.createdAt > Date.now() || manifest.createdAt + this.ttlMs <= Date.now())
          throw new Error('Expired cache')
        await this.#authorize(manifest.source)
        if (!(await this.#validFiles(entry))) throw new Error('Corrupt cache')
        this.entries.set(name, entry)
      } catch {
        await rm(path, { recursive: true, force: true })
      }
    }
    this.#loaded = true
  }
  async #sweep(): Promise<void> {
    for (const entry of this.entries.values()) {
      let valid = !entry.retiring && entry.manifest.createdAt + this.ttlMs > Date.now()
      if (valid) {
        try {
          await this.#authorize(entry.manifest.source)
        } catch {
          valid = false
        }
      }
      if (!valid) await this.#remove(entry)
    }
  }
  async sweep(filter?: { sessionId?: string; mediaId?: string }): Promise<void> {
    return this.#serial(async () => {
      await this.#load()
      for (const entry of this.entries.values()) {
        if (
          filter &&
          ((filter.sessionId && entry.manifest.source.sessionId === filter.sessionId) || (filter.mediaId && entry.manifest.source.id === filter.mediaId))
        )
          await this.#remove(entry)
      }
      await this.#sweep()
    })
  }
  async acquire(source: AgentPdfCacheSource, signal: AbortSignal, build: () => Promise<PreparedAgentPdf>): Promise<PreparedAgentPdf> {
    if (this.#waiting >= 8) throw new AgentRepositoryError('PDF_PREPARATION_BUSY', 'PDF preparation is busy. Try again shortly.', 503)
    return this.#serial(async () => {
      signal.throwIfAborted()
      source = sourceSchema.parse(source)
      await this.#load()
      await this.#sweep()
      await this.#authorize(source)
      const key = keyFor(source)
      let entry = this.entries.get(key)
      if (entry && !(await this.#validFiles(entry))) {
        await this.#remove(entry)
        if (entry.leases) throw new AgentRepositoryError('PDF_PREPARATION_BUSY', 'This prepared PDF is being replaced. Try again shortly.', 503)
        entry = undefined
      }
      if (entry?.retiring) throw unavailable()
      if (!entry) {
        const usage = () => ({
          total: [...this.entries.values()].reduce((sum, item) => sum + item.bytes, 0),
          owner: [...this.entries.values()].filter(item => item.manifest.source.ownerId === source.ownerId).reduce((sum, item) => sum + item.bytes, 0)
        })
        for (const candidate of [...this.entries.values()].sort((a, b) => a.manifest.usedAt - b.manifest.usedAt)) {
          const bytes = usage()
          if (bytes.total + ENTRY_BYTES <= this.globalBytes && bytes.owner + ENTRY_BYTES <= this.ownerBytes) break
          if (!candidate.leases && (bytes.total + ENTRY_BYTES > this.globalBytes || candidate.manifest.source.ownerId === source.ownerId))
            await this.#remove(candidate)
        }
        const bytes = usage()
        if (bytes.total + ENTRY_BYTES > this.globalBytes || bytes.owner + ENTRY_BYTES > this.ownerBytes)
          throw new AgentRepositoryError('PDF_PREPARATION_BUSY', 'Prepared document storage is busy. Try again after another request finishes.', 503)
        signal.throwIfAborted()
        const prepared = await build()
        const pending = join(this.root, `${key}.pending`)
        try {
          await rm(pending, { recursive: true, force: true })
          await mkdir(pending, { mode: 0o700 })
          const parts: Manifest['parts'] = []
          for (const [index, part] of prepared.parts.entries()) {
            signal.throwIfAborted()
            const filename = `part-${index}.pdf`
            await copyFile(part.path, join(pending, filename))
            await chmod(join(pending, filename), 0o600)
            parts.push({
              filename,
              startPage: part.startPage,
              endPage: part.endPage,
              byteLength: part.byteLength,
              sha256: await digest(join(pending, filename))
            })
          }
          const manifest = manifestSchema.parse({ version: VERSION, source, createdAt: Date.now(), usedAt: Date.now(), pageCount: prepared.pageCount, parts })
          await this.#authorize(source)
          signal.throwIfAborted()
          await writeFile(join(pending, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600, flag: 'wx' })
          await rename(pending, join(this.root, key))
          entry = { key, manifest, bytes: parts.reduce((sum, part) => sum + part.byteLength, 0), leases: 0, retiring: false }
          if (!(await this.#validFiles(entry))) {
            await rm(join(this.root, key), { recursive: true, force: true })
            throw new Error('Invalid prepared PDF cache')
          }
          this.entries.set(key, entry)
        } finally {
          await prepared.cleanup()
          await rm(pending, { recursive: true, force: true })
        }
      }
      signal.throwIfAborted()
      entry.leases++
      entry.manifest.usedAt = Date.now()
      const leased = entry
      let released = false
      return {
        pageCount: leased.manifest.pageCount,
        parts: leased.manifest.parts.map(part => ({ ...part, path: join(this.root, leased.key, part.filename) })),
        cleanup: async () => {
          if (released) return
          released = true
          await this.#serial(async () => {
            leased.leases--
            if (leased.retiring || leased.manifest.createdAt + this.ttlMs <= Date.now()) await this.#remove(leased)
          })
        }
      }
    })
  }
}
const caches = new WeakMap<Knex, AgentPdfDiskCache>()
const cacheFor = (db: Knex): AgentPdfDiskCache => {
  let cache = caches.get(db)
  if (!cache) {
    const wiki = Reflect.get(globalThis, 'WIKI') as { ROOTPATH?: string; config?: { dataPath?: string } } | undefined
    cache = new AgentPdfDiskCache(
      db,
      wiki?.ROOTPATH
        ? resolve(wiki.ROOTPATH, wiki.config?.dataPath ?? 'data', 'cache', 'agent-pdf')
        : join(tmpdir(), `wiki-agent-cache-${process.pid}`, randomUUID())
    )
    caches.set(db, cache)
  }
  return cache
}
export const getCachedAgentPdf = (
  db: Knex,
  source: AgentPdfCacheSource,
  signal: AbortSignal,
  build: () => Promise<PreparedAgentPdf>
): Promise<PreparedAgentPdf> => cacheFor(db).acquire(source, signal, build)
export const sweepAgentPdfCache = (db: Knex, filter?: { sessionId?: string; mediaId?: string }): Promise<void> => cacheFor(db).sweep(filter)
