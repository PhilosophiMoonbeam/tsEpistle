import { createHash } from 'node:crypto'
import type { Server } from 'node:http'
import { gzipSync } from 'node:zlib'
import express, { type Response as ExpressResponse, type NextFunction, type Request, type Router } from 'express'
import createKnex, { type Knex } from 'knex'
import { configureTransportRuntime } from '../../controllers/_types.ts'
import { up as createDurableJobs } from '../../db/migrations/2.5.130.ts'
import { up as addDurableJobLeaseToken } from '../../db/migrations/2.5.158.ts'
import type { SiteLogoArtifacts } from '../../helpers/site-logo-processing.ts'
import { SITE_LOGO_SOURCE_LIMIT } from '../../operations/site-logo.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

const legacyGeneral = vi.fn().mockResolvedValue(undefined)
vi.mockModule('../../operations/general-administration.ts', import.meta.url, () => ({
  patchLegacyGeneralConfiguration: legacyGeneral,
  getGeneralAdministrationStore: vi.fn()
}))

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_BYTES = Buffer.concat([PNG_SIGNATURE, Buffer.from('observable-logo-source')])
const ACTIVE_SOURCE = Buffer.concat([PNG_SIGNATURE, Buffer.from('active-logo-source')])
const COMPRESSED_LARGE_JSON = gzipSync(Buffer.from(JSON.stringify({ payload: 'x'.repeat(SITE_LOGO_SOURCE_LIMIT + 1) })))

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const createLogoTables = async (db: Knex): Promise<void> => {
  await createDurableJobs(db)
  await addDurableJobLeaseToken(db)
  await db.schema.createTable('siteLogoObjects', table => {
    table.string('kind', 32).notNullable()
    table.string('sha256', 64).notNullable()
    table.binary('bytes').notNullable()
    table.integer('byteLength').unsigned().notNullable()
    table.string('contentType', 64).notNullable()
    table.dateTime('createdAt').notNullable()
    table.primary(['kind', 'sha256'])
    table.check(`"kind" IN ('source', 'logo-png', 'icon-png', 'favicon-ico', 'particle-v1', 'effect-static-png')`)
    table.check(`"byteLength" = length("bytes")`)
    table.check(
      `"byteLength" > 0 AND (
        ("kind" = 'source' AND "contentType" IN ('image/png', 'image/jpeg', 'image/webp') AND "byteLength" <= ${SITE_LOGO_SOURCE_LIMIT})
        OR ("kind" = 'logo-png' AND "contentType" = 'image/png' AND "byteLength" <= 5242880)
        OR ("kind" = 'icon-png' AND "contentType" = 'image/png' AND "byteLength" <= 2097152)
        OR ("kind" = 'favicon-ico' AND "contentType" = 'image/x-icon' AND "byteLength" <= 16384)
        OR ("kind" = 'particle-v1' AND "contentType" = 'application/octet-stream' AND "byteLength" BETWEEN 68 AND 192056)
        OR ("kind" = 'effect-static-png' AND "contentType" = 'image/png' AND "byteLength" <= 1048576)
      )`
    )
  })
  await db.schema.createTable('siteLogoRevisions', table => {
    table.uuid('id').primary()
    table.string('sourceKind', 32).notNullable()
    table.string('sourceHash', 64).notNullable()
    table.integer('pipelineVersion').unsigned().notNullable()
    table.string('status', 16).notNullable()
    table.uuid('jobId').nullable()
    table.integer('retrySequence').unsigned().notNullable()
    table.string('logoPngKind', 32).nullable()
    table.string('logoPngHash', 64).nullable()
    table.string('iconPngKind', 32).nullable()
    table.string('favicon16Hash', 64).nullable()
    table.string('favicon32Hash', 64).nullable()
    table.string('tile150Hash', 64).nullable()
    table.string('apple180Hash', 64).nullable()
    table.string('app192Hash', 64).nullable()
    table.string('app512Hash', 64).nullable()
    table.string('maskable512Hash', 64).nullable()
    table.string('faviconIcoKind', 32).nullable()
    table.string('faviconIcoHash', 64).nullable()
    table.string('particleV1Kind', 32).nullable()
    table.string('particleV1Hash', 64).nullable()
    table.string('effectStaticPngKind', 32).nullable()
    table.string('effectStaticPngHash', 64).nullable()
    table.integer('normalizedWidth').unsigned().nullable()
    table.integer('normalizedHeight').unsigned().nullable()
    table.integer('particleCount').unsigned().nullable()
    table.double('medianStroke').nullable()
    table.string('auraColor', 7).nullable()
    table.string('enhancementErrorCode', 64).nullable()
    table.string('errorCode', 64).nullable()
    table.integer('requestedBy').unsigned().nullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
    table.dateTime('startedAt').nullable()
    table.dateTime('completedAt').nullable()
    table.dateTime('retiredAt').nullable()
    table.foreign(['sourceKind', 'sourceHash']).references(['kind', 'sha256']).inTable('siteLogoObjects').onDelete('RESTRICT')
    table.foreign(['logoPngKind', 'logoPngHash']).references(['kind', 'sha256']).inTable('siteLogoObjects').onDelete('RESTRICT')
    table.foreign(['iconPngKind', 'favicon16Hash']).references(['kind', 'sha256']).inTable('siteLogoObjects').onDelete('RESTRICT')
    table.foreign(['iconPngKind', 'favicon32Hash']).references(['kind', 'sha256']).inTable('siteLogoObjects').onDelete('RESTRICT')
    table.foreign(['iconPngKind', 'tile150Hash']).references(['kind', 'sha256']).inTable('siteLogoObjects').onDelete('RESTRICT')
    table.foreign(['iconPngKind', 'apple180Hash']).references(['kind', 'sha256']).inTable('siteLogoObjects').onDelete('RESTRICT')
    table.foreign(['iconPngKind', 'app192Hash']).references(['kind', 'sha256']).inTable('siteLogoObjects').onDelete('RESTRICT')
    table.foreign(['iconPngKind', 'app512Hash']).references(['kind', 'sha256']).inTable('siteLogoObjects').onDelete('RESTRICT')
    table.foreign(['iconPngKind', 'maskable512Hash']).references(['kind', 'sha256']).inTable('siteLogoObjects').onDelete('RESTRICT')
    table.foreign(['faviconIcoKind', 'faviconIcoHash']).references(['kind', 'sha256']).inTable('siteLogoObjects').onDelete('RESTRICT')
    table.foreign(['particleV1Kind', 'particleV1Hash']).references(['kind', 'sha256']).inTable('siteLogoObjects').onDelete('RESTRICT')
    table.foreign(['effectStaticPngKind', 'effectStaticPngHash']).references(['kind', 'sha256']).inTable('siteLogoObjects').onDelete('RESTRICT')
    table.check(`"sourceKind" = 'source'`)
    table.check(`"pipelineVersion" BETWEEN 1 AND 7`)
    table.check(`"retrySequence" >= 0`)
    table.check(`"status" IN ('pending', 'running', 'ready', 'failed')`)
  })
  await db.schema.createTable('siteLogoState', table => {
    table.integer('id').primary()
    table.integer('generation').unsigned().notNullable()
    table.uuid('desiredRevisionId').nullable()
    table.uuid('activeRevisionId').nullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
    table.check(`"id" = 1`)
    table.check(`"generation" >= 0`)
  })
  await db.schema.createTable('settings', table => {
    table.string('key').primary()
    table.json('value')
    table.string('updatedAt').notNullable()
  })
  const now = new Date()
  await db('siteLogoState').insert({ id: 1, generation: 0, desiredRevisionId: null, activeRevisionId: null, createdAt: now, updatedAt: now })
}

