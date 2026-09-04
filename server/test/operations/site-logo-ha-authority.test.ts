import { createHash } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import { DurableJobStore } from '../../core/durable-jobs.ts'
import { up as createDurableJobs } from '../../db/migrations/2.5.130.ts'
import { up as addDurableJobLeaseToken } from '../../db/migrations/2.5.158.ts'
import type { ActiveBranding, SiteLogoObjectKind } from '../../helpers/site-logo-branding.ts'
import { readSiteLogoObject, resolveActiveBranding } from '../../helpers/site-logo-branding.ts'
import type { SiteLogoArtifacts } from '../../helpers/site-logo-processing.ts'
import { encodeParticleV1 } from '../../helpers/site-logo-processing.ts'
import type { SiteLogoProcessor } from '../../jobs/site-logo-process.ts'
import { createSiteLogoProcessHandler } from '../../jobs/site-logo-process.ts'
import type { SiteLogoMutationResult, SiteLogoStatusResponse } from '../../operations/site-logo.ts'
import { getSiteLogoStatus, uploadSiteLogoCandidate } from '../../operations/site-logo.ts'
import { afterEach, describe, expect, it, vi } from '../bun-test.mts'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const sourceBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from('ha-source-owned-by-database')])
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

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

interface LogoNodeDependencies {
  readonly getStatus: typeof getSiteLogoStatus
  readonly upload: typeof uploadSiteLogoCandidate
  readonly resolveBranding: typeof resolveActiveBranding
  readonly readObject: typeof readSiteLogoObject
}

interface RevisionSnapshot {
  readonly id: string
  readonly sourceHash: string
  readonly pipelineVersion: number
  readonly status: string
  readonly retrySequence: number
  readonly logoPngHash: string
  readonly particleV1Hash: string
  readonly effectStaticPngHash: string
  readonly normalizedWidth: number
  readonly normalizedHeight: number
  readonly particleCount: number
  readonly medianStroke: number
  readonly auraColor: string | null
}

interface LogoNode {
  upload(bytes: Buffer, requestedBy: number): Promise<SiteLogoMutationResult>
  processNext(processor: SiteLogoProcessor): Promise<void>
  status(): Promise<SiteLogoStatusResponse>
  snapshot(): Promise<ActiveBranding>
  bytes(kind: SiteLogoObjectKind, hash: string): Promise<Buffer | null>
  revision(revisionId: string): Promise<RevisionSnapshot | undefined>
}

const defaultDependencies: LogoNodeDependencies = {
  getStatus: getSiteLogoStatus,
  upload: uploadSiteLogoCandidate,
  resolveBranding: resolveActiveBranding,
  readObject: readSiteLogoObject
}

const createLogoNode = (name: string, db: Knex, legacyLogoUrl: string, dependencies: LogoNodeDependencies = defaultDependencies): LogoNode => ({
  upload: async (bytes: Buffer, requestedBy: number) => await dependencies.upload(bytes, requestedBy, db),
  processNext: async (processor: SiteLogoProcessor): Promise<void> => {
    const store = new DurableJobStore(db)
    const jobs = await store.claim({ workerId: name, limit: 1, leaseMs: 60_000 })
    if (jobs.length !== 1) throw new Error(`${name} expected exactly one site logo job`)
    const job = jobs[0]!
    await createSiteLogoProcessHandler(2, processor)(job, { knex: db, signal: new AbortController().signal })
    if (!(await store.complete(job))) throw new Error(`${name} lost its site logo job before completion`)
  },
  status: async () => await dependencies.getStatus(db),
  snapshot: async () => await dependencies.resolveBranding(db, legacyLogoUrl),
  bytes: async (kind: SiteLogoObjectKind, hash: string) => await dependencies.readObject(db, kind, hash),
  revision: async (revisionId: string) =>
    await db('siteLogoRevisions')
      .where({ id: revisionId })
      .first(
        'id',
        'sourceHash',
        'pipelineVersion',
        'status',
        'retrySequence',
        'logoPngHash',
        'particleV1Hash',
        'effectStaticPngHash',
        'normalizedWidth',
        'normalizedHeight',
        'particleCount',
        'medianStroke',
        'auraColor'
      )
})

const readPublishedBundle = async (
  node: LogoNode,
  hashes: { logo: string; particle: string; effect: string }
): Promise<{ logo: Buffer; particle: Buffer; effect: Buffer }> => {
  const [logo, particle, effect] = await Promise.all([
    node.bytes('logo-png', hashes.logo),
    node.bytes('particle-v1', hashes.particle),
    node.bytes('effect-static-png', hashes.effect)
  ])
  if (!logo || !particle || !effect) throw new Error('Published site logo bundle was not readable')
  return { logo, particle, effect }
}

