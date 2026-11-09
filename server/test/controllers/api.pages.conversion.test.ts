import express from 'express'
import createKnex from 'knex'
import { createHash } from 'node:crypto'
import type { Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import type { Mock } from '../bun-test.mts'
import { configureTransportRuntime, getTransportRuntime } from '../../controllers/_types.ts'
import { createOriginMiddleware } from '../../middlewares/origin.ts'
import { createApiPrincipal } from '../../helpers/api-principal.ts'
import errors from '../../operations/errors.ts'
import * as conversionProcess from '../../helpers/page-conversion-process.ts'
import { consumePageConversionReview } from '../../helpers/page-conversion-review.ts'
import type { ConversionResult } from '../../helpers/page-conversion-protocol.ts'
import { convertPage, reviewPageConversion } from '../../../client/helpers/pages-api.ts'
import type PageModel from '../../models/pages.ts'

const originalWiki = Object.getOwnPropertyDescriptor(globalThis, 'WIKI')
const originalRuntime = getTransportRuntime<object>()
const db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
const actor = { id: 7, ownershipUserId: 7, permissions: [], groups: [] }
const sessionId = 'conversion-browser-session'
const cookie = `conversion-session=${sessionId}`
const source = '<p>Hello <strong>review</strong>.</p>'
const input = { editor: 'markdown', expectedSourceRevision: '8' }
const models: Record<string, unknown> = { knex: db }
const wiki = {
  ROOTPATH: fileURLToPath(new URL('../../../', import.meta.url)),
  SERVERPATH: fileURLToPath(new URL('../../', import.meta.url)),
  config: { lang: { code: 'en', namespacing: false, namespaces: [] }, db: { type: 'sqlite' }, sessionSecret: 'conversion-http-regression-key' },
  models, data: {}, cache: { get: async () => [] },
  auth: {
    checkAccess: () => false,
    checkPageAccess: () => false,
    loadPageRuleAuthority: async (requester: unknown) => ({ requester, permissions: [], groups: [], tagAliases: {} })
  },
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
}
let Page: typeof PageModel
let confirm: Mock<typeof PageModel.convertPage>
let server: Server | undefined
let origin: string
const requests: Array<{ method: string; path: string; body: unknown }> = []
const loopbackFetch: Parameters<typeof reviewPageConversion>[0] = (path, init) =>
  fetch(new URL(path, origin), { ...init, headers: { ...init.headers, Cookie: cookie, Origin: origin } })
const request = (route: string, body: unknown, options: { sourceOrigin?: string; cookie?: string; signal?: AbortSignal } = {}) =>
  fetch(`${origin}/_api/pages/7/convert${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: options.sourceOrigin ?? origin, Cookie: options.cookie ?? cookie },
    body: JSON.stringify(body), signal: options.signal
  })

beforeAll(async () => {
  await db.schema.createTable('pages', table => {
    table.integer('id').primary(); table.string('localeCode').notNullable(); table.string('path').notNullable()
    table.string('visibility').notNullable(); table.integer('ownerId'); table.text('content').notNullable()
    table.string('contentType').notNullable(); table.bigInteger('sourceRevision').notNullable()
  })
  await db.schema.createTable('tags', table => { table.integer('id').primary(); table.string('tag'); table.string('title') })
  await db.schema.createTable('pageTags', table => { table.integer('pageId'); table.integer('tagId') })
  await db.schema.createTable('pageAccessPasswords', table => { table.integer('pageId').primary(); table.integer('version').notNullable(); table.text('passwordHash').notNullable() })
  await db.schema.createTable('pageUnlockGrants', table => {
    table.string('id').primary(); table.integer('pageId'); table.string('sessionId'); table.integer('userId')
    table.integer('passwordVersion'); table.dateTime('createdAt'); table.dateTime('expiresAt')
  })
  Reflect.set(globalThis, 'WIKI', wiki)
  configureTransportRuntime(wiki)
  // These modules capture WIKI at evaluation; static imports would precede the isolated runtime installation.
  Page = (await import('../../models/pages.ts')).default.bindKnex(db)
  models.pages = Page
  models.renderers = {
    getRenderingPipeline: async () => [{
      key: 'markdownCore',
      config: { allowHTML: true, linebreaks: true, linkify: true, typographer: false, quotes: 'English', underline: true },
      children: []
    }]
  }
  // The full reader joins author/editor tables; this fixture exercises native page/tag persistence and access instead.
  vi.spyOn(Page, 'getPageFromDb').mockImplementation(async id => {
    if (typeof id !== 'number') throw new Error('Conversion must look up a numeric page ID')
    return Page.query().findById(id).withGraphFetched('tags')
  })
  // Canonical transactional mutation is covered by the native PostgreSQL conversion suite.
  // This spy isolates the HTTP/operation handoff; it does not manufacture a conversion receipt or authorize a write.
  confirm = vi.spyOn(Page, 'convertPage').mockResolvedValue(undefined)
  const { default: router } = await import('../../controllers/api/index.ts')
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    requests.push({ method: req.method, path: req.path, body: req.body })
    if (req.get('Cookie') === cookie) {
      Reflect.set(req, 'user', actor)
      Reflect.set(req, 'sessionID', sessionId)
    } else if (req.get('Cookie') === 'conversion-api-key') {
      Reflect.set(req, 'user', createApiPrincipal(3, 4, ['manage:system']))
      Reflect.set(req, 'sessionID', '')
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
  if (!address || typeof address === 'string') throw new Error('Conversion test server did not bind a TCP port')
  origin = `http://127.0.0.1:${address.port}`
})

