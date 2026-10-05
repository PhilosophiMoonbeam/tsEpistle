import bcrypt from 'bcryptjs-then'
import createKnex, { type Knex } from 'knex'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from '../bun-test.mts'
import type * as SetupModule from '../../setup.ts'
import type * as ConfigModule from '../../core/config.ts'
import type * as EditorModule from '../../models/editors.ts'
import type * as SearchEngineModule from '../../models/searchEngines.ts'
import { BUILTIN_CONTENT_EXTENSIONS } from '../../../shared/content-extensions.ts'

interface SetupTestWiki extends Record<string, unknown> {
  server?: Server
}

const selectionDatabases = new Set<Knex>()

const startSetupHarness = async (configSaved: boolean, searchFailure = false) => {
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

  const settingsTruncate = vi.fn(async () => selectionDb('settings').del())
  const extensionInsert = vi.fn().mockResolvedValue(undefined)
  const tableQuery = (table: string) => {
    if (table === 'settings') {
      return Object.assign(selectionDb('settings'), { truncate: settingsTruncate })
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
  const selectionDb = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  selectionDatabases.add(selectionDb)
  for (const tableName of ['editors', 'searchEngines']) {
    await selectionDb.schema.createTable(tableName, table => {
      table.string('key').primary()
      table.boolean('isEnabled').notNullable()
    })
  }
  await selectionDb.schema.createTable('settings', table => {
    table.string('key').primary()
    table.text('value').notNullable()
  })
  await selectionDb('editors').insert(['markdown', 'visual-markdown', 'code'].map(key => ({ key, isEnabled: false })))
  await selectionDb('searchEngines').insert(['postgres', 'legacy'].map(key => ({ key, isEnabled: false })))
  const editors = (await vi.importFresh<typeof EditorModule>('../../models/editors.ts', import.meta.url)).default.bindKnex(selectionDb)
  const searchProviders = (await vi.importFresh<typeof SearchEngineModule>('../../models/searchEngines.ts', import.meta.url)).default.bindKnex(selectionDb)
  vi.spyOn(editors, 'refreshEditorsFromDisk').mockResolvedValue(undefined)
  const controller = new AbortController()
  const searchRefresh = vi.spyOn(searchProviders, 'refreshSearchEnginesFromDisk').mockImplementation(async () => {
    if (searchFailure) throw new Error('injected reconciliation failure')
  })
  const searchInit = vi.spyOn(searchProviders, 'initEngine').mockResolvedValue(undefined)
  const saveToDb = vi.fn(async (keys: string[]) => {
    if (!configSaved) return false
    await selectionDb('settings')
      .insert(keys.map(key => ({ key, value: JSON.stringify(globalThis.WIKI.config[key] ?? null) })))
      .onConflict('key')
      .merge()
    return true
  })
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
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    product: { name: 'tsEpistle' },
    models: {
      authentication: { query: vi.fn(() => ({ insert: authenticationInsert })) },
      editors,
      groups: { query: vi.fn(() => ({ insert: groupInsert })) },
      knex,
      locales: { query: vi.fn(() => localesQuery) },
      loggers: { refreshLoggersFromDisk: vi.fn().mockResolvedValue(undefined) },
      navigation: { query: vi.fn(() => navigationQuery) },
      renderers: { refreshRenderersFromDisk: vi.fn().mockResolvedValue(undefined) },
      searchEngines: searchProviders,
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
    editors,
    extensionInsert,
    navigationInsert,
    saveToDb,
    searchProviders,
    searchInit,
    searchRefresh,
    server,
    settingsTruncate,
    settingsDb: selectionDb,
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

  afterEach(async () => {
    try {
      await Promise.all([...selectionDatabases].map(database => database.destroy()))
    } finally {
      selectionDatabases.clear()
      globalThis.WIKI = previousWiki
      vi.restoreAllMocks()
    }
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
    expect(globalThis.WIKI.config.offlineDraftSecret).toEqual(expect.any(String))
    expect(globalThis.WIKI.config.offlineDraftSecret).not.toBe('')
    expect(globalThis.WIKI.config.offlineDraftSecret).not.toBe(globalThis.WIKI.config.sessionSecret)
    const stored = harness.userInsert.mock.calls[0]?.[0].password
    expect(stored).not.toBe(password)
    expect(await bcrypt.compare(password, stored)).toBe(true)
    expect(await bcrypt.compare('unrelated credential', stored)).toBe(false)
  })

  it('does not erase a retained draft root when a finalize request is malformed', async () => {
    const harness = await startSetupHarness(true)
    const retainedRoot = 'retained-encryption-root-before-setup'
    await harness.settingsDb('settings').insert({ key: 'offlineDraftSecret', value: JSON.stringify(retainedRoot) })
    const address = harness.server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${address.port}/finalize`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    })
    const result = await response.json()
    const persisted = await harness.settingsDb('settings').where('key', 'offlineDraftSecret').first()
    harness.controller.abort(new DOMException('test shutdown', 'AbortError'))
    await expect(harness.completion).rejects.toMatchObject({ name: 'AbortError' })
    expect(result).toMatchObject({ ok: false })
    expect(persisted?.value).toBe(JSON.stringify(retainedRoot))
    // A fresh process must resume setup with the retained root, not generate one.
    delete globalThis.WIKI.config.offlineDraftSecret
    globalThis.WIKI.models.settings = {
      getConfig: async () => Object.fromEntries((await harness.settingsDb('settings')).map(row => [row.key, JSON.parse(row.value)]))
    }
    const { default: configService } = await vi.importFresh<typeof ConfigModule>('../../core/config.ts', import.meta.url)
    await configService.loadFromDb()
    expect(globalThis.WIKI.config.setup).toBe(true)
    const retryController = new AbortController()
    globalThis.WIKI.shutdownSignal = retryController.signal
    const { default: startSetup } = await vi.importFresh<typeof SetupModule>('../../setup.ts', import.meta.url)
    const retryCompletion = startSetup()
    const retryServer = globalThis.WIKI.server
    if (!retryServer.listening) await once(retryServer, 'listening')
    expect(await finalize(retryServer)).toMatchObject({ ok: true })
    await retryCompletion
    const retained = await harness.settingsDb('settings').where('key', 'offlineDraftSecret').first()
    expect(retained.value).toBe(JSON.stringify(retainedRoot))
  })

  it('rejects overlapping finalization without deleting the successful installation root', async () => {
    const harness = await startSetupHarness(true)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const persist = harness.saveToDb.getMockImplementation()!
    harness.saveToDb.mockImplementationOnce(async (keys: string[]) => {
      const result = await persist(keys)
      entered.resolve()
      await release.promise
      return result
    })
    const successful = finalize(harness.server)
    await entered.promise
    const address = harness.server.address() as AddressInfo
    const rejected = await fetch(`http://127.0.0.1:${address.port}/finalize`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    })
    const rejection = await rejected.json()
    release.resolve()
    const success = await successful
    await harness.completion
    expect(success).toMatchObject({ ok: true })
    expect(rejection).toMatchObject({ ok: false })
    expect(rejected.status).toBe(409)
    const persisted = await harness.settingsDb('settings').where('key', 'offlineDraftSecret').first()
    expect(persisted?.value).toBe(JSON.stringify(globalThis.WIKI.config.offlineDraftSecret))
    expect(await harness.settingsDb('settings').where('key', 'certs').first()).toBeDefined()
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

    expect(result).toMatchObject({ ok: false })
    expect(harness.saveToDb).toHaveBeenCalledTimes(1)
    for (const mutation of harness.domainMutations) expect(mutation).not.toHaveBeenCalled()
    expect(harness.extensionInsert).not.toHaveBeenCalled()
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
    const inserted = harness.extensionInsert.mock.calls.flatMap(([rows]) => rows as Array<Record<string, unknown>>)
    expect(inserted.map(row => row.key).sort()).toEqual(BUILTIN_CONTENT_EXTENSIONS.map(extension => extension.key).sort())
    for (const extension of BUILTIN_CONTENT_EXTENSIONS) {
      expect(inserted.find(row => row.key === extension.key)).toMatchObject({
        version: extension.version,
        isEnabled: false
      })
    }
    expect(harness.navigationInsert).toHaveBeenCalledWith({
      key: 'site',
      config: [{ locale: 'en', items: [] }]
    })
    expect(harness.searchRefresh).toHaveBeenCalledWith({ strict: true })
    expect((await harness.searchProviders.query().where('isEnabled', true).orderBy('key')).map(provider => provider.key)).toEqual(['postgres'])
    expect(harness.searchInit).toHaveBeenCalled()
    expect((await harness.editors.query().where('isEnabled', true).orderBy('key')).map(editor => editor.key)).toEqual(['markdown', 'visual-markdown'])
    expect(harness.settingsTruncate).not.toHaveBeenCalled()
    expect(globalThis.WIKI.config).toMatchObject({ setup: false })
    expect(harness.server.listening).toBe(false)

    const failed = await startSetupHarness(true, true)
    let settled = false
    void failed.completion.then(() => { settled = true }, () => { settled = true })
    expect(await finalize(failed.server)).toMatchObject({ ok: false })
    expect(failed.searchRefresh).toHaveBeenCalledWith({ strict: true })
    expect(await failed.searchProviders.query().where('isEnabled', true)).toEqual([])
    expect(failed.searchInit).not.toHaveBeenCalled()
    expect(failed.navigationInsert).not.toHaveBeenCalled()
    expect(globalThis.WIKI.config).toMatchObject({ setup: true })
    expect(failed.server.listening).toBe(true)
    expect(settled).toBe(false)
    failed.controller.abort(new DOMException('test shutdown', 'AbortError'))
    await expect(failed.completion).rejects.toMatchObject({ name: 'AbortError' })
    expect(failed.server.listening).toBe(false)
  })
})
