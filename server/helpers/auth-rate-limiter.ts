import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { Knex } from 'knex'
import type {
  RateLimiterRes as RateLimiterResult,
  RateLimiterStoreAbstract as RateLimiterStore
} from 'rate-limiter-flexible'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const RateLimiterRes = require('rate-limiter-flexible/lib/RateLimiterRes.js') as typeof RateLimiterResult
const RateLimiterStoreAbstract = require('rate-limiter-flexible/lib/RateLimiterStoreAbstract.js') as typeof RateLimiterStore

interface RateLimitRow {
  key: string
  points: number | string
  expire: number | string | null
}

interface KnexRateLimiterOptions {
  knex: Knex
  tableName: string
  keyPrefix: string
  points: number
  duration: number
}

interface AuthRateLimiterOptions {
  knex: Knex
  keyPrefix: string
  onLimit: (req: Request, res: Response, retryAfterMs: number) => void
}

export interface AuthRateLimiter {
  middleware: RequestHandler
  reset(req: Request): Promise<void>
}

const tablePromises = new WeakMap<Knex, Map<string, Promise<void>>>()

const ensureTable = (knex: Knex, tableName: string): Promise<void> => {
  let knexTables = tablePromises.get(knex)
  if (knexTables === undefined) {
    knexTables = new Map()
    tablePromises.set(knex, knexTables)
  }

  let tablePromise = knexTables.get(tableName)
  if (tablePromise === undefined) {
    tablePromise = knex.schema.hasTable(tableName).then(async exists => {
      if (exists) return
      await knex.schema.createTable(tableName, table => {
        table.string('key', 255).primary()
        table.bigInteger('points').notNullable()
        table.bigInteger('expire').nullable()
      })
    })
    knexTables.set(tableName, tablePromise)
  }

  return tablePromise
}

class KnexRateLimiter extends RateLimiterStoreAbstract {
  readonly ready: Promise<void>
  readonly knex: Knex
  readonly tableName: string

  constructor(options: KnexRateLimiterOptions) {
    super({
      storeClient: options.knex,
      keyPrefix: options.keyPrefix,
      points: options.points,
      duration: options.duration
    })
    this.knex = options.knex
    this.tableName = options.tableName
    this.ready = ensureTable(options.knex, options.tableName)
  }

  _getRateLimiterRes(_key: string, changedPoints: number, row: RateLimitRow): RateLimiterResult {
    const consumedPoints = Number(row.points)
    const expire = row.expire === null ? null : Number(row.expire)
    return new RateLimiterRes(
      Math.max(this.points - consumedPoints, 0),
      expire === null ? -1 : Math.max(expire - Date.now(), 0),
      consumedPoints,
      consumedPoints === changedPoints
    )
  }

  async _upsert(key: string, points: number, msDuration: number, forceExpire = false): Promise<RateLimitRow> {
    await this.ready
    const now = Date.now()
    const newExpire = msDuration > 0 ? now + msDuration : null

    return this.knex.transaction(async transaction => {
      const current = await transaction<RateLimitRow>(this.tableName)
        .where('key', key)
        .forUpdate()
        .first()

      if (current === undefined) {
        const inserted: RateLimitRow = { key, points, expire: newExpire }
        await transaction<RateLimitRow>(this.tableName).insert(inserted)
        return inserted
      }

      const currentExpire = current.expire === null ? null : Number(current.expire)
      const startsNewDuration = forceExpire || (currentExpire !== null && currentExpire <= now)
      const nextPoints = startsNewDuration ? points : Number(current.points) + points
      const nextExpire = startsNewDuration ? newExpire : currentExpire
      await transaction<RateLimitRow>(this.tableName)
        .where('key', key)
        .update({ points: nextPoints, expire: nextExpire })

      return { key, points: nextPoints, expire: nextExpire }
    })
  }

  async _get(key: string): Promise<RateLimitRow | null> {
    await this.ready
    const row = await this.knex<RateLimitRow>(this.tableName)
      .where('key', key)
      .where(builder => builder.whereNull('expire').orWhere('expire', '>', Date.now()))
      .first()
    return row ?? null
  }

  async _delete(key: string): Promise<boolean> {
    await this.ready
    return await this.knex<RateLimitRow>(this.tableName).where('key', key).del() > 0
  }
}

const FREE_ATTEMPTS = 6
const ATTEMPT_LIFETIME_SECONDS = 12 * 60 * 60
const MAX_POINTS = 2_000_000_000
const WAIT_SECONDS = [5 * 60, 5 * 60, 10 * 60, 15 * 60, 25 * 60, 40 * 60, 60 * 60] as const

const requestKey = (req: Request): string => req.ip ?? req.socket.remoteAddress ?? 'unknown'

export const createAuthRateLimiter = (options: AuthRateLimiterOptions): AuthRateLimiter => {
  const attempts = new KnexRateLimiter({
    knex: options.knex,
    tableName: 'authRateLimitAttempts',
    keyPrefix: `${options.keyPrefix}:attempts`,
    points: MAX_POINTS,
    duration: ATTEMPT_LIFETIME_SECONDS
  })
  const blocks = new KnexRateLimiter({
    knex: options.knex,
    tableName: 'authRateLimitBlocks',
    keyPrefix: `${options.keyPrefix}:blocks`,
    points: MAX_POINTS,
    duration: WAIT_SECONDS.at(-1) ?? 60 * 60
  })

  const middleware = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const key = requestKey(req)
      const activeBlock = await blocks.get(key)
      if (activeBlock !== null && activeBlock.msBeforeNext > 0) {
        options.onLimit(req, res, activeBlock.msBeforeNext)
        return
      }

      const result = await attempts.consume(key)
      if (result.consumedPoints <= FREE_ATTEMPTS) {
        next()
        return
      }

      const progression = result.consumedPoints - FREE_ATTEMPTS - 1
      if (progression % 2 === 1) {
        next()
        return
      }

      const waitIndex = Math.min(Math.floor(progression / 2), WAIT_SECONDS.length - 1)
      const waitSeconds = WAIT_SECONDS[waitIndex] ?? WAIT_SECONDS[WAIT_SECONDS.length - 1]
      const block = await blocks.consume(key, 1, { customDuration: waitSeconds })
      options.onLimit(req, res, block.msBeforeNext)
    } catch (error) {
      next(error)
    }
  }

  return {
    middleware,
    async reset(req: Request): Promise<void> {
      const key = requestKey(req)
      await Promise.all([attempts.delete(key), blocks.delete(key)])
    }
  }
}
