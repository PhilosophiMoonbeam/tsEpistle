/// <reference types="bun" />

import { createHash } from 'node:crypto'
import knexModule from 'knex'
import type { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { up as createProtectionSchema } from '../../db/migrations/2.5.134.ts'
import { up as createKnowledgeSchema } from '../../db/migrations/2.5.152.ts'
import { up as createKnowledgeSearch } from '../../db/migrations/tsepistle-000027-knowledge-search.ts'
import {
  enqueuePageMutationEffects,
  PageProjectionLifecycle
} from '../../core/page-mutation-outbox.ts'
import type PageModel from '../../models/pages.ts'
import type pageOperations from '../../operations/pages.ts'
import type * as pageProtection from '../../operations/page-protection.ts'
import type { SearchOptions, SearchResult } from '../../modules/types.ts'

interface ProtectionSearchEngine {
  config: { dictLanguage: string }
  init(): Promise<void>
  updated(page: unknown): Promise<void>
  reconcilePage(pageId: number): Promise<void>
  removePage(pageId: number): Promise<void>
  query(query: string, options: SearchOptions): Promise<SearchResult>
}

const connection = getPostgresTestConnection('_page_protection_test', import.meta.path)
const suite = connection ? describe : describe.skip
const deferred = () => {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

suite('PostgreSQL protection search withdrawal', () => {
  let db: Knex
  let observer: Knex
  let Page: typeof PageModel
  let engine: ProtectionSearchEngine
  let operations: typeof pageOperations
  let protection: typeof pageProtection
  const originalWiki = Reflect.get(globalThis, 'WIKI')
  const bodyToken = 'classifiedbodyuniquetoken'
  const assetPath = 'uploads/diagram.png'
  const source = `${bodyToken}\n\n![Diagram](/${assetPath})`
  const render = `<p>${bodyToken}</p><img src="/${assetPath}">`
  const requester = { id: 7, email: 'editor@example.test', permissions: ['read:pages', 'write:pages'] }

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined })
    observer = knexModule({ client: 'pg', connection: connection ?? undefined })
    await db.raw(`
      CREATE TABLE users (id integer PRIMARY KEY, name text NOT NULL, email text NOT NULL);
      CREATE TABLE assets (id integer PRIMARY KEY, hash text NOT NULL);
      CREATE TABLE pages (
        id integer PRIMARY KEY, "sourceRevision" bigint NOT NULL, "renderedSourceRevision" bigint,
        path text NOT NULL, hash text NOT NULL DEFAULT '', "localeCode" varchar(35) NOT NULL,
        title text NOT NULL, description text NOT NULL DEFAULT '', content text NOT NULL DEFAULT '',
        render text NOT NULL DEFAULT '', toc jsonb NOT NULL DEFAULT '[]'::jsonb,
        "contentType" text NOT NULL DEFAULT 'markdown', "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(), "editorKey" text NOT NULL DEFAULT '',
        "authorId" integer NOT NULL DEFAULT 7, "creatorId" integer NOT NULL DEFAULT 7, "ownerId" integer,
        extra jsonb NOT NULL DEFAULT '{}'::jsonb, visibility text NOT NULL, "isPublished" boolean NOT NULL,
        "isSearchable" boolean NOT NULL DEFAULT true, "publishStartDate" varchar(255), "publishEndDate" varchar(255)
      );
      CREATE TABLE tags (id integer PRIMARY KEY, tag text NOT NULL UNIQUE, title text NOT NULL);
      CREATE TABLE "pageTags" (
        "pageId" integer NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        "tagId" integer NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY ("pageId", "tagId")
      );
      CREATE TABLE "pageLinks" (
        "pageId" integer NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        "localeCode" varchar(35) NOT NULL, path text NOT NULL, PRIMARY KEY ("pageId", "localeCode", path)
      );
      CREATE TABLE "pageMutationOutbox" (
        id uuid PRIMARY KEY, "pageId" integer NOT NULL, "sourceRevision" bigint NOT NULL,
        "effectKind" varchar(64) NOT NULL, "effectKey" varchar(255) NOT NULL,
        "desiredState" varchar(32) NOT NULL, "payloadSha256" varchar(64) NOT NULL, payload text NOT NULL,
        status varchar(24) NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
        "leaseOwner" varchar(255), "leaseToken" uuid, "leaseExpiresAt" timestamp,
        "availableAt" timestamp NOT NULL DEFAULT now(), result text, postcondition text,
        "createdAt" timestamp NOT NULL DEFAULT now(), "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT page_mutation_outbox_revision_effect_unique UNIQUE ("pageId", "sourceRevision", "effectKind")
      );
      CREATE INDEX page_mutation_outbox_status_available_idx ON "pageMutationOutbox" (status, "availableAt");
    `)
    await createProtectionSchema(db)
    await db.schema.alterTable('pageProtectedAssets', table => table.integer('assetId').nullable())
    await createKnowledgeSchema(db)
    await createKnowledgeSearch(db)
    await db('users').insert({ id: 7, name: 'Editor', email: requester.email })
    await db('assets').insert({ id: 101, hash: createHash('sha1').update(assetPath).digest('hex') })
    await db('pages').insert({
      id: 42, sourceRevision: 8, renderedSourceRevision: 8, path: 'neutral/handbook', localeCode: 'en',
      title: 'Neutral Handbook', description: 'Public overview', content: source, render,
      visibility: 'public', isPublished: true
    })
    const checkAccess = (_requester: unknown, permissions: readonly string[]) =>
      permissions.some(permission => ['read:pages', 'write:pages'].includes(permission))
    const wiki = {
      auth: {
        checkAccess,
        checkPageAccess: checkAccess,
        loadPageRuleAuthority: async (principal: unknown) => ({ requester: principal, permissions: ['read:pages', 'write:pages'], groups: [], tagAliases: {} })
      },
      config: { db: { type: 'postgres' }, search: { maxHits: 100 }, lang: { code: 'en' } },
      data: { searchEngine: undefined as unknown },
      Error: { SearchActivationFailed: class SearchActivationFailed extends Error {} },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      models: { knex: db, pages: undefined as unknown, tags: undefined as unknown }
    }
    Reflect.set(globalThis, 'WIKI', wiki)
    // These application modules capture WIKI at evaluation; bind the isolated native runtime before loading them.
    const [{ default: PageRuntime }, { default: Tag }, { default: plugin }, { default: pageOps }, protectionOps] = await Promise.all([
      import('../../models/pages.ts'), import('../../models/tags.ts'), import('../../modules/search/postgres/engine.ts'),
      import('../../operations/pages.ts'), import('../../operations/page-protection.ts')
    ])
    Page = PageRuntime
    Page.knex(db)
    Tag.knex(db)
    wiki.models.pages = Page
    wiki.models.tags = Tag
    engine = Object.assign(plugin, { config: { dictLanguage: 'simple' } }) as unknown as ProtectionSearchEngine
    wiki.data.searchEngine = engine
    await engine.init()
    operations = pageOps
    protection = protectionOps
  })

  afterAll(async () => {
    Reflect.set(globalThis, 'WIKI', originalWiki)
    await Promise.all([db?.destroy(), observer?.destroy()])
  })

  it('withdraws the body before a delayed failing callback and preserves repair across an older active claim', async () => {
    expect((await operations.search({ query: bodyToken, pageIds: [42] })).results.map(page => page.id)).toEqual([42])
    const canonical = await observer('pages').where({ id: 42 }).first('content', 'render', 'sourceRevision', 'renderedSourceRevision')
    await enqueuePageMutationEffects(db, {
      pageId: 42, sourceRevision: 8, desiredState: 'present', action: 'update', source,
      location: { locale: 'en', path: 'neutral/handbook', visibility: 'public', ownerId: null }, effects: ['render', 'search']
    })
    await db('pageMutationOutbox').where({ effectKind: 'render' }).update({ status: 'succeeded' })
    const immutable = await observer('pageMutationOutbox').where({ effectKind: 'search' }).first('id', 'sourceRevision', 'effectKey', 'payload', 'payloadSha256')
    const oldEntered = deferred()
    const oldRelease = deferred()
    const callbackEntered = deferred()
    const callbackRelease = deferred()
    const runtime = {
      renderPage: async () => { throw new Error('A protection-only repair must preserve the certified authored render') },
      evictLocation: async () => undefined,
      reconcileSearchPage: (pageId: number) => engine.reconcilePage(pageId),
      removeSearchPage: (pageId: number) => engine.removePage(pageId)
    }
    const oldAbort = new AbortController()
    const oldWork = new PageProjectionLifecycle(db, 'older-search-worker', {
      ...runtime,
      reconcileSearchPage: async pageId => {
        oldEntered.release()
        await oldRelease.promise
        await engine.reconcilePage(pageId)
      }
    }).runOnce(oldAbort.signal)
    engine.updated = async () => {
      callbackEntered.release()
      await callbackRelease.promise
      throw new Error('search callback unavailable')
    }
    let setting: Promise<unknown> | undefined
    try {
      await Promise.race([oldEntered.promise, oldWork.then(() => { throw new Error('Old search did not enter its provider') })])
      setting = protection.setPageProtection({ requester, pageId: 42, password: 'durable protection password', sessionId: 'manager-session' })
        .then(() => null, (error: unknown) => error)
      await Promise.race([callbackEntered.promise, setting.then(error => { throw error ?? new Error('Protection did not enter its post-commit callback') })])

      // A separate database connection sees committed protection while the immediate callback is still blocked.
      expect(await observer('pageAccessPasswords').where({ pageId: 42 }).first()).toMatchObject({ pageId: 42, version: 1, updatedBy: 7 })
      expect(await observer('pageUnlockGrants').where({ pageId: 42 })).toEqual([
        expect.objectContaining({ sessionId: 'manager-session', userId: 7, passwordVersion: 1 })
      ])
      expect(await observer('pageProtectedAssets').where({ pageId: 42 })).toEqual([{ pageId: 42, assetPath, assetId: 101 }])
      expect(await observer('pagesVector').where({ pageId: 42 })).toEqual([])
      expect(await observer('pagesWords').where({ pageId: 42 })).toEqual([])
      expect(await observer('pages').where({ id: 42 }).first('content', 'render', 'sourceRevision', 'renderedSourceRevision')).toEqual(canonical)
      const negativeBody = await operations.search({ query: `-${bodyToken}`, pageIds: [42] })
      const negativeAbsent = await operations.search({ query: '-absentbodyuniquetoken', pageIds: [42] })
      expect(negativeBody).toEqual(negativeAbsent)
      expect(negativeBody.results).toEqual([])
      expect(await observer('pageMutationOutbox').where({ effectKind: 'search' }).first('status', 'attempts', 'leaseOwner', 'leaseToken', 'result', 'postcondition')).toEqual({
        status: 'retry', attempts: 0, leaseOwner: null, leaseToken: null, result: null, postcondition: null
      })

      callbackRelease.release()
      expect(await setting).toMatchObject({ message: 'search callback unavailable' })
      expect(await operations.search({ query: `-${bodyToken}`, pageIds: [42] })).toEqual(negativeAbsent)
      oldAbort.abort()
      oldRelease.release()
      await oldWork
      expect(await observer('pageMutationOutbox').where({ effectKind: 'search' }).first('status', 'attempts', 'leaseToken')).toEqual({ status: 'retry', attempts: 0, leaseToken: null })

      await new PageProjectionLifecycle(db, 'protection-repair-worker', runtime).runOnce()
      expect(await observer('pageMutationOutbox').where({ effectKind: 'search' }).first('status', 'attempts')).toEqual({ status: 'succeeded', attempts: 1 })
      expect(await observer('pageMutationOutbox').where({ effectKind: 'search' }).first('id', 'sourceRevision', 'effectKey', 'payload', 'payloadSha256')).toEqual(immutable)
      const repairedNegative = await operations.search({ query: `-${bodyToken}`, pageIds: [42] })
      expect(repairedNegative.results.map(page => page.id)).toEqual([42])
      expect(repairedNegative).toEqual(await operations.search({ query: '-absentbodyuniquetoken', pageIds: [42] }))
      expect((await operations.search({ query: bodyToken, pageIds: [42] })).results).toEqual([])
      const body = await observer.raw<{ rows: Array<{ body: string }> }>(
        `SELECT ts_filter(tokens, ARRAY['C']::"char"[])::text AS body FROM "pagesVector" WHERE "pageId" = ?`, [42]
      )
      expect(body.rows).toEqual([{ body: '' }])
      expect(await observer('pagesWords').where({ pageId: 42, word: bodyToken })).toEqual([])
      expect(await observer('pages').where({ id: 42 }).first('content', 'render', 'sourceRevision', 'renderedSourceRevision')).toEqual(canonical)
    } finally {
      callbackRelease.release()
      oldRelease.release()
      await Promise.all([setting, oldWork])
    }
  })
})
