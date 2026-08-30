import { beforeEach, describe, expect, mock, test } from 'bun:test'

class ModelStub {
  static ManyToManyRelation = Symbol('ManyToManyRelation')
}

class RelatedModelStub {}

mock.module('objection', () => ({ Model: ModelStub }))
mock.module('../../models/groups.ts', () => ({ default: RelatedModelStub }))
mock.module('../../models/authentication.ts', () => ({ default: RelatedModelStub }))
mock.module('../../models/editors.ts', () => ({ default: RelatedModelStub }))
mock.module('../../models/locales.ts', () => ({ default: RelatedModelStub }))

type Row = Record<string, unknown>
type TableName = 'assets' | 'comments' | 'pageHistory' | 'pages' | 'userKeys' | 'users'
type DatabaseState = Record<TableName, Row[]>

interface TransactionContext {
  state: DatabaseState
}

interface FakeDatabase {
  state: DatabaseState
  failUserDeleteWithForeignKey: boolean
  writeAttempts: number
}

const cloneState = (state: DatabaseState): DatabaseState => structuredClone(state)

class FakeQuery {
  private criteria: Row = {}
  private patchValues: Row | null = null
  private shouldDelete = false

  constructor(
    private readonly database: FakeDatabase,
    private readonly trx: TransactionContext,
    private readonly table: TableName
  ) {}

  select(): this {
    return this
  }

  findById(id: number): { forUpdate: () => Promise<Row | undefined> } {
    return {
      forUpdate: async () => this.rows().find(row => row.id === id)
    }
  }

  where(criteria: Row): FakeQuery
  where(column: string, value: unknown): Promise<number>
  where(criteriaOrColumn: Row | string, value?: unknown): FakeQuery | Promise<number> {
    const criteria = typeof criteriaOrColumn === 'string' ? { [criteriaOrColumn]: value } : criteriaOrColumn

    if (this.patchValues) {
      this.database.writeAttempts += 1
      let changed = 0
      for (const row of this.rows()) {
        if (this.matches(row, criteria)) {
          Object.assign(row, this.patchValues)
          changed += 1
        }
      }
      return Promise.resolve(changed)
    }

    if (this.shouldDelete) {
      this.database.writeAttempts += 1
      const rows = this.rows()
      const retained = rows.filter(row => !this.matches(row, criteria))
      this.trx.state[this.table] = retained
      return Promise.resolve(rows.length - retained.length)
    }

    this.criteria = criteria
    return this
  }

  async first(): Promise<Row | undefined> {
    return this.rows().find(row => this.matches(row, this.criteria))
  }

  patch(values: Row): this {
    this.patchValues = values
    return this
  }

  delete(): this {
    this.shouldDelete = true
    return this
  }

  async deleteById(id: number): Promise<number> {
    this.database.writeAttempts += 1
    if (this.table === 'users' && this.database.failUserDeleteWithForeignKey) {
      throw new Error('forced foreign-key failure')
    }
    const rows = this.rows()
    const retained = rows.filter(row => row.id !== id)
    this.trx.state[this.table] = retained
    return rows.length - retained.length
  }

  private rows(): Row[] {
    return this.trx.state[this.table]
  }

  private matches(row: Row, criteria: Row): boolean {
    return Object.entries(criteria).every(([key, value]) => row[key] === value)
  }
}

const modelFor = (database: FakeDatabase, table: TableName) => ({
  query: (trx?: TransactionContext) => {
    if (!trx) {
      throw new Error(`${table} query was not bound to the deletion transaction`)
    }
    return new FakeQuery(database, trx, table)
  }
})

const createDatabase = (): FakeDatabase => ({
  state: {
    assets: [{ id: 1, authorId: 10 }],
    comments: [{ id: 2, authorId: 10 }],
    pageHistory: [{ id: 3, authorId: 10, ownerId: null, visibility: 'public' }],
    pages: [{ id: 4, authorId: 10, creatorId: 10, ownerId: null, visibility: 'public' }],
    userKeys: [{ id: 5, userId: 10 }],
    users: [{ id: 10 }, { id: 20 }]
  },
  failUserDeleteWithForeignKey: false,
  writeAttempts: 0
})

class InputInvalid extends Error {}
class UserNotFound extends Error {}

const wiki = {
  Error: { InputInvalid, UserNotFound },
  models: {} as Record<string, unknown>
}

;(globalThis as typeof globalThis & { WIKI: typeof wiki }).WIKI = wiki
// The model captures the WIKI global during evaluation, so the isolated test context must exist before loading it.

const { default: User } = await import('../../models/users.ts')

const installDatabase = (database: FakeDatabase): void => {
  wiki.models = {
    assets: modelFor(database, 'assets'),
    comments: modelFor(database, 'comments'),
    pageHistory: modelFor(database, 'pageHistory'),
    pages: modelFor(database, 'pages'),
    userKeys: modelFor(database, 'userKeys'),
    users: modelFor(database, 'users'),
    knex: {
      transaction: async <T>(operation: (trx: TransactionContext) => Promise<T>): Promise<T> => {
        const trx = { state: cloneState(database.state) }
        const result = await operation(trx)
        database.state = trx.state
        return result
      }
    }
  }
}

describe('User.deleteUser', () => {
  let database: FakeDatabase

  beforeEach(() => {
    database = createDatabase()
    installDatabase(database)
  })

  test('rejects a private-page owner before any related mutation', async () => {
    database.state.pages[0].visibility = 'private'
    database.state.pages[0].ownerId = 10
    const original = cloneState(database.state)

    await expect(User.deleteUser(10, 20)).rejects.toBeInstanceOf(InputInvalid)

    expect(database.writeAttempts).toBe(0)
    expect(database.state).toEqual(original)
  })

  test('rolls back authorship, tokens, and the user when a later deletion fails', async () => {
    database.failUserDeleteWithForeignKey = true
    const original = cloneState(database.state)

    await expect(User.deleteUser(10, 20)).rejects.toThrow('forced foreign-key failure')

    expect(database.writeAttempts).toBeGreaterThan(0)
    expect(database.state).toEqual(original)
  })

  test('commits all related mutations for an eligible user', async () => {
    await User.deleteUser(10, 20)

    expect(database.state.assets).toEqual([{ id: 1, authorId: 20 }])
    expect(database.state.comments).toEqual([{ id: 2, authorId: 20 }])
    expect(database.state.pageHistory).toEqual([{ id: 3, authorId: 20, ownerId: null, visibility: 'public' }])
    expect(database.state.pages).toEqual([{ id: 4, authorId: 20, creatorId: 20, ownerId: null, visibility: 'public' }])
    expect(database.state.userKeys).toEqual([])
    expect(database.state.users).toEqual([{ id: 20 }])
  })
})
