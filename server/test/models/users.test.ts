import bcrypt from 'bcryptjs-then'
import { newPasswordIssue } from '../../../shared/security-policy.ts'
import { beforeEach, describe, expect, mock, test } from 'bun:test'

const ModelStub = Object.assign(function ModelStub() {}, {
  ManyToManyRelation: Symbol('ManyToManyRelation')
})

class RelatedModelStub {}

mock.module('../../helpers/password-policy.ts', () => ({
  assertSavedPassword: async (_tx: unknown, value: unknown) => {
    const issue = newPasswordIssue(value)
    if (issue) throw new Error(issue)
  }
}))
mock.module('objection', () => ({ Model: ModelStub }))
mock.module('../../models/groups.ts', () => ({ default: RelatedModelStub }))
mock.module('../../models/authentication.ts', () => ({ default: RelatedModelStub }))
const enrollmentPolicy = mock(async (_tx: unknown, key: string) => ({
  isEnabled: true,
  selfRegistration: true,
  domainWhitelist: [] as string[],
  autoEnrollGroups: key === 'local' ? [7] : [9]
}))
mock.module('../../helpers/authentication-provisioning.ts', () => ({ loadEnrollmentPolicy: enrollmentPolicy }))
mock.module('../../models/editors.ts', () => ({ default: RelatedModelStub }))
mock.module('../../models/locales.ts', () => ({ default: RelatedModelStub }))
const signJwt = mock((_payload: Record<string, unknown>) => 'signed-jwt')
mock.module('jsonwebtoken', () => ({ default: { sign: signJwt } }))

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
  userPatches: Row[]
  nextUserId: number
}

