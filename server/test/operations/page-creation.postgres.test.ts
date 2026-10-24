import knexModule, { type Knex } from 'knex'
import * as Objection from 'objection'
import * as Y from 'yjs'
import express from 'express'
import type { Server } from 'node:http'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { configureTransportRuntime, getTransportRuntime } from '../../controllers/_types.ts'
import domainErrors from '../../helpers/error.ts'
import { evaluateGroupAccess, type AccessPage, type PageRuleAuthority } from '../../helpers/group-access.ts'
import { up as createJobs } from '../../db/migrations/2.5.130.ts'
import { up as createEvents } from '../../db/migrations/2.5.131.ts'
import { up as createProtection } from '../../db/migrations/2.5.134.ts'
import { up as createAgents } from '../../db/migrations/2.5.139.ts'
import { up as addMessageVisibility } from '../../db/migrations/2.5.157.ts'
import { up as addJobLease } from '../../db/migrations/2.5.158.ts'
import { up as installRevisionTrigger } from '../../db/migrations/tsepistle-000035-page-search-inclusion.ts'
import { up as createNotes } from '../../db/migrations/tsepistle-000067-live-notes.ts'
import { up as createReceipts } from '../../db/migrations/tsepistle-000068-page-creation-receipts.ts'
import type PageModel from '../../models/pages.ts'
import type pageOperations from '../../operations/pages.ts'
import type { LiveNotesOperations } from '../../operations/live-notes.ts'
import { decodeCollaborationUpdate, encodeCollaborationUpdate } from '../../../shared/collaboration.ts'
import type { PageCreationOrigin, PageCreationInventory } from '../../../shared/page-creation.ts'

const connection = getPostgresTestConnection('_page_creation_test', import.meta.path)
const suite = connection ? describe : describe.skip
const owner = { id: 7, authVersion: 0, name: 'Receipt owner', email: 'receipt@example.test', permissions: [] } as Express.User & { name: string; email: string }
const peer = { id: 8, authVersion: 0, name: 'Other owner', email: 'peer@example.test', permissions: [] } as typeof owner
const grants = ['read:pages', 'write:pages', 'write:notes', 'use:agents']
const rules = [{ match: 'START', path: '', deny: false, roles: ['read:pages', 'write:pages'], locales: [] }]
const sessionId = 'receipt-browser-session'
const append = (state: string, text: string): string => {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, decodeCollaborationUpdate(state))
    const before = Y.encodeStateVector(doc)
    doc.getText('content').insert(doc.getText('content').length, text)
    return encodeCollaborationUpdate(Y.encodeStateAsUpdate(doc, before))
  } finally {
    doc.destroy()
  }
}

