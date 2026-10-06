import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import cookieParser from 'cookie-parser'
import express from 'express'
import session from 'express-session'
import type { Knex } from 'knex'
import type { AgentMediaProviderView, AgentMediaProviderWrite } from '../../../shared/agents/media-providers.ts'
import { AgentMediaProviderRegistry, assertAgentMediaBinding, listAgentMediaBindings } from '../../agents/media-providers.ts'
import { DatabaseAgentSecretRegistry } from '../../agents/providers/secrets.ts'
import createAgentsHostController from '../../controllers/agents-host.ts'
import { up as addSecrets } from '../../db/migrations/2.5.141.ts'
import { up as addMediaProviders } from '../../db/migrations/tsepistle-000055-agent-media-providers.ts'
import { createAgentMediaTestDatabase } from '../agents/media-database.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

const csrf = 'media-provider-http-csrf-token-at-least-thirty-two-bytes'
const origin = 'https://wiki.example.test'
const api = '/_api/agents/admin/media-providers'
const image: AgentMediaProviderWrite = {
  displayName: 'Standalone image API',
  exposureMode: 'all_agent_users',
  secretValue: 'private-original-image-key',
  config: {
    kind: 'image',
    api: 'openai-images',
    model: 'gpt-image-1',
    baseUrl: 'https://api.openai.com/v1',
    timeoutMs: 30_000,
    maxInputTokens: 16_000,
    maxOutputTokens: 4_000,
    pricing: { kind: 'fixed', pricingRevision: 'image-http-v1', costMicros: 30_000 }
  }
}

