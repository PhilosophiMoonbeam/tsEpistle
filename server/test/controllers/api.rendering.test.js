import { fileURLToPath } from 'node:url'
import express from 'express'
import createKnex from 'knex'
import { configureTransportRuntime, getTransportRuntime } from '../../controllers/_types.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

const originalWiki = global.WIKI
const originalTransport = (() => {
  try { return getTransportRuntime() } catch { return {} }
})()
const workspaceExports = { ...await import('../../operations/rendering-workspace.ts') }
const writeLegacy = vi.fn()
const user = { id: 7, permissions: ['manage:system'] }

let server
let db
let baseUrl

const jsonResponse = async (response, status) => {
  expect(response.status).toBe(status)
  expect(response.headers.get('content-type')).toMatch(/^application\/json\b/)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  return response.json()
}

const saveRenderers = body => fetch(`${baseUrl}/renderers`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
})

describe('controllers/api rendering endpoints over HTTP', () => {
  beforeEach(async () => {
    writeLegacy.mockReset().mockResolvedValue(undefined)
    vi.mockModule('../../operations/rendering-workspace.ts', import.meta.url, () => ({
      ...workspaceExports,
      writeLegacyRenderingSettings: writeLegacy
    }))
    // The real API shell imports the other controllers, but these requests use
    // only the renderer model and the reviewed workspace writer below.
    db = createKnex({ client: 'pg', pool: { min: 0, max: 1 } })
    global.WIKI = {
      SERVERPATH: fileURLToPath(new URL('../../', import.meta.url)),
      config: { lang: { code: 'en' }, sessionSecret: 'rendering-http-test-key' },
      cache: { get: async () => [] },
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
      auth: { checkAccess: vi.fn().mockReturnValue(true) },
      data: {
        renderers: [
          {
            key: 'markdownCore',
            title: 'Markdown Core',
            description: 'Core markdown renderer.',
            icon: 'mdi-language-markdown',
            input: 'markdown',
            output: 'html',
            props: {
              safeMode: {
                type: 'boolean',
                title: 'Safe Mode',
                order: 1,
                hint: 'Enable benign safety behavior'
              },
              flavor: { type: 'string', title: 'Flavor', order: 2 }
            },
            unrelatedMetadata: 'private-definition-metadata'
          },
          {
            key: 'emojiRenderer',
            title: 'Emoji Renderer',
            description: 'Adds emoji rendering.',
            icon: 'mdi-emoticon-outline',
            dependsOn: 'markdownCore',
            props: {}
          }
        ]
      },
      models: {
        knex: db,
        renderers: {
          getRenderers: vi.fn().mockResolvedValue([
            {
              key: 'markdownCore',
              isEnabled: 1,
              config: { flavor: 'commonmark', safeMode: true, internalNote: 'private-config-value' },
              privateField: 'private-model-field',
              props: { raw: true }
            },
            { key: 'emojiRenderer', isEnabled: 0, config: {}, privateField: 'private-model-field' }
          ])
        }
      }
    }
    configureTransportRuntime(global.WIKI)
    const { default: apiRouter } = await vi.importFresh('../../controllers/api/index.ts', import.meta.url)
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => { req.user = user; next() })
    app.use('/_api', apiRouter)
    server = app.listen(0, '127.0.0.1')
    await new Promise((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Rendering test server did not bind a TCP port')
    baseUrl = `http://127.0.0.1:${address.port}/_api/rendering`
  })

  afterEach(async () => {
    try {
      if (server?.listening) {
        await new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve())
          server.closeAllConnections()
        })
      }
    } finally {
      server = undefined
      try {
        await db?.destroy()
      } finally {
        db = undefined
        vi.mockModule('../../operations/rendering-workspace.ts', import.meta.url, () => workspaceExports)
        vi.clearAllMocks()
        configureTransportRuntime(originalTransport)
        global.WIKI = originalWiki
      }
    }
  })

  it('denies renderer reads without querying the model', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)

    const response = await fetch(`${baseUrl}/renderers`)

    expect(response.status).toBe(403)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.text()).toBe('Forbidden')
    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(user, ['manage:system'])
    expect(global.WIKI.models.renderers.getRenderers).not.toHaveBeenCalled()
  })

  it('serializes only public renderer fields and known config with definition metadata', async () => {
    const response = await fetch(`${baseUrl}/renderers`)
    const body = await jsonResponse(response, 200)

    expect(body).toEqual([
      {
        isEnabled: true,
        key: 'markdownCore',
        title: 'Markdown Core',
        description: 'Core markdown renderer.',
        icon: 'mdi-language-markdown',
        dependsOn: null,
        input: 'markdown',
        output: 'html',
        config: [
          { key: 'flavor', value: JSON.stringify({ type: 'string', title: 'Flavor', order: 2, value: 'commonmark' }) },
          { key: 'safeMode', value: JSON.stringify({ type: 'boolean', title: 'Safe Mode', order: 1, hint: 'Enable benign safety behavior', value: true }) }
        ]
      },
      {
        isEnabled: false,
        key: 'emojiRenderer',
        title: 'Emoji Renderer',
        description: 'Adds emoji rendering.',
        icon: 'mdi-emoticon-outline',
        dependsOn: 'markdownCore',
        input: null,
        output: null,
        config: []
      }
    ])
    expect(JSON.stringify(body)).not.toMatch(/private-definition-metadata|private-config-value|private-model-field/)
  })

  it('uses fresh runtime renderer definitions after the module has loaded', async () => {
    const before = await jsonResponse(await fetch(`${baseUrl}/renderers`), 200)
    expect(before[0].title).toBe('Markdown Core')
    global.WIKI.data.renderers = global.WIKI.data.renderers.map(renderer => ({
      ...renderer,
      title: `Runtime ${renderer.key}`
    }))

    const after = await jsonResponse(await fetch(`${baseUrl}/renderers`), 200)

    expect(after.map(renderer => renderer.title)).toEqual(['Runtime markdownCore', 'Runtime emojiRenderer'])
  })

  it('denies renderer writes without reaching the workspace writer', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)

    const response = await saveRenderers({ renderers: [{ key: 'markdownCore', isEnabled: true, config: [] }] })

    expect(await jsonResponse(response, 403)).toEqual({ error: 'Forbidden' })
    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(user, ['manage:system'])
    expect(writeLegacy).not.toHaveBeenCalled()
  })

  it('decodes reviewed legacy configuration and writes enabled and disabled settings', async () => {
    const response = await saveRenderers({
      renderers: [
        {
          key: 'markdownCore',
          isEnabled: true,
          config: [
            { key: 'safeMode', value: JSON.stringify({ v: false }) },
            { key: 'flavor', value: JSON.stringify({ v: 'commonmark' }) }
          ]
        },
        { key: 'emojiRenderer', isEnabled: false, config: [] }
      ]
    })

    expect(await jsonResponse(response, 200)).toEqual({ message: 'Renderers updated successfully' })
    expect(writeLegacy).toHaveBeenCalledTimes(1)
    expect(writeLegacy).toHaveBeenCalledWith([
      { key: 'markdownCore', isEnabled: true, config: { safeMode: false, flavor: 'commonmark' } },
      { key: 'emojiRenderer', isEnabled: false, config: {} }
    ])
  })

  it.each([
    ['missing renderers', {}],
    ['non-array renderers', { renderers: {} }],
    ['non-boolean enabled state', { renderers: [{ key: 'markdownCore', isEnabled: 'yes', config: [] }] }],
    ['non-array config', { renderers: [{ key: 'markdownCore', isEnabled: true, config: {} }] }],
    ['non-string config value', { renderers: [{ key: 'markdownCore', isEnabled: true, config: [{ key: 'safeMode', value: false }] }] }],
    ['malformed config JSON', { renderers: [{ key: 'markdownCore', isEnabled: true, config: [{ key: 'safeMode', value: '{bad' }] }] }]
  ])('rejects %s before writing settings', async (_description, body) => {
    const response = await saveRenderers(body)

    expect(await jsonResponse(response, 400)).toEqual({ error: 'Invalid renderers payload' })
    expect(writeLegacy).not.toHaveBeenCalled()
  })

  it('returns a safe JSON error when the workspace writer unexpectedly fails', async () => {
    const error = new Error('database unavailable: private-connection-detail')
    writeLegacy.mockRejectedValue(error)

    const response = await saveRenderers({ renderers: [{ key: 'markdownCore', isEnabled: true, config: [] }] })

    expect(await jsonResponse(response, 500)).toEqual({ error: 'Rendering request failed. Try again or check server logs.' })
    expect(global.WIKI.logger.warn).toHaveBeenCalledWith(error)
  })

  it('propagates unexpected model failures to the mounted API error handler without leaking details', async () => {
    const error = new Error('rendering failed: private-query-detail')
    global.WIKI.models.renderers.getRenderers.mockRejectedValue(error)

    const response = await fetch(`${baseUrl}/renderers`)

    expect(await jsonResponse(response, 500)).toEqual({ error: 'Internal Server Error' })
    expect(global.WIKI.logger.error).toHaveBeenCalledWith(error)
  })
})
