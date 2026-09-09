import { DateTime } from 'luxon'
import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from '../bun-test.mts'
let principal: unknown, info: unknown
const verify = vi.fn()
vi.mockModule('jsonwebtoken', import.meta.url, () => ({ default: { verify, decode: vi.fn() } }))
vi.mockModule('passport', import.meta.url, () => ({ default: { authenticate: (_name: string, _options: unknown, callback: (error: unknown, user: unknown, info: unknown) => unknown) => () => callback(null, principal, info), serializeUser: vi.fn(), deserializeUser: vi.fn() } }))
const { default: auth } = await vi.importFresh('../../core/auth.ts', import.meta.url)
const currentClaims = () => ({ id: 7, iat: Math.floor(Date.now() / 1000), groups: [3], permissions: ['read:pages'], authVersion: 0 })
const account = () => ({ id: 7, isActive: true, authVersion: 0, groups: [3], getGlobalPermissions: () => ['read:pages'], getGroups: () => [3] })
let findById: ReturnType<typeof vi.fn>, refreshToken: ReturnType<typeof vi.fn>
beforeEach(() => {
  principal = currentClaims(); info = null; verify.mockReset()
  findById = vi.fn().mockResolvedValue(account()); refreshToken = vi.fn().mockResolvedValue({ token: 'replacement', user: account() })
  auth.guest = { id: 2, permissions: [], groups: [], cacheExpiration: DateTime.utc().plus({ days: 1 }) }
  auth.revocationList.flushAll()
  globalThis.WIKI = { configSvc: {}, events: {}, lang: {}, config: { api: { isEnabled: true }, auth: { tokenExpiration: '30m', tokenRenewal: '15m', audience: 'urn:test' }, certs: { public: 'PUBLIC-KEY' }, host: 'https://wiki.example.invalid' }, models: { users: { query: () => ({ findById }), refreshToken } }, logger: { warn: vi.fn() }, startedAt: DateTime.utc().minus({ days: 1 }) } as never
})
const run = async () => {
  const next = vi.fn(), req = { path: '/_api/users', originalUrl: '/_api/users', headers: {}, cookies: { jwt: 'signed-token' }, get: (name: string) => name.toLowerCase() === 'content-type' ? 'application/json' : undefined, logIn: vi.fn((_user: unknown, _options: unknown, done: () => void) => done()) } as unknown as Request
  const res = { set: vi.fn(), cookie: vi.fn() } as unknown as Response
  auth.authenticate(req, res, next); await vi.waitFor(() => expect(next).toHaveBeenCalledOnce()); return { req, res, next }
}
describe('HTTP session authority and safe renewal', () => {
  it('checks the persisted account generation even for a fresh token', async () => {
    const { req, next } = await run(); expect(findById).toHaveBeenCalledWith(7); expect(req.authContext).toMatchObject({ kind: 'user', userId: 7 }); expect(next).toHaveBeenCalledWith(); expect(refreshToken).not.toHaveBeenCalled()
  })
  it('treats a revoked or inactive account session as guest without renewing it', async () => {
    for (const value of [{ ...account(), authVersion: 1 }, { ...account(), isActive: false }]) { findById.mockResolvedValue(value); const { req } = await run(); expect(req.authContext).toMatchObject({ kind: 'guest' }); expect(req.logIn).not.toHaveBeenCalled(); expect(refreshToken).not.toHaveBeenCalled() }
  })
  it('verifies an expired token and carries its generation into the renewal transaction boundary', async () => {
    principal = false; info = { name: 'TokenExpiredError', expiredAt: new Date(Date.now() - 10000) }; verify.mockReturnValue(currentClaims())
    const { req, res } = await run(); expect(verify).toHaveBeenCalledWith('signed-token', 'PUBLIC-KEY', { audience: 'urn:test', issuer: 'urn:wiki.js', algorithms: ['RS256'], ignoreExpiration: true }); expect(refreshToken).toHaveBeenCalledWith(7, { expectedAuthVersion: 0 }); expect(res.cookie).toHaveBeenCalledWith('jwt', 'replacement', expect.any(Object)); expect(res.set).toHaveBeenCalledWith('x-wiki-auth-refreshed', '1'); expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store'); expect(req.authContext).toMatchObject({ kind: 'user' })
  })
  it('does not renew a token whose signature fails or whose generation was revoked', async () => {
    principal = false; info = { name: 'TokenExpiredError', expiredAt: new Date(Date.now() - 10000) }; verify.mockImplementationOnce(() => { throw new Error('invalid signature') })
    expect((await run()).req.authContext).toMatchObject({ kind: 'guest' }); expect(findById).not.toHaveBeenCalled(); expect(refreshToken).not.toHaveBeenCalled()
    verify.mockReturnValue(currentClaims()); findById.mockResolvedValue({ ...account(), authVersion: 1 }); expect((await run()).req.authContext).toMatchObject({ kind: 'guest' }); expect(refreshToken).not.toHaveBeenCalled()
  })
  it('does not issue a replacement when account state changes during renewal', async () => {
    principal = false; info = { name: 'TokenExpiredError', expiredAt: new Date(Date.now() - 10000) }; verify.mockReturnValue(currentClaims()); refreshToken.mockRejectedValue(new Error('session generation changed'))
    const { req, res } = await run(); expect(req.authContext).toBeUndefined(); expect(res.set).not.toHaveBeenCalled(); expect(req.logIn).not.toHaveBeenCalled()
  })
  it('fails closed when account authority cannot be read', async () => {
    const failure = new Error('database unavailable'); findById.mockRejectedValue(failure); const { req, next } = await run(); expect(next).toHaveBeenCalledWith(failure); expect(req.logIn).not.toHaveBeenCalled()
  })
})
