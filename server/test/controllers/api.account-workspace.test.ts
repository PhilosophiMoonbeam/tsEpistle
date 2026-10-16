import type { Server } from 'node:http'
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

const store = { list: vi.fn(), creationOptions: vi.fn(), create: vi.fn(), inspect: vi.fn(), updateProfile: vi.fn(), act: vi.fn(), setPassword: vi.fn(), remove: vi.fn() }
const welcome = vi.fn()
vi.mockModule('../../operations/account-administration.ts', import.meta.url, () => ({ accountAdministration: () => store }))
vi.mockModule('../../operations/users.ts', import.meta.url, () => ({ default: { sendWelcomeEmail: welcome } }))
let server: Server
let origin: string
const previousWiki = Reflect.get(globalThis, 'WIKI')
const checkAccess = vi.fn()
const request = (method: string, path: string, body?: unknown) => fetch(`${origin}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
})
beforeAll(async () => {
  const { default: router } = await vi.importFresh('../../controllers/api/users.ts', import.meta.url) as { default: express.Router }
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { Reflect.set(req, 'user', { id: 1 }); next() })
  app.use(router)
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP address')
  origin = `http://127.0.0.1:${address.port}`
})
beforeEach(() => {
  for (const fn of Object.values(store)) fn.mockReset()
  welcome.mockReset()
  checkAccess.mockReset().mockReturnValue(true)
  Reflect.set(globalThis, 'WIKI', { auth: { checkAccess } })
})
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  if (previousWiki === undefined) Reflect.deleteProperty(globalThis, 'WIKI')
  else Reflect.set(globalThis, 'WIKI', previousWiki)
})
describe('reviewed account workspace HTTP boundary', () => {
  it('returns a created identity only after creation completes and never sends mail implicitly', async () => {
    let finishCreate!: (identity: { id: number }) => void
    let entered!: () => void
    const creating = new Promise<void>(resolve => { entered = resolve })
    store.create.mockImplementation(() => { entered(); return new Promise<{ id: number }>(resolve => { finishCreate = resolve }) })
    let settled = false
    const pending = request('POST', '/workspace', { profile: {}, fingerprint: 'options' }).then(response => { settled = true; return response })
    await creating
    expect(settled).toBe(false)
    expect(welcome).not.toHaveBeenCalled()
    finishCreate({ id: 17 })
    const response = await pending
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ id: 17 })
    expect(welcome).not.toHaveBeenCalled()
  })
  it('denies every workspace route before reading or mutating accounts without authority', async () => {
    checkAccess.mockReturnValue(false)
    for (const [method, path] of [
      ['GET', '/workspace'], ['GET', '/workspace/creation-options'], ['POST', '/workspace'], ['GET', '/workspace/7'],
      ['PUT', '/workspace/7/profile'], ['POST', '/workspace/7/actions'], ['PUT', '/workspace/7/password'],
      ['DELETE', '/workspace/7'], ['POST', '/workspace/7/welcome-email']
    ]) {
      const response = await request(method!, path!)
      expect(response.status).toBe(403)
    }
    for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled()
    expect(welcome).not.toHaveBeenCalled()
  })
  it('rejects malformed subject identifiers before accessing the account store', async () => {
    for (const id of ['0', '-1', '7.2', '7x']) {
      const response = await request('POST', `/workspace/${id}/actions`, {})
      expect(response.status).toBe(400)
    }
    expect(store.act).not.toHaveBeenCalled()
  })
  it('preserves actionable conflicts and hides unexpected database details', async () => {
    for (const status of [400, 403, 409]) {
      store.act.mockRejectedValueOnce(Object.assign(new Error('Reload the account'), { status }))
      const response = await request('POST', '/workspace/7/actions', {})
      expect(response.status).toBe(status)
      expect(await response.json()).toEqual({ error: 'Reload the account' })
    }
    store.setPassword.mockRejectedValueOnce(new Error('SQL includes a credential hash'))
    const response = await request('PUT', '/workspace/7/password', {})
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'The password could not be replaced.' })
  })
})
