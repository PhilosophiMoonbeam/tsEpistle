import bcrypt from 'bcryptjs-then'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from '../bun-test.mts'
import type * as SetupModule from '../../setup.ts'

interface SetupTestWiki extends Record<string, unknown> {
  server?: Server
}

const mutationQuery = () => ({
  where: vi.fn().mockReturnThis(),
  orWhere: vi.fn().mockReturnThis(),
  del: vi.fn().mockResolvedValue(1),
  truncate: vi.fn().mockResolvedValue(1)
})

const startSetupHarness = async (configSaved: boolean) => {
  vi.resetModules()
  const fs = {
    ensureDir: vi.fn().mockResolvedValue(undefined),
    emptyDir: vi.fn().mockResolvedValue(undefined),
    readJson: vi.fn().mockResolvedValue({})
  }
  vi.mockModule('fs-extra', import.meta.url, () => ({ default: fs }))
  vi.mockModule('pem-jwk', import.meta.url, () => ({ default: { pem2jwk: vi.fn(() => ({})) } }))
  vi.mockModule('../../helpers/vite-assets.ts', import.meta.url, () => ({
    default: { collectEntry: vi.fn(() => ({})) }
  }))
  vi.mockModule('../../core/system.ts', import.meta.url, () => ({ default: {} }))

  const settingsTruncate = vi.fn().mockResolvedValue(undefined)
  const extensionInsert = vi.fn().mockResolvedValue(undefined)
  const tableQuery = (table: string) => {
    if (table === 'settings') {
      return {
        where: vi.fn().mockReturnThis(),
        forShare: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(undefined),
        insert: vi.fn().mockResolvedValue(undefined),
        truncate: settingsTruncate
      }
    }
    return {
      insert: table === 'contentExtensions' ? extensionInsert : vi.fn().mockResolvedValue(undefined),
      truncate: vi.fn().mockResolvedValue(undefined)
    }
  }
  const transactionKnex = vi.fn((table: string) => tableQuery(table))
  const transaction = vi.fn(async (operation: (trx: typeof transactionKnex) => Promise<unknown>) => operation(transactionKnex))
  const knex = Object.assign(vi.fn((table: string) => tableQuery(table)), {
    raw: vi.fn().mockResolvedValue(undefined),
    transaction
  })
  const localesDelete = vi.fn().mockResolvedValue(1)
  const localesInsert = vi.fn().mockResolvedValue({})
  const localesQuery = {
    where: vi.fn().mockReturnThis(),
    del: localesDelete,
    insert: localesInsert
  }
  const navigationTruncate = vi.fn().mockResolvedValue(1)
  const navigationInsert = vi.fn().mockResolvedValue({})
  const navigationQuery = {
    truncate: navigationTruncate,
    insert: navigationInsert
  }
  const groupInsert = vi.fn().mockResolvedValueOnce({ id: 1 }).mockResolvedValueOnce({ id: 2 })
  const userRelate = vi.fn().mockResolvedValue(undefined)
  const userInsert = vi
    .fn()
    .mockResolvedValueOnce({ id: 1, $relatedQuery: vi.fn(() => ({ relate: userRelate })) })
    .mockResolvedValueOnce({ id: 2, $relatedQuery: vi.fn(() => ({ relate: userRelate })) })
  const authenticationInsert = vi.fn().mockResolvedValue({})
  const editorMutation = mutationQuery()
  const searchMutation = mutationQuery()
  searchMutation.where.mockResolvedValue(1)
  const editorPatch = vi.fn(() => editorMutation)
  const searchPatch = vi.fn(() => searchMutation)
  const controller = new AbortController()
  const searchRefresh = vi.fn().mockResolvedValue(undefined)
  const searchInit = vi.fn().mockResolvedValue(undefined)
  const saveToDb = vi.fn().mockResolvedValue(configSaved)
  const wiki: SetupTestWiki = {
    IS_DEBUG: false,
    ROOTPATH: process.cwd(),
    SERVERPATH: process.cwd() + '/server',
    config: {
      bindIP: '127.0.0.1',
      dataPath: './data',
      db: { type: 'postgres' },
      port: 0,
      sessionSecret: 'setup-secret',
      setup: true,
      site: { path: '', title: 'tsEpistle' },
      telemetry: { isEnabled: false }
    },
    configSvc: { saveToDb },
    data: {},
    logger: { error: vi.fn(), info: vi.fn() },
    product: { name: 'tsEpistle' },
    models: {
      authentication: { query: vi.fn(() => ({ insert: authenticationInsert })) },
      editors: {
        refreshEditorsFromDisk: vi.fn().mockResolvedValue(undefined),
        query: vi.fn(() => ({ patch: editorPatch }))
      },
      groups: { query: vi.fn(() => ({ insert: groupInsert })) },
      knex,
      locales: { query: vi.fn(() => localesQuery) },
      loggers: { refreshLoggersFromDisk: vi.fn().mockResolvedValue(undefined) },
      navigation: { query: vi.fn(() => navigationQuery) },
      renderers: { refreshRenderersFromDisk: vi.fn().mockResolvedValue(undefined) },
      searchEngines: {
        initEngine: searchInit,
        refreshSearchEnginesFromDisk: searchRefresh,
        query: vi.fn(() => ({ patch: searchPatch }))
      },
      storage: { refreshTargetsFromDisk: vi.fn().mockResolvedValue(undefined) },
      users: { query: vi.fn(() => ({ insert: userInsert })) }
    },
    shutdownSignal: controller.signal,
    telemetry: { sendError: vi.fn(), sendInstanceEvent: vi.fn().mockResolvedValue(undefined) }
  }
  globalThis.WIKI = wiki

  const { default: startSetup } = await vi.importFresh<typeof SetupModule>('../../setup.ts', import.meta.url)
  const completion = startSetup()
  const server = wiki.server
  if (!server) throw new Error('Setup server was not created')
  if (!server.listening) await once(server, 'listening')

  return {
    completion,
    controller,
    domainMutations: [localesDelete, localesInsert, navigationTruncate, navigationInsert, knex.raw, groupInsert, authenticationInsert, userInsert],
    editorMutation,
    editorPatch,
    extensionInsert,
    navigationInsert,
    saveToDb,
    searchMutation,
    searchInit,
    searchPatch,
    searchRefresh,
    server,
    settingsTruncate,
    transaction,
    userInsert
  }
}

