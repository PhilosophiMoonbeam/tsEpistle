import type { Server } from 'node:http'
import express, { type Router } from 'express'
import { configureTransportRuntime } from '../../controllers/_types.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { MAX_LOCALE_FILE_BYTES } from '../../../shared/locale-policy.ts'

const store = { reviewLocalFile: vi.fn(), enqueueLocalFile: vi.fn() }
vi.mockModule('../../operations/locale-administration.ts', import.meta.url, () => ({ getLocaleAdministrationStore: () => store }))
vi.mockModule('../../operations/localization.ts', import.meta.url, () => ({ default: {} }))

const auth = { checkAccess: vi.fn() }
let authorized = true
let server: Server
let baseUrl: string
const review = {
  id: 'review-1', code: 'fr', name: 'French', nativeName: 'Français', digest: 'd'.repeat(64), reason: 'Reviewed update',
  expiresAt: '2026-09-28T00:00:00.000Z', changes: { added: ['home.title'], changed: [], removed: [] }
}

beforeEach(async () => {
  vi.clearAllMocks()
  authorized = true
  auth.checkAccess.mockImplementation(() => authorized)
  store.reviewLocalFile.mockResolvedValue(review)
  store.enqueueLocalFile.mockResolvedValue({ jobId: 'locale-job-1' })
  configureTransportRuntime({ auth })

  const { default: localesRouter } = await vi.importFresh<{ default: Router }>('../../controllers/api/locales.ts', import.meta.url)
  const app = express()
  app.use((req, _res, next) => {
    req.user = { id: 7 } as Express.User
    next()
  })
  app.use('/_api', express.json({ limit: '1mb' }))
  app.use('/_api/locales', localesRouter)
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : String(error)
    res.status(500).json({ error: message })
  })
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Locale test server did not bind a TCP port')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
})

const upload = async (bytes: Uint8Array, filename = 'suggested-locale-name.json', extraField?: [string, string]): Promise<Response> => {
  const form = new FormData()
  form.append('code', 'fr')
  form.append('fingerprint', 'f'.repeat(64))
  form.append('reason', 'Reviewed update')
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/json' }), filename)
  if (extraField) form.append(extraField[0], extraField[1])
  return await fetch(`${baseUrl}/_api/locales/workspace/local-files/review`, { method: 'POST', body: form })
}

describe('locale local-file transport', () => {
  it('requires manage:system before parsing and marks the response non-cacheable', async () => {
    authorized = false
    const denied = await fetch(`${baseUrl}/_api/locales/workspace/local-files/review`, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=broken' },
      body: '--broken\r\nContent-Disposition: form-data; name="file"; filename="locale.json"\r\n'
    })

    expect(denied.status).toBe(403)
    expect(denied.headers.get('cache-control')).toBe('no-store')
    expect(await denied.json()).toEqual({ error: 'manage:system is required' })
    expect(auth.checkAccess).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), ['manage:system'])
    expect(store.reviewLocalFile).not.toHaveBeenCalled()
    const deniedCommit = await fetch(`${baseUrl}/_api/locales/workspace/local-files/review-1/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    })
    expect(deniedCommit.status).toBe(403)
    expect(deniedCommit.headers.get('cache-control')).toBe('no-store')
    expect(store.enqueueLocalFile).not.toHaveBeenCalled()
  })

  it('binds the explicit locale code and exact uploaded bytes to the reviewed operation, ignoring the filename', async () => {
    const bytes = new TextEncoder().encode('{"hello":"bonjour"}')
    const response = await upload(bytes, 'de.json')

    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual(review)
    expect(store.reviewLocalFile).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), {
      code: 'fr', fingerprint: 'f'.repeat(64), reason: 'Reviewed update', bytes: Buffer.from(bytes)
    })
  })

  it('accepts exactly the configured locale-file ceiling and rejects the first byte over it', async () => {
    const exact = await upload(new Uint8Array(MAX_LOCALE_FILE_BYTES))
    expect(exact.status).toBe(201)
    expect(store.reviewLocalFile).toHaveBeenCalledTimes(1)
    expect(store.reviewLocalFile.mock.calls[0]![1].bytes.byteLength).toBe(MAX_LOCALE_FILE_BYTES)

    store.reviewLocalFile.mockClear()
    const oversized = await upload(new Uint8Array(MAX_LOCALE_FILE_BYTES + 1))
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toMatchObject({ error: expect.stringContaining('size limit') })
    expect(store.reviewLocalFile).not.toHaveBeenCalled()
  })

  it('rejects excess or unrecognized multipart fields and preserves reviewed-operation conflicts', async () => {
    const malformed = await upload(new TextEncoder().encode('{}'), 'fr.json', ['unexpected', 'value'])
    expect(malformed.status).toBe(400)
    expect(store.reviewLocalFile).not.toHaveBeenCalled()

    const form = new FormData()
    form.append('code', 'fr')
    form.append('fingerprint', 'f'.repeat(64))
    form.append('unexpected', 'Reviewed update')
    form.append('file', new Blob(['{}'], { type: 'application/json' }), 'fr.json')
    const unknownField = await fetch(`${baseUrl}/_api/locales/workspace/local-files/review`, { method: 'POST', body: form })
    expect(unknownField.status).toBe(400)
    expect(store.reviewLocalFile).not.toHaveBeenCalled()

    store.reviewLocalFile.mockRejectedValueOnce(Object.assign(new Error('Locale workspace changed'), { status: 409 }))
    const conflict = await upload(new TextEncoder().encode('{}'))
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({ error: 'Locale workspace changed' })
    store.reviewLocalFile.mockRejectedValueOnce(new Error('private staged path'))
    const failed = await upload(new TextEncoder().encode('{}'))
    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({ error: 'Locale administration is temporarily unavailable. Reload to confirm the saved state.' })
  })

  it('queues a reviewed commit by path identity under system authority', async () => {
    const response = await fetch(`${baseUrl}/_api/locales/workspace/local-files/review-1/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    })

    expect(response.status).toBe(202)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ jobId: 'locale-job-1' })
    expect(store.enqueueLocalFile).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), { reviewId: 'review-1' })
  })
})
