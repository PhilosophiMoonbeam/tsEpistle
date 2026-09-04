import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import type { Server } from 'node:http'
import createKnex, { type Knex } from 'knex'
import express, { type NextFunction, type Request, type Response as ExpressResponse, type Router } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { up as createDurableJobs } from '../../db/migrations/2.5.130.ts'
import { up as addDurableJobLeaseToken } from '../../db/migrations/2.5.158.ts'
import { configureTransportRuntime } from '../../controllers/_types.ts'
import { SITE_LOGO_SOURCE_LIMIT } from '../../operations/site-logo.ts'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_BYTES = Buffer.concat([PNG_SIGNATURE, Buffer.from('observable-logo-source')])
const ACTIVE_SOURCE = Buffer.concat([PNG_SIGNATURE, Buffer.from('active-logo-source')])
const COMPRESSED_LARGE_JSON = gzipSync(Buffer.from(JSON.stringify({ payload: 'x'.repeat(SITE_LOGO_SOURCE_LIMIT + 1) })))

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const createLogoTables = async (db: Knex): Promise<void> => {
  await createDurableJobs(db)
  await addDurableJobLeaseToken(db)
  await db.schema.createTable('siteLogoObjects', table => {
    table.string('kind').notNullable()
    table.string('sha256', 64).notNullable()
    table.binary('bytes').notNullable()
    table.integer('byteLength').notNullable()
    table.string('contentType').notNullable()
    table.dateTime('createdAt').notNullable()
    table.primary(['kind', 'sha256'])
  })
  await db.schema.createTable('siteLogoRevisions', table => {
    table.uuid('id').primary()
    table.string('sourceKind').notNullable()
    table.string('sourceHash', 64).notNullable()
    table.integer('pipelineVersion').notNullable()
    table.string('status').notNullable()
    table.uuid('jobId').nullable()
    table.integer('retrySequence').notNullable()
    table.string('logoPngKind').nullable()
    table.string('logoPngHash', 64).nullable()
    table.string('particleV1Kind').nullable()
    table.string('particleV1Hash', 64).nullable()
    table.string('effectStaticPngKind').nullable()
    table.string('effectStaticPngHash', 64).nullable()
    table.integer('normalizedWidth').nullable()
    table.integer('normalizedHeight').nullable()
    table.integer('particleCount').nullable()
    table.float('medianStroke').nullable()
    table.string('auraColor').nullable()
    table.string('errorCode').nullable()
    table.integer('requestedBy').nullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
    table.dateTime('startedAt').nullable()
    table.dateTime('completedAt').nullable()
    table.dateTime('retiredAt').nullable()
  })
  await db.schema.createTable('siteLogoState', table => {
    table.integer('id').primary()
    table.integer('generation').notNullable()
    table.uuid('desiredRevisionId').nullable()
    table.uuid('activeRevisionId').nullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
  })
  await db.schema.createTable('settings', table => {
    table.string('key').primary()
    table.json('value')
    table.string('updatedAt').notNullable()
  })
  const now = new Date()
  await db('siteLogoState').insert({ id: 1, generation: 0, desiredRevisionId: null, activeRevisionId: null, createdAt: now, updatedAt: now })
}

type ReadyRevision = {
  revisionId: string
  sourceHash: string
  logoHash: string
  particleHash: string
  staticHash: string
}

const objectContentType = (kind: string): string => (kind === 'particle-v1' ? 'application/octet-stream' : 'image/png')

const insertObject = async (db: Knex, kind: string, bytes: Buffer, claimedHash = digest(bytes)): Promise<string> => {
  await db('siteLogoObjects').insert({
    kind,
    sha256: claimedHash,
    bytes,
    byteLength: bytes.byteLength,
    contentType: objectContentType(kind),
    createdAt: new Date()
  })
  return claimedHash
}

