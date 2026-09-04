import { createHash } from 'node:crypto'
import express from 'express'
import type { Knex } from 'knex'
import { readSiteLogoObject, type SiteLogoObjectKind } from '../helpers/site-logo-branding.ts'

interface PublicObjectRoute {
  readonly kind: SiteLogoObjectKind
  readonly contentType: string
}

const PUBLIC_OBJECT_ROUTES: Readonly<Record<string, PublicObjectRoute>> = {
  'logo.png': { kind: 'logo-png', contentType: 'image/png' },
  'particle.bin': { kind: 'particle-v1', contentType: 'application/octet-stream' },
  'effect.png': { kind: 'effect-static-png', contentType: 'image/png' }
}

const CANONICAL_OBJECT_PATH = /^\/_site-logo\/([0-9a-f]{64})\/(logo\.png|particle\.bin|effect\.png)$/
// Holds one maximum-sized generated public artifact set while bounding each router's retained memory.
const VERIFIED_OBJECT_CACHE_MAX_BYTES = 2 * 1024 * 1024
const VERIFIED_OBJECT_CACHE_MAX_ENTRIES = 64
const VERIFIED_OBJECT_MAX_PENDING_READS = 64

interface VerifiedPublicObject {
  readonly bytes: Buffer
  readonly byteLength: number
  readonly contentType: string
  readonly etag: string
}

const matchesIfNoneMatch = (value: string | undefined, etag: string): boolean => {
  if (!value) return false
  return value.split(',').some(candidate => {
    const tag = candidate.trim()
    return tag === '*' || tag === etag || tag === `W/${etag}`
  })
}

export default function createSiteLogoController(knex: Knex): express.Router {
  const router = express.Router()
  const verifiedObjects = new Map<string, VerifiedPublicObject>()
  const pendingReads = new Map<string, Promise<VerifiedPublicObject | null>>()
  let verifiedObjectBytes = 0

  const readVerifiedObject = (route: PublicObjectRoute, requestedHash: string): Promise<VerifiedPublicObject | null> => {
    const cacheKey = `${route.kind}:${requestedHash}`
    const cached = verifiedObjects.get(cacheKey)
    if (cached) {
      verifiedObjects.delete(cacheKey)
      verifiedObjects.set(cacheKey, cached)
      return Promise.resolve(cached)
    }

    const pending = pendingReads.get(cacheKey)
    if (pending) return pending

    const read = (async (): Promise<VerifiedPublicObject | null> => {
      const bytes = await readSiteLogoObject(knex, route.kind, requestedHash)
      if (!bytes || createHash('sha256').update(bytes).digest('hex') !== requestedHash) return null

      const object: VerifiedPublicObject = {
        bytes,
        byteLength: bytes.byteLength,
        contentType: route.contentType,
        etag: `"${requestedHash}"`
      }
      if (object.byteLength <= VERIFIED_OBJECT_CACHE_MAX_BYTES) {
        while (verifiedObjectBytes + object.byteLength > VERIFIED_OBJECT_CACHE_MAX_BYTES || verifiedObjects.size >= VERIFIED_OBJECT_CACHE_MAX_ENTRIES) {
          const oldestKey = verifiedObjects.keys().next().value
          if (oldestKey === undefined) break
          const oldest = verifiedObjects.get(oldestKey)!
          verifiedObjects.delete(oldestKey)
          verifiedObjectBytes -= oldest.byteLength
        }
        verifiedObjects.set(cacheKey, object)
        verifiedObjectBytes += object.byteLength
      }
      return object
    })()
    if (pendingReads.size < VERIFIED_OBJECT_MAX_PENDING_READS) {
      pendingReads.set(cacheKey, read)
      const clearPendingRead = (): void => {
        if (pendingReads.get(cacheKey) === read) pendingReads.delete(cacheKey)
      }
      void read.then(clearPendingRead, clearPendingRead)
    }
    return read
  }

  router.use('/_site-logo', async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.sendStatus(404)

    if (req.originalUrl.includes('?')) return res.sendStatus(404)
    const match = CANONICAL_OBJECT_PATH.exec(req.originalUrl)
    if (!match) return res.sendStatus(404)

    const requestedHash = match[1]!
    const route = PUBLIC_OBJECT_ROUTES[match[2]!]
    if (!route) return res.sendStatus(404)

    try {
      const object = await readVerifiedObject(route, requestedHash)
      if (!object) return res.sendStatus(404)
      res.set({
        'Cache-Control': 'public, max-age=2592000, immutable',
        'Content-Length': String(object.byteLength),
        'Content-Type': object.contentType,
        ETag: object.etag,
        'X-Content-Type-Options': 'nosniff'
      })
      if (matchesIfNoneMatch(req.get('if-none-match'), object.etag)) return res.status(304).end()
      if (req.method === 'HEAD') return res.status(200).end()
      return res.status(200).end(object.bytes)
    } catch (error) {
      next(error)
    }
  })

  return router
}
