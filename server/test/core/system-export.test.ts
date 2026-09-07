import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import zlib from 'node:zlib'

import fsExtra from 'fs-extra'

import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

interface ExportSystem {
  exportStatus: {
    status: 'notrunning' | 'running' | 'success' | 'error'
    progress: number
    message: string
  }
  export(options: { path: string; entities: string[] }): Promise<void>
}

type Row = Record<string, unknown>
type FetchBatch = (offset: number, eagerMode?: 'fetched' | 'joined') => Promise<Row[]>
type AssetRow = { filename: string; data: Buffer }

const temporaryDirectories: string[] = []

const createQueryModel = (total: number, fetchBatch: FetchBatch) => ({
  query() {
    let offset = 0
    let eagerMode: 'fetched' | 'joined' | undefined
    const builder = {
      count: () => builder,
      first: async () => ({ total }),
      where: () => builder,
      orderBy: () => builder,
      offset: (value: number) => {
        offset = value
        return builder
      },
      limit: () => builder,
      withGraphJoined: () => {
        eagerMode = 'joined'
        return builder
      },
      withGraphFetched: () => {
        eagerMode = 'fetched'
        return builder
      },
      modifyGraph: (_name: string, callback: (selection: { select(...columns: string[]): void }) => void) => {
        callback({ select: () => undefined })
        return builder
      },
      then: <Result, Failure = never>(resolve: (rows: Row[]) => Result | PromiseLike<Result>, reject?: (reason: unknown) => Failure | PromiseLike<Failure>) =>
        fetchBatch(offset, eagerMode).then(resolve, reject)
    }
    return builder
  }
})

const createRelationPagedModel = (rows: Row[], relation: string) => ({
  query() {
    let offset = 0
    let limit = 0
    let publicOnly = false
    let eagerMode: 'fetched' | 'joined' = 'joined'
    const matchingRows = (): Row[] => (publicOnly ? rows.filter(row => row.visibility === 'public') : rows)
    const builder = {
      count: () => builder,
      first: async () => ({ total: matchingRows().length }),
      where: (column: string, value: unknown) => {
        publicOnly ||= column === 'visibility' && value === 'public'
        return builder
      },
      orderBy: () => builder,
      offset: (value: number) => {
        offset = value
        return builder
      },
      limit: (value: number) => {
        limit = value
        return builder
      },
      withGraphJoined: () => {
        eagerMode = 'joined'
        return builder
      },
      withGraphFetched: () => {
        eagerMode = 'fetched'
        return builder
      },
      modifyGraph: () => builder,
      then: <Result, Failure = never>(
        resolve: (batch: Row[]) => Result | PromiseLike<Result>,
        reject?: (reason: unknown) => Failure | PromiseLike<Failure>
      ) => {
        const parents = matchingRows()
        const flat =
          eagerMode === 'joined'
            ? parents.flatMap(parent => {
                const children = parent[relation]
                return Array.isArray(children) && children.length > 0 ? children.map(child => ({ ...parent, [relation]: [child] })) : [parent]
              })
            : parents
        return Promise.resolve(flat.slice(offset, offset + limit)).then(resolve, reject)
      }
    }
    return builder
  }
})

class GatedWritable extends Writable {
  private releaseFirstWrite: (() => void) | undefined
  private firstWriteBlocked = false
  private readonly firstWriteSignal = Promise.withResolvers<void>()
  readonly firstWrite = this.firstWriteSignal.promise

  constructor(private readonly destination: Writable) {
    super()
  }

  override _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const write = (): void => {
      this.destination.write(chunk, encoding, callback)
    }
    if (!this.firstWriteBlocked) {
      this.firstWriteBlocked = true
      this.releaseFirstWrite = write
      this.firstWriteSignal.resolve()
      return
    }
    write()
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.destination.end(callback)
  }

  release(): void {
    this.releaseFirstWrite?.()
    this.releaseFirstWrite = undefined
  }
}

let system: ExportSystem
let wiki: Record<string, unknown>

beforeEach(async () => {
  wiki = {
    ROOTPATH: process.cwd(),
    config: { dataPath: 'data' },
    logger: { info: () => undefined, warn: () => undefined },
    models: {}
  }
  vi.stubGlobal('WIKI', wiki)
  system = (await vi.importFresh<{ default: ExportSystem }>('../../core/system.ts', import.meta.url)).default
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true })
})

const createExportDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-system-export-'))
  temporaryDirectories.push(directory)
  return directory
}

const setModels = (models: Record<string, unknown>): void => {
  Reflect.set(wiki, 'models', models)
}

const readGzipJson = (file: string): unknown => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'))