beforeEach(async () => {
  confirm.mockClear()
  requests.length = 0
  await db('pageUnlockGrants').delete()
  await db('pageAccessPasswords').delete()
  await db('pages').delete()
  await db('pages').insert({ id: 7, localeCode: 'en', path: 'private/conversion', visibility: 'private', ownerId: actor.id, content: source, contentType: 'html', sourceRevision: '8' })
})

afterAll(async () => {
  try {
    if (server?.listening) {
      const closed = Promise.withResolvers<void>()
      server.close(error => error ? closed.reject(error) : closed.resolve())
      await closed.promise
    }
  } finally {
    vi.restoreAllMocks()
    await db.destroy()
    configureTransportRuntime(originalRuntime)
    if (originalWiki) Object.defineProperty(globalThis, 'WIKI', originalWiki)
    else Reflect.deleteProperty(globalThis, 'WIKI')
  }
})

describe('mounted explicit page conversion contract', () => {
  it('reviews native conversion through the real client without mutation, then forwards only its token on confirmation', async () => {
    const before = await db('pages').where({ id: 7 }).first()
    const review = await reviewPageConversion(loopbackFetch, 7, 'markdown', '8')

    expect(review.originalSource).toBe(source)
    expect(review.candidate).toBe('Hello **review**.')
    expect(review.candidateDigest).toBe(createHash('sha256').update(review.candidate).digest('hex'))
    expect(review.report.previewHtml).toContain('<strong>review</strong>')
    expect(review.report.warnings.join(' ')).toContain('not certified lossless')
    expect(await db('pages').where({ id: 7 }).first()).toEqual(before)
    expect(confirm).not.toHaveBeenCalled()

    await convertPage(loopbackFetch, 7, 'markdown', '8', review.reviewToken)

    expect(requests.map(({ method, path }) => [method, path])).toEqual([
      ['POST', '/_api/pages/7/convert/review'], ['POST', '/_api/pages/7/convert']
    ])
    expect(requests[1].body).toEqual({ ...input, reviewToken: review.reviewToken })
    expect(confirm).toHaveBeenCalledWith({ id: 7, ...input, reviewToken: review.reviewToken, user: actor, sessionId })
    const binding = { pageId: 7, sourceRevision: '8', editor: 'markdown', userId: actor.id, source }
    expect(() => consumePageConversionReview({ ...binding, reviewToken: review.reviewToken, sessionBinding: 'another-browser-session' })).toThrow()
    expect(consumePageConversionReview({ ...binding, reviewToken: review.reviewToken, sessionBinding: sessionId })).toBe('Hello **review**.')
  }, 15_000)

  it('marks original source and candidate responses private and uncacheable', async () => {
    const response = await request('/review', input)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('vary')?.split(/\s*,\s*/)).toContain('Cookie')
    expect(await response.json()).toMatchObject({ pageId: 7, sourceRevision: '8', originalSource: source })
  }, 15_000)

  it('rejects untrusted fields rather than silently dropping them on review or confirmation', async () => {
    for (const route of ['/review', '']) {
      for (const body of [
        { ...input, candidate: 'browser-authored replacement' },
        { ...input, sessionId: 'another-browser-session' },
        { ...input, user: actor },
        { ...input, expectedSourceRevision: '08' },
        { ...input, editor: null }
      ]) {
        expect((await request(route, body)).status).toBe(400)
      }
    }
    expect((await request('/review', { ...input, reviewToken: 'r'.repeat(43) })).status).toBe(400)
    for (const reviewToken of [null, 42, '', 'not-a-token']) {
      expect((await request('', { ...input, reviewToken })).status).toBe(400)
    }
    expect(confirm).not.toHaveBeenCalled()
    expect((await db('pages').where({ id: 7 }).first()).content).toBe(source)
  })

  it('retains native ownership, password unlock and same-origin boundaries for source review', async () => {
    expect((await request('/review', input, { cookie: '' })).status).toBe(404)
    expect((await request('/review', input, { cookie: 'conversion-api-key' })).status).toBe(403)
    for (const route of ['/review', '']) {
      expect((await request(route, input, { sourceOrigin: 'https://attacker.example' })).status).toBe(403)
    }
    await db('pages').where({ id: 7 }).update({ ownerId: 8 })
    expect((await request('/review', input)).status).toBe(404)
    await db('pages').where({ id: 7 }).update({ ownerId: actor.id })
    await db('pageAccessPasswords').insert({ pageId: 7, version: 1, passwordHash: 'unused-unlock-hash' })
    for (const route of ['/review', '']) {
      const locked = await request(route, input)
      expect(locked.status).toBe(403)
      expect(await locked.json()).toEqual({ error: 'Access denied' })
    }
    await db('pageUnlockGrants').insert({ id: 'foreign-grant', pageId: 7, sessionId: 'another-browser-session', userId: actor.id, passwordVersion: 1, createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) })
    expect((await request('/review', input)).status).toBe(403)
    expect(confirm).not.toHaveBeenCalled()
    expect((await db('pages').where({ id: 7 }).first()).content).toBe(source)
  })

  it('preserves revision-conflict status and never returns a stale preview', async () => {
    await db('pages').where({ id: 7 }).update({ sourceRevision: '9' })
    await expect(reviewPageConversion(loopbackFetch, 7, 'markdown', '8')).rejects.toMatchObject({ status: 409, message: 'Page source changed. Refresh before reviewing.' })
    expect(confirm).not.toHaveBeenCalled()
    expect(requests).toHaveLength(1)
  })

  it('rechecks private ownership after native work before disclosing the candidate', async () => {
    const run = conversionProcess.runPageConversion
    const pending = vi.spyOn(conversionProcess, 'runPageConversion').mockImplementation(async (...args) => {
      const result = await run(...args)
      await db('pages').where({ id: 7 }).update({ ownerId: 8 })
      return result
    })
    try {
      const response = await request('/review', input)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'Page not found.' })
      expect(confirm).not.toHaveBeenCalled()
      expect((await db('pages').where({ id: 7 }).first()).content).toBe(source)
    } finally {
      pending.mockRestore()
    }
  }, 15_000)

  it('preserves canonical confirmation conflicts without retrying or replaying conversion', async () => {
    confirm.mockRejectedValueOnce(new errors.ApplicationError('Review the current HTML source and conversion options again before confirming.', { status: 409, code: 'CONVERSION_REVIEW_STALE' }))
    await expect(convertPage(loopbackFetch, 7, 'markdown', '8', 'r'.repeat(43))).rejects.toMatchObject({
      status: 409, message: 'Review the current HTML source and conversion options again before confirming.'
    })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(requests.map(({ method, path }) => [method, path])).toEqual([['POST', '/_api/pages/7/convert']])
    expect((await db('pages').where({ id: 7 }).first()).content).toBe(source)
  })

  it('propagates a completed-body HTTP disconnect into the pending conversion AbortSignal', async () => {
    const entered = Promise.withResolvers<AbortSignal>()
    const cancelled = Promise.withResolvers<void>()
    const result = Promise.withResolvers<ConversionResult>()
    const deadline = Promise.withResolvers<never>()
    // A real TCP close cannot use fake time; this deadline only releases the fixture on a missing event.
    const timeout = setTimeout(() => deadline.reject(new Error('HTTP disconnect did not reach the pending converter')), 2000)
    void result.promise.catch(() => undefined)
    // Only the isolated-work boundary is held open: Express must deliver the actual response disconnect.
    const pending = vi.spyOn(conversionProcess, 'runPageConversion').mockImplementation(async (_input, signal) => {
      if (!signal) throw new Error('Review did not supply an AbortSignal')
      signal.addEventListener('abort', () => {
        cancelled.resolve()
        result.reject(new DOMException('Conversion cancelled.', 'AbortError'))
      }, { once: true })
      entered.resolve(signal)
      return result.promise
    })
    const controller = new AbortController()
    const response = request('/review', input, { signal: controller.signal }).catch(error => error)
    try {
      const signal = await Promise.race([entered.promise, deadline.promise])
      expect(signal.aborted).toBe(false)
      controller.abort()
      await Promise.race([cancelled.promise, deadline.promise])
      expect(signal.aborted).toBe(true)
      expect(await response).toMatchObject({ name: 'AbortError' })
      expect(confirm).not.toHaveBeenCalled()
      expect((await db('pages').where({ id: 7 }).first()).content).toBe(source)
    } finally {
      clearTimeout(timeout)
      controller.abort()
      result.reject(new DOMException('Conversion cancelled.', 'AbortError'))
      pending.mockRestore()
    }
  })
})
