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
  const raw = vi.fn().mockResolvedValue(undefined)
  const transactionContexts: object[] = []
  const transaction = vi.fn(
    async (callback: (trx: { raw(sql: string, bindings: unknown[]): Promise<unknown>; table(name: string): unknown }) => Promise<unknown>) => {
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
      const trx = { raw, table }
      transactionContexts.push(trx)
      const result = await callback(trx)
      visibleProjection = stagedProjection
      return result
    }
  )
  const orderBy = vi.fn().mockResolvedValue(pages)
  const select = vi.fn().mockReturnValue({ orderBy })
  const query = vi.fn((transactionContext: object) => ({ select }))
  const models = {
    knex: { destroy, table: rootTable, transaction },
    pages: { query }
  }

  return {
    destroy,
    insertBatchSizes,
    models,
    rootTable,
    query,
    raw,
    transaction,
    transactionTableNames,
    transactionContexts,
    visible: () => cloneRows(visibleProjection),
    visibleDuringStatements
  }
}

const createDeferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

const createConcurrencyModels = () => {
  let sourcePages = [
    {
      id: 1,
      path: 'old/path',
      localeCode: 'en',
      title: 'Old',
      visibility: 'public' as const,
      ownerId: null
    }
  ]
  let visibleProjection = cloneRows(originalProjection)
  let lockHeld = false
  const lockQueue: Array<() => void> = []
  const lockedTransactions = new WeakSet<object>()
  const sourceReadStarted = createDeferred()
  const resumeSourceRead = createDeferred()
  const lockWaitStarted = createDeferred()
  const secondSourceReadStarted = createDeferred()
  const sourceReads: string[][] = []
  const commits: string[][] = []
  const destroy = vi.fn().mockResolvedValue(undefined)
  const rootTable = vi.fn(() => {
    throw new Error('pageTree statement escaped its transaction')
  })

  const transaction = vi.fn(
    async (
      callback: (trx: {
        raw(sql: string, bindings: unknown[]): Promise<unknown>
        table(name: string): {
          truncate(): Promise<void>
          insert(rows: ProjectionRow[]): Promise<void>
        }
      }) => Promise<unknown>
    ) => {
      const stagedProjection = cloneRows(visibleProjection)
      const table = () => ({
        truncate: async () => {
          stagedProjection.length = 0
        },
        insert: async (rows: ProjectionRow[]) => {
          stagedProjection.push(...cloneRows(rows))
        }
      })
      const trx = {
        raw: vi.fn(async () => {
          if (lockHeld) {
            lockWaitStarted.resolve()
            await new Promise<void>(resolve => lockQueue.push(resolve))
          }
          lockHeld = true
          lockedTransactions.add(trx)
        }),
        table
      }

      try {
        const result = await callback(trx)
        visibleProjection = stagedProjection
        commits.push(visibleProjection.map(row => String(row.path)))
        return result
      } finally {
        if (lockedTransactions.delete(trx)) {
          const next = lockQueue.shift()
          if (next) next()
          else lockHeld = false
        }
      }
    }
  )

  const query = vi.fn((_transactionContext: object) => ({
    select: vi.fn(() => ({
      orderBy: vi.fn(async () => {
        const snapshot = sourcePages.map(page => ({ ...page }))
        sourceReads.push(snapshot.map(page => page.path))
        if (sourceReads.length === 2) secondSourceReadStarted.resolve()
        if (sourceReads.length === 1) {
          sourceReadStarted.resolve()
          await resumeSourceRead.promise
        }
        return snapshot
      })
    }))
  }))
  const models = {
    knex: { destroy, table: rootTable, transaction },
    pages: { query }
  }

  return {
    commits,
    destroy,
    lockWaitStarted: lockWaitStarted.promise,
    nextRebuildEvent: Promise.race([
      lockWaitStarted.promise.then(() => 'lock-wait' as const),
      secondSourceReadStarted.promise.then(() => 'source-read' as const)
    ]),
    models,
    movePage: () => {
      sourcePages = sourcePages.map(page => ({ ...page, path: 'new/path', title: 'New' }))
    },
    resumeSourceRead: resumeSourceRead.resolve,
    sourceReadStarted: sourceReadStarted.promise,
    sourceReads,
    visible: () => cloneRows(visibleProjection)
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
    expect(harness.raw).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(?)', [0x574b5452])
    expect(harness.query).toHaveBeenCalledWith(harness.transactionContexts[0])
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

  it('keeps a paused old snapshot from replacing the tree after a newer page move', async () => {
    const harness = createConcurrencyModels()
    databaseInit.mockResolvedValue(harness.models)

    const oldRebuild = rebuildTree()
    await harness.sourceReadStarted
    harness.movePage()
    const newerRebuild = rebuildTree()

    const nextRebuildEvent = await harness.nextRebuildEvent
    const commitsBeforeResume = [...harness.commits]
    harness.resumeSourceRead()
    await Promise.all([oldRebuild, newerRebuild])

    expect(nextRebuildEvent).toBe('lock-wait')
    expect(commitsBeforeResume).toEqual([])

    expect(harness.sourceReads).toEqual([['old/path'], ['new/path']])
    expect(harness.commits).toEqual([
      ['old', 'old/path'],
      ['new', 'new/path']
    ])
    expect(harness.visible().map(row => row.path)).toEqual(['new', 'new/path'])
    expect(harness.destroy).toHaveBeenCalledTimes(2)
  })
})
