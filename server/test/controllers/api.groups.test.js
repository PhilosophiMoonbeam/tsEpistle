import { beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
const operations = Object.fromEntries(['create','list','listPickerOptions','get','listUsers','assignUser','unassignUser','update','remove'].map(name => [name, vi.fn()]))
vi.mockModule('../../operations/groups.ts', import.meta.url, () => ({ default: operations }))
const router = { get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }
vi.mockModule('express', import.meta.url, () => ({ default: { Router: () => router } }))
const handlers = new Map(), res = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() }), user = { id: 7, permissions: ['manage:groups'] }
let graph
beforeAll(async () => { await vi.importFresh('../../controllers/api/groups.ts', import.meta.url); for (const method of Object.keys(router)) for (const [path, handler] of router[method].mock.calls) handlers.set(`${method} ${path}`, handler); graph = (await vi.importFresh('../../graph/resolvers/group.ts', import.meta.url)).default })
beforeEach(() => { for (const fn of Object.values(operations)) fn.mockReset(); globalThis.WIKI = { auth: { checkAccess: vi.fn().mockReturnValue(true) } }; operations.create.mockResolvedValue({ id: 3, name: 'Editors', isSystem: false }); operations.listPickerOptions.mockResolvedValue([]); operations.list.mockResolvedValue([]); operations.listUsers.mockResolvedValue([]) })
describe('legacy group REST and GraphQL boundaries', () => {
  it('passes requester identity through every GraphQL lifecycle mutation, including creation', async () => {
    const context = { req: { user } }
    for (const [method, args, operation, expected] of [['create',{ name: 'Editors' },'create',['Editors',user]],['assignUser',{ groupId: 3, userId: 10 },'assignUser',[{ requester: user, groupId: 3, userId: 10 }]],['unassignUser',{ groupId: 3, userId: 10 },'unassignUser',[{ requester: user, groupId: 3, userId: 10 }]],['delete',{ id: 3 },'remove',[{ requester: user, id: 3 }]],['update',{ id: 3, name: 'Editors' },'update',[{ requester: user, id: 3, name: 'Editors' }]]]) { await graph.GroupMutation[method](null, args, context); expect(operations[operation]).toHaveBeenCalledWith(...expected) }
  })
  it('normalizes create names and returns only the created identity fields', async () => {
    operations.create.mockResolvedValue({ id: 3, name: 'Editors', isSystem: false, secret: 'PRIVATE' })
    const response = res(); await handlers.get('post /')({ user, body: { name: ' Editors ' } }, response, vi.fn()); expect(operations.create).toHaveBeenCalledWith('Editors', user); expect(response.json).toHaveBeenCalledWith({ succeeded: true, message: 'Group created successfully.', group: { id: 3, name: 'Editors', isSystem: false } })
  })
  it('keeps picker, directory and detail metadata allowlisted', async () => {
    const row = { id: 3, name: 'Editors', isSystem: 0, userCount: '2', permissions: ['read:pages',9], pageRules: [{ id: 'r', path: '', match: 'START', roles: ['read:pages',9], locales: ['en',9], deny: 0, secret: 'PRIVATE' }], secret: 'PRIVATE' }
    operations.listPickerOptions.mockResolvedValue([row]); operations.list.mockResolvedValue([row]); operations.get.mockResolvedValue(row); operations.listUsers.mockResolvedValue([{ id: 10, name: 'Alice', email: 'alice@example.invalid', password: 'PRIVATE' }])
    const expected = [
      ['get /', [{ id: 3, name: 'Editors', isSystem: false }]],
      ['get /list', [{ id: 3, name: 'Editors', isSystem: false, userCount: 2, createdAt: undefined, updatedAt: undefined }]],
      ['get /:id', { id: 3, name: 'Editors', redirectOnLogin: undefined, isSystem: false, permissions: ['read:pages'], pageRules: [{ id: 'r', path: '', match: 'START', roles: ['read:pages'], locales: ['en'], deny: false }], users: [{ id: 10, name: 'Alice', email: 'alice@example.invalid' }], createdAt: undefined, updatedAt: undefined }]
    ]
    for (const [route, payload] of expected) { const response = res(); await handlers.get(route)({ user, params: { id: '3' } }, response, vi.fn()); expect(response.json).toHaveBeenCalledWith(payload); expect(JSON.stringify(response.json.mock.calls)).not.toContain('PRIVATE') }
    expect(operations.get).toHaveBeenCalledWith(3)
  })
  it('enforces route-specific permissions, including picker-only callers', async () => {
    WIKI.auth.checkAccess.mockImplementation((_user, permissions) => permissions.includes('manage:api'))
    const picker = res(); await handlers.get('get /')({ user }, picker, vi.fn()); expect(picker.json).toHaveBeenCalledWith([]); expect(picker.status).not.toHaveBeenCalled()
    for (const route of ['get /list','get /:id','post /','patch /:id','delete /:id','post /:groupId/users/:userId','delete /:groupId/users/:userId']) { const response = res(); await handlers.get(route)({ user, params: { id: '3', groupId: '3', userId: '10' }, body: {} }, response, vi.fn()); expect(response.status).toHaveBeenCalledWith(403) }
    for (const operation of ['list','get','create','update','remove','assignUser','unassignUser','listUsers']) expect(operations[operation]).not.toHaveBeenCalled()
  })
  it('passes requester and integer targets through membership and deletion routes', async () => {
    for (const [route, operation, expected] of [['post /:groupId/users/:userId','assignUser',{ requester: user, groupId: 3, userId: 10 }],['delete /:groupId/users/:userId','unassignUser',{ requester: user, groupId: 3, userId: 10 }],['delete /:id','remove',{ requester: user, id: 3 }]]) { await handlers.get(route)({ user, params: { id: '3', groupId: '3', userId: '10' } }, res(), vi.fn()); expect(operations[operation]).toHaveBeenCalledWith(expected) }
  })
  it('rejects malformed subjects and blank names before calling operations', async () => {
    for (const id of ['0','-1','3x','3.2']) for (const route of ['get /:id','patch /:id','delete /:id','post /:groupId/users/:userId','delete /:groupId/users/:userId']) { const response = res(); await handlers.get(route)({ user, params: { id, groupId: id, userId: id }, body: {} }, response, vi.fn()); expect(response.status).toHaveBeenCalledWith(400) }
    for (const userId of ['0','-1','3x','3.2']) for (const route of ['post /:groupId/users/:userId','delete /:groupId/users/:userId']) { const response = res(); await handlers.get(route)({ user, params: { groupId: '3', userId } }, response, vi.fn()); expect(response.status).toHaveBeenCalledWith(400) }
    for (const operation of ['get','update','remove','assignUser','unassignUser']) expect(operations[operation]).not.toHaveBeenCalled()
    const response = res(); await handlers.get('post /')({ user, body: { name: '   ' } }, response, vi.fn()); expect(response.status).toHaveBeenCalledWith(400); expect(operations.create).not.toHaveBeenCalled()
  })
  it('validates structured page rules and defaults a blank sign-in destination', async () => {
    const body = { name: 'Editors', permissions: ['read:pages'], pageRules: [{ id: 'r', match: 'START', path: '', deny: false, roles: ['read:pages'], locales: [] }], redirectOnLogin: '' }
    await handlers.get('patch /:id')({ user, params: { id: '3' }, body }, res(), vi.fn()); expect(operations.update).toHaveBeenCalledWith({ requester: user, id: 3, ...body, redirectOnLogin: '/' })
    for (const changes of [{ name: '' },{ permissions: [2] },{ pageRules: 'bad' },...['id','match','path','deny','roles','locales'].map(key => ({ pageRules: [{ ...body.pageRules[0], [key]: null }] })),{ pageRules: [{ ...body.pageRules[0], match: 'REGEX', path: '[' }] }]) { const response = res(); await handlers.get('patch /:id')({ user, params: { id: '3' }, body: { ...body, ...changes } }, response, vi.fn()); expect(response.status).toHaveBeenCalledWith(400) }
  })
  it('preserves operation authority, missing-target and conflict responses', async () => {
    for (const status of [400,403,404,409]) for (const [route, operation] of [['post /:groupId/users/:userId','assignUser'],['delete /:groupId/users/:userId','unassignUser'],['delete /:id','remove']]) { operations[operation].mockRejectedValueOnce(Object.assign(new Error('Action rejected'), { status })); const response = res(); await handlers.get(route)({ user, params: { id: '3', groupId: '3', userId: '10' } }, response, vi.fn()); expect(response.status).toHaveBeenCalledWith(status); expect(response.json).toHaveBeenCalledWith({ error: 'Action rejected' }) }
  })
  it('returns missing detail and forwards unexpected service failures', async () => {
    const response = res(); await handlers.get('get /:id')({ user, params: { id: '3' } }, response, vi.fn()); expect(response.status).toHaveBeenCalledWith(404)
    for (const [route, operation] of [['get /','listPickerOptions'],['get /list','list'],['get /:id','get'],['post /','create'],['delete /:id','remove']]) { const error = new Error('service unavailable'), next = vi.fn(); operations[operation].mockRejectedValueOnce(error); await handlers.get(route)({ user, params: { id: '3' }, body: { name: 'Editors' } }, res(), next); expect(next).toHaveBeenCalledWith(error) }
  })
})
