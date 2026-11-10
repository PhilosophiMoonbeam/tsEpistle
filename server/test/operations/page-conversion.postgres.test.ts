import express from 'express'
import session from 'express-session'
import { makeExecutableSchema } from '@graphql-tools/schema'
import { createYoga } from 'graphql-yoga'
import { readFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import knexModule, { type Knex } from 'knex'
import { EventEmitter } from 'node:events'
import * as Objection from 'objection'
import auth, { loadPageRuleAuthority } from '../../core/auth.ts'
import pageErrors from '../../helpers/error.ts'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { up as installPageRevisionTrigger } from '../../db/migrations/tsepistle-000035-page-search-inclusion.ts'
import { up as createJobs } from '../../db/migrations/2.5.130.ts'
import { up as addJobLease } from '../../db/migrations/2.5.158.ts'
import { up as createReviewRouting } from '../../db/migrations/tsepistle-000074-page-review-routing.ts'
import { up as createLifecycle } from '../../db/migrations/tsepistle-000075-page-lifecycle.ts'
import { up as createFeedback } from '../../db/migrations/tsepistle-000073-page-feedback.ts'
import { up as createStoragePageImportOwners } from '../../db/migrations/tsepistle-000077-storage-page-import-owners.ts'
import { up as createEditLocks } from '../../db/migrations/tsepistle-000080-page-edit-locks.ts'
import type { writeOutboxEvent as WriteOutboxEvent } from '../../core/outbox.ts'
import type PageOperations from '../../operations/pages.ts'
import type PageModel from '../../models/pages.ts'
import type PageHistoryModel from '../../models/pageHistory.ts'
import type { reviewPageConversion as ReviewPageConversionOperation } from '../../operations/page-conversion.ts'
import { configureTransportRuntime, getTransportRuntime } from '../../controllers/_types.ts'
import { authDirectiveTransformer } from '../../graph/directives/auth.ts'
import { apiKeyMutationTransformer } from '../../graph/api-key-mutations.ts'
import { createOriginMiddleware } from '../../middlewares/origin.ts'
import { reviewPageConversion as reviewConversionOverHttp } from '../../../client/helpers/pages-api.ts'

const connection = getPostgresTestConnection('_page_conversion_test', import.meta.path)
const suite = connection ? describe : describe.skip
const requester = { id: 7, authVersion: 0, name: 'Conversion author', email: 'conversion@example.test', permissions: ['read:pages', 'write:pages'] }
const original = '<pre><code>&lt;literal&gt;\\ &amp; bytes</code></pre>\r\n<p>Original exact HTML</p>'
const otherRequester = { ...requester, id: 8, name: 'Other conversion author', email: 'other-conversion@example.test' }
const previousTransportRuntime = getTransportRuntime<object>()
const tables = ['pages', 'pageHistory', 'pageHistoryTags', 'pageMutationOutbox', 'outboxEvents']

suite('PostgreSQL reviewed conversion canonical boundary', () => {
  let db: Knex
  let Page: typeof PageModel
  let History: typeof PageHistoryModel
  let reviewPageConversion: typeof ReviewPageConversionOperation
  let writeOutboxEvent: typeof WriteOutboxEvent
  let pageOperations: typeof PageOperations
  let server: Server | undefined
  let origin = ''
  const openBrowser = async (actor = requester): Promise<string> => {
    const response = await fetch(`${origin}/fixture-session/${actor.id}`, { method: 'POST' })
    if (!response.ok) throw new Error('Could not establish the native fixture browser session')
    const cookie = response.headers.get('set-cookie')?.split(';')[0]
    if (!cookie) throw new Error('Native fixture browser session did not set a cookie')
    return cookie
  }
  const reviewOverHttp = (cookie: string) => reviewConversionOverHttp(
    (path, init) => fetch(new URL(path, origin), { ...init, headers: { ...init?.headers, Cookie: cookie, Origin: origin } }),
    42, 'markdown', '1'
  )
  const confirmOverGraphql = async (cookie: string | undefined, reviewToken?: string, editor = 'markdown') => {
    const response = await fetch(`${origin}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({
        query: 'mutation Confirm($editor: String!, $reviewToken: String) { pages { convert(id: 42, editor: $editor, expectedSourceRevision: "1", reviewToken: $reviewToken) { responseResult { succeeded slug message } } } }',
        variables: { editor, reviewToken }
      })
    })
    return response.json()
  }
  const effects: string[] = []
  let effectObserved = Promise.withResolvers<void>()
  let finalEffect: 'links' | 'collaboration' = 'collaboration'
  const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async table => [table, await db(table).select('*').orderBy(table === 'pageHistoryTags' ? 'pageId' : 'id')])))

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection!, pool: { min: 0, max: 5 } })
    await db.raw(`
      CREATE TABLE users (id integer PRIMARY KEY, name text NOT NULL, email text NOT NULL, "isActive" boolean NOT NULL DEFAULT true, "isSystem" boolean NOT NULL DEFAULT false, "authVersion" integer NOT NULL DEFAULT 0);
      CREATE TABLE groups (id integer PRIMARY KEY, name text NOT NULL, permissions jsonb NOT NULL, "pageRules" jsonb NOT NULL);
      CREATE TABLE "userGroups" ("userId" integer NOT NULL, "groupId" integer NOT NULL);
      CREATE TABLE locales (code text PRIMARY KEY);
      CREATE TABLE pages (
        id serial PRIMARY KEY, path text NOT NULL, hash text NOT NULL, "localeCode" text NOT NULL,
        title text NOT NULL, description text NOT NULL DEFAULT '', content text NOT NULL, render text NOT NULL DEFAULT '', toc text NOT NULL DEFAULT '[]',
        "sourceRevision" bigint NOT NULL DEFAULT 1, "renderedSourceRevision" bigint, "localeGroupId" text, "changeReason" text,
        "isPublished" boolean NOT NULL, "isSearchable" boolean NOT NULL DEFAULT true,
        "publishStartDate" text NOT NULL DEFAULT '', "publishEndDate" text NOT NULL DEFAULT '',
        visibility text NOT NULL, "ownerId" integer, "authorId" integer NOT NULL, "creatorId" integer NOT NULL,
        "contentType" text NOT NULL, "editorKey" text NOT NULL, extra jsonb NOT NULL DEFAULT '{}',
        "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE tags (id serial PRIMARY KEY, tag text NOT NULL UNIQUE, title text NOT NULL, "redirectToId" integer, "isArchived" boolean NOT NULL DEFAULT false, "createdAt" text, "updatedAt" text);
      CREATE TABLE "pageTags" ("pageId" integer NOT NULL, "tagId" integer NOT NULL);
      CREATE TABLE "pageHistory" (
        id serial PRIMARY KEY, "pageId" integer NOT NULL, "authorId" integer NOT NULL, path text NOT NULL, hash text NOT NULL,
        title text NOT NULL, description text NOT NULL, visibility text NOT NULL, "ownerId" integer, "isPublished" boolean NOT NULL, "isSearchable" boolean NOT NULL,
        "publishStartDate" text NOT NULL, "publishEndDate" text NOT NULL, content text NOT NULL, "contentType" text NOT NULL, "editorKey" text NOT NULL,
        extra jsonb NOT NULL, "localeCode" text NOT NULL, action text NOT NULL, "versionDate" timestamptz NOT NULL, "sourceRevision" bigint NOT NULL, "changeReason" text,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE "pageHistoryTags" ("pageId" integer NOT NULL, "tagId" integer NOT NULL);
      CREATE TABLE "pageMutationOutbox" (
        id uuid PRIMARY KEY, "pageId" integer NOT NULL, "sourceRevision" bigint NOT NULL, "effectKind" text NOT NULL, "effectKey" text NOT NULL,
        "desiredState" text NOT NULL, "payloadSha256" text NOT NULL, payload text NOT NULL, status text NOT NULL, attempts integer NOT NULL,
        "availableAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL,
        UNIQUE ("pageId", "sourceRevision", "effectKind")
      );
      CREATE TABLE "outboxEvents" (id uuid PRIMARY KEY, type text NOT NULL, version integer NOT NULL, "aggregateType" text NOT NULL,
        "aggregateId" text NOT NULL, payload text NOT NULL, "createdAt" timestamptz NOT NULL, "publishedAt" timestamptz);
      CREATE TABLE "pageAccessPasswords" ("pageId" integer PRIMARY KEY, "passwordHash" text NOT NULL, version integer NOT NULL, "updatedBy" integer NOT NULL, "updatedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE "pageUnlockGrants" (id text PRIMARY KEY, "pageId" integer NOT NULL, "sessionId" text NOT NULL, "userId" integer NOT NULL, "passwordVersion" integer NOT NULL, "expiresAt" timestamptz NOT NULL);
      CREATE TABLE storage (key text PRIMARY KEY, "isEnabled" boolean NOT NULL, mode text NOT NULL, "syncInterval" text NOT NULL, config jsonb NOT NULL);
      CREATE TABLE "assetFolders" (id serial PRIMARY KEY, name text, slug text, "parentId" integer);
      CREATE TABLE assets (id serial PRIMARY KEY, filename text, "folderId" integer);
      CREATE TABLE "pageTree" ("pageId" integer, title text);
    `)
    await installPageRevisionTrigger(db)
    await createJobs(db)
    await addJobLease(db)
    await createReviewRouting(db)
    await createLifecycle(db)
    await createFeedback(db)
    await createStoragePageImportOwners(db)
    await createEditLocks(db)
    await db('users').insert([requester, otherRequester].map(actor => ({ id: actor.id, name: actor.name, email: actor.email })))
    await db('groups').insert({ id: 3, name: 'Authors', permissions: JSON.stringify(requester.permissions), pageRules: JSON.stringify([{ match: 'START', path: '', deny: false, roles: requester.permissions }]) })
    await db('userGroups').insert([requester, otherRequester].map(actor => ({ userId: actor.id, groupId: 3 })))
    const runtime = {
      config: { db: { type: 'postgres' }, lang: { code: 'en', namespacing: false }, sessionSecret: 'canonical-native-feedback-session-secret' },
      // Match the native auth runtime guard; authorization still reads the owned database.
      configSvc: {}, lang: {}, startedAt: {},
      data: { editors: [{ key: 'ckeditor', contentType: 'html' }, { key: 'markdown', contentType: 'markdown' }, { key: 'visual-markdown', contentType: 'markdown' }] },
      events: { inbound: new EventEmitter(), outbound: new EventEmitter() }, logger: console, Error: pageErrors,
      collaboration: { pageChanged: async () => { effects.push('collaboration'); if (finalEffect === 'collaboration') effectObserved.resolve() } },
      auth: { loadPageRuleAuthority, checkPageAccess: auth.checkPageAccess, checkAccess: auth.checkAccess },
      models: { knex: db, Objection, pages: {} as unknown, pageHistory: {} as unknown,
        renderers: { getRenderingPipeline: async () => [{ key: 'markdownCore', config: { allowHTML: true, linebreaks: true, linkify: true, typographer: false, underline: true, quotes: 'English' }, children: [] }] } }
    }
    vi.stubGlobal('WIKI', runtime)
    configureTransportRuntime(runtime)
    // Native model modules capture the disposable WIKI runtime during evaluation.
    Page = (await import('../../models/pages.ts')).default
    History = (await import('../../models/pageHistory.ts')).default
    const Tag = (await import('../../models/tags.ts')).default
    const User = (await import('../../models/users.ts')).default
    for (const model of [Page, History, Tag, User]) model.knex(db)
    Object.assign(runtime.models, { pages: Page, pageHistory: History, tags: Tag })
    reviewPageConversion = (await import('../../operations/page-conversion.ts')).reviewPageConversion
    writeOutboxEvent = (await import('../../core/outbox.ts')).writeOutboxEvent
    pageOperations = (await import('../../operations/pages.ts')).default
    // Cache is a postcommit adapter; all source/history/revision/outbox writes below are native.
    vi.spyOn(Page, 'deletePageFromCache').mockImplementation(async () => { effects.push('cache') })
    vi.spyOn(Page, 'rebuildTree').mockImplementation(async () => { effects.push('tree') })
    vi.spyOn(Page, 'reconnectLinks').mockImplementation(async () => { effects.push('links'); if (finalEffect === 'links') effectObserved.resolve() })
    // The production page resolver captures operations bound to the disposable WIKI runtime.
    const { default: pageResolvers } = await import('../../graph/resolvers/page.ts')
    const typeDefs = await Promise.all(['common', 'scalars', 'page', 'logging'].map(name =>
      readFile(new URL(`../../graph/schemas/${name}.graphql`, import.meta.url), 'utf8')
    ))
    const schema = apiKeyMutationTransformer(authDirectiveTransformer(makeExecutableSchema({ typeDefs, resolvers: pageResolvers })))
    const yoga = createYoga<{ req: express.Request; res: express.Response }>({
      schema, graphqlEndpoint: '/graphql', graphiql: false, logging: false,
      context: ({ req }) => ({ req })
    })
    const app = express()
    app.use(express.json())
    app.use(session({ secret: runtime.config.sessionSecret, resave: false, saveUninitialized: false }))
    app.post('/fixture-session/:id', (req, res, next) => {
      const actor = [requester, otherRequester].find(candidate => String(candidate.id) === req.params.id)
      if (!actor) { res.sendStatus(404); return }
      req.session.regenerate(error => {
        if (error) { next(error); return }
        Object.assign(req.session, { conversionActorId: actor.id })
        req.session.save(saveError => {
          if (saveError) next(saveError)
          else res.sendStatus(204)
        })
      })
    })
    app.use((req, _res, next) => {
      const actor = [requester, otherRequester].find(candidate => candidate.id === Reflect.get(req.session, 'conversionActorId'))
      if (actor) req.user = actor
      next()
    })
    app.use(createOriginMiddleware(() => origin))
    // The production REST module must likewise load after the disposable runtime is installed.
    const { default: pagesRouter } = await import('../../controllers/api/pages.ts')
    app.use('/_api/pages', pagesRouter)
    app.use('/graphql', (req, res, next) => { void Promise.resolve(yoga(req, res)).catch(next) })
    const listening = Promise.withResolvers<void>()
    server = app.listen(0, '127.0.0.1')
    server.once('listening', listening.resolve)
    server.once('error', listening.reject)
    await listening.promise
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Conversion browser fixture did not bind a TCP port')
    origin = `http://127.0.0.1:${address.port}`
  })
  beforeEach(async () => {
    await db('pageEditLockAudit').delete()
    await db('pageEditLocks').delete()
    await db('feedbackBoards').delete()
    await db('pageLifecycleClocks').delete()
    await db('pageReviewRouting').delete()
    await db('durableJobs').delete()
    await db('storagePageImportOwners').delete()
    effects.length = 0
    effectObserved = Promise.withResolvers<void>()
    finalEffect = 'collaboration'
    for (const table of [...tables].reverse()) await db(table).delete()
    await db('groups').where({ id: 3 }).update({ permissions: JSON.stringify(requester.permissions), pageRules: JSON.stringify([{ match: 'START', path: '', deny: false, roles: requester.permissions }]) })
    await db('pages').insert({ id: 42, path: 'guide/review', hash: 'conversion-original', localeCode: 'en', title: 'Conversion source', content: original, render: '<p>Old derived render</p>', renderedSourceRevision: 1, contentType: 'html', editorKey: 'ckeditor', visibility: 'public', ownerId: null, isPublished: true, authorId: requester.id, creatorId: requester.id })
  })
  afterAll(async () => {
    try {
      if (server?.listening) {
        const closed = Promise.withResolvers<void>()
        server.close(error => error ? closed.reject(error) : closed.resolve())
        await closed.promise
      }
    } finally {
      try { if (db) await db.destroy() } finally {
        configureTransportRuntime(previousTransportRuntime)
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
      }
    }
  })

  const review = () => reviewPageConversion(42, { editor: 'markdown', expectedSourceRevision: '1' }, { requester })

  it('refuses a genuine reviewed conversion when the page is locked after review without consuming canonical state', async () => {
    const candidate = await review()
    await db('pageEditLocks').insert({ pageId: 42, isEditLocked: true, lockVersion: '1', updatedBy: requester.id, reason: 'Retain current HTML until explicit unlock' })
    const before = await snapshot()
    await expect(Page.convertPage({ id: 42, editor: 'markdown', user: requester, expectedSourceRevision: '1', reviewToken: candidate.reviewToken })).rejects.toMatchObject({ name: 'PAGE_EDIT_LOCKED', status: 409 })
    expect(await snapshot()).toEqual(before)
  })

  it('refuses a direct unreviewed HTML-to-Markdown model mutation without touching native state', async () => {
    const before = await snapshot()
    await expect(Page.convertPage({ id: 42, editor: 'markdown', user: requester, expectedSourceRevision: '1' })).rejects.toMatchObject({ name: 'CONVERSION_REVIEW_STALE', status: 409 })
    expect(await snapshot()).toEqual(before)
    expect(await db('pageLifecycleClocks')).toEqual([])
    expect(effects).toEqual([])
  })

  it('review is mutation-free; confirmation atomically retains exact original history and durable publication', async () => {
    const before = await snapshot()
    const candidate = await review()
    expect(candidate.originalSource).toBe(original)
    expect(await snapshot()).toEqual(before)
    await Page.convertPage({ id: 42, editor: 'markdown', user: requester, expectedSourceRevision: '1', reviewToken: candidate.reviewToken })
    const page = await db('pages').where({ id: 42 }).first()
    expect(page).toMatchObject({ content: candidate.candidate, contentType: 'markdown', editorKey: 'markdown', sourceRevision: '2', renderedSourceRevision: null })
    expect(await db('pageHistory').where({ pageId: 42 }).first()).toMatchObject({ content: original, contentType: 'html', editorKey: 'ckeditor', sourceRevision: '1' })
    expect(await db('outboxEvents').where({ type: 'page.updated' })).toHaveLength(1)
    expect((await db('pageMutationOutbox').where({ pageId: 42 })).length).toBeGreaterThan(0)
  }, 15_000)

  it('confirms a real REST review through GraphQL in the same native browser session', async () => {
    const cookie = await openBrowser()
    const before = await snapshot()
    const candidate = await reviewOverHttp(cookie)
    expect(candidate.originalSource).toBe(original)
    expect(await snapshot()).toEqual(before)
    const result = await confirmOverGraphql(cookie, candidate.reviewToken)
    expect(result.errors).toBeUndefined()
    expect(result.data?.pages.convert.responseResult).toMatchObject({ succeeded: true })
    expect(await db('pages').where({ id: 42 }).first()).toMatchObject({
      content: candidate.candidate, contentType: 'markdown', editorKey: 'markdown', sourceRevision: '2', renderedSourceRevision: null
    })
    expect(await db('pageHistory').where({ pageId: 42 }).first()).toMatchObject({ content: original, contentType: 'html', sourceRevision: '1' })
    expect(await db('outboxEvents').where({ type: 'page.updated' })).toHaveLength(1)
    expect((await db('pageMutationOutbox').where({ pageId: 42 })).length).toBeGreaterThan(0)
  }, 15_000)

  it('refuses foreign session, foreign user, changed editor and stale source proofs through GraphQL', async () => {
    const cookie = await openBrowser()
    const candidate = await reviewOverHttp(cookie)
    const before = await snapshot()
    for (const [proofCookie, editor] of [
      [await openBrowser(), 'markdown'],
      [await openBrowser(otherRequester), 'markdown'],
      [cookie, 'visual-markdown']
    ]) {
      const result = await confirmOverGraphql(proofCookie, candidate.reviewToken, editor)
      expect(result.errors).toBeUndefined()
      expect(result.data?.pages.convert.responseResult).toMatchObject({ succeeded: false, slug: 'CONVERSION_REVIEW_STALE' })
      expect(await snapshot()).toEqual(before)
    }
    await db('pages').where({ id: 42 }).update({ content: '<p>Concurrent source wins</p>' })
    const edited = await snapshot()
    const stale = await confirmOverGraphql(cookie, candidate.reviewToken)
    expect(stale.errors).toBeUndefined()
    expect(stale.data?.pages.convert.responseResult).toMatchObject({ succeeded: false, slug: 'PageUpdateConflict' })
    expect(await snapshot()).toEqual(edited)
  }, 15_000)

  it('does not expose client-authored session context or an unreviewed GraphQL conversion shim', async () => {
    const cookie = await openBrowser()
    const candidate = await reviewOverHttp(cookie)
    const before = await snapshot()
    const unreviewed = await confirmOverGraphql(cookie)
    expect(unreviewed.data?.pages.convert.responseResult).toMatchObject({ succeeded: false, slug: 'CONVERSION_REVIEW_STALE' })
    const unsupported = await confirmOverGraphql(undefined, candidate.reviewToken)
    expect(unsupported.errors).toBeDefined()
    const forged = await fetch(`${origin}/graphql`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
      body: JSON.stringify({ query: 'mutation { pages { convert(id: 42, editor: "markdown", expectedSourceRevision: "1", sessionId: "client-authored") { responseResult { succeeded } } } }' })
    })
    expect((await forged.json()).errors).toBeDefined()
    expect(await snapshot()).toEqual(before)
  }, 15_000)

  it('stale source and revoked rules cannot commit a retained review', async () => {
    const candidate = await review()
    await db('pages').where({ id: 42 }).update({ content: '<p>Concurrent edit wins</p>' })
    const afterEdit = await snapshot()
    await expect(Page.convertPage({ id: 42, editor: 'markdown', user: requester, expectedSourceRevision: '1', reviewToken: candidate.reviewToken })).rejects.toMatchObject({ name: 'PageUpdateConflict', status: 409 })
    expect(await snapshot()).toEqual(afterEdit)
    await db('groups').where({ id: 3 }).update({ permissions: '[]', pageRules: '[]' })
    const beforeRevoked = await snapshot()
    await expect(reviewPageConversion(42, { editor: 'markdown', expectedSourceRevision: '2' }, { requester })).rejects.toMatchObject({ name: 'PAGE_NOT_FOUND', status: 404 })
    await expect(Page.convertPage({ id: 42, editor: 'markdown', user: requester, expectedSourceRevision: '2', reviewToken: candidate.reviewToken })).rejects.toMatchObject({ name: 'PageUpdateForbidden', code: 6009 })
    expect(await snapshot()).toEqual(beforeRevoked)
  }, 15_000)

  it('withholds a locked private-page policy after manager authority is revoked while an edit waits, before associating proposed tags', async () => {
    const actor = { ...requester, permissions: ['read:pages', 'write:pages', 'manage:system'] }
    await db('groups').where({ id: 3 }).update({ permissions: JSON.stringify(actor.permissions) })
    await db('pages').where({ id: 42 }).update({ visibility: 'private', ownerId: otherRequester.id })
    const page = await db('pages').where({ id: 42 }).first()
    await db('pageEditLocks').insert({ pageId: 42, isEditLocked: true, lockVersion: '1', updatedBy: requester.id, reason: 'Current private authority must precede edit-lock disclosure' })
    const before = await snapshot(), blocker = await db.transaction(), preflight = Promise.withResolvers<void>()
    let mutation: Promise<unknown> | undefined
    const authority = vi.spyOn(WIKI.auth, 'loadPageRuleAuthority').mockImplementation(async (user, transaction) => {
      const current = await loadPageRuleAuthority(user, transaction)
      if (!transaction && user === actor) preflight.resolve()
      return current
    })
    try {
      await blocker('pages').where({ id: 42 }).forUpdate().first()
      mutation = Page.updatePage({ id: 42, user: actor, content: 'Must not replace private source', tags: ['must-not-associate'], expectedSourceRevision: String(page.sourceRevision) }).then(() => null, error => { preflight.reject(error); return error })
      await preflight.promise
      await db('groups').where({ id: 3 }).update({ permissions: JSON.stringify(requester.permissions) })
      await blocker.commit()
      expect(await mutation).toMatchObject({ name: 'PageNotFound' })
      expect(await snapshot()).toEqual(before)
      expect(await db('tags').where({ tag: 'must-not-associate' })).toEqual([])
    } finally {
      authority.mockRestore()
      if (!blocker.isCompleted()) await blocker.rollback()
      await mutation
    }
  })

  it('reauthorizes after waiting for the canonical page lock, not only before conversion', async () => {
    const candidate = await review()
    await db('pageEditLocks').insert({ pageId: 42, isEditLocked: true, lockVersion: '1', updatedBy: requester.id, reason: 'The prior writer must not learn policy after current authority is revoked' })
    const before = await snapshot()
    const blocker = await db.transaction()
    let mutation: Promise<unknown> | undefined
    try {
      await blocker('pages').where({ id: 42 }).forUpdate().first()
      const preflight = Promise.withResolvers<void>()
      const authority = vi.spyOn(WIKI.auth, 'loadPageRuleAuthority').mockImplementation(async (user, transaction) => {
        const result = await loadPageRuleAuthority(user, transaction)
        if (!transaction) preflight.resolve()
        return result
      })
      try {
        mutation = Page.convertPage({ id: 42, editor: 'markdown', user: requester, expectedSourceRevision: '1', reviewToken: candidate.reviewToken }).then(() => null, error => {
          preflight.reject(error)
          return error
        })
        await preflight.promise
        await db('groups').where({ id: 3 }).update({ permissions: '[]', pageRules: '[]' })
        await blocker.commit()
        expect(await mutation).toMatchObject({ name: 'PageUpdateForbidden', code: 6009 })
        expect(await snapshot()).toEqual(before)
      } finally {
        authority.mockRestore()
      }
    } finally {
      try {
        if (!blocker.isCompleted()) await blocker.rollback()
      } finally {
        await mutation
      }
    }
  }, 15_000)

  it('rolls back source, original history and outboxes when canonical publication fails', async () => {
    const candidate = await review()
    await db.raw(`CREATE FUNCTION reject_conversion_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned conversion failure'; END; $$; CREATE TRIGGER reject_conversion_outbox BEFORE INSERT ON "pageMutationOutbox" FOR EACH ROW EXECUTE FUNCTION reject_conversion_outbox()`)
    try {
      const before = await snapshot()
      await expect(Page.convertPage({ id: 42, editor: 'markdown', user: requester, expectedSourceRevision: '1', reviewToken: candidate.reviewToken })).rejects.toMatchObject({ code: 'P0001' })
      expect(await snapshot()).toEqual(before)
    } finally {
      await db.raw('DROP TRIGGER reject_conversion_outbox ON "pageMutationOutbox"; DROP FUNCTION reject_conversion_outbox()')
    }
  }, 15_000)

  it('commits an explicitly reviewed empty candidate as empty, retaining the nonempty original', async () => {
    await db('pages').where({ id: 42 }).update({ content: '<p></p>' })
    const candidate = await reviewPageConversion(42, { editor: 'markdown', expectedSourceRevision: '2' }, { requester })
    expect(candidate.candidate).toBe('')
    await Page.convertPage({ id: 42, editor: 'markdown', user: requester, expectedSourceRevision: '2', reviewToken: candidate.reviewToken })
    expect(await db('pages').where({ id: 42 }).first('content', 'contentType')).toEqual({ content: '', contentType: 'markdown' })
    expect(await db('pageHistory').where({ pageId: 42 }).first('content')).toEqual({ content: '<p></p>' })
  }, 15_000)

  it.each(['create', 'update', 'move'] as const)('keeps native %s and its hook receipt in the caller transaction until outer commit', async kind => {
    finalEffect = kind === 'create' ? 'links' : 'collaboration'
    const before = await snapshot()
    const receiptId = crypto.randomUUID()
    const transaction = await db.transaction()
    const hook: NonNullable<Parameters<typeof Page.updatePage>[0]['canonicalTransactionHook']> = async (canonicalTransaction, result) => {
      expect(canonicalTransaction).toBe(transaction)
      expect(await canonicalTransaction('outboxEvents').where({ id: result.outboxId, aggregateId: String(result.id) }).first()).toBeDefined()
      await writeOutboxEvent(canonicalTransaction, { id: receiptId, type: 'page.canonical-hook-receipt', version: 1, aggregateType: 'page', aggregateId: result.id, payload: { pageId: result.id, sourceRevision: result.sourceRevision, outboxId: result.outboxId } })
    }
    try {
      if (kind === 'create') await Page.createPage({ path: 'new-caller-page', locale: 'en', user: requester, content: '# New source', editor: 'markdown', description: '', visibility: 'public', isPublished: true, title: 'New caller page', transaction, canonicalTransactionHook: hook })
      else if (kind === 'update') await Page.updatePage({ id: 42, user: requester, content: 'Caller transaction edit', expectedSourceRevision: '1', transaction, canonicalTransactionHook: hook })
      else await Page.movePage({ id: 42, user: requester, destinationPath: 'guide/caller-move', destinationLocale: 'en', expectedSourceRevision: '1', transaction, canonicalTransactionHook: hook })
      expect(await transaction('outboxEvents').where({ id: receiptId }).first()).toBeDefined()
      expect(await db('outboxEvents').where({ id: receiptId }).first()).toBeUndefined()
      expect(await snapshot()).toEqual(before)
      expect(effects).toEqual([])
      await transaction.commit()
      await effectObserved.promise
      const event = await db('outboxEvents').where({ id: receiptId }).first()
      expect(event).toBeDefined()
      const receipt = JSON.parse(event.payload) as { pageId: number; sourceRevision: string; outboxId: string }
      expect(await db('pages').where({ id: receipt.pageId }).first('sourceRevision')).toMatchObject({ sourceRevision: receipt.sourceRevision })
      expect(effects).toContain('cache')
    } finally {
      if (!transaction.isCompleted()) await transaction.rollback()
    }
  })

  it.each(['create', 'update', 'move'] as const)('rolls back canonical %s/history/outbox/clock when the admission hook rejects', async kind => {
    const before = await snapshot()
    const beforeClocks = await db('pageLifecycleClocks')
    const transaction = await db.transaction()
    const refusal = new Error('owned canonical receipt refusal')
    const hook: NonNullable<Parameters<typeof Page.updatePage>[0]['canonicalTransactionHook']> = async (canonicalTransaction, result) => {
      await writeOutboxEvent(canonicalTransaction, { type: 'page.canonical-hook-receipt', version: 1, aggregateType: 'page', aggregateId: result.id, payload: { pageId: result.id, sourceRevision: result.sourceRevision, outboxId: result.outboxId } })
      throw refusal
    }
    try {
      const mutation = kind === 'create'
        ? Page.createPage({ path: 'rejected-caller-page', locale: 'en', user: requester, content: '# Rejected', editor: 'markdown', description: '', visibility: 'public', isPublished: true, title: 'Rejected', transaction, canonicalTransactionHook: hook })
        : kind === 'update'
          ? Page.updatePage({ id: 42, user: requester, content: 'Rejected update', expectedSourceRevision: '1', transaction, canonicalTransactionHook: hook })
          : Page.movePage({ id: 42, user: requester, destinationPath: 'rejected-move', destinationLocale: 'en', expectedSourceRevision: '1', transaction, canonicalTransactionHook: hook })
      await expect(mutation).rejects.toBe(refusal)
      await transaction.rollback()
      expect(await snapshot()).toEqual(before)
      expect(await db('outboxEvents').where({ type: 'page.canonical-hook-receipt' })).toEqual([])
      expect(await db('pageLifecycleClocks')).toEqual(beforeClocks)
      expect(effects).toEqual([])
    } finally {
      if (!transaction.isCompleted()) await transaction.rollback()
    }
  })

  it('suppresses released-savepoint effects when the outer transaction rolls back without an error', async () => {
    const before = await snapshot()
    const outer = await db.transaction()
    try {
      await outer.transaction(async transaction => {
        await Page.updatePage({ id: 42, user: requester, content: 'Released savepoint', expectedSourceRevision: '1', transaction })
      })
      expect(effects).toEqual([])
      await outer.rollback()
      expect(await snapshot()).toEqual(before)
      expect(effects).toEqual([])
    } finally {
      if (!outer.isCompleted()) await outer.rollback()
    }
  })

  it('attaches a full native feedback page and rejects a membership write without leaving a canonical orphan', async () => {
    const boardId = crypto.randomUUID()
    await db('feedbackBoards').insert({ id: boardId, boardPageId: 42, name: 'Native feedback', enabled: true })
    const createInput = { path: 'ideas/full-native-source', locale: 'en', content: '# A fully authored proposal', editor: 'markdown', description: 'Native canonical draft', visibility: 'public', isPublished: false, title: 'Native proposal', feedbackSubmission: { boardId, expectedBoardRevision: '1', acknowledged: true } }
    finalEffect = 'links'
    const page = await pageOperations.create({ requester, sessionId: 'canonical-feedback-browser', input: createInput }) as PageModel
    await effectObserved.promise
    expect(await db('pages').where({ id: page.id }).first()).toMatchObject({ content: createInput.content, isPublished: false, ownerId: null })
    expect(await db('feedbackIdeas').where({ pageId: page.id }).first()).toMatchObject({ boardId, submittedBy: requester.id, state: 'proposed' })
    expect(await db('feedbackVotes')).toEqual([])
    expect(await db('pageLifecycleClocks').where({ pageId: page.id }).first()).toMatchObject({ bodyAnchorKind: 'known-change', bodyObservedSourceRevision: '1' })
    const before = await snapshot()
    const beforeIdeas = await db('feedbackIdeas')
    const beforeClocks = await db('pageLifecycleClocks')
    effects.length = 0
    await db.raw("CREATE FUNCTION reject_native_feedback_attach() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned native feedback refusal'; END; $$; CREATE TRIGGER reject_native_feedback_attach BEFORE INSERT ON \"feedbackIdeas\" FOR EACH ROW EXECUTE FUNCTION reject_native_feedback_attach()")
    try {
      await expect(Promise.resolve(pageOperations.create({ requester, sessionId: 'canonical-feedback-browser', input: { ...createInput, path: 'ideas/must-not-orphan' } }))).rejects.toMatchObject({ code: 'P0001' })
      expect(await snapshot()).toEqual(before)
      expect(await db('feedbackIdeas')).toEqual(beforeIdeas)
      expect(await db('pageLifecycleClocks')).toEqual(beforeClocks)
      expect(effects).toEqual([])
    } finally {
      await db.raw('DROP TRIGGER reject_native_feedback_attach ON "feedbackIdeas"; DROP FUNCTION reject_native_feedback_attach()')
    }
  })

  it('feeds exact canonical body clocks without treating metadata or identical restoration as body activity', async () => {
    const transaction = await db.transaction()
    let pageId: number | undefined
    try {
      const created = await Page.createPage({ path: 'body-clock-source', locale: 'en', user: requester, content: '# Body bytes', editor: 'markdown', description: '', visibility: 'public', isPublished: false, title: 'Body clock', transaction })
      pageId = created.id
      const initial = await transaction('pageLifecycleClocks').where({ pageId }).first()
      expect(initial).toMatchObject({ bodyAnchorKind: 'known-change', bodyObservedSourceRevision: '1' })
      const oldReviewTime = new Date('2020-01-01T00:00:00.000Z')
      await transaction('pageReviewRouting').insert({ pageId, enabled: true, observedSourceRevision: '1', unverifiedAt: oldReviewTime, enabledAt: oldReviewTime, createdAt: oldReviewTime, updatedAt: oldReviewTime })
      const metadata = await Page.updatePage({ id: pageId, user: requester, title: 'Metadata only', expectedSourceRevision: '1', transaction })
      expect(await transaction('pageLifecycleClocks').where({ pageId }).first()).toMatchObject({ bodyEpoch: initial.bodyEpoch, bodyAnchorAt: initial.bodyAnchorAt, bodyDigest: initial.bodyDigest, bodyObservedSourceRevision: metadata.sourceRevision })
      const routed = await transaction('pageReviewRouting').where({ pageId }).first()
      expect(routed.observedSourceRevision).toBe(String(metadata.sourceRevision))
      expect(new Date(routed.unverifiedAt).valueOf()).toBeGreaterThan(oldReviewTime.valueOf())
      const restored = await Page.updatePage({ id: pageId, user: requester, content: created.content, description: 'Restored unchanged body', action: 'restored', expectedSourceRevision: String(metadata.sourceRevision), transaction })
      expect(await transaction('pageLifecycleClocks').where({ pageId }).first()).toMatchObject({ bodyEpoch: initial.bodyEpoch, bodyDigest: initial.bodyDigest, bodyObservedSourceRevision: restored.sourceRevision })
      const changed = await Page.updatePage({ id: pageId, user: requester, content: '# Changed exact bytes', expectedSourceRevision: String(restored.sourceRevision), transaction })
      const finalClock = await transaction('pageLifecycleClocks').where({ pageId }).first()
      expect(finalClock).toMatchObject({ bodyAnchorKind: 'known-change', bodyObservedSourceRevision: changed.sourceRevision })
      expect(finalClock.bodyEpoch).not.toBe(initial.bodyEpoch)
      expect(finalClock.bodyDigest).not.toBe(initial.bodyDigest)
      const revisionJobs = await transaction('durableJobs').where({ type: 'page-review-reminder' })
      expect(revisionJobs).toHaveLength(3)
      for (const job of revisionJobs) expect(JSON.parse(job.payload)).toEqual({ mode: 'reconcile', pageId })
      expect(effects).toEqual([])
    } finally {
      if (!transaction.isCompleted()) await transaction.rollback()
    }
    expect(await db('pages').where({ id: pageId }).first()).toBeUndefined()
    expect(await db('durableJobs').where({ type: 'page-review-reminder' })).toEqual([])
    expect(effects).toEqual([])
  })

  it('publishes nested native effects only after the actual outer commit', async () => {
    const outer = await db.transaction()
    try {
      await outer.transaction(async transaction => {
        await Page.updatePage({ id: 42, user: requester, content: 'Committed savepoint', expectedSourceRevision: '1', transaction })
      })
      expect(effects).toEqual([])
      expect((await db('pages').where({ id: 42 }).first()).content).toBe(original)
      await outer.commit()
      await effectObserved.promise
      expect((await db('pages').where({ id: 42 }).first()).content).toBe('Committed savepoint')
      expect(effects).toContain('cache')
      expect(effects).toContain('collaboration')
    } finally {
      if (!outer.isCompleted()) await outer.rollback()
    }
  })

  it('does not publish rolled-back savepoint effects when the enclosing transaction commits', async () => {
    const before = await snapshot()
    const outer = await db.transaction()
    try {
      const nested = await outer.transaction()
      try {
        await Page.updatePage({ id: 42, user: requester, content: 'Rolled-back savepoint', expectedSourceRevision: '1', transaction: nested })
        await nested.rollback()
        await outer.commit()
        expect(await snapshot()).toEqual(before)
        expect(effects).toEqual([])
      } finally {
        if (!nested.isCompleted()) await nested.rollback()
      }
    } finally {
      if (!outer.isCompleted()) await outer.rollback()
    }
  })

  it('refuses protected unattended updates without manufacturing an interactive unlock', async () => {
    await db('pageAccessPasswords').insert({ pageId: 42, passwordHash: 'native-fixture-protection', version: 1, updatedBy: requester.id })
    const before = await snapshot()
    const hook = vi.fn(async () => {})
    const transaction = await db.transaction()
    try {
      await expect(Page.updatePage({ id: 42, user: requester, tags: ['lifecycle-tag'], expectedSourceRevision: '1', transaction, unattendedLifecycle: true, canonicalTransactionHook: hook })).rejects.toMatchObject({ name: 'LIFECYCLE_NEEDS_INTERACTIVE', status: 403 })
      expect(hook).not.toHaveBeenCalled()
      await transaction.rollback()
      expect(await snapshot()).toEqual(before)
      expect(await db('tags').where({ tag: 'lifecycle-tag' })).toEqual([])
      expect(effects).toEqual([])
    } finally {
      if (!transaction.isCompleted()) await transaction.rollback()
      await db('pageAccessPasswords').where({ pageId: 42 }).delete()
    }
  })
})