suite('native page creation receipts and authorized recovery', () => {
  let db: Knex
  let Page: typeof PageModel
  let operations: typeof pageOperations
  let notes: LiveNotesOperations
  let directory: string
  let server: Server | undefined
  let baseUrl: string
  const errors: unknown[] = []
  const originalWiki = Object.getOwnPropertyDescriptor(globalThis, 'WIKI')
  const originalRuntime = getTransportRuntime<object>()

  const authorityFor = async (requester: Express.User | undefined, transaction?: Knex.Transaction): Promise<PageRuleAuthority> => {
    const reader = transaction ?? db
    const groups = requester
      ? await reader('groups').join('userGroups', 'groups.id', 'userGroups.groupId').where('userGroups.userId', requester.id).select('groups.*')
      : []
    return { requester, permissions: [...new Set(groups.flatMap(group => group.permissions as string[]))], groups, tagAliases: {} }
  }
  const input = (requestId = randomUUID(), overrides: Record<string, unknown> = {}) => ({
    path: `receipt-${requestId}`,
    locale: 'en',
    content: 'Reviewed independent draft',
    editor: 'markdown',
    description: '',
    title: 'Receipt destination',
    visibility: 'private',
    isPublished: false,
    tags: [],
    skipStorage: true,
    creationRequestId: requestId,
    ...overrides
  })
  const create = (requestId = randomUUID(), overrides: Record<string, unknown> = {}, requester = owner) =>
    operations.create({ requester, sessionId, input: input(requestId, overrides) }) as Promise<PageModel>
  const status = (requestId: string, requester = owner, browserSession = sessionId) =>
    operations.creationStatus({ requester, sessionId: browserSession, requestId })
  const inventory = (noteId: string, requester = owner, browserSession = sessionId) =>
    operations.noteCreationInventory({ requester, sessionId: browserSession, noteId })
  const http = (pathname: string, options: { method?: string; body?: unknown; requester?: typeof owner; claimedOwner?: string } = {}) => {
    const requester = options.requester ?? owner
    return fetch(`${baseUrl}/_api/pages${pathname}`, {
      method: options.method ?? 'GET',
      headers: {
        Cookie: `receipt-owner=${requester.id}`,
        'X-Page-Creation-Owner': options.claimedOwner ?? String(requester.id),
        'Content-Type': 'application/json'
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    })
  }
  const publication = async () => {
    const note = await notes.create(owner, {})
    const saved = await notes.applyUpdate(owner, note.key, {
      requestId: 'saved-source',
      update: append(note.state, '# Captured heading\n\nOriginal **saved** body.')
    })
    const origin: PageCreationOrigin = { kind: 'live-note', noteId: saved.id, revision: saved.revision }
    return { saved, origin, content: 'Original **saved** body.' }
  }
  const persisted = async () =>
    Object.fromEntries(
      await Promise.all(
        [
          ['pages', 'id'],
          ['pageCreationReceipts', 'requestId'],
          ['pageMutationOutbox', 'id'],
          ['outboxEvents', 'id'],
          ['durableJobs', 'id'],
          ['liveNotes', 'id'],
          ['liveNoteRevisions', 'revision'],
          ['liveNoteRequests', 'requestId'],
          ['pageUnlockGrants', 'id'],
          ['agentSessions', 'id'],
          ['agentMessages', 'id']
        ].map(async ([table, key]) => [table, await db(table!).orderBy(key!)])
      )
    )

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 8 } })
    directory = await mkdtemp(path.join(tmpdir(), 'page-creation-native-'))
    // Canonical base-model dependencies only; all receipt, CRDT, agent, protection,
    // revision-trigger and durable-side-effect structures come from real migrations.
    await db.raw(`
      CREATE TABLE users (id integer PRIMARY KEY, name text NOT NULL, email text NOT NULL, "isActive" boolean NOT NULL DEFAULT true, "authVersion" integer NOT NULL DEFAULT 0, "isSystem" boolean NOT NULL DEFAULT false);
      CREATE TABLE groups (id integer PRIMARY KEY, permissions jsonb NOT NULL, "pageRules" jsonb NOT NULL);
      CREATE TABLE "userGroups" ("userId" integer NOT NULL REFERENCES users(id), "groupId" integer NOT NULL REFERENCES groups(id));
      CREATE TABLE locales (code text PRIMARY KEY);
      CREATE TABLE storage (key text PRIMARY KEY, "isEnabled" boolean NOT NULL, mode text NOT NULL, "syncInterval" text NOT NULL, config jsonb NOT NULL);
      CREATE TABLE pages (
        id serial PRIMARY KEY, path text NOT NULL, hash text NOT NULL, "localeCode" text NOT NULL,
        title text NOT NULL, description text NOT NULL DEFAULT '', content text NOT NULL, render text NOT NULL DEFAULT '', toc text NOT NULL DEFAULT '[]',
        "renderedSourceRevision" bigint, "localeGroupId" text, "isPublished" boolean NOT NULL, "isSearchable" boolean NOT NULL DEFAULT true,
        "publishStartDate" text NOT NULL DEFAULT '', "publishEndDate" text NOT NULL DEFAULT '', visibility text NOT NULL, "ownerId" integer,
        "authorId" integer NOT NULL, "creatorId" integer NOT NULL, "contentType" text NOT NULL, "editorKey" text NOT NULL, extra jsonb NOT NULL DEFAULT '{}',
        "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE tags (id serial PRIMARY KEY, tag text NOT NULL UNIQUE, title text NOT NULL, "redirectToId" integer, "isArchived" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE "pageTags" ("pageId" integer NOT NULL, "tagId" integer NOT NULL);
      CREATE TABLE "pageLinks" ("pageId" integer NOT NULL, "localeCode" text NOT NULL, path text NOT NULL);
      CREATE TABLE "pageTree" (id integer PRIMARY KEY, "pageId" integer, title text, "localeCode" text NOT NULL, path text NOT NULL, depth integer NOT NULL,
        "isFolder" boolean NOT NULL, visibility text NOT NULL, "ownerId" integer, parent integer, ancestors text NOT NULL);
      CREATE TABLE "pageHistory" (id serial PRIMARY KEY);
      CREATE TABLE "pageHistoryTags" ("pageId" integer NOT NULL, "tagId" integer NOT NULL);
      CREATE TABLE "assetFolders" (id serial PRIMARY KEY, name text NOT NULL, slug text NOT NULL, "parentId" integer);
      CREATE TABLE assets (id serial PRIMARY KEY, hash text NOT NULL UNIQUE, filename text NOT NULL, "folderId" integer);
      CREATE TABLE "apiKeys" (id integer PRIMARY KEY);
    `)
    for (const migrate of [
      createJobs,
      createEvents,
      createProtection,
      createAgents,
      addMessageVisibility,
      addJobLease,
      installRevisionTrigger,
      createNotes,
      createReceipts
    ])
      await migrate(db)
    const wiki = {
      ROOTPATH: directory,
      SERVERPATH: path.resolve(import.meta.dir, '../..'),
      config: {
        db: { type: 'postgres' },
        dataPath: 'data',
        lang: { code: 'en', namespacing: false, namespaces: [] },
        sessionSecret: 'native-receipt-session-secret',
        editors: { available: ['markdown'] }
      },
      data: { reservedPaths: [], editors: [{ key: 'markdown', contentType: 'markdown' }] },
      cache: { get: async () => [] },
      logger: {
        error: (error: unknown) => {
          errors.push(error)
        },
        warn: console.warn,
        info: console.info
      },
      events: { inbound: new EventEmitter(), outbound: new EventEmitter() },
      Error: domainErrors,
      auth: {
        loadPageRuleAuthority: authorityFor,
        checkAccess: (requester: Express.User | undefined, requested: readonly string[]) =>
          requested.some(permission => requester?.permissions?.includes(permission)),
        checkPageAccess: (requester: Express.User | undefined, requested: string[], context: AccessPage, authority: PageRuleAuthority) =>
          authority.requester === requester &&
          evaluateGroupAccess(authority.permissions, requested, authority.groups, context, authority.tagAliases, false).allowed
      },
      scheduler: {
        registerJob: async ({ name }: { name: string }) => {
          if (name !== 'rebuild-tree') throw new Error(`Unexpected receipt fixture job: ${name}`)
          return { finished: Promise.resolve() }
        }
      },
      models: { knex: db, Objection, pages: {} as unknown, tags: {} as unknown }
    }
    Reflect.set(globalThis, 'WIKI', wiki)
    configureTransportRuntime(wiki)
    // Models, operations and API modules capture WIKI at evaluation; static
    // imports would bind the preload runtime instead of this disposable database.
    Page = (await import('../../models/pages.ts')).default
    const Tag = (await import('../../models/tags.ts')).default
    const User = (await import('../../models/users.ts')).default
    for (const model of [Page, Tag, User]) model.knex(db)
    Object.assign(wiki.models, { pages: Page, tags: Tag })
    operations = (await import('../../operations/pages.ts')).default
    const { createLiveNotesStore } = await import('../../operations/live-notes.ts')
    notes = createLiveNotesStore({ db, secret: 'native-receipt-session-secret', audience: 'urn:wiki:receipt-test' })
    const router = (await import('../../controllers/api/index.ts')).default
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      if (req.get('Cookie') === `receipt-owner=${owner.id}`) req.user = owner
      else if (req.get('Cookie') === `receipt-owner=${peer.id}`) req.user = peer
      req.sessionID = sessionId
      next()
    })
    app.use('/_api', router)
    server = app.listen(0, '127.0.0.1')
    const listening = Promise.withResolvers<void>()
    server.once('listening', listening.resolve)
    server.once('error', listening.reject)
    await listening.promise
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Receipt fixture did not bind a loopback port')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  beforeEach(async () => {
    await db.raw('DROP TRIGGER IF EXISTS receipt_fixture_failure ON "pageCreationReceipts"; DROP FUNCTION IF EXISTS receipt_fixture_abort();')
    await db.raw(
      'TRUNCATE "pageCreationReceipts", "liveNotes", "agentSessions", pages, users, groups, "durableJobs", "outboxEvents", "pageMutationOutbox", tags, "pageTags", "pageLinks", "pageTree" RESTART IDENTITY CASCADE'
    )
    await db('users').insert([owner, peer].map(({ id, name, email }) => ({ id, name, email })))
    await db('groups').insert({ id: 3, permissions: JSON.stringify(grants), pageRules: JSON.stringify(rules) })
    await db('userGroups').insert([
      { userId: 7, groupId: 3 },
      { userId: 8, groupId: 3 }
    ])
    if (!(await db('locales').where({ code: 'en' }).first())) await db('locales').insert({ code: 'en' })
    errors.length = 0
  })

  afterAll(async () => {
    try {
      if (server?.listening) {
        const closed = Promise.withResolvers<void>()
        server.close(error => (error ? closed.reject(error) : closed.resolve()))
        await closed.promise
      }
    } finally {
      await db?.destroy()
      if (directory) await rm(directory, { recursive: true, force: true })
      configureTransportRuntime(originalRuntime)
      if (originalWiki) Object.defineProperty(globalThis, 'WIKI', originalWiki)
      else Reflect.deleteProperty(globalThis, 'WIKI')
    }
  })

  it('commits a real page and authoritative receipt together and distinguishes committed from current revisions', async () => {
    const requestId = randomUUID()
    const page = await Page.createPage({ ...input(requestId), user: owner } as Parameters<typeof Page.createPage>[0])
    expect(await db('pages').where({ id: page.id }).first()).toMatchObject({ content: 'Reviewed independent draft', sourceRevision: '1' })
    expect(await db('pageCreationReceipts').where({ ownerId: owner.id, requestId }).first()).toMatchObject({
      pageId: page.id,
      sourceRevision: '1',
      originKind: null
    })
    expect(await status(requestId)).toMatchObject({ status: 'committed', requestId, sourceRevision: '1', destination: { id: page.id, path: page.path } })
    await db('pages').where({ id: page.id }).update({ title: 'Later title', path: 'later-destination', content: 'Later independent edit' })
    expect(await status(requestId)).toMatchObject({
      sourceRevision: '1',
      destination: { id: page.id, sourceRevision: '2', title: 'Later title', path: 'later-destination' }
    })
  })

  it('serializes concurrent same-owner/request creates even when the second request chooses a different path', async () => {
    const requestId = randomUUID()
    const results = await Promise.allSettled([create(requestId, { path: 'first-attempt' }), create(requestId, { path: 'second-attempt' })])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected')
    expect(rejected?.status === 'rejected' ? rejected.reason : undefined).toMatchObject({ name: 'PAGE_CREATION_ALREADY_COMMITTED', status: 409 })
    expect(await db('pages')).toHaveLength(1)
    expect(await db('pageCreationReceipts')).toHaveLength(1)
    const committed = await status(requestId)
    expect(committed.status).toBe('committed')
    if (committed.status === 'committed') expect(committed.destination?.id).toBe((await db('pages').first()).id)
  })

  it('rolls back page and all side effects when the native receipt insert fails', async () => {
    await db.raw(`CREATE FUNCTION receipt_fixture_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private receipt persistence failure'; END $$;
      CREATE TRIGGER receipt_fixture_failure AFTER INSERT ON "pageCreationReceipts" FOR EACH ROW EXECUTE FUNCTION receipt_fixture_abort();`)
    const requestId = randomUUID()
    await expect(create(requestId)).rejects.toThrow('private receipt persistence failure')
    for (const table of ['pages', 'pageCreationReceipts', 'pageMutationOutbox', 'outboxEvents', 'durableJobs']) expect(await db(table)).toEqual([])
    expect(await status(requestId)).toEqual({ status: 'unknown', requestId })
  })

  it('isolates the same request identity and private path by owner', async () => {
    const requestId = randomUUID()
    const first = await create(requestId, { path: 'same-private-path' })
    expect(await status(requestId, peer)).toEqual({ status: 'unknown', requestId })
    const other = await create(requestId, { path: 'same-private-path' }, peer)
    expect(first.id).not.toBe(other.id)
    expect(await status(requestId)).toMatchObject({ destination: { id: first.id } })
    expect(await status(requestId, peer)).toMatchObject({ destination: { id: other.id } })
  })

  it('publishes exactly the retained captured note revision, never substitutes the latest, and permits intentional independent publications', async () => {
    const { saved, origin, content } = await publication()
    const latest = await notes.applyUpdate(owner, saved.key, { requestId: 'later-source', update: append(saved.state, '\nLater saved material.') })
    const firstId = randomUUID(),
      secondId = randomUUID()
    const first = await create(firstId, { content, creationOrigin: origin, title: 'Reviewed custom title' })
    const second = await create(secondId, { content, creationOrigin: origin })
    expect(first.content).toBe('Original **saved** body.')
    expect(first.content).not.toContain('Later saved material')
    expect(second.id).not.toBe(first.id)
    const recovered = await inventory(saved.id)
    expect(recovered.items.map(item => item.requestId).sort()).toEqual([firstId, secondId].sort())
    expect(recovered.items.every(item => item.creationOrigin?.kind === 'live-note' && item.creationOrigin.revision === saved.revision)).toBe(true)
    expect(latest.revision).toBeGreaterThan(saved.revision)
    for (const invalid of [
      { content: '# Captured heading\n\nOriginal **saved** body.', creationOrigin: origin },
      { content: 'Original **saved** body.\nLater saved material.', creationOrigin: origin },
      { content, creationOrigin: { ...origin, revision: latest.revision } }
    ])
      await expect(create(randomUUID(), invalid)).rejects.toMatchObject({ status: 409, name: 'NOTE_CAPTURE_MISMATCH' })
    await expect(create(randomUUID(), { content, creationOrigin: { ...origin, revision: latest.revision + 10 } })).rejects.toMatchObject({
      status: 409,
      name: 'NOTE_REVISION_UNAVAILABLE'
    })
    expect(await db('pages')).toHaveLength(2)
    expect(await db('pageCreationReceipts')).toHaveLength(2)
  })

  it('requires a currently owned, visible, completed assistant answer, without binding the editable draft to its body', async () => {
    const origin: PageCreationOrigin = { kind: 'agent-answer', sessionId: randomUUID(), messageId: randomUUID() }
    await db('agentSessions').insert({ id: origin.sessionId, ownerId: owner.id, title: 'Owned answer', retention: 'saved', executionMode: 'review' })
    await db('agentMessages').insert({
      id: origin.messageId,
      sessionId: origin.sessionId,
      ordinal: 1,
      role: 'assistant',
      status: 'complete',
      content: 'Original assistant answer',
      isVisible: true
    })
    const requestId = randomUUID()
    const page = await create(requestId, { content: 'Deliberately edited answer draft', creationOrigin: origin })
    expect(page.content).toBe('Deliberately edited answer draft')
    expect(
      await operations.answerCreationInventory({ requester: owner, sessionId, originSessionId: origin.sessionId, messageId: origin.messageId })
    ).toMatchObject({ items: [{ requestId, creationOrigin: origin }] })
    await expect(create(randomUUID(), { creationOrigin: origin }, peer)).rejects.toMatchObject({ status: 404 })
    for (const invalid of [{ role: 'user' }, { status: 'streaming' }, { isVisible: false }]) {
      await db('agentMessages')
        .where({ id: origin.messageId })
        .update({ role: 'assistant', status: 'complete', isVisible: true, ...invalid })
      await expect(create(randomUUID(), { creationOrigin: origin })).rejects.toMatchObject({ status: 404 })
      expect(await status(requestId)).toMatchObject({ status: 'committed', creationOrigin: null, destination: null })
    }
    await db('agentMessages').where({ id: origin.messageId }).update({ role: 'assistant', status: 'complete', isVisible: true })
    await db('agentSessions').where({ id: origin.sessionId }).update({ deletedAt: new Date() })
    await expect(create(randomUUID(), { creationOrigin: origin })).rejects.toMatchObject({ status: 404 })
    await expect(
      operations.answerCreationInventory({ requester: owner, sessionId, originSessionId: origin.sessionId, messageId: origin.messageId })
    ).rejects.toMatchObject({ status: 404 })
    expect(await status(requestId)).toMatchObject({ status: 'committed', creationOrigin: null, destination: null })
    expect(await db('pages')).toHaveLength(1)
  })

  it('recovers unknown/status/origin inventory through private read-only HTTP without changing persisted state', async () => {
    const { saved, origin, content } = await publication()
    const requestId = randomUUID(),
      unknownId = randomUUID()
    await create(requestId, { creationOrigin: origin, content })
    const before = await persisted()
    for (const endpoint of [`/creation-requests/${unknownId}`, `/creation-requests/${requestId}`, `/creation-origins/live-notes/${saved.id}`]) {
      const response = await http(endpoint)
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(response.headers.get('vary')?.split(/\s*,\s*/)).toContain('Cookie')
      const value = await response.json()
      if (endpoint.includes(unknownId)) expect(value).toEqual({ status: 'unknown', requestId: unknownId })
      else if (endpoint.includes('/creation-origins/')) expect(value.items).toHaveLength(1)
      else expect(value).toMatchObject({ status: 'committed', requestId })
    }
    expect(await persisted()).toEqual(before)
    expect((await http(`/creation-requests/${requestId}`, { claimedOwner: '8' })).status).toBe(409)
    expect(await (await http(`/creation-requests/${requestId}`, { requester: peer })).json()).toEqual({ status: 'unknown', requestId })
    expect((await http(`/creation-origins/live-notes/${saved.id}`, { requester: peer })).status).toBe(404)
  })

  it('withholds revoked or deleted destination metadata while preserving committed proof and immutable revision', async () => {
    const { saved, origin, content } = await publication()
    const requestId = randomUUID()
    const page = await create(requestId, {
      content,
      creationOrigin: origin,
      visibility: 'public',
      isPublished: true,
      path: 'secret-destination',
      title: 'Sensitive destination title'
    })
    await db('groups')
      .where({ id: 3 })
      .update({ permissions: JSON.stringify(['write:notes', 'use:agents']), pageRules: '[]' })
    for (const result of [await status(requestId), (await inventory(saved.id)).items[0]]) {
      expect(result).toMatchObject({ status: 'committed', sourceRevision: '1', creationOrigin: origin, destination: null })
      expect(JSON.stringify(result)).not.toContain('secret-destination')
      expect(JSON.stringify(result)).not.toContain('Sensitive destination title')
      expect(JSON.stringify(result)).not.toContain(`"id":${page.id}`)
    }
    await db('groups')
      .where({ id: 3 })
      .update({ permissions: JSON.stringify(grants), pageRules: JSON.stringify(rules) })
    expect(await status(requestId)).toMatchObject({ destination: { id: page.id } })
    await db('pages').where({ id: page.id }).delete()
    expect(await status(requestId)).toMatchObject({ status: 'committed', sourceRevision: '1', destination: null })
    expect((await inventory(saved.id)).items[0]?.destination).toBeNull()
    expect(await db('pageCreationReceipts')).toHaveLength(1)
  })

  it('waits behind real Agent admission fences before taking account locks, then rejects stale write and recovery sessions', async () => {
    const { saved, origin, content } = await publication()
    const committedId = randomUUID(),
      rejectedId = randomUUID()
    await create(committedId, { content, creationOrigin: origin })
    // Exercise the production coordinator fence used by Agent admission, rather
    // than reproducing its advisory key or mocking transaction lock behavior.
    const { acquireAgentCoordinatorAdvisoryLocks } = await import('../../agents/coordinator.ts')
    const admission = await db.transaction()
    const pending: Promise<unknown>[] = []
    try {
      await admission.raw("SET LOCAL lock_timeout = '3s'")
      await acquireAgentCoordinatorAdvisoryLocks(admission, [owner.id])
      pending.push(status(committedId), inventory(saved.id), create(rejectedId, { content, creationOrigin: origin }))
      for (const work of pending) void work.catch(() => undefined)
      let waiting = 0
      const deadline = Date.now() + 2_000
      while (Date.now() < deadline) {
        const result = await db.raw<{ rows: Array<{ waiting: number }> }>(`
          SELECT count(*)::integer AS waiting FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event='advisory'
        `)
        waiting = result.rows[0]?.waiting ?? 0
        if (waiting === 3) break
      }
      expect(waiting).toBe(3)
      // If a receipt took account FOR SHARE before waiting for admission, this
      // real account update deadlocks/times out instead of completing.
      await admission('users').where({ id: owner.id }).update({ authVersion: 1 })
      await admission.commit()
      const results = await Promise.allSettled(pending)
      expect(results.every(result => result.status === 'rejected')).toBe(true)
      for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 401 })
      expect(await db('pageCreationReceipts').where({ requestId: rejectedId })).toEqual([])
      expect(await db('pages')).toHaveLength(1)
      const refreshed = { ...owner, authVersion: 1 }
      expect(await status(committedId, refreshed)).toMatchObject({ status: 'committed', destination: { id: (await db('pages').first()).id } })
    } finally {
      if (!admission.isCompleted()) await admission.rollback()
      await Promise.allSettled(pending)
    }
  })

  it('locks inventory destinations in numeric order while preserving request order, without deadlocking an ascending page-lock transaction', async () => {
    const { saved, origin, content } = await publication()
    const laterRequest = '00000000-0000-4000-8000-000000000002'
    const earlierRequest = '00000000-0000-4000-8000-000000000001'
    const lowPage = await create(laterRequest, { content, creationOrigin: origin })
    const highPage = await create(earlierRequest, { content, creationOrigin: origin })
    expect(lowPage.id).toBeLessThan(highPage.id)
    const writer = await db.transaction()
    let pending: Promise<PageCreationInventory> | undefined
    try {
      await writer.raw("SET LOCAL lock_timeout = '3s'")
      await writer('pages').where({ id: lowPage.id }).forUpdate().first()
      pending = inventory(saved.id)
      void pending.catch(() => undefined)
      // Observe the real receipt query blocked on the held page. This is a
      // finite database barrier, not a timing sleep or a retry of the operation.
      const deadline = Date.now() + 2_000
      let blocked = false
      while (Date.now() < deadline) {
        const result = await db.raw<{ rows: Array<{ blocked: boolean }> }>(`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE datname=current_database() AND pid<>pg_backend_pid()
              AND wait_event_type='Lock' AND query LIKE '%"pages"%' AND query LIKE '%for share%') AS blocked
        `)
        if (result.rows[0]?.blocked) {
          blocked = true
          break
        }
      }
      expect(blocked).toBe(true)
      // Production moves lock canonical pages by ascending ID. An inventory
      // that already locked highPage in UUID order creates a native deadlock here.
      await writer('pages').where({ id: highPage.id }).forUpdate().first()
      await writer.commit()
      const result = await pending
      expect(result.items.map(item => item.requestId)).toEqual([earlierRequest, laterRequest])
      expect(result.items.map(item => item.destination?.id)).toEqual([highPage.id, lowPage.id])
    } finally {
      if (!writer.isCompleted()) await writer.rollback()
      await pending?.catch(() => undefined)
    }
  })

  it('discloses a protected destination only for a current same-owner/session/password-version unlock, and never mutates reads', async () => {
    const { saved, origin, content } = await publication()
    const requestId = randomUUID()
    const page = await create(requestId, { content, creationOrigin: origin })
    await db('pageAccessPasswords').insert({
      pageId: page.id,
      passwordHash: 'private-password-verifier',
      version: 3,
      updatedBy: peer.id,
      updatedAt: new Date()
    })
    expect(await status(requestId)).toMatchObject({ destination: null })
    expect((await inventory(saved.id)).items[0]?.destination).toBeNull()
    const grantId = randomUUID()
    await db('pageUnlockGrants').insert({
      id: grantId,
      pageId: page.id,
      sessionId,
      userId: owner.id,
      passwordVersion: 3,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000)
    })
    expect(await status(requestId)).toMatchObject({ destination: { id: page.id } })
    expect((await inventory(saved.id)).items[0]?.destination).toMatchObject({ id: page.id })
    expect(await status(requestId, owner, 'another-browser-session')).toMatchObject({ destination: null })
    for (const invalid of [{ userId: peer.id }, { passwordVersion: 2 }, { expiresAt: new Date(Date.now() - 60_000) }]) {
      await db('pageUnlockGrants')
        .where({ id: grantId })
        .update({ userId: owner.id, passwordVersion: 3, expiresAt: new Date(Date.now() + 60_000), ...invalid })
      const before = await persisted()
      expect(await status(requestId)).toMatchObject({ status: 'committed', destination: null })
      expect((await inventory(saved.id)).items[0]?.destination).toBeNull()
      expect(await persisted()).toEqual(before)
    }
    await db('pageUnlockGrants')
      .where({ id: grantId })
      .update({ userId: owner.id, passwordVersion: 3, expiresAt: new Date(Date.now() + 60_000) })
    await db('pages').where({ id: page.id }).update({ ownerId: peer.id })
    // An otherwise valid unlock never widens current page ownership/ACL.
    expect(await status(requestId)).toMatchObject({ destination: null })
    expect((await inventory(saved.id)).items[0]?.destination).toBeNull()
    expect(JSON.stringify(await status(requestId))).not.toContain('private-password-verifier')
  })

  it('hides note origin and destination when source access is revoked, and refuses its origin inventory', async () => {
    const note = await notes.create(peer, {})
    const saved = await notes.applyUpdate(peer, note.key, { requestId: 'shared-note-body', update: append(note.state, 'Shared captured body') })
    const shared = await notes.updateAccess(peer, note.key, { expectedRevision: saved.revision, access: 'read' })
    const origin: PageCreationOrigin = { kind: 'live-note', noteId: shared.id, revision: shared.revision }
    const requestId = randomUUID()
    await create(requestId, { content: 'Shared captured body', creationOrigin: origin })
    expect(await status(requestId)).toMatchObject({ creationOrigin: origin })
    await notes.updateAccess(peer, note.key, { expectedRevision: shared.revision, access: 'private' })
    expect(await status(requestId)).toMatchObject({ status: 'committed', creationOrigin: null, destination: null })
    await expect(inventory(shared.id)).rejects.toMatchObject({ status: 404 })
    await expect(create(randomUUID(), { content: 'Shared captured body', creationOrigin: origin })).rejects.toMatchObject({ status: 404 })
    expect(await db('pages')).toHaveLength(1)
  })

  it('returns known duplicate-path HTTP conflict but masks/logs an unexpected native failure as 500', async () => {
    const firstId = randomUUID()
    const response = await http('/', { method: 'POST', body: input(firstId, { path: 'occupied-path' }) })
    expect(response.status).toBe(201)
    const duplicateId = randomUUID()
    const duplicate = await http('/', { method: 'POST', body: input(duplicateId, { path: 'occupied-path' }) })
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toMatchObject({ error: new domainErrors.PageDuplicateCreate().message })
    expect(await status(duplicateId)).toEqual({ status: 'unknown', requestId: duplicateId })
    const repeated = await http('/', { method: 'POST', body: input(firstId, { path: 'must-not-create-again' }) })
    expect(repeated.status).toBe(409)
    expect(await repeated.json()).toMatchObject({ code: 'PAGE_CREATION_ALREADY_COMMITTED' })
    expect(errors).toEqual([])
    await db.raw(`CREATE FUNCTION receipt_fixture_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private database diagnostic'; END $$;
      CREATE TRIGGER receipt_fixture_failure AFTER INSERT ON "pageCreationReceipts" FOR EACH ROW EXECUTE FUNCTION receipt_fixture_abort();`)
    const failureId = randomUUID()
    const failure = await http('/', { method: 'POST', body: input(failureId) })
    expect(failure.status).toBe(500)
    expect(await failure.json()).toEqual({ error: 'Internal Server Error' })
    expect(errors).toHaveLength(1)
    expect(await status(failureId)).toEqual({ status: 'unknown', requestId: failureId })
    expect(await db('pages')).toHaveLength(1)
    expect(await db('pageCreationReceipts')).toHaveLength(1)
  })
})
