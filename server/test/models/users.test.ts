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

interface AggregateState {
  users: Row[]
  memberships: Array<{ userId: number; groupId: number }>
  tokens: Array<{ id: number; userId: number; kind: string; token: string }>
}

interface AggregateTransaction {
  state: AggregateState
}

interface AggregateRelationQuery extends PromiseLike<Row[]> {
  relate(value: number | number[]): Promise<void>
  unrelate(): AggregateRelationQuery
  where(column: string, groupId: number): Promise<number>
}

interface AggregateDatabase {
  state: AggregateState
  commits: number
  failRelation: boolean
  failUserPatch: boolean
  nextUserId: number
}

const createAggregateDatabase = (users: Row[] = []): AggregateDatabase => ({
  state: { users: structuredClone(users), memberships: [], tokens: [] },
  commits: 0,
  failRelation: false,
  failUserPatch: false,
  nextUserId: 100
})

const installAggregateDatabase = (database: AggregateDatabase): void => {
  const requireTransaction = (trx?: AggregateTransaction): AggregateTransaction => {
    if (!trx) throw new Error('aggregate query was not bound to the caller transaction')
    return trx
  }
  const userRecord = (row: Row, trx: AggregateTransaction): Row => {
    const relatedQuery = (): AggregateRelationQuery => {
      let unrelating = false
      const relation: AggregateRelationQuery = {
        then: <TResult1 = Row[], TResult2 = never>(
          onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
        ): Promise<TResult1 | TResult2> =>
          Promise.resolve(trx.state.memberships.filter(membership => membership.userId === row.id).map(membership => ({ id: membership.groupId }))).then(
            onfulfilled,
            onrejected
          ),
        relate: async (value: number | number[]): Promise<void> => {
          for (const groupId of Array.isArray(value) ? value : [value]) {
            trx.state.memberships.push({ userId: Number(row.id), groupId })
          }
          if (database.failRelation) throw new Error('forced relation failure')
        },
        unrelate: (): AggregateRelationQuery => {
          unrelating = true
          return relation
        },
        where: async (column: string, groupId: number): Promise<number> => {
          if (!unrelating || column !== 'groupId') throw new Error('unexpected relation query')
          const before = trx.state.memberships.length
          trx.state.memberships = trx.state.memberships.filter(membership => membership.userId !== row.id || membership.groupId !== groupId)
          if (database.failRelation) throw new Error('forced relation failure')
          return before - trx.state.memberships.length
        }
      }
      return relation
    }
    return {
      ...row,
      $relatedQuery: (_relation: string, relatedTrx?: AggregateTransaction) => {
        if (relatedTrx !== trx) throw new Error('relation query did not share the aggregate transaction')
        return relatedQuery()
      }
    }
  }
  const usersQuery = (transaction?: AggregateTransaction) => {
    const trx = transaction ?? { state: database.state }
    let criteria: Row = {}
    const query = {
      findOne: async (input: Row): Promise<Row | undefined> => {
        const row = trx.state.users.find(candidate => Object.entries(input).every(([key, value]) => candidate[key] === value))
        return row ? userRecord(row, trx) : undefined
      },
      findById: (id: number) => {
        const find = async (): Promise<Row | undefined> => {
          const row = trx.state.users.find(candidate => candidate.id === id)
          return row ? userRecord(row, trx) : undefined
        }
        return {
          forUpdate: find,
          then: <TResult1 = Row | undefined, TResult2 = never>(
            onfulfilled?: ((value: Row | undefined) => TResult1 | PromiseLike<TResult1>) | null,
            onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
          ): Promise<TResult1 | TResult2> => find().then(onfulfilled, onrejected)
        }
      },
      insert: async (input: Row): Promise<Row> => {
        const row = { id: database.nextUserId++, ...input }
        trx.state.users.push(row)
        return userRecord(row, trx)
      },
      insertAndFetch: async (input: Row): Promise<Row> => query.insert(input),
      select: (): typeof query => query,
      where: (input: Row): typeof query => {
        criteria = input
        return query
      },
      first: async (): Promise<Row | undefined> => {
        const row = trx.state.users.find(candidate => Object.entries(criteria).every(([key, value]) => candidate[key] === value))
        return row ? userRecord(row, trx) : undefined
      },
      patch: (input: Row) => ({
        findById: async (id: number): Promise<number> => {
          if (database.failUserPatch) throw new Error('forced user patch failure')
          const row = trx.state.users.find(candidate => candidate.id === id)
          if (!row) return 0
          Object.assign(row, input)
          return 1
        }
      }),
      deleteById: async (id: number): Promise<number> => {
        const before = trx.state.users.length
        trx.state.users = trx.state.users.filter(row => row.id !== id)
        return before - trx.state.users.length
      }
    }
    return query
  }

  Object.assign(wiki, {
    auth: {
      strategies: {
        oidc: {
          stategyKey: 'oidc',
          selfRegistration: true,
          domainWhitelist: [],
          autoEnrollGroups: [9]
        }
      }
    },
    config: { lang: { code: 'en' }, title: 'Test Wiki', host: 'https://example.test' },
    data: { authentication: [] },
    logger: { debug: () => {}, error: () => {}, warn: () => {} },
    mail: { send: async () => {} }
  })
  wiki.models = {
    authentication: {
      getStrategy: async () => ({
        selfRegistration: true,
        domainWhitelist: { v: [] },
        autoEnrollGroups: { v: [7] }
      })
    },
    knex: {
      transaction: async <T>(operation: (trx: AggregateTransaction) => Promise<T>): Promise<T> => {
        const trx = { state: structuredClone(database.state) }
        const result = await operation(trx)
        database.state = trx.state
        database.commits += 1
        return result
      }
    },
    userKeys: {
      generateToken: async ({ userId, kind }: { userId: number; kind: string }, trx?: AggregateTransaction): Promise<string> => {
        const transaction = requireTransaction(trx)
        const token = `${kind}-token`
        transaction.state.tokens.push({ id: transaction.state.tokens.length + 1, userId, kind, token })
        return token
      },
      validateToken: async ({ kind, token }: { kind: string; token: string }, trx?: AggregateTransaction): Promise<Row> => {
        const transaction = requireTransaction(trx)
        const tokenIndex = transaction.state.tokens.findIndex(candidate => candidate.kind === kind && candidate.token === token)
        if (tokenIndex < 0) throw new Error('invalid token')
        const [consumed] = transaction.state.tokens.splice(tokenIndex, 1)
        const row = transaction.state.users.find(candidate => candidate.id === consumed?.userId)
        if (!row) throw new Error('invalid token')
        return userRecord(row, transaction)
      },
      query: (trx?: AggregateTransaction) => {
        const transaction = requireTransaction(trx)
        return {
          delete: () => ({
            where: async (_column: string, userId: number): Promise<number> => {
              const before = transaction.state.tokens.length
              transaction.state.tokens = transaction.state.tokens.filter(token => token.userId !== userId)
              return before - transaction.state.tokens.length
            }
          })
        }
      }
    },
    users: {
      query: usersQuery,
      sendWelcomeEmail: async () => {},
      updateUserAvatarData: async () => {}
    }
  }
}