const finalize = async (server: Server, adminPassword = 'correct horse battery staple'): Promise<Record<string, unknown>> => {
  const address = server.address() as AddressInfo
  const response = await fetch(`http://127.0.0.1:${address.port}/finalize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      siteUrl: 'https://wiki.example.com',
      adminEmail: 'admin@example.com',
      adminPassword,
      telemetry: false
    })
  })
  return (await response.json()) as Record<string, unknown>
}

describe('setup finalization', () => {
  const previousWiki = globalThis.WIKI

  afterEach(() => {
    globalThis.WIKI = previousWiki
    vi.restoreAllMocks()
  })

  it('rejects short and oversized passwords before changing setup state', async () => {
    const harness = await startSetupHarness(true)
    for (const password of ['short', '🔐'.repeat(19)]) {
      expect(await finalize(harness.server, password)).toMatchObject({ ok: false })
    }
    expect(harness.saveToDb).not.toHaveBeenCalled()
    expect(harness.settingsTruncate).not.toHaveBeenCalled()
    for (const mutation of harness.domainMutations) expect(mutation).not.toHaveBeenCalled()
    harness.controller.abort(new DOMException('test shutdown', 'AbortError'))
    await expect(harness.completion).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('hashes a bcrypt-shaped administrator password as the literal credential', async () => {
    const harness = await startSetupHarness(true)
    const password = await bcrypt.hash('unrelated credential', 4)
    expect(await finalize(harness.server, password)).toMatchObject({ ok: true })
    await harness.completion
    expect(harness.transaction).toHaveBeenCalledWith(expect.any(Function))
    const stored = harness.userInsert.mock.calls[0]?.[0].password
    expect(stored).not.toBe(password)
    expect(await bcrypt.compare(password, stored)).toBe(true)
    expect(await bcrypt.compare('unrelated credential', stored)).toBe(false)
  })

  it('keeps setup active and domain data untouched when config persistence returns false', async () => {
    const harness = await startSetupHarness(false)
    let settled = false
    void harness.completion.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )

    const result = await finalize(harness.server)

    expect(result).toEqual({ ok: false, error: 'Failed to persist setup configuration' })
    expect(harness.saveToDb).toHaveBeenCalledTimes(1)
    for (const mutation of harness.domainMutations) expect(mutation).not.toHaveBeenCalled()
    expect(harness.extensionInsert).not.toHaveBeenCalled()
    expect(harness.settingsTruncate).toHaveBeenCalledTimes(1)
    expect(globalThis.WIKI.config).toMatchObject({ setup: true })
    expect(harness.server.listening).toBe(true)
    expect(settled).toBe(false)

    harness.controller.abort(new DOMException('test shutdown', 'AbortError'))
    await expect(harness.completion).rejects.toMatchObject({ name: 'AbortError' })
    expect(harness.server.listening).toBe(false)
  })

  it('settles and tears down a setup server when shutdown arrives before finalization', async () => {
    const harness = await startSetupHarness(true)

    harness.controller.abort(new DOMException('test shutdown', 'AbortError'))

    await expect(harness.completion).rejects.toMatchObject({ name: 'AbortError' })
    expect(harness.saveToDb).not.toHaveBeenCalled()
    expect(harness.server.listening).toBe(false)
  })

  it('restores the built-in content-extension registry after setup resets dependent tables', async () => {
    const harness = await startSetupHarness(true)

    const result = await finalize(harness.server)
    await harness.completion

    expect(result).toMatchObject({ ok: true, redirectPath: '/' })
    expect(harness.extensionInsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ key: 'qr', isEnabled: false, version: 1 }),
        expect.objectContaining({ key: 'map', isEnabled: false, version: 1 })
      ])
    )
    expect(harness.extensionInsert.mock.calls[0]?.[0]).toHaveLength(13)
    expect(harness.navigationInsert).toHaveBeenCalledWith({
      key: 'site',
      config: [{ locale: 'en', items: [] }]
    })
    expect(harness.searchRefresh).toHaveBeenCalledTimes(1)
    expect(harness.searchRefresh).toHaveBeenCalledWith({ strict: true })
    expect(harness.searchPatch).toHaveBeenCalledTimes(1)
    expect(harness.searchPatch).toHaveBeenCalledWith({ isEnabled: true })
    expect(harness.searchMutation.where).toHaveBeenCalledTimes(1)
    expect(harness.searchMutation.where).toHaveBeenCalledWith('key', 'postgres')
    expect(harness.searchInit).toHaveBeenCalledTimes(1)
    expect(harness.editorPatch).toHaveBeenCalledTimes(1)
    expect(harness.editorPatch).toHaveBeenCalledWith({ isEnabled: true })
    expect(harness.editorMutation.where).toHaveBeenCalledTimes(1)
    expect(harness.editorMutation.where).toHaveBeenCalledWith('key', 'markdown')
    expect(harness.editorMutation.orWhere).toHaveBeenCalledTimes(1)
    expect(harness.editorMutation.orWhere).toHaveBeenCalledWith('key', 'visual-markdown')
    expect(harness.settingsTruncate).not.toHaveBeenCalled()
    expect(globalThis.WIKI.config).toMatchObject({ setup: false })
    expect(harness.server.listening).toBe(false)
  })
})