const createAggregateDatabase = (users: Row[] = []): AggregateDatabase => ({
  state: { users: structuredClone(users), memberships: [], tokens: [] },
  commits: 0,
  failRelation: false,
  failUserPatch: false,
  nextUserId: 100,
  userPatches: []
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
      patch: (input: Row) => {
        database.userPatches.push(structuredClone(input))
        return {
          findById: async (id: number): Promise<number> => {
            if (database.failUserPatch) throw new Error('forced user patch failure')
            const row = trx.state.users.find(candidate => candidate.id === id)
            if (!row) return 0
            const next = { ...input }
            if (typeof next.authVersion === 'object') next.authVersion = Number(row.authVersion ?? 0) + 1
            Object.assign(row, next)
            return 1
          }
        }
      },
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
    config: {
      lang: { code: 'en' },
      title: 'Test Wiki',
      host: 'https://example.test'
    },
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
      raw: (sql: string, bindings: string[]) => {
        expect(sql).toBe('?? + 1')
        expect(bindings).toEqual(['authVersion'])
        return { accountVersionIncrement: true }
      },
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

  test('patches both presentation preference columns without changing unrelated profile fields', async () => {
    const database = createAggregateDatabase([
      {
        id: 10,
        email: 'old@example.test',
        name: 'Unchanged',
        providerKey: 'local',
        appearance: 'system',
        fontFamily: 'newsreader'
      }
    ])
    installAggregateDatabase(database)

    await expect(User.updateUser({ id: 10, appearance: 'dark', fontFamily: 'roboto-flex' })).resolves.toBe(false)

    expect(database.userPatches).toEqual([{ appearance: 'dark', fontFamily: 'roboto-flex' }])
    expect(database.state.users[0]).toMatchObject({
      name: 'Unchanged',
      appearance: 'dark',
      fontFamily: 'roboto-flex'
    })
  })

  test.each([
    [
      'administrative creation',
      async () =>
        User.createNewUser({
          providerKey: 'local',
          email: 'new@example.test',
          passwordRaw: 'a-valid-secret1',
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
            password: 'a-valid-secret1',
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
          passwordRaw: 'a-valid-secret1',
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
            password: 'a-valid-secret1',
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
    if (_label === 'local self-registration') expect(database.state.users[0]).toMatchObject({ providerKey: 'local', localeCode: 'en' })
    expect(database.state.memberships.map(membership => membership.groupId)).toEqual(expectedGroups)
    expect(database.commits).toBe(1)
    expect(database.state.users[0]).toMatchObject({
      fontFamily: 'blend'
    })
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

  test('treats a bcrypt-shaped replacement as a literal new password', async () => {
    const literal = await bcrypt.hash('an-unrelated-password', 4)
    const database = createAggregateDatabase([{ id: 10, isActive: true, providerKey: 'local', password: 'old-password' }])
    database.state.tokens = [{ id: 1, userId: 10, kind: 'resetPwd', token: 'reset-token' }]
    installAggregateDatabase(database)
    await User.resetPassword({ token: 'reset-token', newPassword: literal })
    const stored = String(database.state.users[0]?.password)
    expect(stored).not.toBe(literal)
    expect(await bcrypt.compare(literal, stored)).toBe(true)
    expect(await bcrypt.compare('an-unrelated-password', stored)).toBe(false)
  })

  test('commits token consumption and password mutation together on success', async () => {
    const database = createAggregateDatabase([{ id: 10, isActive: true, password: 'old-password' }])
    database.state.tokens = [{ id: 1, userId: 10, kind: 'resetPwd', token: 'reset-token' }]
    installAggregateDatabase(database)

    await expect(User.resetPassword({ token: 'reset-token', newPassword: 'new-password' })).resolves.toBe(10)

    expect(await bcrypt.compare('new-password', String(database.state.users[0]?.password))).toBe(true)
    expect(database.state.tokens).toEqual([])
    expect(database.commits).toBe(1)
  })
})

interface TfaState {
  users: Row[]
  userKeys: Row[]
}

interface TfaTransaction {
  state: TfaState
}

interface TfaDatabase {
  state: TfaState
  commits: number
  expectedCode: string
  failEnable: boolean
  afterLoginResult: Row
  afterLoginCalls: number
  afterLoginCommits: number[]
  tokenValidationTransactions: TfaTransaction[]
  enableTransactions: TfaTransaction[]
  generatedTokens: Array<{ userId: number; kind: string; commits: number }>
}

const tfaErrors = {
  AuthTFAFailed: class extends Error {},
  AuthTFAInvalid: class extends Error {},
  AuthValidationTokenInvalid: class extends Error {}
}

const createTfaDatabase = (userValues: Row = {}): TfaDatabase => ({
  state: {
    users: [{
      id: 10,
      isActive: true,
      tfaIsActive: false,
      tfaSecret: 'test-secret',
      authVersion: 0,
      mustChangePwd: false,
      groups: [],
      ...userValues
    }],
    userKeys: [{
      id: 1,
      userId: 10,
      kind: 'tfaSetup',
      token: 'setup-token',
      authVersion: 0,
      validUntil: '2999-01-01T00:00:00.000Z'
    }]
  },
  commits: 0,
  expectedCode: '123456',
  failEnable: false,
  afterLoginResult: { jwt: 'signed-jwt', redirect: '/' },
  afterLoginCalls: 0,
  afterLoginCommits: [],
  tokenValidationTransactions: [],
  enableTransactions: [],
  generatedTokens: []
})

const installTfaDatabase = (database: TfaDatabase): void => {
  const userRecord = (row: Row): User =>
    Object.assign(new User(), row, {
      verifyTFA: (code: string) => code === database.expectedCode,
      $relatedQuery: () => ({ select: async () => [] })
    })
  const query = (transaction?: TfaTransaction) => {
    if (!transaction) throw new Error('TFA query was not bound to the transaction')
    database.enableTransactions.push(transaction)
    return {
      findById: (id: number) => ({
        patch: async (values: Row): Promise<number> => {
          const row = transaction.state.users.find(candidate => candidate.id === id)
          if (!row) return 0
          Object.assign(row, values)
          if (database.failEnable) throw new Error('forced TFA activation failure')
          return 1
        }
      })
    }
  }
  const validateToken = async (
    { kind, token }: { kind: string; token: string },
    transaction?: TfaTransaction
  ): Promise<User> => {
    if (!transaction) throw new Error('TFA token validation was not bound to the transaction')
    database.tokenValidationTransactions.push(transaction)
    const tokenIndex = transaction.state.userKeys.findIndex(candidate => candidate.kind === kind && candidate.token === token)
    if (tokenIndex < 0) throw new tfaErrors.AuthValidationTokenInvalid()
    const [candidate] = transaction.state.userKeys.splice(tokenIndex, 1)
    const row = transaction.state.users.find(user => user.id === candidate?.userId)
    if (!row) throw new tfaErrors.AuthValidationTokenInvalid()
    return userRecord(row)
  }
  const afterLoginChecks = async (): Promise<Row> => {
    database.afterLoginCalls += 1
    database.afterLoginCommits.push(database.commits)
    return structuredClone(database.afterLoginResult)
  }
  const generateToken = async ({ userId, kind }: { userId: number; kind: string }): Promise<string> => {
    database.generatedTokens.push({ userId, kind, commits: database.commits })
    return `${kind}-token`
  }
  const transaction = async <T>(operation: (trx: TfaTransaction) => Promise<T>): Promise<T> => {
    const trx = { state: structuredClone(database.state) }
    const result = await operation(trx)
    database.state = trx.state
    database.commits += 1
    return result
  }

  Object.assign(wiki.Error, tfaErrors)
  Object.assign(wiki, { config: { auth: { enforce2FA: false } } })
  wiki.models = {
    knex: { transaction },
    userKeys: { validateToken, generateToken },
    users: { query, afterLoginChecks }
  }
}

describe('User.loginTFA setup transactions', () => {
  const context = {
    req: { login: () => {}, logIn: () => {}, body: {}, params: {} },
    res: {}
  } as never

  test('rolls back an invalid setup code so a valid retry can consume and enable', async () => {
    const database = createTfaDatabase()
    installTfaDatabase(database)

    await expect(User.loginTFA({ securityCode: '000000', continuationToken: 'setup-token', setup: true }, context))
      .rejects.toBeInstanceOf(tfaErrors.AuthTFAFailed)

    expect(database.state.userKeys).toHaveLength(1)
    expect(database.state.users[0]).toMatchObject({ tfaIsActive: false })
    expect(database.commits).toBe(0)
    expect(database.afterLoginCalls).toBe(0)

    await expect(User.loginTFA({ securityCode: '123456', continuationToken: 'setup-token', setup: true }, context))
      .resolves.toEqual(database.afterLoginResult)

    expect(database.state.userKeys).toEqual([])
    expect(database.state.users[0]).toMatchObject({ tfaIsActive: true })
    expect(database.commits).toBe(1)
    expect(database.afterLoginCommits).toEqual([1])
    expect(database.enableTransactions).toHaveLength(1)
    expect(database.enableTransactions[0]).toBe(database.tokenValidationTransactions[1])
  })

  test('consumes a valid setup token exactly once and rejects its replay', async () => {
    const database = createTfaDatabase()
    installTfaDatabase(database)

    await expect(User.loginTFA({ securityCode: '123456', continuationToken: 'setup-token', setup: true }, context))
      .resolves.toEqual(database.afterLoginResult)
    await expect(User.loginTFA({ securityCode: '123456', continuationToken: 'setup-token', setup: true }, context))
      .rejects.toBeInstanceOf(tfaErrors.AuthValidationTokenInvalid)

    expect(database.state.userKeys).toEqual([])
    expect(database.state.users[0]).toMatchObject({ tfaIsActive: true })
    expect(database.commits).toBe(1)
    expect(database.afterLoginCalls).toBe(1)
  })

  test('rejects setup for an already-active account without consuming its token', async () => {
    const database = createTfaDatabase({ tfaIsActive: true })
    installTfaDatabase(database)

    await expect(User.loginTFA({ securityCode: '123456', continuationToken: 'setup-token', setup: true }, context))
      .rejects.toBeInstanceOf(tfaErrors.AuthValidationTokenInvalid)

    expect(database.state.userKeys).toHaveLength(1)
    expect(database.state.users[0]).toMatchObject({ tfaIsActive: true })
    expect(database.commits).toBe(0)
    expect(database.afterLoginCalls).toBe(0)
  })

  test('rolls back setup token consumption when TFA activation fails', async () => {
    const database = createTfaDatabase()
    database.failEnable = true
    installTfaDatabase(database)

    await expect(User.loginTFA({ securityCode: '123456', continuationToken: 'setup-token', setup: true }, context))
      .rejects.toThrow('forced TFA activation failure')

    expect(database.state.userKeys).toHaveLength(1)
    expect(database.state.users[0]).toMatchObject({ tfaIsActive: false })
    expect(database.commits).toBe(0)
    expect(database.afterLoginCalls).toBe(0)
  })

  test('returns the mandatory-password continuation after setup without starting a session', async () => {
    const database = createTfaDatabase({ mustChangePwd: true })
    database.afterLoginResult = { mustChangePwd: true, continuationToken: 'changePwd-token', redirect: '/' }
    installTfaDatabase(database)
    const usersModel = wiki.models.users as { afterLoginChecks: typeof User.afterLoginChecks }
    const originalAfterLoginChecks = User.afterLoginChecks
    usersModel.afterLoginChecks = async (...args: Parameters<typeof User.afterLoginChecks>) => {
      database.afterLoginCalls += 1
      database.afterLoginCommits.push(database.commits)
      return originalAfterLoginChecks(...args)
    }
    let loginCalls = 0
    let cookieCalls = 0
    const result = await User.loginTFA(
      { securityCode: '123456', continuationToken: 'setup-token', setup: true },
      {
        req: { login: () => { loginCalls += 1 }, logIn: () => { loginCalls += 1 }, body: {}, params: {} },
        res: { cookie: () => { cookieCalls += 1 } }
      } as never
    )

    expect(result).toEqual(database.afterLoginResult)
    expect(database.state.userKeys).toEqual([])
    expect(database.state.users[0]).toMatchObject({ tfaIsActive: true, mustChangePwd: true })
    expect(database.afterLoginCommits).toEqual([1])
    expect(database.generatedTokens).toEqual([{ userId: 10, kind: 'changePwd', commits: 1 }])
    expect(loginCalls).toBe(0)
    expect(cookieCalls).toBe(0)
  })
})

describe('User.refreshToken', () => {
  test('does not issue a fresh token after the sign-in provider has been disabled', async () => {
    wiki.models = { authentication: { getStrategy: async () => ({ isEnabled: false }) } }
    const user = Object.assign(new User(), { id: 10, providerKey: 'oidc', groups: [] })
    const previousCalls = signJwt.mock.calls.length
    await expect(User.refreshToken(user)).rejects.toBeInstanceOf(Error)
    expect(signJwt.mock.calls.length).toBe(previousCalls)
  })

  test('issues the font-family JWT claim without a removed gutter claim', async () => {
    const updateLastLogin = mock(async () => 1)
    const knex = (_table: string) => ({
      where: (_column: string, _id: number) => ({ update: updateLastLogin })
    })
    Object.assign(wiki, {
      config: {
        auth: { audience: 'wiki-test', tokenExpiration: '1h' },
        certs: { private: 'private-key' },
        sessionSecret: 'secret'
      }
    })
    wiki.models = { knex, authentication: { getStrategy: async () => ({ isEnabled: true }) } }
    const user = Object.assign(new User(), {
      id: 10,
      email: 'user@example.test',
      name: 'User',
      pictureUrl: '',
      timezone: 'UTC',
      localeCode: 'en',
      dateFormat: 'YYYY-MM-DD',
      appearance: 'system',
      fontFamily: 'roboto-flex',
      groups: []
    })
    const callIndex = signJwt.mock.calls.length

    await expect(User.refreshToken(user)).resolves.toMatchObject({ token: 'signed-jwt', user })

    const claims = signJwt.mock.calls[callIndex]?.[0]
    expect(claims).toMatchObject({
      id: 10,
      authVersion: 0,
      ap: 'system',
      ff: 'roboto-flex'
    })
    expect(claims).not.toHaveProperty('rg')
    expect(updateLastLogin).toHaveBeenCalledTimes(1)
  })
})