describe('User aggregate transactions', () => {
  test('rolls back membership reconciliation when the profile patch fails', async () => {
    const database = createAggregateDatabase([{ id: 10, email: 'old@example.test', name: 'Old', providerKey: 'local' }])
    database.state.memberships = [{ userId: 10, groupId: 1 }]
    database.failUserPatch = true
    installAggregateDatabase(database)

    await expect(User.updateUser({ id: 10, name: 'New', groups: [2] })).rejects.toThrow('forced user patch failure')

    expect(database.state.users[0]?.name).toBe('Old')
    expect(database.state.memberships).toEqual([{ userId: 10, groupId: 1 }])
    expect(database.commits).toBe(0)
  })

  test('rolls back the profile patch and memberships when relation reconciliation fails', async () => {
    const database = createAggregateDatabase([{ id: 10, email: 'old@example.test', name: 'Old', providerKey: 'local' }])
    database.state.memberships = [{ userId: 10, groupId: 1 }]
    database.failRelation = true
    installAggregateDatabase(database)

    await expect(User.updateUser({ id: 10, name: 'New', groups: [2] })).rejects.toThrow('forced relation failure')

    expect(database.state.users[0]?.name).toBe('Old')
    expect(database.state.memberships).toEqual([{ userId: 10, groupId: 1 }])
  })

  test('commits profile and membership reconciliation once on success', async () => {
    const database = createAggregateDatabase([{ id: 10, email: 'old@example.test', name: 'Old', providerKey: 'local' }])
    database.state.memberships = [{ userId: 10, groupId: 1 }]
    installAggregateDatabase(database)

    await expect(User.updateUser({ id: 10, name: 'New', groups: [2] })).resolves.toBe(true)

    expect(database.state.users[0]?.name).toBe('New')
    expect(database.state.memberships).toEqual([{ userId: 10, groupId: 2 }])
    expect(database.commits).toBe(1)
  })

  test.each([
    [
      'administrative creation',
      async () =>
        User.createNewUser({
          providerKey: 'local',
          email: 'new@example.test',
          passwordRaw: 'secret1',
          name: 'New User',
          groups: [5]
        })
    ],
    [
      'provider self-registration',
      async () =>
        User.processProfile({
          providerKey: 'oidc',
          profile: { id: 'subject', email: 'new@example.test', displayName: 'New User' }
        })
    ],
    [
      'local self-registration',
      async () =>
        User.register(
          {
            email: 'new@example.test',
            password: 'secret1',
            name: 'New User'
          },
          {} as never
        )
    ]
  ])('rolls back the initial user and memberships for %s when relation creation fails', async (_label, create) => {
    const database = createAggregateDatabase()
    database.failRelation = true
    installAggregateDatabase(database)

    await expect(create()).rejects.toThrow('forced relation failure')

    expect(database.state.users).toEqual([])
    expect(database.state.memberships).toEqual([])
    expect(database.commits).toBe(0)
  })

  test.each([
    [
      'administrative creation',
      [5],
      async () =>
        User.createNewUser({
          providerKey: 'local',
          email: 'new@example.test',
          passwordRaw: 'secret1',
          name: 'New User',
          groups: [5]
        })
    ],
    [
      'provider self-registration',
      [9],
      async () =>
        User.processProfile({
          providerKey: 'oidc',
          profile: { id: 'subject', email: 'new@example.test', displayName: 'New User' }
        })
    ],
    [
      'local self-registration',
      [7],
      async () =>
        User.register(
          {
            email: 'new@example.test',
            password: 'secret1',
            name: 'New User'
          },
          {} as never
        )
    ]
  ])('commits the initial user and memberships once for %s', async (_label, expectedGroups, create) => {
    const database = createAggregateDatabase()
    installAggregateDatabase(database)

    await create()

    expect(database.state.users).toHaveLength(1)
    expect(database.state.memberships.map(membership => membership.groupId)).toEqual(expectedGroups)
    expect(database.commits).toBe(1)
  })

  test.each([
    ['email verification', 'verify', async () => User.verifyEmail({ token: 'account-token' })],
    ['password reset', 'resetPwd', async () => User.resetPassword({ token: 'account-token', newPassword: 'new-password' })],
    [
      'mandatory password change',
      'changePwd',
      async () =>
        User.loginChangePassword({ continuationToken: 'account-token', newPassword: 'new-password' }, {
          req: {
            logIn: () => {
              throw new Error('login must not run after a failed patch')
            }
          }
        } as never)
    ]
  ])('keeps a one-time token usable when the protected %s patch fails', async (_label, kind, mutate) => {
    const database = createAggregateDatabase([{ id: 10, isActive: true, isVerified: false, password: 'old-password' }])
    database.state.tokens = [{ id: 1, userId: 10, kind, token: 'account-token' }]
    database.failUserPatch = true
    installAggregateDatabase(database)

    await expect(mutate()).rejects.toThrow('forced user patch failure')

    expect(database.state.users[0]).toMatchObject({ isVerified: false, password: 'old-password' })
    expect(database.state.tokens).toEqual([{ id: 1, userId: 10, kind, token: 'account-token' }])
    expect(database.commits).toBe(0)
  })

  test('commits token consumption and password mutation together on success', async () => {
    const database = createAggregateDatabase([{ id: 10, isActive: true, password: 'old-password' }])
    database.state.tokens = [{ id: 1, userId: 10, kind: 'resetPwd', token: 'reset-token' }]
    installAggregateDatabase(database)

    await expect(User.resetPassword({ token: 'reset-token', newPassword: 'new-password' })).resolves.toBe(10)

    expect(database.state.users[0]?.password).toBe('new-password')
    expect(database.state.tokens).toEqual([])
    expect(database.commits).toBe(1)
  })
})