describe('independent media provider administration over HTTP', () => {
  let db: Knex
  let destroyDatabase: () => Promise<void>
  let vault: DatabaseAgentSecretRegistry
  let server: Server
  let baseUrl: string
  let cookie: string
  let ownerId: number
  let requestAuthVersion: number
  let vendorRequests: number
  const environmentName = 'WIKI_AGENT_MEDIA_HTTP_TEST_KEY'
  let previousEnvironment: string | undefined

  beforeEach(async () => {
    ownerId = 7
    requestAuthVersion = 3
    vendorRequests = 0
    previousEnvironment = process.env[environmentName]
    delete process.env[environmentName]
    ;({ db, destroy: destroyDatabase } = await createAgentMediaTestDatabase(null))
    await db.raw('PRAGMA foreign_keys = ON')
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
      table.boolean('isActive').notNullable()
      table.integer('authVersion').notNullable()
    })
    await db.schema.createTable('groups', table => {
      table.integer('id').primary()
      table.text('permissions').notNullable()
    })
    await db.schema.createTable('userGroups', table => {
      table.integer('userId').references('id').inTable('users')
      table.integer('groupId').references('id').inTable('groups')
      table.primary(['userId', 'groupId'])
    })
    await db('users').insert([
      { id: 7, isActive: true, authVersion: 3 },
      { id: 8, isActive: true, authVersion: 2 }
    ])
    await db('groups').insert([
      { id: 1, permissions: JSON.stringify(['manage:system']) },
      { id: 2, permissions: JSON.stringify(['use:agents']) },
      { id: 3, permissions: '[]' }
    ])
    await db('userGroups').insert([
      { userId: 7, groupId: 1 },
      { userId: 8, groupId: 2 }
    ])
    await addSecrets(db)
    await addMediaProviders(db)
    vault = new DatabaseAgentSecretRegistry(db, { currentKeyId: 'http-fixture', keys: { 'http-fixture': new Uint8Array(32).fill(17) } })
    const app = express()
    app.use(cookieParser())
    app.use(session({ secret: 'media-provider-http-session-secret', resave: false, saveUninitialized: true }))
    app.get('/seed', (req, res) => {
      ;(req.session as typeof req.session & { agentCsrfToken?: string }).agentCsrfToken = csrf
      res.sendStatus(204)
    })
    app.use(
      createAgentsHostController({
        auth: {
          authenticate(req, _res, next) {
            req.authContext = { kind: 'user', userId: ownerId, ownershipUserId: ownerId, principal: { id: ownerId } }
            // Deliberately stale cached permissions: the registry must consult the live account/groups.
            req.user = { id: ownerId, authVersion: requestAuthVersion, permissions: ['manage:system'] } as Express.User
            next()
          }
        },
        config: {
          host: origin,
          sessionSecret: 'media-provider-http-resolution-secret',
          agents: {
            enabled: true,
            provider: { enabled: true },
            retention: { temporarySessionHours: 24 },
            skills: { enabled: false, namespace: 'system/agent-skills' },
            proposals: { enabled: false },
            writes: {
              enabled: false,
              create: { enabled: false },
              patch: { enabled: false },
              move: { enabled: false },
              restore: { enabled: false },
              delete: { enabled: false }
            }
          }
        },
        models: { knex: db },
        mediaProviders: new AgentMediaProviderRegistry(db, vault)
        // No LLM registry, conformance runner, or provider transport is configured.
      })
    )
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const fetchHttp = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const destination = input instanceof Request ? input.url : String(input)
      if (!destination.startsWith(`${baseUrl}/`)) {
        vendorRequests += 1
        throw new Error('Media administration must not make provider readiness requests')
      }
      return fetchHttp(input, init)
    })
    cookie = (await fetch(`${baseUrl}/seed`)).headers.get('set-cookie')?.split(';', 1)[0] ?? ''
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (previousEnvironment === undefined) delete process.env[environmentName]
    else process.env[environmentName] = previousEnvironment
    try {
      await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
    } finally {
      await destroyDatabase()
    }
  })

  const request = (path: string, method = 'GET', body?: unknown, extraHeaders: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { cookie, origin, 'sec-fetch-site': 'same-origin', 'x-wiki-csrf': csrf, 'content-type': 'application/json', ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  const providerResponse = async (response: Response, expectedStatus = 200): Promise<AgentMediaProviderView> => {
    expect(response.status).toBe(expectedStatus)
    const payload = (await response.json()) as { provider: AgentMediaProviderView }
    expect(payload.provider).not.toHaveProperty('secretValue')
    expect(payload.provider).not.toHaveProperty('secretReference')
    expect(JSON.stringify(payload)).not.toContain('private-original-image-key')
    return payload.provider
  }

  it('creates and edits a media-only exact model, restores safe config, and preserves revision-fenced historical versions', async () => {
    const created = await providerResponse(await request(api, 'POST', image), 201)
    expect(created).toMatchObject({ config: { model: 'gpt-image-1' }, enabled: false, isDefault: false, revision: 1, secretConfigured: true })
    const original = await db('agentMediaProviderVersions').where({ id: created.profileVersionId }).first()
    const editedConfig = { ...image.config, model: 'gpt-image-1.5', pricing: { kind: 'fixed' as const, pricingRevision: 'image-http-v2', costMicros: 42_000 } }
    const edited = await providerResponse(
      await request(`${api}/${created.id}`, 'PATCH', {
        displayName: 'Edited independent image API',
        config: editedConfig,
        exposureMode: 'all_agent_users',
        expectedRevision: created.revision
      })
    )
    expect(edited).toMatchObject({ config: editedConfig, revision: 2, secretConfigured: true, enabled: false })
    expect(edited.profileVersionId).not.toBe(created.profileVersionId)
    expect(await db('agentMediaProviderVersions').where({ id: created.profileVersionId }).first()).toEqual(original)
    const current = await db('agentMediaProviderVersions').where({ id: edited.profileVersionId }).first()
    expect(current.secretReference).toBe(original.secretReference)
    expect(await vault.get(original.secretReference)).toBe('private-original-image-key')
    const list = await request(api)
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual({ providers: [edited] })
    for (const [suffix, method, body] of [
      ['', 'PATCH', { ...image, expectedRevision: created.revision }],
      ['/enabled', 'POST', { enabled: true, expectedRevision: created.revision }],
      ['/default', 'POST', { expectedRevision: created.revision }],
      ['', 'DELETE', { expectedRevision: created.revision }]
    ] as const) {
      const stale = await request(`${api}/${created.id}${suffix}`, method, body)
      expect(stale.status).toBe(409)
      expect(await stale.json()).toMatchObject({ error: 'MEDIA_PROVIDER_REVISION_CHANGED' })
    }
    expect(await db('agentMediaProviderVersions').where({ providerId: created.id }).select('id')).toHaveLength(2)
    const removed = await request(`${api}/${created.id}`, 'DELETE', { expectedRevision: edited.revision })
    expect(removed.status).toBe(204)
    expect(await (await request(api)).json()).toEqual({ providers: [] })
    expect(await db('agentMediaProviderVersions').where({ id: created.profileVersionId }).first()).toEqual(original)
    expect(await vault.get(original.secretReference)).toBe('private-original-image-key')
    expect(vendorRequests).toBe(0)
  })

  it('retains omitted credentials, clears explicit null, and accepts environment credentials without exposing secret references', async () => {
    const created = await providerResponse(await request(api, 'POST', image), 201)
    const enabled = await providerResponse(await request(`${api}/${created.id}/enabled`, 'POST', { enabled: true, expectedRevision: created.revision }))
    const defaulted = await providerResponse(await request(`${api}/${created.id}/default`, 'POST', { expectedRevision: enabled.revision }))
    const cleared = await providerResponse(
      await request(`${api}/${created.id}`, 'PATCH', {
        displayName: image.displayName,
        config: image.config,
        exposureMode: image.exposureMode,
        secretValue: null,
        expectedRevision: defaulted.revision
      })
    )
    expect(cleared).toMatchObject({ enabled: false, isDefault: false, secretConfigured: false })
    const unavailable = await request(`${api}/${created.id}/enabled`, 'POST', { enabled: true, expectedRevision: cleared.revision })
    expect(unavailable.status).toBe(409)
    expect(await unavailable.json()).toMatchObject({ error: 'MEDIA_PROVIDER_NOT_READY' })
    process.env[environmentName] = 'private-env-media-credential'
    const restored = await providerResponse(
      await request(`${api}/${created.id}`, 'PATCH', {
        displayName: image.displayName,
        config: image.config,
        exposureMode: image.exposureMode,
        secretReference: `env:${environmentName}`,
        expectedRevision: cleared.revision
      })
    )
    expect(restored.secretConfigured).toBe(true)
    const safe = await request(api)
    const safeText = await safe.text()
    expect(safeText).not.toContain(environmentName)
    expect(safeText).not.toContain('private-env-media-credential')
    const envEnabled = await providerResponse(await request(`${api}/${created.id}/enabled`, 'POST', { enabled: true, expectedRevision: restored.revision }))
    expect(envEnabled.enabled).toBe(true)
    const nullReference = await providerResponse(
      await request(`${api}/${created.id}`, 'PATCH', {
        displayName: image.displayName,
        config: image.config,
        exposureMode: image.exposureMode,
        secretReference: null,
        expectedRevision: envEnabled.revision
      })
    )
    expect(nullReference).toMatchObject({ enabled: false, secretConfigured: false })
    expect(vendorRequests).toBe(0)
  })

  it('applies HTTP grant edits, independent defaults and enabled state to real live binding consumers', async () => {
    const first = await providerResponse(await request(api, 'POST', { ...image, exposureMode: 'groups', groupIds: [3] }), 201)
    const firstEnabled = await providerResponse(await request(`${api}/${first.id}/enabled`, 'POST', { enabled: true, expectedRevision: first.revision }))
    let firstDefault = await providerResponse(await request(`${api}/${first.id}/default`, 'POST', { expectedRevision: firstEnabled.revision }))
    expect(await listAgentMediaBindings(db, 8)).toEqual({})
    const granted = await providerResponse(
      await request(`${api}/${first.id}`, 'PATCH', {
        displayName: image.displayName,
        config: image.config,
        exposureMode: 'groups',
        groupIds: [2],
        expectedRevision: firstDefault.revision
      })
    )
    expect(granted.groupIds).toEqual([2])
    expect(await listAgentMediaBindings(db, 8)).toEqual({ image: granted.profileVersionId })
    await expect(assertAgentMediaBinding(db, 8, 'image', first.profileVersionId)).rejects.toMatchObject({ code: 'MEDIA_PROVIDER_CHANGED' })
    const music = await providerResponse(
      await request(api, 'POST', {
        ...image,
        displayName: 'Standalone music API',
        config: { ...image.config, kind: 'music', api: 'gemini-interactions', model: 'lyria-3.5', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }
      }),
      201
    )
    const musicEnabled = await providerResponse(await request(`${api}/${music.id}/enabled`, 'POST', { enabled: true, expectedRevision: music.revision }))
    const musicDefault = await providerResponse(await request(`${api}/${music.id}/default`, 'POST', { expectedRevision: musicEnabled.revision }))
    expect(musicDefault.isDefault).toBe(true)
    const second = await providerResponse(await request(api, 'POST', { ...image, displayName: 'Second image API' }), 201)
    const secondEnabled = await providerResponse(await request(`${api}/${second.id}/enabled`, 'POST', { enabled: true, expectedRevision: second.revision }))
    const secondDefault = await providerResponse(await request(`${api}/${second.id}/default`, 'POST', { expectedRevision: secondEnabled.revision }))
    const listed = (await (await request(api)).json()) as { providers: AgentMediaProviderView[] }
    firstDefault = listed.providers.find(provider => provider.id === first.id)!
    expect(firstDefault.isDefault).toBe(false)
    expect(firstDefault.revision).toBeGreaterThan(granted.revision)
    expect(listed.providers.find(provider => provider.id === music.id)?.isDefault).toBe(true)
    const disabled = await providerResponse(await request(`${api}/${second.id}/enabled`, 'POST', { enabled: false, expectedRevision: secondDefault.revision }))
    expect(disabled).toMatchObject({ enabled: false, isDefault: false })
    await db('userGroups').where({ userId: 8, groupId: 2 }).delete()
    await expect(assertAgentMediaBinding(db, 8, 'image', granted.profileVersionId)).rejects.toMatchObject({ code: 'AGENT_ACCESS_REVOKED' })
  })

  it('rejects stale account sessions and revoked live administration permissions despite cached administrator claims', async () => {
    const created = await providerResponse(await request(api, 'POST', image), 201)
    await db('users').where({ id: 7 }).update({ authVersion: 4 })
    expect((await request(api)).status).toBe(403)
    const staleWrite = await request(`${api}/${created.id}/enabled`, 'POST', { enabled: true, expectedRevision: created.revision })
    expect(staleWrite.status).toBe(403)
    expect(await staleWrite.json()).toMatchObject({ error: 'MEDIA_ADMIN_REQUIRED' })
    requestAuthVersion = 4
    await db('groups')
      .where({ id: 1 })
      .update({ permissions: JSON.stringify(['use:agents']) })
    expect((await request(api)).status).toBe(403)
    expect((await request(`${api}/${created.id}`, 'DELETE', { expectedRevision: created.revision })).status).toBe(403)
    await db('groups')
      .where({ id: 1 })
      .update({ permissions: JSON.stringify(['manage:system']) })
    ownerId = 8
    requestAuthVersion = 2
    expect((await request(api, 'POST', image)).status).toBe(403)
    expect((await db('agentMediaProviders').where({ id: created.id }).first('revision')).revision).toBe(created.revision)
  })

  it('enforces origin and CSRF controls before media administration writes', async () => {
    const invalidHeaders: readonly Record<string, string>[] = [
      { origin: 'https://attacker.example.test' },
      { 'sec-fetch-site': 'cross-site' },
      { 'x-wiki-csrf': 'incorrect-token' }
    ]
    for (const extraHeaders of invalidHeaders) expect((await request(api, 'POST', image, extraHeaders)).status).toBe(403)
    expect(await db('agentMediaProviders').first()).toBeUndefined()
    expect(await db('agentProviderSecrets').first()).toBeUndefined()
  })

  it('rejects unsupported operations, endpoints and missing revision fences without storing profiles or credentials', async () => {
    for (const body of [
      { ...image, config: { ...image.config, model: 'an-llm-not-an-image-model' } },
      { ...image, config: { ...image.config, baseUrl: 'https://attacker.example.test/v1' } },
      { ...image, config: { ...image.config, kind: 'video' } },
      { ...image, exposureMode: 'groups', groupIds: [999] }
    ]) {
      const response = await request(api, 'POST', body)
      expect(response.status).toBe(400)
    }
    expect(await db('agentMediaProviders').first()).toBeUndefined()
    expect(await db('agentProviderSecrets').first()).toBeUndefined()
    const created = await providerResponse(await request(api, 'POST', image), 201)
    expect((await request(`${api}/${created.id}/enabled`, 'POST', { enabled: true })).status).toBe(400)
    expect((await db('agentMediaProviders').where({ id: created.id }).first('revision', 'enabled')).revision).toBe(created.revision)
  })
})
