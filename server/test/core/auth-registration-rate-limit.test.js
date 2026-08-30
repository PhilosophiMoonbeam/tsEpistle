import createKnex from 'knex'

const router = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  use: vi.fn()
}))

vi.mockModule('express', import.meta.url, () => {
  const express = { Router: () => router }
  return { default: express, ...express }
})


class BruteTooManyAttempts extends Error {
  constructor () {
    super('Too many attempts! Try again later.')
    this.name = 'BruteTooManyAttempts'
    this.code = 1008
  }
}

const request = (ip, body = {}) => ({ body, ip, socket: { remoteAddress: ip } })
const response = () => ({
  json: vi.fn(),
  set: vi.fn(),
  status: vi.fn().mockReturnThis()
})


let knex
let register
let registerRoute
let graphResolvers

beforeEach(async () => {
  router.get.mockClear()
  router.post.mockClear()
  router.use.mockClear()
  knex = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  register = vi.fn().mockResolvedValue(undefined)
  global.WIKI = {
    Error: { BruteTooManyAttempts },
    auth: {},
    config: { api: { isEnabled: true } },
    configSvc: {},
    events: { outbound: {} },
    models: { apiKeys: {}, knex, users: { register } }
  }

  await vi.importFresh('../../controllers/api/auth.ts', import.meta.url)
  const registration = router.post.mock.calls.find(([path]) => path === '/register')
  if (!registration) throw new Error('REST registration route was not installed')
  registerRoute = registration.at(-1)

  const { default: createAuthenticationResolvers } = await vi.importFresh(
    '../../graph/resolvers/authentication.ts',
    import.meta.url
  )
  graphResolvers = createAuthenticationResolvers({
    ROOTPATH: '/tmp',
    config: { flags: { ldapdebug: false } },
    logger: { warn: vi.fn() }
  })
})

afterEach(async () => {
  await knex.destroy()
})

it('blocks GraphQL registration after REST exhausts the shared durable admission limit', async () => {
  const ip = '192.0.2.80'
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const req = request(ip, {
      email: `rest-${attempt}@example.test`,
      password: 'correct horse battery staple',
      name: 'REST User'
    })
    await registerRoute(req, response(), vi.fn())
  }

  const blocked = await graphResolvers.AuthenticationMutation.register(null, {
    email: 'graphql@example.test',
    password: 'correct horse battery staple',
    name: 'GraphQL User'
  }, { req: request(ip) })

  expect(blocked).toEqual({
    responseResult: {
      succeeded: false,
      errorCode: 1008,
      slug: 'BruteTooManyAttempts',
      message: 'Too many failed attempts. Try again later.'
    }
  })
  expect(register).toHaveBeenCalledTimes(6)
})

it('blocks REST registration after GraphQL exhausts the limit and isolates another resolved client identity', async () => {
  const ip = '192.0.2.81'
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const result = await graphResolvers.AuthenticationMutation.register(null, {
      email: `graphql-${attempt}@example.test`,
      password: 'correct horse battery staple',
      name: 'GraphQL User'
    }, { req: request(ip) })
    expect(result.responseResult.succeeded).toBe(true)
  }

  const blockedResponse = response()
  await registerRoute(request(ip, {
    email: 'rest-blocked@example.test',
    password: 'correct horse battery staple',
    name: 'REST User'
  }), blockedResponse, vi.fn())

  expect(blockedResponse.set).toHaveBeenCalledWith('Retry-After', '300')
  expect(blockedResponse.status).toHaveBeenCalledWith(429)
  expect(blockedResponse.json).toHaveBeenCalledWith({ error: 'Too many failed attempts. Try again later.' })
  expect(register).toHaveBeenCalledTimes(6)

  const otherClientResponse = response()
  await registerRoute(request('192.0.2.82', {
    email: 'rest-allowed@example.test',
    password: 'correct horse battery staple',
    name: 'Other REST User'
  }), otherClientResponse, vi.fn())

  expect(otherClientResponse.status).toHaveBeenCalledWith(201)
  expect(register).toHaveBeenCalledTimes(7)
})
