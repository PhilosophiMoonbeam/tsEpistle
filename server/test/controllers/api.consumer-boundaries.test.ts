import express from 'express'
import createKnex from 'knex'
import type { Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { configureTransportRuntime, getTransportRuntime } from '../../controllers/_types.ts'
import { createOriginMiddleware } from '../../middlewares/origin.ts'
import errors from '../../operations/errors.ts'

const resizeImage = vi.fn(), previewImage = vi.fn(), previewMove = vi.fn(), relocate = vi.fn()
vi.mockModule('../../operations/assets.ts', import.meta.url, () => ({ default: { resizeImage, previewImage, previewMove, relocate } }))
const originalWiki = Object.getOwnPropertyDescriptor(globalThis, 'WIKI')
const originalRuntime = getTransportRuntime<object>()
const db = createKnex({
  client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true,
  postProcessResponse(result: unknown): unknown {
    if (Array.isArray(result)) return result.map(row => {
      if (!row || typeof row !== 'object') return row
      if (Object.hasOwn(row, 'isActive')) Reflect.set(row, 'isActive', Reflect.get(row, 'isActive') === 1)
      if (typeof Reflect.get(row, 'permissions') === 'string') Reflect.set(row, 'permissions', JSON.parse(Reflect.get(row, 'permissions')))
      return row
    })
    if (result && typeof result === 'object' && Object.hasOwn(result, 'isActive')) Reflect.set(result, 'isActive', Reflect.get(result, 'isActive') === 1)
    return result
  }
})
let allowed = true
const actor = { id: 7, name: 'Administrator', email: 'admin@example.com', authVersion: 3 }
const checkAccess = vi.fn((user: unknown) => allowed && user !== undefined)
const wiki = {
  ROOTPATH: fileURLToPath(new URL('../../../', import.meta.url)),
  SERVERPATH: fileURLToPath(new URL('../../', import.meta.url)),
  config: { lang: { code: 'en', namespacing: false, namespaces: [] }, db: { type: 'sqlite' }, sessionSecret: 'consumer-boundary-session-key' },
  models: { knex: db }, data: {}, cache: { get: async () => [] }, auth: { checkAccess },
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
}
const digest = 'a'.repeat(64)
const revision = 'b'.repeat(64)
const resizeRequest = {
  destination: { filename: 'copy.png', folderId: 0 }, width: 12, height: 8,
  aspectPolicy: 'preserve', format: 'png', quality: 90, animationPolicy: 'first-frame'
}
const operations = [
  { type: 'crop', left: 1, top: 2, width: 8, height: 6 },
  { type: 'rotate', turns: 1 },
  { type: 'mirror', axis: 'horizontal' },
  { type: 'fill', left: 0, top: 0, width: 2, height: 3, color: '#1234aB' }
]
const previewReceipt = { status: 'previewed', dataUrl: 'data:image/png;base64,cHJldmlldw==', sourceSha256: digest, sourceRevision: revision, width: 12, height: 8, editWidth: 6, editHeight: 8, frames: 1, format: 'png' }
const saveReceipt = { status: 'succeeded', assetId: 19, destinationPath: 'copy.png', sourceSha256: digest, width: 12, height: 8, frames: 1, format: 'png', fileSize: 123 }
const ceilings = {
  pageCreated: 'off', pageDeleted: 'in-app-only', watchedPageComment: 'existing-consented-channels',
  commentReply: 'off', mention: 'in-app-only', pageWatch: 'off',
  feedbackStatus: 'existing-consented-channels', reviewReminder: 'existing-consented-channels',
  pageLifecycle: 'existing-consented-channels'
}
let server: Server | undefined, origin: string
const request = (method: string, path: string, body?: unknown, options: { authenticated?: boolean; sourceOrigin?: string } = {}) => fetch(`${origin}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', Origin: options.sourceOrigin ?? origin, ...(options.authenticated === false ? {} : { Cookie: 'consumer-session=authorized' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
})

beforeAll(async () => {
  await db.schema.createTable('groups', table => { table.integer('id').primary(); table.json('permissions').notNullable() })
  await db.schema.createTable('users', table => { table.integer('id').primary(); table.boolean('isActive').notNullable(); table.integer('authVersion').notNullable() })
  await db.schema.createTable('userGroups', table => { table.integer('userId').notNullable(); table.integer('groupId').notNullable() })
  await db.schema.createTable('settings', table => { table.string('key').primary(); table.text('value').notNullable(); table.string('updatedAt').notNullable() })
  Reflect.set(globalThis, 'WIKI', wiki)
  configureTransportRuntime(wiki)
  // The API graph captures WIKI at module load, after the complete fixture must be installed.
  const { default: router } = await import('../../controllers/api/index.ts')
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    if (req.get('Cookie') === 'consumer-session=authorized') {
      Reflect.set(req, 'user', actor)
      Reflect.set(req, 'sessionID', 'consumer-session')
    }
    next()
  })
  app.use(createOriginMiddleware(() => origin))
  app.use('/_api', router)
  server = app.listen(0, '127.0.0.1')
  const listening = Promise.withResolvers<void>()
  server.once('listening', listening.resolve)
  server.once('error', listening.reject)
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP address')
  origin = `http://127.0.0.1:${address.port}`
})
beforeEach(async () => {
  allowed = true
  checkAccess.mockClear()
  resizeImage.mockReset().mockResolvedValue(saveReceipt)
  previewImage.mockReset().mockResolvedValue(previewReceipt)
  previewMove.mockReset().mockResolvedValue({ sourcePath: 'source.png', destinationPath: 'folder/source.png' })
  relocate.mockReset()
  await db('settings').delete(); await db('userGroups').delete(); await db('users').delete(); await db('groups').delete()
  await db('groups').insert({ id: 4, permissions: JSON.stringify(['manage:system']) })
  await db('users').insert({ id: actor.id, isActive: true, authVersion: actor.authVersion })
  await db('userGroups').insert({ userId: actor.id, groupId: 4 })
})
afterAll(async () => {
  try {
    if (server?.listening) {
      const closed = Promise.withResolvers<void>()
      server.close(error => error ? closed.reject(error) : closed.resolve())
      await closed.promise
    }
  } finally {
    await db.destroy()
    configureTransportRuntime(originalRuntime)
    if (originalWiki) Object.defineProperty(globalThis, 'WIKI', originalWiki)
    else Reflect.deleteProperty(globalThis, 'WIKI')
  }
})