const seedReadyRevision = async (
  db: Knex,
  source: Buffer,
  revisionId: string,
  retrySequence = 0,
  omitKind?: 'logo-png' | 'particle-v1' | 'effect-static-png',
  corruptKind?: 'logo-png' | 'particle-v1' | 'effect-static-png'
): Promise<ReadyRevision> => {
  const sourceHash = digest(source)
  await db('siteLogoObjects')
    .insert({ kind: 'source', sha256: sourceHash, bytes: source, byteLength: source.byteLength, contentType: 'image/png', createdAt: new Date() })
    .onConflict(['kind', 'sha256'])
    .ignore()

  const artifacts = {
    'logo-png': Buffer.from(`logo:${sourceHash}`),
    'particle-v1': Buffer.from(`particle:${sourceHash}`),
    'effect-static-png': Buffer.from(`static:${sourceHash}`)
  } as const
  const hashes = {
    'logo-png': digest(artifacts['logo-png']),
    'particle-v1': digest(artifacts['particle-v1']),
    'effect-static-png': digest(artifacts['effect-static-png'])
  } as const
  for (const kind of ['logo-png', 'particle-v1', 'effect-static-png'] as const) {
    if (kind === omitKind) continue
    const bytes = kind === corruptKind ? Buffer.from(`corrupt:${kind}`) : artifacts[kind]
    await insertObject(db, kind, bytes, hashes[kind])
  }

  const now = new Date()
  await db('siteLogoRevisions').insert({
    id: revisionId,
    sourceKind: 'source',
    sourceHash,
    pipelineVersion: 1,
    status: 'ready',
    retrySequence,
    logoPngKind: 'logo-png',
    logoPngHash: hashes['logo-png'],
    particleV1Kind: 'particle-v1',
    particleV1Hash: hashes['particle-v1'],
    effectStaticPngKind: 'effect-static-png',
    effectStaticPngHash: hashes['effect-static-png'],
    normalizedWidth: 320,
    normalizedHeight: 96,
    particleCount: 12,
    medianStroke: 2,
    auraColor: '#112233',
    requestedBy: 3,
    createdAt: now,
    updatedAt: now,
    completedAt: now
  })
  return {
    revisionId,
    sourceHash,
    logoHash: hashes['logo-png'],
    particleHash: hashes['particle-v1'],
    staticHash: hashes['effect-static-png']
  }
}

const json = async <Value>(response: Response): Promise<Value> => (await response.json()) as Value

interface StatusBody {
  active: { revisionId: string; logoUrl: string } | null
  candidate: { revisionId: string; status: string; errorCode: string | null } | null
  statusUrl?: string
}

interface ControllerModule {
  default: Router
  siteLogoPreBodyRouter: Router
}

