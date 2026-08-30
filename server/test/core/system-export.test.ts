import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'

import fsExtra from 'fs-extra'

import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

interface ExportSystem {
  exportStatus: {
    status: 'notrunning' | 'running' | 'success' | 'error'
    message: string
  }
  export(options: { path: string; entities: string[] }): Promise<void>
}

type Row = Record<string, unknown>
type FetchBatch = (offset: number) => Promise<Row[]>

const temporaryDirectories: string[] = []

const createQueryModel = (total: number, fetchBatch: FetchBatch) => ({
  query() {
    let offset = 0
    const builder = {
      count: () => builder,
      first: async () => ({ total }),
      offset: (value: number) => {
        offset = value
        return builder
      },
      limit: () => builder,
      withGraphJoined: () => builder,
      modifyGraph: (_name: string, callback: (selection: { select(...columns: string[]): void }) => void) => {
        callback({ select: () => undefined })
        return builder
      },
      then: <Result, Failure = never>(resolve: (rows: Row[]) => Result | PromiseLike<Result>, reject?: (reason: unknown) => Failure | PromiseLike<Failure>) =>
        fetchBatch(offset).then(resolve, reject)
    }
    return builder
  }
})

class GatedWritable extends Writable {
  private releaseFirstWrite: (() => void) | undefined
  readonly firstWrite = new Promise<void>(resolve => {
    this.once('firstWrite', resolve)
  })

  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.releaseFirstWrite) {
      this.releaseFirstWrite = callback
      this.emit('firstWrite')
      return
    }
    callback()
  }

  release(): void {
    this.releaseFirstWrite?.()
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
    expect(system.exportStatus.message).toContain(path.join('assets', 'logo.png'))
  })

  it('does not fetch the next batch while the output pipeline is backpressured', async () => {
    const offsets: number[] = []
    const destination = new GatedWritable({ highWaterMark: 1 })
    vi.spyOn(fsExtra, 'createWriteStream').mockReturnValue(destination as never)
    const rows = Array.from({ length: 50 }, (_, id) => ({
      id,
      content: randomBytes(64 * 1024).toString('base64')
    }))
    setModels({
      comments: createQueryModel(50, async offset => {
        offsets.push(offset)
        return offset === 0 ? rows : []
      })
    })

    const exportPromise = system.export({ path: createExportDirectory(), entities: ['comments'] })
    await destination.firstWrite
    try {
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
      expect(offsets).toEqual([0])
    } finally {
      destination.release()
    }
    await exportPromise
    expect(offsets).toEqual([0, 50])
    expect(system.exportStatus.status).toBe('success')
  })
})
