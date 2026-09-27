import { describe, expect, it } from './bun-test.mts'
import {
  PAGE_INTEGRITY_BATCH_MAX,
  PAGE_INTEGRITY_MAX_CHECKS_PER_PAGE,
  PageIntegrityScanRequestSchema,
  PageIntegrityScanResponseSchema,
  pageEditorIsCompatible
} from '../../shared/page-integrity.ts'
import { createPageIntegrityOperations } from '../operations/page-integrity.ts'

type Row = Record<string, unknown>
type TableData = Record<string, Row[]>
type Filter = (row: Row) => boolean

class FakeQuery {
  readonly #table: string
  readonly #tables: TableData
  readonly #filters: Filter[] = []
  readonly #orders: Array<{ column: string; direction: 'asc' | 'desc' }> = []
  #rowLimit = Number.POSITIVE_INFINITY
  #maximum: { alias: string; column: string } | null = null

  constructor(table: string, tables: TableData, queries: string[]) {
    this.#table = table
    this.#tables = tables
    queries.push(table)
  }

  select(..._columns: unknown[]) { return this }

  where(columnOrValues: string | Row, operatorOrValue?: unknown, value?: unknown) {
    if (typeof columnOrValues === 'object' && columnOrValues !== null) {
      for (const [column, expected] of Object.entries(columnOrValues)) this.#filters.push(row => this.#equal(row[column], expected))
      return this
    }
    if (value === undefined) {
      this.#filters.push(row => this.#equal(row[columnOrValues], operatorOrValue))
      return this
    }
    const column = columnOrValues
    const operator = String(operatorOrValue)
    this.#filters.push(row => {
      const actual = row[column]
      if (operator === '>') return Number(actual) > Number(value)
      if (operator === '>=') return Number(actual) >= Number(value)
      if (operator === '<') return Number(actual) < Number(value)
      if (operator === '<=') return Number(actual) <= Number(value)
      return this.#equal(actual, value)
    })
    return this
  }

  andWhere(column: string, operator: unknown, value: unknown) { return this.where(column, operator, value) }
  whereNot(column: string, value: unknown) { this.#filters.push(row => !this.#equal(row[column], value)); return this }
  whereIn(column: string, values: unknown[]) { this.#filters.push(row => values.some(value => this.#equal(row[column], value))); return this }
  orderBy(column: string, direction: 'asc' | 'desc' = 'asc') { this.#orders.push({ column, direction }); return this }
  limit(value: number) { this.#rowLimit = value; return this }
  max(selection: Record<string, string>) {
    const [alias, column] = Object.entries(selection)[0]!
    this.#maximum = { alias, column }
    return this
  }

  first(..._columns: unknown[]) { return Promise.resolve(this.#rows()[0]) }
  then(resolve?: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) { return Promise.resolve(this.#rows()).then(resolve, reject) }

  #equal(actual: unknown, expected: unknown): boolean {
    return actual === expected || (actual !== null && actual !== undefined && expected !== null && expected !== undefined && String(actual) === String(expected))
  }

  #rows(): Row[] {
    const source = this.#tables[this.#table] ?? []
    if (this.#maximum) {
      const values = source.map(row => Number(row[this.#maximum!.column])).filter(Number.isFinite)
      return [{ [this.#maximum.alias]: values.length ? Math.max(...values) : null }]
    }
    let rows = source.filter(row => this.#filters.every(filter => filter(row)))
    for (const order of [...this.#orders].reverse()) {
      rows = [...rows].sort((left, right) => {
        const rawA = left[order.column]
        const rawB = right[order.column]
        const a = rawA instanceof Date ? rawA.valueOf() : rawA
        const b = rawB instanceof Date ? rawB.valueOf() : rawB
        const comparison = a === b ? 0 : a === undefined || a === null ? -1 : b === undefined || b === null ? 1 : typeof a === 'number' && typeof b === 'number' ? a < b ? -1 : 1 : String(a).localeCompare(String(b))
        return order.direction === 'desc' ? -comparison : comparison
      })
    }
    return rows.slice(0, this.#rowLimit)
  }
}

const page = (id: number, overrides: Row = {}): Row => ({
  id,
  sourceRevision: '4',
  renderedSourceRevision: '4',
  editorKey: 'markdown',
  contentType: 'markdown',
  localeCode: 'en',
  path: `guide/page-${id}`,
  visibility: 'public',
  ownerId: null,
  isPublished: true,
  isSearchable: true,
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  diagnosticSource: `---\ntype: Reference\nstatus: stable\n---\nSource secret for ${id}`,
  sourceByteLength: 65,
  renderLength: 18,
  ...overrides
})

const makeDatabase = (input: { pages?: Row[]; allowed?: boolean; afterFirstTransaction?: () => void } = {}) => {
  const pages = input.pages ?? [page(1), page(2, { editorKey: 'ckeditor' }), page(3)]
  const tables: TableData = {
    pages,
    groups: [{ id: 1, permissions: input.allowed === false ? ['read:pages'] : ['manage:system'], adminRevision: '1' }],
    users: [{ id: 7, isActive: true, authVersion: 2 }],
    userGroups: [{ userId: 7, groupId: 1 }],
    locales: [{ code: 'en' }],
    pageMutationOutbox: pages.flatMap(record =>
      ['render', 'links', 'search', 'knowledge'].map(effectKind => ({
        pageId: record.id,
        sourceRevision: record.sourceRevision,
        effectKind,
        status: 'succeeded',
        postcondition: { satisfied: true },
        updatedAt: new Date('2026-09-02T00:00:00.000Z')
      }))
    ),
    pagesVector: pages.map(record => ({ pageId: record.id, sourceRevision: record.sourceRevision })),
    pagesWords: pages.map(record => ({ pageId: record.id })),
    pageAccessPasswords: [],
    pageProtectedAssets: [],
    assets: [],
    storage: [{
      key: 'disk',
      isEnabled: true,
      state: JSON.stringify({ status: 'warning', message: 'credential-secret', lastAttempt: '2026-09-02T00:00:00.000Z', lastOperation: { message: 'private-storage-message' } })
    }]
  }
  const queries: string[] = []
  const transaction = async (callback: (tx: unknown) => Promise<unknown>, _configuration: unknown) => {
    const result = await callback(db)
    transactionCount += 1
    if (transactionCount === 1) input.afterFirstTransaction?.()
    return result
  }
  let transactionCount = 0
  const db = ((table: string) => new FakeQuery(table, tables, queries)) as unknown as ((table: string) => FakeQuery) & {
    raw: (query: string, bindings?: unknown[]) => unknown
    transaction: typeof transaction
  }
  db.raw = (query, bindings) => ({ query, bindings })
  db.transaction = transaction
  return { db, tables, queries }
}

const requester = { user: { id: 7, authVersion: 2 }, apiKey: undefined } as never

describe('page integrity diagnostics', () => {
  it('validates bounded cursors and native editor/source compatibility', () => {
    expect(PageIntegrityScanRequestSchema.parse({})).toEqual({ cursor: null, upperWatermark: null, limit: 15 })
    expect(PageIntegrityScanRequestSchema.safeParse({ cursor: 4, upperWatermark: 3, limit: 1 }).success).toBe(false)
    expect(PageIntegrityScanRequestSchema.safeParse({ cursor: 0, upperWatermark: 10, limit: PAGE_INTEGRITY_BATCH_MAX + 1 }).success).toBe(false)
    expect(pageEditorIsCompatible('visual-markdown', 'markdown')).toBe(true)
    expect(pageEditorIsCompatible('ckeditor', 'markdown')).toBe(false)
    expect(pageEditorIsCompatible('asciidoc', 'asciidoc')).toBe(true)
    expect(pageEditorIsCompatible('missing-editor', 'markdown')).toBe(false)
  })

  it('captures a fixed upper watermark, advances stable bounded batches, and omits source and storage details', async () => {
    const { db, tables } = makeDatabase()
    const operations = createPageIntegrityOperations({ db: db as never })
    const first = await operations.scan(requester, { limit: 2 })
    expect(first).toMatchObject({ upperWatermark: 3, nextCursor: 2, state: 'running', pagesScanned: 2 })
    expect(first.checks.length).toBeLessThanOrEqual(2 * PAGE_INTEGRITY_MAX_CHECKS_PER_PAGE)
    expect(first.checks.some(item => item.pageId === 2 && item.checkCode === 'SOURCE_EDITOR_COMPATIBILITY' && item.outcome === 'finding')).toBe(true)
    expect(first.localStorage).toEqual([expect.objectContaining({ key: 'disk', status: 'warning', hasRecordedOperation: true })])
    expect(JSON.stringify(first)).not.toContain('Source secret')
    expect(JSON.stringify(first)).not.toContain('credential-secret')
    expect(JSON.stringify(first)).not.toContain('private-storage-message')

    tables.pages.push(page(4))
    const second = await operations.scan(requester, { cursor: first.nextCursor, upperWatermark: first.upperWatermark, limit: 2 })
    expect(second).toMatchObject({ upperWatermark: 3, nextCursor: null, state: 'complete', pagesScanned: 1 })
    expect(second.checks.every(item => item.pageId === 3)).toBe(true)
    expect([...first.checks, ...second.checks].some(item => item.pageId === 4)).toBe(false)
    expect(PageIntegrityScanResponseSchema.safeParse(first).success).toBe(true)
  })

  it('marks every page observation stale when its revision changes during the scan', async () => {
    const records = [page(1)]
    const { db } = makeDatabase({ pages: records, afterFirstTransaction: () => { records[0]!.sourceRevision = '5' } })
    const operations = createPageIntegrityOperations({ db: db as never })
    const result = await operations.scan(requester, { limit: 1 })
    expect(result.state).toBe('complete')
    expect(result.checks.length).toBeGreaterThan(0)
    expect(result.checks.every(item => item.outcome === 'changed' && item.sourceRevision === '4')).toBe(true)
  })

  it('requires current manage:system authority and rejects response fields that could carry source', async () => {
    const { db, queries } = makeDatabase({ allowed: false })
    const operations = createPageIntegrityOperations({ db: db as never })
    await expect(operations.scan(requester, {})).rejects.toMatchObject({ status: 403 })
    expect(queries).not.toContain('pages')

    const response = PageIntegrityScanResponseSchema.parse({ upperWatermark: 0, nextCursor: null, state: 'complete', pagesScanned: 0, checks: [], localStorage: [] })
    expect(PageIntegrityScanResponseSchema.safeParse({ ...response, source: 'private page content' }).success).toBe(false)
  })
})
