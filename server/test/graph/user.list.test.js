const makeUsersQueryFactory = (users) => {
  const makeBuilder = () => {
    let rows = [...users]
    let selected = null

    const builder = {
      select (...fields) {
        selected = fields
        return builder
      },
      where (callback) {
        const clauses = []
        const whereBuilder = {
          where (field, operator, value) {
            if (typeof field === 'function') {
              field(whereBuilder)
              return whereBuilder
            }
            clauses.push({ type: 'where', field, operator, value })
            return whereBuilder
          },
          orWhere (field, operator, value) {
            clauses.push({ type: 'orWhere', field, operator, value })
            return whereBuilder
          },
          andWhere (field, value) {
            clauses.push({ type: 'andWhere', field, operator: '=', value })
            return whereBuilder
          }
        }
        callback(whereBuilder)
        if (clauses.length > 0) {
          rows = rows.filter(row => {
            const searchClauses = clauses.filter(clause => clause.type !== 'andWhere')
            const andClauses = clauses.filter(clause => clause.type === 'andWhere')

            const matchesSearch = searchClauses.length === 0 || searchClauses.some(clause => {
              const haystack = String(row[clause.field] || '').toLowerCase()
              const needle = String(clause.value || '').replace(/%/g, '').toLowerCase()
              return haystack.includes(needle)
            })

            const matchesAnd = andClauses.every(clause => row[clause.field] === clause.value)

            return matchesSearch && matchesAnd
          })
        }
        return builder
      },
      andWhere (field, value) {
        rows = rows.filter(row => row[field] === value)
        return builder
      },
      orderBy (field, direction = 'asc') {
        rows.sort((a, b) => {
          const av = a[field]
          const bv = b[field]
          if (av === bv) return 0
          if (direction === 'desc') {
            return av < bv ? 1 : -1
          }
          return av > bv ? 1 : -1
        })
        return builder
      },
      offset (value) {
        rows = rows.slice(value)
        return builder
      },
      limit (value) {
        rows = rows.slice(0, value)
        return builder
      },
      count () {
        return {
          first: async () => ({ total: rows.length })
        }
      },
      then (resolve, reject) {
        const finalRows = selected ? rows.map(row => selected.reduce((acc, field) => {
          acc[field] = row[field]
          return acc
        }, {})) : rows
        return Promise.resolve(finalRows).then(resolve, reject)
      }
    }

    return builder
  }

  return vi.fn(() => makeBuilder())
}

describe('graph/resolvers/user list pagination', () => {
  let previousWiki

  beforeEach(() => {
    vi.resetModules()
    previousWiki = global.WIKI
    global.WIKI = {
      Error: {},
      auth: {
        strategies: {}
      },
      data: {
        authentication: []
      },
      events: {
        outbound: {}
      },
      models: {
        pages: {},
        users: {
          query: makeUsersQueryFactory([
            { id: 1, name: 'Alice', email: 'alice@example.com', providerKey: 'local', isSystem: false, isActive: true, createdAt: '2024-01-01', lastLoginAt: '2024-01-10' },
            { id: 2, name: 'Bob', email: 'bob@example.com', providerKey: 'github', isSystem: false, isActive: true, createdAt: '2024-01-02', lastLoginAt: '2024-01-09' },
            { id: 3, name: 'Charlie', email: 'charlie@example.com', providerKey: 'local', isSystem: false, isActive: false, createdAt: '2024-01-03', lastLoginAt: null }
          ])
        }
      }
    }
  })

  afterEach(() => {
    global.WIKI = previousWiki
  })

  it('returns paginated user results with total count', async () => {
    const { default: resolver } = await import('../../graph/resolvers/user.ts')

    const result = await resolver.UserQuery.list(null, {
      page: 2,
      pageSize: 1,
      orderBy: 'name',
      orderByDirection: 'asc'
    })

    expect(result.total).toBe(3)
    expect(result.users).toHaveLength(1)
    expect(result.users[0].name).toBe('Bob')
  })

  it('filters by search string and provider key', async () => {
    const { default: resolver } = await import('../../graph/resolvers/user.ts')

    const result = await resolver.UserQuery.list(null, {
      filter: 'alice@',
      providerKey: 'local',
      page: 1,
      pageSize: 10
    })

    expect(result.total).toBe(1)
    expect(result.users).toEqual([
      expect.objectContaining({
        name: 'Alice',
        providerKey: 'local'
      })
    ])
  })
})