describe('managed site logo HTTP contracts', () => {
  let db: Knex
  let server: Server
  let baseUrl: string
  let authorized: boolean
  let saveToDb = vi.fn(async (_keys: string[]): Promise<void> => {})
  let auth = { checkAccess: vi.fn((_user: Express.User | undefined, _permissions: string[]) => true) }
  let globalJsonParserCalls: number
  let globalUrlencodedParserCalls: number

  beforeEach(async () => {
    vi.clearAllMocks()
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await createLogoTables(db)
    authorized = true
    auth = { checkAccess: vi.fn((_user: Express.User | undefined, _permissions: string[]) => authorized) }
    globalJsonParserCalls = 0
    globalUrlencodedParserCalls = 0
    saveToDb = vi.fn(async (_keys: string[]): Promise<void> => {})
    global.WIKI = {
      auth,
      models: { knex: db },
      configSvc: { saveToDb },
      app: { set: vi.fn() },
      config: {
        host: 'https://wiki.example.test',
        title: 'Wiki',
        company: 'Company',
        contentLicense: 'ccby',
        footerOverride: '',
        banner: { isEnabled: false, title: '', content: '' },
        logoUrl: '/legacy-logo.svg',
        pageExtensions: ['md'],
        editors: { available: ['markdown'] },
        seo: { description: '', robots: [], analyticsService: '', analyticsId: '' },
        editShortcuts: {},
        features: {},
        security: { securityTrustProxy: false },
        auth: { autoLogin: false, enforce2FA: false, hideLocal: false, loginBgUrl: '', audience: '', tokenExpiration: '', tokenRenewal: '' },
        uploads: { maxFileSize: 1024, maxFiles: 1, scanSVG: true, forceDownload: false }
      }
    }
    configureTransportRuntime({ auth })

    const logoController = await vi.importFresh<ControllerModule>('../../controllers/api/site-logo.ts', import.meta.url)
    const logoRouter = logoController.default
    const siteRouter = (await vi.importFresh<ControllerModule>('../../controllers/api/site.ts', import.meta.url)).default
    const app = express()
    app.use((req, _res, next) => {
      req.user = { id: 7 } as Express.User
      next()
    })
    app.use('/_api/site/logo', logoController.siteLogoPreBodyRouter)
    const jsonBodyParser = express.json({ limit: '5mb' })
    app.use((req, res, next) => {
      globalJsonParserCalls += 1
      jsonBodyParser(req, res, next)
    })
    app.use('/_api/site/logo', logoRouter)
    app.use('/_api/site', siteRouter)
    const urlencodedBodyParser = express.urlencoded({ extended: false, limit: '1mb' })
    app.use((req, res, next) => {
      globalUrlencodedParserCalls += 1
      urlencodedBodyParser(req, res, next)
    })
    app.use((error: unknown, _req: Request, res: ExpressResponse, _next: NextFunction) => {
      const message = error instanceof Error ? error.message : String(error)
      res.status(500).json({ error: message })
    })
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Logo test server did not bind a TCP port')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
    await db.destroy()
  })

  const upload = async (...files: Array<{ bytes: Buffer; name?: string }>): Promise<Response> => {
    const form = new FormData()
    for (const [index, file] of files.entries()) {
      form.append('image', new Blob([new Uint8Array(file.bytes)], { type: 'image/png' }), file.name ?? `logo-${index}.png`)
    }
    return await fetch(`${baseUrl}/_api/site/logo`, { method: 'POST', body: form })
  }

  it.each(['/_api/site/logo', '/_api/site/logo/retry'])('denies large compressed JSON at %s without entering either global body parser', async requestPath => {
    authorized = false
    const denied = await fetch(`${baseUrl}${requestPath}`, {
      method: 'POST',
      headers: {
        'content-encoding': 'gzip',
        'content-type': 'application/json'
      },
      body: new Uint8Array(COMPRESSED_LARGE_JSON)
    })

    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: 'Forbidden' })
    expect(globalJsonParserCalls).toBe(0)
    expect(globalUrlencodedParserCalls).toBe(0)
    expect(auth.checkAccess).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), ['manage:system'])
  })

  it('authorizes before multipart parsing and enforces exactly one bounded file', async () => {
    authorized = false
    const denied = await fetch(`${baseUrl}/_api/site/logo`, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=broken' },
      body: '--broken\r\nContent-Disposition: form-data; name="image"; filename="logo.png"\r\n'
    })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: 'Forbidden' })
    expect(auth.checkAccess).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), ['manage:system'])
    expect(await db('siteLogoObjects')).toHaveLength(0)
    expect(await db('durableJobs')).toHaveLength(0)

    authorized = true
    const missing = await upload()
    expect(missing.status).toBe(400)
    expect(await missing.json()).toMatchObject({ code: 'INVALID_IMAGE' })

    const empty = await upload({ bytes: Buffer.alloc(0) })
    expect(empty.status).toBe(400)
    expect(await empty.json()).toMatchObject({ code: 'INVALID_IMAGE' })

    const multiple = await upload({ bytes: PNG_BYTES }, { bytes: PNG_BYTES })
    expect(multiple.status).toBe(400)
    expect(await multiple.json()).toMatchObject({ code: 'INVALID_IMAGE' })

    const oversized = await upload({ bytes: Buffer.alloc(SITE_LOGO_SOURCE_LIMIT + 1) })
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toMatchObject({ code: 'IMAGE_TOO_LARGE' })
    expect(await db('siteLogoObjects')).toHaveLength(0)
  })

  it('accepts one image at the exact source-byte limit', async () => {
    const bytes = Buffer.alloc(SITE_LOGO_SOURCE_LIMIT)
    PNG_SIGNATURE.copy(bytes)

    const response = await upload({ bytes })
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ candidate: { status: 'pending' }, statusUrl: '/_api/site/logo' })
    expect(await db('siteLogoObjects').where({ kind: 'source' }).first('byteLength')).toEqual({ byteLength: SITE_LOGO_SOURCE_LIMIT })
    expect(globalJsonParserCalls).toBe(0)
    expect(globalUrlencodedParserCalls).toBe(0)
    expect(await db('durableJobs')).toHaveLength(1)
  })

  it('returns 202 and reuses the same pending or running candidate while enqueuing only once', async () => {
    const first = await upload({ bytes: PNG_BYTES, name: 'same-name.png' })
    expect(first.status).toBe(202)
    const firstBody = await json<StatusBody>(first)
    expect(firstBody).toMatchObject({ active: null, candidate: { status: 'pending', errorCode: null }, statusUrl: '/_api/site/logo' })

    const pending = await upload({ bytes: Buffer.from(PNG_BYTES), name: 'renamed.png' })
    expect(pending.status).toBe(202)
    expect((await json<StatusBody>(pending)).candidate?.revisionId).toBe(firstBody.candidate?.revisionId)

    await db('siteLogoRevisions').where({ id: firstBody.candidate!.revisionId }).update({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
    const running = await upload({ bytes: Buffer.from(PNG_BYTES), name: 'same-name.png' })
    expect(running.status).toBe(202)
    expect((await json<StatusBody>(running)).candidate).toMatchObject({ revisionId: firstBody.candidate!.revisionId, status: 'running' })

    const jobs = await db('durableJobs').select('type', 'version', 'payload')
    expect(jobs).toEqual([
      { type: 'process-site-logo', version: 1, payload: JSON.stringify({ revisionId: firstBody.candidate!.revisionId, retrySequence: 0 }) }
    ])
  })

  it('returns 200 without work for an intact active upload', async () => {
    const active = await seedReadyRevision(db, PNG_BYTES, '00000000-0000-4000-8000-000000000011')
    await db('siteLogoState').where({ id: 1 }).update({ generation: 1, desiredRevisionId: active.revisionId, activeRevisionId: active.revisionId })

    const response = await upload({ bytes: Buffer.from(PNG_BYTES) })
    expect(response.status).toBe(200)
    expect(await json<StatusBody>(response)).toEqual({
      active: { revisionId: active.revisionId, logoUrl: `/_site-logo/${active.logoHash}/logo.png` },
      candidate: null,
      statusUrl: '/_api/site/logo'
    })
    expect(await db('durableJobs')).toHaveLength(0)
  })

  it('activates an intact reusable ready revision with 200 instead of enqueuing it again', async () => {
    const active = await seedReadyRevision(db, ACTIVE_SOURCE, '00000000-0000-4000-8000-000000000021')
    const reusable = await seedReadyRevision(db, PNG_BYTES, '00000000-0000-4000-8000-000000000022', 2)
    await db('siteLogoState').where({ id: 1 }).update({ generation: 2, desiredRevisionId: reusable.revisionId, activeRevisionId: active.revisionId })

    const response = await upload({ bytes: PNG_BYTES })
    expect(response.status).toBe(200)
    expect(await json<StatusBody>(response)).toMatchObject({
      active: { revisionId: reusable.revisionId, logoUrl: `/_site-logo/${reusable.logoHash}/logo.png` },
      candidate: null
    })
    expect(await db('durableJobs')).toHaveLength(0)
    expect(global.WIKI.config.logoUrl).toBe(`/_site-logo/${reusable.logoHash}/logo.png`)
    expect(await db('settings').where({ key: 'logoUrl' }).first('value')).toEqual({ value: JSON.stringify({ v: `/_site-logo/${reusable.logoHash}/logo.png` }) })
  })

  it.each([
    ['digest-mismatched', undefined, 'logo-png'],
    ['incomplete', 'particle-v1', undefined]
  ] as const)('retires a %s ready candidate and creates fresh fenced work without hiding the active preview', async (_label, omitKind, corruptKind) => {
    const active = await seedReadyRevision(db, ACTIVE_SOURCE, '00000000-0000-4000-8000-000000000031')
    const broken = await seedReadyRevision(db, PNG_BYTES, '00000000-0000-4000-8000-000000000032', 4, omitKind, corruptKind)
    await db('siteLogoState').where({ id: 1 }).update({ generation: 2, desiredRevisionId: broken.revisionId, activeRevisionId: active.revisionId })

    const response = await upload({ bytes: PNG_BYTES })
    expect(response.status).toBe(202)
    const body = await json<StatusBody>(response)
    expect(body.active).toEqual({ revisionId: active.revisionId, logoUrl: `/_site-logo/${active.logoHash}/logo.png` })
    expect(body.candidate).toMatchObject({ status: 'pending', errorCode: null })
    expect(body.candidate?.revisionId).not.toBe(broken.revisionId)
    expect((await db('siteLogoRevisions').where({ id: broken.revisionId }).first('retiredAt'))?.retiredAt).not.toBeNull()
    expect(await db('siteLogoRevisions').where({ id: body.candidate!.revisionId }).first('retrySequence')).toEqual({ retrySequence: 5 })
    expect(await db('durableJobs')).toHaveLength(1)
  })

  it('returns no-store safe status, preserves the active preview on failure, and retries as fresh work', async () => {
    const active = await seedReadyRevision(db, ACTIVE_SOURCE, '00000000-0000-4000-8000-000000000041')
    await db('siteLogoState').where({ id: 1 }).update({ generation: 1, desiredRevisionId: active.revisionId, activeRevisionId: active.revisionId })
    const pendingResponse = await upload({ bytes: PNG_BYTES })
    const pending = (await json<StatusBody>(pendingResponse)).candidate!
    await db('siteLogoRevisions')
      .where({ id: pending.revisionId })
      .update({ status: 'failed', errorCode: 'ARTIFACT_TOO_LARGE', completedAt: new Date(), updatedAt: new Date() })

    const status = await fetch(`${baseUrl}/_api/site/logo`)
    expect(status.status).toBe(200)
    expect(status.headers.get('cache-control')).toBe('no-store')
    expect(await json<StatusBody>(status)).toEqual({
      active: { revisionId: active.revisionId, logoUrl: `/_site-logo/${active.logoHash}/logo.png` },
      candidate: { revisionId: pending.revisionId, status: 'failed', errorCode: 'ARTIFACT_TOO_LARGE' }
    })

    const retried = await fetch(`${baseUrl}/_api/site/logo/retry`, { method: 'POST' })
    expect(retried.status).toBe(202)
    const retriedBody = await json<StatusBody>(retried)
    expect(retriedBody.active?.revisionId).toBe(active.revisionId)
    expect(retriedBody.candidate).toMatchObject({ status: 'pending', errorCode: null })
    expect(retriedBody.candidate?.revisionId).not.toBe(pending.revisionId)
    expect(await db('siteLogoRevisions').where({ id: retriedBody.candidate!.revisionId }).first('retrySequence', 'requestedBy')).toEqual({
      retrySequence: 1,
      requestedBy: 7
    })
    expect((await db('siteLogoRevisions').where({ id: pending.revisionId }).first('retiredAt'))?.retiredAt).not.toBeNull()
  })

  it('does not disclose an unrecognized processor error through status', async () => {
    const uploaded = await upload({ bytes: PNG_BYTES })
    const candidate = (await json<StatusBody>(uploaded)).candidate!
    await db('siteLogoRevisions').where({ id: candidate.revisionId }).update({ status: 'failed', errorCode: 'decoder stack trace', completedAt: new Date() })

    const status = await fetch(`${baseUrl}/_api/site/logo`)
    expect((await json<StatusBody>(status)).candidate).toEqual({ revisionId: candidate.revisionId, status: 'failed', errorCode: 'PROCESSING_FAILED' })
  })

  it('returns a canonical conflict code for stale logoUrl writes while either managed pointer is fenced', async () => {
    const pointer = '00000000-0000-4000-8000-000000000051'
    for (const state of [
      { desiredRevisionId: pointer, activeRevisionId: null },
      { desiredRevisionId: null, activeRevisionId: pointer }
    ]) {
      await db('siteLogoState').where({ id: 1 }).update(state)
      const response = await fetch(`${baseUrl}/_api/site/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ logoUrl: '/stale-client-logo.svg' })
      })
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({
        error: 'Managed logos can only be replaced through the dedicated logo API.',
        code: 'MANAGED_LOGO_CONFLICT'
      })
      expect(global.WIKI.config.logoUrl).toBe('/legacy-logo.svg')
      expect(saveToDb).not.toHaveBeenCalled()
    }
  })

  it('allows unrelated site saves while fenced and never persists logoUrl through the legacy save keys', async () => {
    await db('siteLogoState').where({ id: 1 }).update({ desiredRevisionId: '00000000-0000-4000-8000-000000000061' })
    const response = await fetch(`${baseUrl}/_api/site/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Updated title' })
    })

    expect(response.status).toBe(200)
    expect(global.WIKI.config.title).toBe('Updated title')
    expect(global.WIKI.config.logoUrl).toBe('/legacy-logo.svg')
    expect(saveToDb).toHaveBeenCalledOnce()
    expect(saveToDb.mock.calls[0]![0]).not.toContain('logoUrl')
  })
})
