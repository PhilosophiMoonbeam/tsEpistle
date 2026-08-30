import { beforeEach, describe, expect, it, vi } from '../bun-test.mts'

const { databaseInit } = vi.hoisted(() => ({ databaseInit: vi.fn() }))
vi.mockModule('../../core/db.ts', import.meta.url, () => ({ default: { init: databaseInit } }))

const logger = {
  error: vi.fn(),
  info: vi.fn()
}
const wiki = {
  config: { db: { type: 'postgres' } },
  configSvc: {
    applyFlags: vi.fn().mockResolvedValue(undefined),
    loadFromDb: vi.fn().mockResolvedValue(undefined)
  },
  logger,
  models: {}
}
Reflect.set(globalThis, 'WIKI', wiki)

// The job must load after its database module is mocked for this worker-boundary test.
const { default: rebuildTree } = await import('../../jobs/rebuild-tree.ts')

type ProjectionRow = Record<string, unknown>

const originalProjection: ProjectionRow[] = [
  { id: 700, path: 'original/first', pageId: 70 },
  { id: 701, path: 'original/second', pageId: 71 }
]
const pages = Array.from({ length: 101 }, (_, index) => ({
  id: index + 1,
  path: `replacement-${String(index).padStart(3, '0')}`,
  localeCode: 'en',
  title: `Replacement ${index}`,
  visibility: 'public' as const,
  ownerId: null
}))

const cloneRows = (rows: ProjectionRow[]): ProjectionRow[] => rows.map(row => ({ ...row }))

const createModels = (failInsert?: number) => {
  let visibleProjection = cloneRows(originalProjection)
  const visibleDuringStatements: ProjectionRow[][] = []
  const insertBatchSizes: number[] = []
  const transactionTableNames: string[] = []
  const rootTable = vi.fn(() => {
    throw new Error('pageTree statement escaped its transaction')
  })
  const destroy = vi.fn().mockResolvedValue(undefined)
  const transaction = vi.fn(async (callback: (trx: { table(name: string): unknown }) => Promise<unknown>) => {
    const stagedProjection = cloneRows(visibleProjection)
    let insertNumber = 0
    const table = (name: string) => {
      transactionTableNames.push(name)
      return {
        truncate: async () => {
          visibleDuringStatements.push(cloneRows(visibleProjection))
          stagedProjection.length = 0
        },
        insert: async (rows: ProjectionRow[]) => {
          insertNumber += 1
          insertBatchSizes.push(rows.length)
          visibleDuringStatements.push(cloneRows(visibleProjection))
          if (insertNumber === failInsert) throw new Error('later chunk failed')
          stagedProjection.push(...cloneRows(rows))
        }
      }
    }
    const result = await callback({ table })
    visibleProjection = stagedProjection
    return result
  })
  const orderBy = vi.fn().mockResolvedValue(pages)
  const select = vi.fn().mockReturnValue({ orderBy })
  const models = {
    knex: { destroy, table: rootTable, transaction },
    pages: { query: vi.fn().mockReturnValue({ select }) }
  }

  return {
    destroy,
    insertBatchSizes,
    models,
    rootTable,
    transaction,
    transactionTableNames,
    visible: () => cloneRows(visibleProjection),
    visibleDuringStatements
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('rebuild-tree projection replacement', () => {
  it('keeps the original complete projection when a later replacement chunk fails', async () => {
    const harness = createModels(2)
    databaseInit.mockResolvedValue(harness.models)

    await expect(Promise.resolve(rebuildTree())).rejects.toThrow('later chunk failed')

    expect(harness.insertBatchSizes).toEqual([100, 1])
    expect(harness.visible()).toEqual(originalProjection)
    expect(harness.transaction).toHaveBeenCalledOnce()
    expect(harness.transactionTableNames).toEqual(['pageTree', 'pageTree', 'pageTree'])
    expect(harness.rootTable).not.toHaveBeenCalled()
    expect(harness.destroy).toHaveBeenCalledOnce()
  })

  it('atomically exposes the complete replacement after every chunk succeeds', async () => {
    const harness = createModels()
    databaseInit.mockResolvedValue(harness.models)

    await rebuildTree()

    expect(harness.insertBatchSizes).toEqual([100, 1])
    expect(harness.visibleDuringStatements).toEqual([originalProjection, originalProjection, originalProjection])
    expect(harness.visible()).toHaveLength(101)
    expect(harness.visible().map(row => row.pageId)).toEqual(pages.map(page => page.id))
    expect(harness.visible().some(row => row.path === 'original/first')).toBe(false)
    expect(harness.transaction).toHaveBeenCalledOnce()
    expect(harness.transactionTableNames).toEqual(['pageTree', 'pageTree', 'pageTree'])
    expect(harness.rootTable).not.toHaveBeenCalled()
    expect(harness.destroy).toHaveBeenCalledOnce()
  })
})