describe('system export pipelines', () => {
  it('settles the export as an error when a later query batch fails', async () => {
    const offsets: number[] = []
    setModels({
      comments: createQueryModel(51, async offset => {
        offsets.push(offset)
        if (offset === 0) return Array.from({ length: 50 }, (_, id) => ({ id }))
        throw new Error('second batch failed')
      })
    })

    await system.export({ path: createExportDirectory(), entities: ['comments'] })

    expect(offsets).toEqual([0, 50])
    expect(system.exportStatus).toMatchObject({ status: 'error', message: 'second batch failed' })
  })

  it('settles the export as an error when an asset output file fails', async () => {
    const exportDirectory = createExportDirectory()
    fs.writeFileSync(path.join(exportDirectory, 'assets'), 'not a directory')
    setModels({
      assetFolders: { getAllPaths: async () => ({}) },
      assets: createQueryModel(1, async () => []),
      knex: {
        select: () => ({
          from: () => ({
            join: () => ({
              stream: () => Readable.from([{ filename: 'logo.png', data: Buffer.from('logo') }])
            })
          })
        })
      }
    })

    await system.export({ path: exportDirectory, entities: ['assets'] })
    expect(system.exportStatus.status).toBe('error')
    expect(system.exportStatus.message).toContain('assets')
  })

  it('does not fetch the next batch while the output pipeline is backpressured', async () => {
    const offsets: number[] = []
    const firstWrite = Promise.withResolvers<void>()
    let destination: GatedWritable | undefined
    vi.spyOn(fsExtra, 'createWriteStream').mockImplementation((file, options) => {
      destination = new GatedWritable(fs.createWriteStream(file, options))
      void destination.firstWrite.then(firstWrite.resolve)
      return destination as never
    })
    const publicPage = { id: 1, visibility: 'public', path: 'backpressure', localeCode: 'en', title: 'Backpressure' }
    const rows = Array.from({ length: 50 }, (_, id) => ({
      id,
      pageId: publicPage.id,
      content: randomBytes(64 * 1024).toString('base64'),
      page: publicPage
    }))
    setModels({
      comments: createQueryModel(50, async offset => {
        offsets.push(offset)
        return offset === 0 ? rows : []
      })
    })

    const exportPromise = system.export({ path: createExportDirectory(), entities: ['comments'] })
    await firstWrite.promise
    try {
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
      expect(offsets).toEqual([0])
    } finally {
      destination?.release()
    }
    await exportPromise
    expect(offsets).toEqual([0, 50])
    expect(system.exportStatus.status).toBe('success')
  })

  it('projects production-shaped settings and users without credentials or authentication secrets', async () => {
    const secrets = {
      session: 'session-secret-value',
      certificate: 'private-signing-key',
      database: 'database-password',
      provider: 'oidc-client-secret',
      storage: 'storage-access-key',
      api: 'signed-api-bearer'
    }
    Reflect.set(wiki, 'config', {
      dataPath: 'data',
      title: 'Portable wiki',
      company: 'Example',
      sessionSecret: secrets.session,
      certs: { private: secrets.certificate },
      db: { user: 'wiki', pass: secrets.database },
      mail: { pass: secrets.provider },
      auth: { audience: 'urn:wiki.js' },
      telemetry: { clientId: 'telemetry-id', isEnabled: true },
      lang: { code: 'en' },
      theming: { theme: 'default' }
    })
    const query = (rows: Row[]) => createQueryModel(rows.length, async offset => (offset === 0 ? rows : []))
    setModels({
      apiKeys: query([{ name: 'Automation', key: secrets.api, expiration: 'P30D', isRevoked: false, validUntil: '2027-01-01' }]),
      analytics: query([{ key: 'plausible', isEnabled: true, config: { apiKey: secrets.provider } }]),
      authentication: query([
        {
          key: 'oidc',
          isEnabled: true,
          config: { clientSecret: secrets.provider },
          strategyKey: 'oidc',
          displayName: 'OIDC',
          domainWhitelist: { v: ['example.com'] },
          autoEnrollGroups: { v: [1] }
        }
      ]),
      commentProviders: query([{ key: 'default', isEnabled: true, config: { token: secrets.provider } }]),
      renderers: query([{ key: 'markdown', isEnabled: true, config: { token: secrets.provider } }]),
      searchEngines: query([{ key: 'postgres', isEnabled: true, config: { password: secrets.provider } }]),
      storage: query([{ key: 's3', isEnabled: true, config: { accessKey: secrets.storage }, mode: 'push', syncInterval: 'P1D' }]),
      users: query([
        {
          id: 7,
          name: 'Ada',
          email: 'ada@example.test',
          password: '$2b$12$password-hash',
          tfaSecret: 'totp-secret',
          authVersion: 4,
          providerKey: 'oidc',
          groups: [{ id: 1, name: 'Administrators' }],
          provider: { key: 'oidc', strategyKey: 'oidc', displayName: 'OIDC' }
        }
      ])
    })

    const directory = createExportDirectory()
    await system.export({ path: directory, entities: ['settings', 'users'] })
    const settingsOutput = JSON.parse(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8'))
    expect(settingsOutput).toMatchObject({
      format: 'portable-settings-v1',
      modules: { storage: [{ key: 's3', isEnabled: true, mode: 'push', syncInterval: 'P1D' }] },
      apiKeys: [{ name: 'Automation', expiration: 'P30D', isRevoked: false, validUntil: '2027-01-01' }]
    })
    expect(settingsOutput.apiKeys[0]).not.toHaveProperty('key')
    const output = `${fs.readFileSync(path.join(directory, 'settings.json'), 'utf8')}${JSON.stringify(readGzipJson(path.join(directory, 'users.json.gz')))}`
    for (const secret of Object.values(secrets)) expect(output).not.toContain(secret)
    expect(output).not.toContain('password-hash')
    expect(output).not.toContain('totp-secret')
  })

  it('pages public parent records before fetching every many-valued export relation', async () => {
    const publicIds = [1, 2, 4, 5, 6, 7, 9, 13, 15, 16, 17, 18, 19, 20]
    const tagsFor = (id: number) => [
      { tag: `page-${id}-alpha`, title: `Page ${id} alpha` },
      { tag: `page-${id}-beta`, title: `Page ${id} beta` }
    ]
    const publicPages = publicIds.map(id => ({
      id,
      visibility: 'public',
      path: `page-${id}`,
      localeCode: 'en',
      title: `Page ${id}`,
      content: `public ${id}`,
      author: { id: 1, name: 'Ada' },
      creator: { id: 1, name: 'Ada' },
      tags: tagsFor(id)
    }))
    const privatePage = {
      id: 14,
      visibility: 'private',
      path: 'private-page',
      localeCode: 'en',
      title: 'Private page',
      content: 'private page content',
      author: { id: 2, name: 'Private' },
      creator: { id: 2, name: 'Private' },
      tags: tagsFor(14)
    }
    const publicHistory = publicPages.map(page => ({
      ...page,
      id: page.id + 100,
      pageId: page.id,
      action: 'updated',
      versionDate: '2026-09-07T00:00:00.000Z'
    }))
    const privateHistory = {
      ...privatePage,
      id: 114,
      pageId: privatePage.id,
      action: 'updated',
      versionDate: '2026-09-07T00:00:00.000Z'
    }
    const users = Array.from({ length: 51 }, (_, index) => {
      const id = index + 1
      return {
        id,
        name: `User ${id}`,
        email: `user-${id}@example.test`,
        groups: [
          { id: id * 10, name: `Group ${id} A` },
          { id: id * 10 + 1, name: `Group ${id} B` }
        ],
        provider: { key: 'local', strategyKey: 'local', displayName: 'Local' }
      }
    })
    setModels({
      pages: createRelationPagedModel([...publicPages, privatePage], 'tags'),
      pageHistory: createRelationPagedModel([...publicHistory, privateHistory], 'tags'),
      users: createRelationPagedModel(users, 'groups')
    })

    const directory = createExportDirectory()
    await system.export({ path: directory, entities: ['pages', 'history', 'users'] })

    const pages = readGzipJson(path.join(directory, 'pages.json.gz')) as Row[]
    const history = readGzipJson(path.join(directory, 'pages-history.json.gz')) as Row[]
    const exportedUsers = readGzipJson(path.join(directory, 'users.json.gz')) as Row[]
    expect(pages.map(page => page.id)).toEqual(publicIds)
    expect(history.map(entry => entry.id)).toEqual(publicIds.map(id => id + 100))
    expect(exportedUsers.map(user => user.id)).toEqual(Array.from({ length: 51 }, (_, index) => index + 1))
    expect(pages.map(page => page.tags)).toEqual(publicIds.map(tagsFor))
    expect(history.map(entry => entry.tags)).toEqual(publicIds.map(tagsFor))
    expect(exportedUsers.map(user => user.groups)).toEqual(users.map(user => user.groups))
    expect(JSON.stringify([pages, history])).not.toContain('private page content')
  })

  it('exports only public page, history, and comment content, excluding protected assets', async () => {
    const publicPage = {
      id: 1,
      visibility: 'public',
      path: 'public',
      localeCode: 'en',
      title: 'Public',
      content: 'public content',
      author: { id: 1, name: 'Ada' },
      creator: { id: 1, name: 'Ada' },
      tags: []
    }
    const privatePage = {
      id: 2,
      visibility: 'private',
      ownerId: 9,
      path: 'private',
      localeCode: 'en',
      title: 'Private',
      content: 'private content',
      author: { id: 9, name: 'Private' },
      creator: { id: 9, name: 'Private' },
      tags: []
    }
    const query = (rows: Row[]) => createQueryModel(rows.length, async offset => (offset === 0 ? rows : []))
    setModels({
      pages: query([publicPage, privatePage]),
      pageHistory: query([
        { ...publicPage, pageId: 1, action: 'updated', versionDate: '2025-01-01' },
        { ...privatePage, pageId: 2, action: 'updated', versionDate: '2025-01-01' }
      ]),
      comments: query([
        { id: 1, pageId: 1, content: 'public comment', page: publicPage, author: { id: 1, name: 'Ada' } },
        { id: 2, pageId: 2, content: 'private comment', page: privatePage, author: { id: 9, name: 'Private' } }
      ]),
      assetFolders: { getAllPaths: async () => ({}) },
      assets: query([{ filename: 'public.png' }, { filename: 'protected.png' }]),
      knex: {
        raw: async () => ({ rows: [{ assetPath: 'protected.png' }] }),
        select: () => ({
          from: () => ({
            join: () => ({
              stream: () =>
                Readable.from([
                  { filename: 'public.png', data: Buffer.from('public') },
                  { filename: 'protected.png', data: Buffer.from('protected') }
                ])
            })
          })
        })
      }
    })

    const directory = createExportDirectory()
    await system.export({ path: directory, entities: ['pages', 'history', 'comments', 'assets'] })

    const output = [
      JSON.stringify(readGzipJson(path.join(directory, 'pages.json.gz'))),
      JSON.stringify(readGzipJson(path.join(directory, 'pages-history.json.gz'))),
      JSON.stringify(readGzipJson(path.join(directory, 'comments.json.gz'))),
      fs.readFileSync(path.join(directory, 'assets', 'public.png'), 'utf8')
    ].join('\\n')
    expect(output).toContain('public content')
    expect(output).toContain('public comment')
    expect(output).not.toContain('private content')
    expect(output).not.toContain('private comment')
    expect(fs.existsSync(path.join(directory, 'assets', 'protected.png'))).toBe(false)
    expect(fs.statSync(path.join(directory, 'pages.json.gz')).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.join(directory, 'assets', 'public.png')).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.join(directory, 'assets')).mode & 0o777).toBe(0o700)
  })

  it('creates atomic private artifacts and leaves no completed gzip after a failed batch', async () => {
    const directory = createExportDirectory()
    setModels({
      comments: createQueryModel(51, async offset => {
        if (offset === 0) return Array.from({ length: 50 }, (_, id) => ({ id, page: { visibility: 'public' } }))
        throw new Error('second batch failed')
      })
    })

    await system.export({ path: directory, entities: ['comments'] })

    expect(system.exportStatus.status).toBe('error')
    expect(fs.existsSync(path.join(directory, 'comments.json.gz'))).toBe(false)
    expect(fs.readdirSync(directory).some(entry => entry.includes('.tmp'))).toBe(false)
  })
  it('keeps asset progress proportional beyond fifty assets and below completion while writing', async () => {
    const halfWritten = Promise.withResolvers<void>()
    const fiftyPublished = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const directory = createExportDirectory()
    const assetsDirectory = path.join(directory, 'assets')
    const rename = fsExtra.rename.bind(fsExtra)
    vi.spyOn(fsExtra, 'rename').mockImplementation(async (source, destination) => {
      await rename(source, destination)
      if (destination === path.join(assetsDirectory, 'asset-49.txt')) {
        expect(fs.readdirSync(assetsDirectory)).toHaveLength(50)
        fiftyPublished.resolve()
      }
    })
    const nextTurn = (): Promise<void> => {
      const turn = Promise.withResolvers<void>()
      setImmediate(turn.resolve)
      return turn.promise
    }
    const awaitProgress = async (progress: number): Promise<void> => {
      while (system.exportStatus.progress < progress) await nextTurn()
    }
    async function* assetRows(): AsyncGenerator<AssetRow> {
      for (let id = 0; id < 100; id += 1) {
        if (id === 50) {
          await fiftyPublished.promise
          await awaitProgress(50)
          halfWritten.resolve()
          await release.promise
        }
        yield { filename: `asset-${id}.txt`, data: Buffer.from(String(id)) }
      }
    }
    setModels({
      assetFolders: { getAllPaths: async () => ({}) },
      assets: createQueryModel(100, async () => []),
      knex: {
        select: () => ({
          from: () => ({
            join: () => ({
              stream: () => Readable.from(assetRows())
            })
          })
        })
      }
    })

    const pending = system.export({ path: directory, entities: ['assets'] })
    await halfWritten.promise
    try {
      expect(system.exportStatus.progress).toBe(50)
      expect(system.exportStatus.progress).toBeLessThan(100)
    } finally {
      release.resolve()
    }
    await pending
    expect(system.exportStatus).toMatchObject({ status: 'success', progress: 100 })
  })
})
