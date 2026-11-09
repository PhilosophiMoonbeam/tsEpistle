import type { Request } from 'express'
import session from 'express-session'
import type { Knex } from 'knex'
import { BrowserSessionStore } from '../../helpers/browser-session-store.ts'
import { afterEach, describe, expect, it, vi } from '../bun-test.mts'

const secret = 'browser-session-test-secret-with-at-least-thirty-two-bytes'
const unavailable = new Error('fixture transaction unavailable')
const stores: BrowserSessionStore[] = []

const createStore = (options: { cleanupInterval?: number; onDbCleanupError?: (error: unknown) => void } = {}) => {
  // This boundary deliberately fails every transaction. These tests distinguish
  // capability admission from SQL behavior; the native suite exercises real SQL.
  const transaction = vi.fn(async () => { throw unavailable })
  const knex = { schema: { hasTable: async () => true }, transaction } as unknown as Knex
  const store = new BrowserSessionStore({ knex, cleanupInterval: 0, ...options })
  stores.push(store)
  store.middleware({ secret, resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax' } })
  return { store, transaction }
}

const generate = (store: BrowserSessionStore): Request => {
  const request = { headers: {}, connection: {}, sessionStore: store } as unknown as Request
  store.generate(request)
  return request
}
const saveError = (store: BrowserSessionStore, sid: string, value: session.SessionData): Promise<unknown> => {
  const result = Promise.withResolvers<unknown>()
  store.set(sid, value, error => result.resolve(error))
  return result.promise
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()))
  vi.useRealTimers()
})

describe('native browser-session creation capabilities', () => {
  it('admits only the real generated Session, not its serialized clone or an arbitrary payload', async () => {
    const { store, transaction } = createStore()
    const request = generate(store)
    const original = request.session
    expect(request.sessionID).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(original.cookie.httpOnly).toBe(true)
    expect(original.cookie.sameSite).toBe('lax')
    expect(original.cookie.expires).toBeNull()
    const copy = JSON.parse(JSON.stringify(original)) as session.SessionData
    expect(Object.keys(copy)).toEqual(['cookie'])

    expect(await saveError(store, request.sessionID, original)).toBe(unavailable)
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(await saveError(store, request.sessionID, copy)).toMatchObject({ code: 'BROWSER_SESSION_RETIRED' })
    expect(await saveError(store, 'unmarked-sid', { cookie: new session.Cookie() })).toMatchObject({ code: 'BROWSER_SESSION_RETIRED' })
    expect(transaction).toHaveBeenCalledTimes(1)
  })

  it('marks native regeneration without copying the old browser state or capabilities', async () => {
    const { store, transaction } = createStore()
    const request = generate(store)
    const original = request.session
    Object.assign(original, { browserWorkflow: 'old-state' })
    vi.spyOn(store, 'destroy').mockImplementation((_sid, callback) => { callback?.() })

    const regenerated = Promise.withResolvers<void>()
    original.regenerate(error => error ? regenerated.reject(error) : regenerated.resolve())
    await regenerated.promise
    expect(request.session).not.toBe(original)
    expect(request.sessionID).not.toBe(original.id)
    expect(Reflect.get(request.session, 'browserWorkflow')).toBeUndefined()
    expect(await saveError(store, request.sessionID, request.session)).toBe(unavailable)
    expect(transaction).toHaveBeenCalledTimes(1)
  })

  it('expires never-saved creation authority before a retirement tombstone can age out', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-08T00:00:00.000Z'))
    const { store, transaction } = createStore()
    const request = generate(store)
    vi.setSystemTime(new Date('2026-11-09T00:00:00.001Z'))
    expect(await saveError(store, request.sessionID, request.session)).toMatchObject({ code: 'BROWSER_SESSION_RETIRED' })
    expect(transaction).not.toHaveBeenCalled()
  })

  it('does not reinterpret unmarked loaded JSON or another store instance as fresh creation', async () => {
    const first = createStore()
    const second = createStore()
    const request = generate(first.store)
    expect(() => first.store.createSession(request, { cookie: new session.Cookie() })).toThrow('The browser session is no longer current.')
    expect(await saveError(second.store, request.sessionID, request.session)).toMatchObject({ code: 'BROWSER_SESSION_RETIRED' })
    expect(second.transaction).not.toHaveBeenCalled()
  })

  it('reports cleanup failures and keeps one default 60000ms timer that close cancels', async () => {
    vi.useFakeTimers()
    const onDbCleanupError = vi.fn()
    const { store } = createStore({ cleanupInterval: undefined, onDbCleanupError })
    await store.ready
    await vi.advanceTimersByTimeAsync(0)
    expect(onDbCleanupError).toHaveBeenCalledTimes(1)
    expect(onDbCleanupError).toHaveBeenLastCalledWith(unavailable)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(onDbCleanupError).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(onDbCleanupError).toHaveBeenCalledTimes(2)
    await store.close()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onDbCleanupError).toHaveBeenCalledTimes(2)
  })
})