describe('site logo HA database authority', () => {
  let db: Knex | undefined

  afterEach(async () => {
    await db?.destroy()
  })

  it('publishes on another node and resolves identically after a cold reader restart without shared disk or refresh', async () => {
    db = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      pool: { min: 1, max: 1 },
      useNullAsDefault: true
    })
    await createLogoTables(db)

    const particleV1 = encodeParticleV1(160, 64, [
      {
        sourceIndex: 0,
        x: 20,
        y: 12,
        xEncoded: -12_000,
        yEncoded: 10_000,
        depth: -12,
        rgba: [18, 52, 86, 255],
        size: 7,
        seed: 1_337
      },
      {
        sourceIndex: 1,
        x: 132,
        y: 48,
        xEncoded: 21_000,
        yEncoded: -17_000,
        depth: 19,
        rgba: [170, 187, 204, 220],
        size: 11,
        seed: 9_001
      }
    ])
    const artifacts: SiteLogoArtifacts = {
      logoPng: Buffer.concat([PNG_SIGNATURE, Buffer.from('ordinary-logo')]),
      particleV1,
      effectStaticPng: Buffer.concat([PNG_SIGNATURE, Buffer.from('static-effect')]),
      normalizedWidth: 160,
      normalizedHeight: 64,
      particleCount: 2,
      medianStroke: 5.5,
      auraColor: '#345678'
    }
    const hashes = {
      logo: sha256(artifacts.logoPng),
      particle: sha256(artifacts.particleV1),
      effect: sha256(artifacts.effectStaticPng)
    }

    const nodeA = createLogoNode('logo-node-a', db, '/node-a-stale-logo.svg')
    const nodeB = createLogoNode('logo-node-b', db, '/node-b-stale-logo.svg')
    const upload = await nodeA.upload(sourceBytes, 42)
    const candidate = upload.status.candidate
    if (!candidate) throw new Error('Accepted site logo upload did not create a candidate revision')
    const revisionId = candidate.revisionId
    expect(revisionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(upload).toEqual({
      statusCode: 202,
      status: {
        active: null,
        candidate: { revisionId, status: 'pending', errorCode: null },
        statusUrl: '/_api/site/logo'
      }
    })

    await nodeB.processNext(async (bytes, sourceHash) => {
      if (!Buffer.from(bytes).equals(sourceBytes) || sourceHash !== sha256(sourceBytes)) {
        throw new Error('Node B did not receive Node A database-owned source')
      }
      return artifacts
    })

    const freshOperations = await vi.importFresh<{
      getSiteLogoStatus: LogoNodeDependencies['getStatus']
      uploadSiteLogoCandidate: LogoNodeDependencies['upload']
    }>('../../operations/site-logo.ts', import.meta.url)
    const freshBranding = await vi.importFresh<{
      resolveActiveBranding: LogoNodeDependencies['resolveBranding']
      readSiteLogoObject: LogoNodeDependencies['readObject']
    }>('../../helpers/site-logo-branding.ts', import.meta.url)
    const restartedNodeA = createLogoNode('logo-node-a-restarted', db, '/cold-node-unrefreshed-logo.svg', {
      getStatus: freshOperations.getSiteLogoStatus,
      upload: freshOperations.uploadSiteLogoCandidate,
      resolveBranding: freshBranding.resolveActiveBranding,
      readObject: freshBranding.readSiteLogoObject
    })

    const [statusA, statusB, snapshotA, snapshotB] = await Promise.all([restartedNodeA.status(), nodeB.status(), restartedNodeA.snapshot(), nodeB.snapshot()])
    expect(statusA).toEqual(statusB)
    expect(statusA).toEqual({
      active: { revisionId, logoUrl: `/_site-logo/${hashes.logo}/logo.png` },
      candidate: null
    })
    expect(snapshotA).toEqual(snapshotB)
    expect(snapshotA).toEqual({
      logoUrl: `/_site-logo/${hashes.logo}/logo.png`,
      logoEffect: {
        logoUrl: `/_site-logo/${hashes.logo}/logo.png`,
        particleUrl: `/_site-logo/${hashes.particle}/particle.bin`,
        staticUrl: `/_site-logo/${hashes.effect}/effect.png`,
        width: 160,
        height: 64,
        aspect: 2.5,
        count: 2,
        medianStroke: 5.5,
        auraColor: '#345678'
      }
    })

    const [revisionA, revisionB, bundleA, bundleB] = await Promise.all([
      restartedNodeA.revision(revisionId),
      nodeB.revision(revisionId),
      readPublishedBundle(restartedNodeA, hashes),
      readPublishedBundle(nodeB, hashes)
    ])
    expect(revisionA).toEqual(revisionB)
    expect(revisionA).toEqual({
      id: revisionId,
      sourceHash: sha256(sourceBytes),
      pipelineVersion: 4,
      status: 'ready',
      retrySequence: 0,
      logoPngHash: hashes.logo,
      particleV1Hash: hashes.particle,
      effectStaticPngHash: hashes.effect,
      normalizedWidth: 160,
      normalizedHeight: 64,
      particleCount: 2,
      medianStroke: 5.5,
      auraColor: '#345678'
    })
    expect(bundleA).toEqual(bundleB)
    expect({ logo: sha256(bundleA.logo), particle: sha256(bundleA.particle), effect: sha256(bundleA.effect) }).toEqual(hashes)

    const particleHeader = {
      width: bundleA.particle.readUInt32LE(8),
      height: bundleA.particle.readUInt32LE(12),
      count: bundleA.particle.readUInt32LE(16)
    }
    expect(particleHeader).toEqual({
      width: snapshotA.logoEffect!.width,
      height: snapshotA.logoEffect!.height,
      count: snapshotA.logoEffect!.count
    })
    expect(snapshotA.logoEffect!.aspect).toBe(particleHeader.width / particleHeader.height)
  })
})