describe('mounted image edit API boundary', () => {
  it('forwards ordered strict edits and preview digest, returning the operation receipts unchanged', async () => {
    const preview = await request('POST', '/_api/assets/9/resize-preview', { ...resizeRequest, operations })
    expect(preview.status).toBe(200)
    expect(preview.headers.get('cache-control')).toBe('private, no-store')
    expect(await preview.json()).toEqual(previewReceipt)
    expect(previewImage).toHaveBeenCalledWith({ ...resizeRequest, operations, requester: actor, id: 9 })
    const saved = await request('POST', '/_api/assets/9/resize', { ...resizeRequest, operations, expectedSourceSha256: digest, expectedSourceRevision: revision })
    expect(saved.status).toBe(201)
    expect(await saved.json()).toEqual(saveReceipt)
    expect(resizeImage).toHaveBeenCalledWith({ ...resizeRequest, operations, expectedSourceSha256: digest, expectedSourceRevision: revision, requester: actor, id: 9 })
  })
  it('retains resize without edits or a preview digest and accepts all supported quarter turns and mirror axes', async () => {
    expect((await request('POST', '/_api/assets/9/resize', resizeRequest)).status).toBe(201)
    const edits = [{ type: 'rotate', turns: 2 }, { type: 'rotate', turns: 3 }, { type: 'mirror', axis: 'vertical' }]
    expect((await request('POST', '/_api/assets/9/resize-preview', { ...resizeRequest, operations: edits })).status).toBe(200)
    expect(previewImage).toHaveBeenCalledWith(expect.objectContaining({ operations: edits }))
    const maximumEdits = Array.from({ length: 16 }, () => ({ type: 'rotate', turns: 1 }))
    expect((await request('POST', '/_api/assets/9/resize-preview', { ...resizeRequest, operations: maximumEdits, expectedSourceSha256: digest, expectedSourceRevision: revision })).status).toBe(200)
    expect(previewImage).toHaveBeenLastCalledWith({ ...resizeRequest, operations: maximumEdits, expectedSourceSha256: digest, expectedSourceRevision: revision, requester: actor, id: 9 })
  })
  it('rejects untrusted edit shapes, excessive lists and bad digest before either operation', async () => {
    const invalidEdits = [null, {}, Array(17).fill({ type: 'rotate', turns: 1 }), [null], [{ type: 'rotate', turns: 0 }], [{ type: 'rotate', turns: 1, angle: 90 }], [{ type: 'mirror', axis: 'diagonal' }], [{ type: 'crop', left: -1, top: 0, width: 1, height: 1 }], [{ type: 'crop', left: 0.5, top: 0, width: 1, height: 1 }], [{ type: 'crop', left: 0, top: 0, width: 0, height: 1 }], [{ type: 'fill', left: 0, top: 0, width: 1, height: 1, color: '#1234' }], [{ type: 'fill', left: 0, top: 0, width: 1, height: 1, color: '#123456', opacity: 0.5 }], [{ type: 'crop', left: '0', top: 0, width: 1, height: 1 }], [{ type: 'crop', left: null, top: 0, width: 1, height: 1 }]]
    for (const route of ['resize', 'resize-preview']) {
      for (const invalid of invalidEdits) expect((await request('POST', `/_api/assets/9/${route}`, { ...resizeRequest, operations: invalid })).status).toBe(400)
      for (const extra of [{ replace: true }, { expectedSourceSha256: 'not-a-digest' }, { expectedSourceRevision: 'not-a-revision' }, { destination: { filename: 'copy.png', folderId: 0, overwrite: true } }]) {
        expect((await request('POST', `/_api/assets/9/${route}`, { ...resizeRequest, ...extra })).status).toBe(400)
      }
    }
    expect((await request('POST', '/_api/assets/9/resize', { ...resizeRequest, operations })).status).toBe(400)
    expect((await request('POST', '/_api/assets/9/resize', { ...resizeRequest, operations, expectedSourceSha256: digest })).status).toBe(400)
    expect((await request('POST', '/_api/assets/9/resize', { ...resizeRequest, operations, expectedSourceRevision: revision })).status).toBe(400)
    expect(resizeImage).not.toHaveBeenCalled(); expect(previewImage).not.toHaveBeenCalled()
  })
  it('denies missing authority and cross-origin mutation before decoding or saving', async () => {
    for (const route of ['resize', 'resize-preview']) {
      expect((await request('POST', `/_api/assets/9/${route}`, resizeRequest, { authenticated: false })).status).toBe(403)
      expect((await request('POST', `/_api/assets/9/${route}`, resizeRequest, { sourceOrigin: 'https://attacker.example' })).status).toBe(403)
      allowed = false
      expect((await request('POST', `/_api/assets/9/${route}`, resizeRequest)).status).toBe(403)
      allowed = true
    }
    expect(resizeImage).not.toHaveBeenCalled(); expect(previewImage).not.toHaveBeenCalled()
  })
  it('preserves source stale and denied errors from the authoritative operations', async () => {
    resizeImage.mockRejectedValueOnce(new errors.ApplicationError('The source changed. Preview again.', { status: 409, code: 'ASSET_IMAGE_SOURCE_STALE' }))
    const stale = await request('POST', '/_api/assets/9/resize', { ...resizeRequest, operations, expectedSourceSha256: digest, expectedSourceRevision: revision })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: 'The source changed. Preview again.' })
    previewImage.mockRejectedValueOnce(new errors.ApplicationError('This asset does not exist.', { status: 404 }))
    expect((await request('POST', '/_api/assets/9/resize-preview', resizeRequest)).status).toBe(404)
  })
})

