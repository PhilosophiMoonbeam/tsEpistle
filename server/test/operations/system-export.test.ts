import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

interface SystemOperations {
  startExport(input: unknown, beforeStart?: () => Promise<void>): Promise<void>
}

interface ExportEffect {
  (options: { entities: string[]; path: string }): Promise<void>
  mockImplementationOnce(implementation: (options: { entities: string[]; path: string }) => Promise<void>): unknown
}

const roots: string[] = []
let root: string
let exportStatus: { status: string; progress: number; message: string }
let exportEffect: ExportEffect
let systemOperations: SystemOperations

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-system-operation-export-'))
  roots.push(root)
  exportStatus = { status: 'notrunning', progress: 0, message: '' }
  exportEffect = vi.fn(async () => undefined) as unknown as ExportEffect
  vi.stubGlobal('WIKI', {
    ROOTPATH: root,
    version: 'test',
    product: { version: 'test' },
    models: { groups: {}, pages: {}, users: {}, tags: {}, assets: {}, pageHistory: {}, knex: { client: {} } },
    scheduler: { registerJob: vi.fn() },
    system: { exportStatus, export: exportEffect },
    config: { flags: {}, db: {}, telemetry: {}, server: {}, ssl: {} },
    telemetry: {},
    servers: { servers: {} },
    events: { outbound: { emit: vi.fn() } },
    Error: {}
  })
  systemOperations = (await vi.importFresh<{ default: SystemOperations }>('../../operations/system.ts', import.meta.url)).default
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const directory of roots.splice(0)) fs.rmSync(directory, { force: true, recursive: true })
})

describe('operations/system export preflight', () => {
  it('creates a private empty destination, then awaits the pre-dispatch fence and export effect', async () => {
    const fenceReached = Promise.withResolvers<void>()
    const releaseEffect = Promise.withResolvers<void>()
    let fenceRan = false
    exportEffect.mockImplementationOnce(async () => {
      expect(fenceRan).toBe(true)
      exportStatus.status = 'running'
      await releaseEffect.promise
      exportStatus.status = 'success'
    })

    const pending = systemOperations.startExport({ entities: ['pages'], exportPath: 'exports/reviewed' }, async () => {
      const directory = path.join(root, 'exports', 'reviewed')
      expect(fs.readdirSync(directory)).toEqual([])
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700)
      expect(exportEffect).not.toHaveBeenCalled()
      fenceRan = true
      fenceReached.resolve()
    })
    await fenceReached.promise
    await Promise.resolve()
    expect(exportEffect).toHaveBeenCalledWith({ entities: ['pages'], path: path.join(root, 'exports', 'reviewed') })
    releaseEffect.resolve()
    await pending
  })

  it('rejects a nonempty destination before invoking the fence or exporter', async () => {
    const directory = path.join(root, 'exports', 'occupied')
    fs.mkdirSync(directory, { mode: 0o700, recursive: true })
    fs.writeFileSync(path.join(directory, 'existing.json'), '{}')
    const beforeStart = vi.fn(async () => undefined)

    await expect(systemOperations.startExport({ entities: ['users'], exportPath: 'exports/occupied' }, beforeStart)).rejects.toThrow(
      'Target directory must be empty'
    )

    expect(beforeStart).not.toHaveBeenCalled()
    expect(exportEffect).not.toHaveBeenCalled()
    expect(fs.readFileSync(path.join(directory, 'existing.json'), 'utf8')).toBe('{}')
  })

  it('rejects destinations outside the application root before dispatch', async () => {
    const beforeStart = vi.fn(async () => undefined)

    await expect(systemOperations.startExport({ entities: ['settings'], exportPath: '../outside' }, beforeStart)).rejects.toThrow(
      'beneath the application root'
    )

    expect(beforeStart).not.toHaveBeenCalled()
    expect(exportEffect).not.toHaveBeenCalled()
  })
})
