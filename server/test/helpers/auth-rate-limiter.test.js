import createKnex from 'knex'
import { createAuthRateLimiter } from '../../helpers/auth-rate-limiter.ts'

const request = ip => ({ ip, socket: { remoteAddress: ip } })

const invoke = async (limiter, req) => {
  const next = vi.fn()
  await limiter.middleware(req, {}, next)
  return next
}

describe('auth rate limiter', () => {
  let knex
  let limiter
  let onLimit
  let now

  beforeEach(() => {
    now = Date.UTC(2026, 0, 1)
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    knex = createKnex({
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    onLimit = vi.fn()
    limiter = createAuthRateLimiter({ knex, keyPrefix: 'auth-test', onLimit })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await knex.destroy()
  })

  it('allows an initial attempt and five free retries per client before blocking', async () => {
    const firstClient = request('192.0.2.10')
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect(await invoke(limiter, firstClient)).toHaveBeenCalledOnce()
    }

    expect(await invoke(limiter, firstClient)).not.toHaveBeenCalled()
    expect(onLimit).toHaveBeenLastCalledWith(firstClient, {}, 5 * 60 * 1000)

    const secondClient = request('192.0.2.11')
    expect(await invoke(limiter, secondClient)).toHaveBeenCalledOnce()
  })

  it('does not extend an active block and escalates waits up to one hour', async () => {
    const req = request('192.0.2.20')
    for (let attempt = 0; attempt < 6; attempt += 1) await invoke(limiter, req)

    await invoke(limiter, req)
    now += 60 * 1000
    await invoke(limiter, req)
    expect(onLimit).toHaveBeenLastCalledWith(req, {}, 4 * 60 * 1000)

    now += 4 * 60 * 1000 + 1
    expect(await invoke(limiter, req)).toHaveBeenCalledOnce()
    await invoke(limiter, req)
    expect(onLimit).toHaveBeenLastCalledWith(req, {}, 5 * 60 * 1000)

    now += 5 * 60 * 1000 + 1
    expect(await invoke(limiter, req)).toHaveBeenCalledOnce()
    await invoke(limiter, req)
    expect(onLimit).toHaveBeenLastCalledWith(req, {}, 10 * 60 * 1000)

    for (const waitMinutes of [10, 15, 25, 40, 60, 60]) {
      now += waitMinutes * 60 * 1000 + 1
      expect(await invoke(limiter, req)).toHaveBeenCalledOnce()
      await invoke(limiter, req)
    }
    expect(onLimit.mock.calls.at(-1)[2]).toBe(60 * 60 * 1000)
  })

  it('deletes persisted attempt and block state when reset', async () => {
    const req = request('192.0.2.30')
    for (let attempt = 0; attempt < 6; attempt += 1) await invoke(limiter, req)
    expect(await invoke(limiter, req)).not.toHaveBeenCalled()

    await limiter.reset(req)

    onLimit.mockClear()
    expect(await invoke(limiter, req)).toHaveBeenCalledOnce()
    expect(onLimit).not.toHaveBeenCalled()
  })
})