describe('mounted asset move preselection boundary', () => {
  it('returns the authorized source and destination without executing relocation', async () => {
    const response = await request('POST', '/_api/assets/9/move-preview', { folderId: 4 })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ sourcePath: 'source.png', destinationPath: 'folder/source.png' })
    expect(previewMove).toHaveBeenCalledWith({ requester: actor, id: 9, folderId: 4 })
    expect(checkAccess).toHaveBeenCalledWith(actor, ['manage:assets'])
    expect(relocate).not.toHaveBeenCalled()
  })
  it('rejects unsupported destinations, malformed identifiers, denied authority and cross-origin requests', async () => {
    for (const body of [null, [], {}, { folderId: null }, { folderId: -1 }, { folderId: 1.5 }, { folderId: '4' }, { folderId: 4, filename: 'replace.png' }]) {
      expect((await request('POST', '/_api/assets/9/move-preview', body)).status).toBe(400)
    }
    expect((await request('POST', '/_api/assets/0/move-preview', { folderId: 4 })).status).toBe(400)
    expect((await request('POST', '/_api/assets/9/move-preview', { folderId: 4 }, { authenticated: false })).status).toBe(403)
    expect((await request('POST', '/_api/assets/9/move-preview', { folderId: 4 }, { sourceOrigin: 'https://attacker.example' })).status).toBe(403)
    allowed = false
    expect((await request('POST', '/_api/assets/9/move-preview', { folderId: 4 })).status).toBe(403)
    expect(previewMove).not.toHaveBeenCalled()
    expect(relocate).not.toHaveBeenCalled()
  })
  it('preserves fresh authority denials and collisions using existing relocation errors', async () => {
    for (const [name, status] of [['AssetRenameTargetForbidden', 403], ['AssetRenameCollision', 409]] as const) {
      previewMove.mockRejectedValueOnce(Object.assign(new Error('private diagnostic'), { name }))
      const response = await request('POST', '/_api/assets/9/move-preview', { folderId: 4 })
      expect(response.status).toBe(status)
      expect(await response.json()).toEqual({ error: expect.not.stringContaining('private diagnostic') })
    }
    expect(relocate).not.toHaveBeenCalled()
  })
})