const ICON_NAMES = ['favicon16', 'favicon32', 'tile150', 'apple180', 'app192', 'app512', 'maskable512'] as const
type IconName = (typeof ICON_NAMES)[number]
type IconHashes = { [Name in IconName]: string }

type ReadyRevision = {
  revisionId: string
  sourceHash: string
  logoHash: string
  iconHashes: IconHashes | null
  faviconIcoHash: string | null
  particleHash: string
  staticHash: string
}

const objectContentType = (kind: string): string =>
  kind === 'particle-v1' ? 'application/octet-stream' : kind === 'favicon-ico' ? 'image/x-icon' : 'image/png'

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
  pipelineVersion = 6,
  retrySequence = 0,
  omitKind?: 'logo-png' | 'particle-v1' | 'effect-static-png',
  corruptKind?: 'logo-png' | 'particle-v1' | 'effect-static-png',
  iconArtifacts?: Pick<SiteLogoArtifacts, 'icons' | 'faviconIco'>
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

  const iconBytes = iconArtifacts?.icons ?? {
    favicon16: Buffer.from(`icon:favicon16:${sourceHash}`),
    favicon32: Buffer.from(`icon:favicon32:${sourceHash}`),
    tile150: Buffer.from(`icon:tile150:${sourceHash}`),
    apple180: Buffer.from(`icon:apple180:${sourceHash}`),
    app192: Buffer.from(`icon:app192:${sourceHash}`),
    app512: Buffer.from(`icon:app512:${sourceHash}`),
    maskable512: Buffer.from(`icon:maskable512:${sourceHash}`)
  }
  const iconHashes: IconHashes = {
    favicon16: digest(iconBytes.favicon16),
    favicon32: digest(iconBytes.favicon32),
    tile150: digest(iconBytes.tile150),
    apple180: digest(iconBytes.apple180),
    app192: digest(iconBytes.app192),
    app512: digest(iconBytes.app512),
    maskable512: digest(iconBytes.maskable512)
  }
  const faviconIco = iconArtifacts?.faviconIco ?? Buffer.from(`ico:${sourceHash}`)
  const faviconIcoHash = digest(faviconIco)
  const hasLogo = omitKind !== 'logo-png'
  const hasParticle = omitKind !== 'particle-v1'
  const hasEffect = omitKind !== 'effect-static-png'
  const hasEnhancement = hasParticle && hasEffect
  const hasIcons = pipelineVersion === 6 || pipelineVersion === 7
  if (hasIcons) {
    for (const name of ICON_NAMES) await insertObject(db, 'icon-png', iconBytes[name], iconHashes[name])
    await insertObject(db, 'favicon-ico', faviconIco, faviconIcoHash)
  }

  const now = new Date()
  await db('siteLogoRevisions').insert({
    id: revisionId,
    sourceKind: 'source',
    sourceHash,
    pipelineVersion,
    status: 'ready',
    retrySequence,
    logoPngKind: hasLogo ? 'logo-png' : null,
    logoPngHash: hasLogo ? hashes['logo-png'] : null,
    iconPngKind: hasIcons ? 'icon-png' : null,
    favicon16Hash: hasIcons ? iconHashes.favicon16 : null,
    favicon32Hash: hasIcons ? iconHashes.favicon32 : null,
    tile150Hash: hasIcons ? iconHashes.tile150 : null,
    apple180Hash: hasIcons ? iconHashes.apple180 : null,
    app192Hash: hasIcons ? iconHashes.app192 : null,
    app512Hash: hasIcons ? iconHashes.app512 : null,
    maskable512Hash: hasIcons ? iconHashes.maskable512 : null,
    faviconIcoKind: hasIcons ? 'favicon-ico' : null,
    faviconIcoHash: hasIcons ? faviconIcoHash : null,
    particleV1Kind: hasParticle ? 'particle-v1' : null,
    particleV1Hash: hasParticle ? hashes['particle-v1'] : null,
    effectStaticPngKind: hasEffect ? 'effect-static-png' : null,
    effectStaticPngHash: hasEffect ? hashes['effect-static-png'] : null,
    normalizedWidth: hasEnhancement ? 320 : null,
    normalizedHeight: hasEnhancement ? 96 : null,
    particleCount: hasEnhancement ? 12 : null,
    medianStroke: hasEnhancement ? 2 : null,
    auraColor: hasEnhancement ? '#112233' : null,
    enhancementErrorCode: null,
    errorCode: null,
    requestedBy: 3,
    createdAt: now,
    updatedAt: now,
    completedAt: now
  })
  return {
    revisionId,
    sourceHash,
    logoHash: hashes['logo-png'],
    iconHashes: pipelineVersion === 6 || pipelineVersion === 7 ? iconHashes : null,
    faviconIcoHash: pipelineVersion === 6 || pipelineVersion === 7 ? faviconIcoHash : null,
    particleHash: hashes['particle-v1'],
    staticHash: hashes['effect-static-png']
  }
}

