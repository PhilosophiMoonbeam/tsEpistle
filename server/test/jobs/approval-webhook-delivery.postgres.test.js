import { EventEmitter } from 'node:events'
import { createHmac, randomUUID } from 'node:crypto'
import createKnex from 'knex'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { up as durableSchema } from '../../db/migrations/2.5.130.ts'
import { up as leaseSchema } from '../../db/migrations/2.5.158.ts'
import { up as outboxSchema } from '../../db/migrations/2.5.131.ts'

const { lookupMock, requestMock } = vi.hoisted(() => ({ lookupMock: vi.fn(), requestMock: vi.fn() }))
vi.mockModule('node:dns/promises', import.meta.url, () => ({ lookup: lookupMock }))
vi.mockModule('node:https', import.meta.url, () => ({ request: requestMock }))

const connection = getPostgresTestConnection('_approval_webhook_test', import.meta.path)
const suite = connection ? describe : describe.skip

suite('native approval public-only webhook handoff', () => {
  let db, wiki, handler, sentBody, sentOptions
  let createWebhookDeliveryHandler, encryptWebhookSecret, sendSignedWebhook, DurableJobStore, publishOutboxEvents, writeOutboxEvent
  const hookId = randomUUID(), requestId = randomUUID()
  const exactRevision = '9007199254740993'
  const minimal = { requestId, pageId: 42, status: 'published', reviewedSourceRevision: exactRevision, publishedSourceRevision: '9007199254740994' }
  const storedPayload = { ...minimal, source: 'private source', content: 'private body', title: 'Private title', path: 'private/path', email: 'reviewer@example.test', actorId: 7, submitterId: 8, comment: 'private review', revisionId: 19 }
  beforeAll(async () => {
    db = createKnex({ client: 'pg', connection, pool: { min: 0, max: 4 } })
    await db.raw(`
      CREATE TABLE users (id integer PRIMARY KEY, "isActive" boolean NOT NULL DEFAULT true);
      CREATE TABLE groups (id integer PRIMARY KEY, name text, permissions jsonb, "pageRules" jsonb);
      CREATE TABLE "userGroups" ("userId" integer REFERENCES users(id), "groupId" integer REFERENCES groups(id));
      CREATE TABLE pages (id integer PRIMARY KEY, visibility text, "ownerId" integer, path text, "localeCode" text, "isPublished" boolean, "isSearchable" boolean, "publishStartDate" text DEFAULT '', "publishEndDate" text DEFAULT '');
      CREATE TABLE tags (id integer PRIMARY KEY, tag text, "redirectToId" integer, "isArchived" boolean DEFAULT false);
      CREATE TABLE "pageTags" ("pageId" integer, "tagId" integer);
      CREATE TABLE "pageAccessPasswords" ("pageId" integer PRIMARY KEY);
    `)
    await durableSchema(db); await leaseSchema(db); await outboxSchema(db)
    wiki = {
      config: {
        host: 'https://wiki.example.test', sessionSecret: 'native-session-secret',
        db: { type: 'postgres' }, lang: { code: 'en', namespacing: false },
        features: { featurePageComments: false }
      },
      configSvc: {}, lang: {}, startedAt: {},
      events: { inbound: new EventEmitter(), outbound: new EventEmitter() },
      data: {}, logger: console,
      models: { knex: db, users: { getGuestUser: () => db('users').where('id', 2).first() } }
    }
    vi.stubGlobal('WIKI', wiki)
    wiki.auth = (await import('../../core/auth.ts')).default
    // Runtime modules capture WIKI (including model/database bindings) at import.
    ;({ createWebhookDeliveryHandler } = await import('../../jobs/durable-job-handlers.ts'))
    ;({ encryptWebhookSecret, sendSignedWebhook } = await import('../../core/webhooks.ts'))
    ;({ DurableJobStore } = await import('../../core/durable-jobs.ts'))
    ;({ publishOutboxEvents, writeOutboxEvent } = await import('../../core/outbox.ts'))
    handler = createWebhookDeliveryHandler('native-session-secret', wiki)
  })
  afterAll(async () => { try { await db?.destroy() } finally { vi.unstubAllGlobals() } })
  beforeEach(async () => {
    vi.clearAllMocks()
    sentBody = ''; sentOptions = undefined
    await db.raw('TRUNCATE "userGroups", users, groups, pages, tags, "pageTags", "pageAccessPasswords", "durableJobs", "outboxEvents", webhooks CASCADE')
    await db('users').insert({ id: 2, isActive: true })
    await db('groups').insert({ id: 1, name: 'Guests', permissions: JSON.stringify(['read:pages']), pageRules: JSON.stringify([{ match: 'START', path: '', deny: false, roles: ['read:pages'], locales: [] }]) })
    await db('userGroups').insert({ userId: 2, groupId: 1 })
    await db('pages').insert({ id: 42, visibility: 'public', ownerId: null, path: 'eligible', localeCode: 'en', isPublished: true, isSearchable: true })
    const now = new Date()
    await db('webhooks').insert({ id: hookId, name: 'Explicit approvals', url: 'https://hooks.example.test/wiki', events: JSON.stringify(['approval.publish']), secretCiphertext: encryptWebhookSecret('delivery-secret', 'native-session-secret'), isEnabled: true, createdAt: now, updatedAt: now })
    lookupMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    requestMock.mockImplementation((_url, options, callback) => {
      sentOptions = options
      const req = new EventEmitter()
      req.end = body => {
        sentBody = body
        const response = new EventEmitter()
        response.statusCode = 204
        queueMicrotask(() => { callback(response); response.emit('end') })
      }
      return req
    })
  })
  const queued = async (payload = storedPayload, eventType = 'approval.publish') => {
    const eventId = await writeOutboxEvent(db, { type: eventType, version: 1, aggregateType: 'page-approval', aggregateId: requestId, payload })
    expect(await publishOutboxEvents(db)).toBe(1)
    const [job] = await new DurableJobStore(db).claim({ workerId: 'approval-native', supportedIdentities: ['deliver-webhook@1'] })
    expect(job).toBeDefined()
    return { eventId, job, deliveryId: job.payload.deliveryId }
  }
  const expectSuppressed = async ({ eventId, job, deliveryId }, signal = new AbortController().signal) => {
    const retained = await db('outboxEvents').where('id', eventId).first()
    await handler(job, { knex: db, signal })
    expect(requestMock).not.toHaveBeenCalled()
    expect(await db('webhookDeliveries').where('id', deliveryId).first()).toMatchObject({ eventId, statusCode: null, deliveredAt: expect.anything(), responseSnippet: expect.stringContaining('suppressed without delivery') })
    expect(await db('outboxEvents').where('id', eventId).first()).toEqual(retained)
    expect(await new DurableJobStore(db).complete(job)).toBe(true)
    expect(await db('durableJobs').where('id', job.id).first()).toMatchObject({ state: 'succeeded', attempts: 1 })
  }
  it('exports only the exact versioned DTO and retains event/delivery identity and DNS-pinned signing', async () => {
    const { eventId, job, deliveryId } = await queued()
    await handler(job, { knex: db, signal: new AbortController().signal })
    await handler(job, { knex: db, signal: new AbortController().signal })
    expect(requestMock).toHaveBeenCalledOnce()
    const event = await db('outboxEvents').where('id', eventId).first()
    expect(JSON.parse(sentBody)).toEqual({ id: eventId, type: 'approval.publish', version: 2, createdAt: new Date(event.createdAt).toISOString(), data: minimal })
    expect(sentOptions.headers['x-wiki-delivery']).toBe(deliveryId)
    expect(sentOptions.headers['x-wiki-signature']).toBe(`sha256=${createHmac('sha256', 'delivery-secret').update(`${sentOptions.headers['x-wiki-timestamp']}.${sentBody}`).digest('hex')}`)
    await new Promise((resolve, reject) => sentOptions.lookup('hooks.example.test', {}, (error, address, family) => { if (error) reject(error); else { expect({ address, family }).toEqual({ address: '8.8.8.8', family: 4 }); resolve() } }))
    expect(JSON.parse(event.payload)).toEqual(storedPayload)
  })
  it('requires literal subscriptions and leaves wildcard page subscriptions unchanged', async () => {
    await db('webhooks').insert(['*', 'approval.*'].map((event, index) => ({ id: randomUUID(), name: `Not literal ${index}`, url: 'https://hooks.example.test/wiki', events: JSON.stringify([event]), secretCiphertext: 'unused', isEnabled: true, createdAt: new Date(), updatedAt: new Date() })))
    const { eventId } = await queued()
    expect(await db('webhookDeliveries').where('eventId', eventId).select('webhookId')).toEqual([{ webhookId: hookId }])
    const pageEvent = await writeOutboxEvent(db, { type: 'page.updated', version: 1, aggregateType: 'page', aggregateId: 42, payload: {} })
    await publishOutboxEvents(db)
    expect(await db('webhookDeliveries').where('eventId', pageEvent)).toHaveLength(1)
  })
  const changes = [
    ['endpoint disabled', () => db('webhooks').where('id', hookId).update({ isEnabled: false })],
    ['literal approval subscription revoked', () => db('webhooks').where('id', hookId).update({ events: '["*"]' })],
    ['private visibility', () => db('pages').where('id', 42).update({ visibility: 'private', ownerId: 2 })],
    ['unpublished page', () => db('pages').where('id', 42).update({ isPublished: false })],
    ['searchability revoked', () => db('pages').where('id', 42).update({ isSearchable: false })],
    ['future publication', () => db('pages').where('id', 42).update({ publishStartDate: '2999-01-01T00:00:00.000Z' })],
    ['expired publication', () => db('pages').where('id', 42).update({ publishEndDate: '2000-01-01T00:00:00.000Z' })],
    ['password protection', () => db('pageAccessPasswords').insert({ pageId: 42 })],
    ['guest deactivated', () => db('users').where('id', 2).update({ isActive: false })],
    ['guest membership revoked', () => db('userGroups').where('userId', 2).delete()],
    ['current page ACL denial', () => db('groups').where('id', 1).update({ pageRules: JSON.stringify([{ match: 'START', path: '', deny: true, roles: ['read:pages'], locales: [] }]) })]
  ]
  for (const [name, change] of changes) it(`suppresses after ${name} during DNS resolution before signed handoff`, async () => {
    const delivery = await queued()
    let changed = false
    lookupMock.mockImplementationOnce(async () => { await change(); changed = true; return [{ address: '8.8.8.8', family: 4 }] })
    await expectSuppressed(delivery)
    expect(changed).toBe(true)
  })
  for (const ambiguous of [
    { reviewedSourceRevision: undefined }, { reviewedSourceRevision: null }, { reviewedSourceRevision: 9007199254740992 },
    { reviewedSourceRevision: '01' }, { publishedSourceRevision: null }, { publishedSourceRevision: undefined }, { status: 'approved' }
  ]) it(`suppresses ambiguous retained approval provenance ${JSON.stringify(ambiguous)}`, async () => {
    const delivery = await queued({ ...storedPayload, ...ambiguous })
    await expectSuppressed(delivery)
    expect(lookupMock).not.toHaveBeenCalled()
  })
  for (const raw of ['null', '[]', '\"legacy\"', '{invalid-json']) it(`suppresses invalid queued approval JSON ${raw} without raw replay`, async () => {
    const delivery = await queued()
    await db('outboxEvents').where('id', delivery.eventId).update({ payload: raw })
    await expectSuppressed(delivery)
    expect(lookupMock).not.toHaveBeenCalled()
  })
  for (const [name, change] of changes.slice(0, 2)) it(`records suppression without a fabricated HTTP status when ${name} before delivery begins`, async () => {
    const delivery = await queued()
    await change()
    await expectSuppressed(delivery)
    expect(lookupMock).not.toHaveBeenCalled()
  })
  it('fails closed at the signed transport boundary without an approval eligibility callback', async () => {
    await expect(sendSignedWebhook({ deliveryId: randomUUID(), eventId: randomUUID(), eventType: 'approval.publish', eventVersion: 1, eventCreatedAt: new Date(), payload: storedPayload, secret: 'delivery-secret', target: { url: new URL('https://hooks.example.test/wiki'), address: '8.8.8.8', family: 4 } })).rejects.toThrow('requires a current visibility check')
    expect(requestMock).not.toHaveBeenCalled()
  })
  it('does not hand off or mark completion after lease cancellation during DNS resolution', async () => {
    const { job, deliveryId } = await queued()
    const controller = new AbortController()
    lookupMock.mockImplementationOnce(async () => { controller.abort(new DOMException('Lease lost', 'AbortError')); return [{ address: '8.8.8.8', family: 4 }] })
    await expect(handler(job, { knex: db, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(requestMock).not.toHaveBeenCalled()
    expect(await db('webhookDeliveries').where('id', deliveryId).first()).toMatchObject({ deliveredAt: null, statusCode: null })
  })
  it('retains an uncertain network outcome as incomplete rather than forging success', async () => {
    const { job, deliveryId } = await queued()
    requestMock.mockImplementationOnce(() => { const req = new EventEmitter(); req.end = () => queueMicrotask(() => req.emit('error', new Error('Acceptance lost'))); return req })
    await expect(handler(job, { knex: db, signal: new AbortController().signal })).rejects.toThrow('Acceptance lost')
    expect(await db('webhookDeliveries').where('id', deliveryId).first()).toMatchObject({ deliveredAt: null, statusCode: null, responseSnippet: '' })
    expect(await new DurableJobStore(db).fail(job, new Error('Acceptance lost'))).toBe(true)
    expect(await db('durableJobs').where('id', job.id).first()).toMatchObject({ state: 'pending', attempts: 1 })
  })
})