describe('mounted notification ceilings API boundary', () => {
  it('reads and saves every category through the live authoritative operation', async () => {
    const inspected = await request('GET', '/_api/site/notification-settings')
    expect(inspected.status).toBe(200)
    expect(inspected.headers.get('cache-control')).toBe('private, no-store')
    const current = await inspected.json()
    expect(current.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    const saved = await request('PUT', '/_api/site/notification-settings', { ceilings, fingerprint: current.fingerprint })
    expect(saved.status).toBe(200)
    const receipt = await saved.json()
    expect(receipt.ceilings).toEqual(ceilings)
    expect(receipt.fingerprint).not.toBe(current.fingerprint)
    expect(await (await request('GET', '/_api/site/notification-settings')).json()).toEqual(receipt)
    const stale = await request('PUT', '/_api/site/notification-settings', { ceilings: current.ceilings, fingerprint: current.fingerprint })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: 'Notification settings changed. Reload before saving.' })
    expect(await (await request('GET', '/_api/site/notification-settings')).json()).toEqual(receipt)
  })
  it('rejects a literal null body at HTTP admission without persisting settings', async () => {
    const response = await request('PUT', '/_api/site/notification-settings', null)
    expect(response.status).toBe(400)
    // The mounted body parser rejects null before the API router; its error representation is not a route contract.
    expect(await db('settings')).toHaveLength(0)
  })
  it('rejects routed invalid settings and category values without persisting settings', async () => {
    for (const body of [[], { ceilings: {} }, { ceilings: { ...ceilings, mention: 'email' } }, { ceilings: { ...ceilings, invented: 'off' } }]) {
      const response = await request('PUT', '/_api/site/notification-settings', body)
      expect(response.status).toBe(400)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(await response.json()).toEqual({ error: expect.any(String) })
      expect(await db('settings')).toHaveLength(0)
    }
  })
  it('requires current system authority and same-origin writes, not cached admin claims', async () => {
    for (const method of ['GET', 'PUT']) {
      expect((await request(method, '/_api/site/notification-settings', method === 'PUT' ? { ceilings } : undefined, { authenticated: false })).status).toBe(403)
    }
    expect((await request('PUT', '/_api/site/notification-settings', { ceilings }, { sourceOrigin: 'https://attacker.example' })).status).toBe(403)
    await db('userGroups').delete()
    expect((await request('GET', '/_api/site/notification-settings')).status).toBe(403)
    expect((await request('PUT', '/_api/site/notification-settings', { ceilings, fingerprint: digest })).status).toBe(403)
    await db('userGroups').insert({ userId: actor.id, groupId: 4 })
    await db('users').where('id', actor.id).update({ authVersion: actor.authVersion + 1 })
    expect((await request('GET', '/_api/site/notification-settings')).status).toBe(403)
    expect(await db('settings')).toHaveLength(0)
  })
})