const json = async <Value>(response: Response): Promise<Value> => (await response.json()) as Value

type LogoIconsBody = {
  favicon16Url: string
  favicon32Url: string
  tile150Url: string
  apple180Url: string
  app192Url: string
  app512Url: string
  maskable512Url: string
  faviconIcoUrl: string
}

type ActiveBody = {
  revisionId: string
  logoUrl: string
  logoIcons: LogoIconsBody | null
  enhancement: { status: 'ready'; reason: null } | { status: 'unavailable'; reason: string }
}

interface StatusBody {
  active: ActiveBody | null
  candidate: { revisionId: string; status: 'pending' | 'running' | 'ready' | 'failed'; errorCode: string | null } | null
  statusUrl?: string
}

const activeBody = (revision: ReadyRevision): ActiveBody => ({
  revisionId: revision.revisionId,
  logoUrl: `/_site-logo/${revision.logoHash}/logo.png`,
  logoIcons:
    revision.iconHashes === null || revision.faviconIcoHash === null
      ? null
      : {
          favicon16Url: `/_site-logo/${revision.iconHashes.favicon16}/icon.png`,
          favicon32Url: `/_site-logo/${revision.iconHashes.favicon32}/icon.png`,
          tile150Url: `/_site-logo/${revision.iconHashes.tile150}/icon.png`,
          apple180Url: `/_site-logo/${revision.iconHashes.apple180}/icon.png`,
          app192Url: `/_site-logo/${revision.iconHashes.app192}/icon.png`,
          app512Url: `/_site-logo/${revision.iconHashes.app512}/icon.png`,
          maskable512Url: `/_site-logo/${revision.iconHashes.maskable512}/icon.png`,
          faviconIcoUrl: `/_site-logo/${revision.faviconIcoHash}/favicon.ico`
        },
  enhancement: { status: 'ready', reason: null }
})

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
    const body = await json<StatusBody>(response)
    expect(body).toMatchObject({ active: null, candidate: { status: 'pending', errorCode: null }, statusUrl: '/_api/site/logo' })
    expect(await db('siteLogoRevisions').where({ id: body.candidate!.revisionId }).first('pipelineVersion')).toEqual({ pipelineVersion: 7 })
    expect(await db('siteLogoObjects').where({ kind: 'source' }).first('byteLength')).toEqual({ byteLength: SITE_LOGO_SOURCE_LIMIT })
    expect(globalJsonParserCalls).toBe(0)
    expect(globalUrlencodedParserCalls).toBe(0)
    expect(await db('durableJobs')).toHaveLength(1)
  })

  it('returns 202 and reuses the same pending or running candidate while enqueuing only once', async () => {
    const first = await upload({ bytes: PNG_BYTES, name: 'same-name.png' })
    expect(first.status).toBe(202)
    const firstBody = await json<StatusBody>(first)
    expect(await db('siteLogoRevisions').where({ id: firstBody.candidate!.revisionId }).first('pipelineVersion')).toEqual({ pipelineVersion: 7 })

    const pending = await upload({ bytes: Buffer.from(PNG_BYTES), name: 'renamed.png' })
    expect(pending.status).toBe(202)
    expect((await json<StatusBody>(pending)).candidate?.revisionId).toBe(firstBody.candidate?.revisionId)

    await db('siteLogoRevisions').where({ id: firstBody.candidate!.revisionId }).update({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
    const running = await upload({ bytes: Buffer.from(PNG_BYTES), name: 'same-name.png' })
    expect(running.status).toBe(202)
    expect((await json<StatusBody>(running)).candidate).toMatchObject({ revisionId: firstBody.candidate!.revisionId, status: 'running' })

    const jobs = await db('durableJobs').select('type', 'version', 'payload')
    expect(jobs).toEqual([
      { type: 'process-site-logo', version: 5, payload: JSON.stringify({ revisionId: firstBody.candidate!.revisionId, retrySequence: 0 }) }
    ])
  })

  it('creates v7 work instead of reusing an intact active historical pipeline-v5 revision', async () => {
    const active = await seedReadyRevision(db, PNG_BYTES, '00000000-0000-4000-8000-000000000011', 5)
    await db('siteLogoState').where({ id: 1 }).update({ generation: 1, desiredRevisionId: active.revisionId, activeRevisionId: active.revisionId })

    const response = await upload({ bytes: Buffer.from(PNG_BYTES) })
    expect(response.status).toBe(202)
    const body = await json<StatusBody>(response)
    expect(body.active).toEqual(activeBody(active))
    expect(body.candidate).toMatchObject({ status: 'pending', errorCode: null })
    expect(body.candidate?.revisionId).not.toBe(active.revisionId)
    expect(body.statusUrl).toBe('/_api/site/logo')
    expect(await db('siteLogoRevisions').where({ id: body.candidate!.revisionId }).first('pipelineVersion', 'retrySequence')).toEqual({
      pipelineVersion: 7,
      retrySequence: 1
    })
    expect(await db('durableJobs')).toHaveLength(1)
  })
  it('activates an intact reusable ready pipeline-v7 revision with 200 and preserves every role URL', async () => {
    const active = await seedReadyRevision(db, ACTIVE_SOURCE, '00000000-0000-4000-8000-000000000021')
    const sourceHash = digest(PNG_BYTES)
    const reusable = await seedReadyRevision(db, PNG_BYTES, '00000000-0000-4000-8000-000000000022', 7, 2)
    expect(await db('siteLogoRevisions').where({ id: reusable.revisionId }).first('sourceHash')).toEqual({ sourceHash })
    await db('siteLogoState').where({ id: 1 }).update({ generation: 2, desiredRevisionId: reusable.revisionId, activeRevisionId: active.revisionId })

    const response = await upload({ bytes: PNG_BYTES })
    expect(response.status).toBe(200)
    const body = await json<StatusBody>(response)
    expect(body).toEqual({
      active: activeBody(reusable),
      candidate: null,
      statusUrl: '/_api/site/logo'
    })
    expect(body.active?.logoIcons).toEqual({
      favicon16Url: `/_site-logo/${reusable.iconHashes!.favicon16}/icon.png`,
      favicon32Url: `/_site-logo/${reusable.iconHashes!.favicon32}/icon.png`,
      tile150Url: `/_site-logo/${reusable.iconHashes!.tile150}/icon.png`,
      apple180Url: `/_site-logo/${reusable.iconHashes!.apple180}/icon.png`,
      app192Url: `/_site-logo/${reusable.iconHashes!.app192}/icon.png`,
      app512Url: `/_site-logo/${reusable.iconHashes!.app512}/icon.png`,
      maskable512Url: `/_site-logo/${reusable.iconHashes!.maskable512}/icon.png`,
      faviconIcoUrl: `/_site-logo/${reusable.faviconIcoHash!}/favicon.ico`
    })
    expect(await db('siteLogoRevisions').where({ id: reusable.revisionId }).first('pipelineVersion')).toEqual({ pipelineVersion: 7 })
    expect(await db('durableJobs')).toHaveLength(0)
    expect(global.WIKI.config.logoUrl).toBe(`/_site-logo/${reusable.logoHash}/logo.png`)
    expect(await db('settings').where({ key: 'logoUrl' }).first('value')).toEqual({ value: JSON.stringify({ v: `/_site-logo/${reusable.logoHash}/logo.png` }) })
  })

  it.each([1, 2, 3, 4, 5, 6] as const)(
    'does not reuse a ready historical pipeline-v%s revision and preserves the active bundle while creating pipeline v7 work',
    async pipelineVersion => {
      const active = await seedReadyRevision(db, ACTIVE_SOURCE, '00000000-0000-4000-8000-000000000023')
      const olderReady = await seedReadyRevision(db, PNG_BYTES, '00000000-0000-4000-8000-000000000024', pipelineVersion, 2)
      await db('siteLogoState').where({ id: 1 }).update({ generation: 2, desiredRevisionId: olderReady.revisionId, activeRevisionId: active.revisionId })

      const response = await upload({ bytes: PNG_BYTES })
      expect(response.status).toBe(202)
      const body = await json<StatusBody>(response)
      expect(body.active).toEqual(activeBody(active))
      expect(body.candidate).toMatchObject({ status: 'pending', errorCode: null })
      expect(body.candidate?.revisionId).not.toBe(olderReady.revisionId)
      expect(await db('siteLogoRevisions').where({ id: body.candidate!.revisionId }).first('pipelineVersion', 'retrySequence')).toEqual({
        pipelineVersion: 7,
        retrySequence: 3
      })
      expect((await db('siteLogoRevisions').where({ id: olderReady.revisionId }).first('retiredAt'))?.retiredAt).not.toBeNull()
      expect(await db('durableJobs')).toHaveLength(1)
    }
  )

  it.each([1, 2, 3, 4, 5, 6] as const)(
    'keeps an active historical pipeline-v%s bundle visible while identical-source pipeline v7 work is pending',
    async pipelineVersion => {
      const olderActive = await seedReadyRevision(db, PNG_BYTES, '00000000-0000-4000-8000-000000000025', pipelineVersion)
      await db('siteLogoState').where({ id: 1 }).update({
        generation: 1,
        desiredRevisionId: olderActive.revisionId,
        activeRevisionId: olderActive.revisionId
      })

      const response = await upload({ bytes: PNG_BYTES })
      expect(response.status).toBe(202)
      const body = await json<StatusBody>(response)
      expect(body.active).toEqual(activeBody(olderActive))
      expect(body.candidate).toMatchObject({ status: 'pending', errorCode: null })
      expect(body.candidate?.revisionId).not.toBe(olderActive.revisionId)
      expect(await db('siteLogoRevisions').where({ id: body.candidate!.revisionId }).first('pipelineVersion')).toEqual({ pipelineVersion: 7 })
    }
  )

  it.each([
    ['digest-mismatched', undefined, 'logo-png'],
    ['incomplete', 'particle-v1', undefined]
  ] as const)('retires a %s ready candidate and creates fresh fenced work without hiding the active preview', async (_label, omitKind, corruptKind) => {
    const active = await seedReadyRevision(db, ACTIVE_SOURCE, '00000000-0000-4000-8000-000000000031')
    const broken = await seedReadyRevision(db, PNG_BYTES, '00000000-0000-4000-8000-000000000032', 7, 4, omitKind, corruptKind)
    await db('siteLogoState').where({ id: 1 }).update({ generation: 2, desiredRevisionId: broken.revisionId, activeRevisionId: active.revisionId })

    const response = await upload({ bytes: PNG_BYTES })
    expect(response.status).toBe(202)
    const body = await json<StatusBody>(response)
    expect(body.active).toEqual(activeBody(active))
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
      active: activeBody(active),
      candidate: { revisionId: pending.revisionId, status: 'failed', errorCode: 'ARTIFACT_TOO_LARGE' }
    })

    const retried = await fetch(`${baseUrl}/_api/site/logo/retry`, { method: 'POST' })
    expect(retried.status).toBe(202)
    const retriedBody = await json<StatusBody>(retried)
    expect(retriedBody.active).toEqual(activeBody(active))
    expect(retriedBody.candidate).toMatchObject({ status: 'pending', errorCode: null })
    expect(retriedBody.candidate?.revisionId).not.toBe(pending.revisionId)
    expect(retriedBody.statusUrl).toBe('/_api/site/logo')
    const retriedRevision = await db('siteLogoRevisions')
      .where({ id: retriedBody.candidate!.revisionId })
      .first('pipelineVersion', 'retrySequence', 'requestedBy', 'jobId')
    expect(retriedRevision).toMatchObject({
      pipelineVersion: 7,
      retrySequence: 1,
      requestedBy: 7
    })
    expect(await db('durableJobs').where({ id: retriedRevision.jobId }).first('type', 'version')).toEqual({
      type: 'process-site-logo',
      version: 5
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

  it('delegates unrelated General saves while fenced without changing managed logo state', async () => {
    await db('siteLogoState').where({ id: 1 }).update({ desiredRevisionId: '00000000-0000-4000-8000-000000000061' })
    const response = await fetch(`${baseUrl}/_api/site/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Updated title' })
    })

    expect(response.status).toBe(200)
    expect(legacyGeneral).toHaveBeenCalledWith({ id: 7 }, { title: 'Updated title' })
    expect(global.WIKI.config.logoUrl).toBe('/legacy-logo.svg')
    expect(saveToDb).not.toHaveBeenCalled()
  })
})
