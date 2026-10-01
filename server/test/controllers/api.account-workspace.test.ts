import { beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
const store = { list: vi.fn(), creationOptions: vi.fn(), create: vi.fn(), inspect: vi.fn(), updateProfile: vi.fn(), act: vi.fn(), setPassword: vi.fn(), remove: vi.fn() }, welcome = vi.fn()
vi.mockModule('../../operations/account-administration.ts', import.meta.url, () => ({ accountAdministration: () => store }))
vi.mockModule('../../operations/users.ts', import.meta.url, () => ({ default: { sendWelcomeEmail: welcome } }))
const router = { get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }
vi.mockModule('express', import.meta.url, () => ({ default: { Router: () => router } }))
type Handler = (request: unknown, response: unknown) => Promise<void>
const handlers = new Map<string, Handler>(), response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() })
beforeAll(async () => { await vi.importFresh('../../controllers/api/users.ts', import.meta.url); for (const method of ['get','put','post','patch','delete'] as const) for (const [path, handler] of router[method].mock.calls) handlers.set(`${method} ${path}`, handler as Handler) })
beforeEach(() => { for (const fn of Object.values(store)) fn.mockReset(); welcome.mockReset(); globalThis.WIKI = { auth: { checkAccess: vi.fn().mockReturnValue(true) } } as never })
describe('reviewed account workspace transports', () => {
  it('passes requester, subject and exact review payload to each mutation', async () => {
    const user = { id: 1 }, body = { fingerprint: 'review', reason: 'Operator reviewed', profile: {}, action: 'end-sessions', replaceId: 8 }
    for (const [route, method] of [['put /workspace/:id/profile','updateProfile'],['post /workspace/:id/actions','act'],['put /workspace/:id/password','setPassword'],['delete /workspace/:id','remove']] as const) {
      await handlers.get(route)!({ user, params: { id: '7' }, body }, response()); expect(store[method]).toHaveBeenCalledWith(user, 7, body)
    }
    await handlers.get('post /workspace/:id/welcome-email')!({ user, params: { id: '7' }, body }, response()); expect(welcome).toHaveBeenCalledWith(7, user, body)
  })
  it('returns a created identity only after the creation owner completes and does not send mail implicitly', async () => {
    let finishCreate!: (identity: { id: number }) => void
    store.create.mockReturnValue(new Promise<{ id: number }>(resolve => { finishCreate = resolve }))
    const res = response(), user = { id: 1 }, body = { profile: {}, fingerprint: 'options' }
    const pending = handlers.get('post /workspace')!({ user, body }, res)
    expect(store.create).toHaveBeenCalledWith(user, body)
    expect(res.json).not.toHaveBeenCalled()
    expect(welcome).not.toHaveBeenCalled()
    finishCreate({ id: 17 })
    await pending
    expect(res.status).toHaveBeenCalledWith(201); expect(res.json).toHaveBeenCalledWith({ id: 17 }); expect(welcome).not.toHaveBeenCalled()
  })
  it('denies every workspace route before reading or mutating accounts for an unauthorized requester', async () => {
    ;(WIKI.auth.checkAccess as ReturnType<typeof vi.fn>).mockReturnValue(false)
    for (const [path, handler] of handlers) if (path.includes('/workspace')) { const res = response(); await handler({ params: { id: '7' }, query: {}, body: {} }, res); expect(res.status).toHaveBeenCalledWith(403) }
    for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled(); expect(welcome).not.toHaveBeenCalled()
  })
  it('rejects malformed subject identifiers before passing them to the account store', async () => {
    for (const id of ['0','-1','7.2','7x']) { const res = response(); await handlers.get('post /workspace/:id/actions')!({ user: { id: 1 }, params: { id }, body: {} }, res); expect(res.status).toHaveBeenCalledWith(400) }
    expect(store.act).not.toHaveBeenCalled()
  })
  it('preserves actionable conflicts and hides unexpected database details', async () => {
    for (const status of [400,403,409]) { store.act.mockRejectedValueOnce(Object.assign(new Error('Reload the account'), { status })); const res = response(); await handlers.get('post /workspace/:id/actions')!({ user: { id: 1 }, params: { id: '7' }, body: {} }, res); expect(res.status).toHaveBeenCalledWith(status); expect(res.json).toHaveBeenCalledWith({ error: 'Reload the account' }) }
    store.setPassword.mockRejectedValueOnce(new Error('SQL includes a credential hash')); const res = response(); await handlers.get('put /workspace/:id/password')!({ user: { id: 1 }, params: { id: '7' }, body: {} }, res)
    expect(res.status).toHaveBeenCalledWith(500); expect(JSON.stringify(res.json.mock.calls)).not.toContain('credential hash')
  })
})
