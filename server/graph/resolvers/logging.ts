import graphHelper from '../../helpers/graph.ts'
import { redactLoggingLiveOutput, getLoggingWorkspaceStore } from '../../operations/logging.ts'
import type { LoggingLiveTrailDelivery, LoggingLiveTrailSource } from '../../operations/logging-live-trail.ts'
import errors from '../../operations/errors.ts'
import type { SystemRequester } from '../../helpers/system-authority.ts'
import type { GraphRuntime } from '../index.ts'

interface LoggersArgs {
  filter?: string | null
  orderBy?: string | null
}

interface LiveTrailEvent {
  loggingLiveTrail: {
    timestamp: Date | string
    level: unknown
    output: unknown
  }
}

interface ResolverContext {
  req: unknown
}

interface LiveTrailBroker {
  subscribe(): LoggingLiveTrailSource
}

const LIVE_REVALIDATION_MILLISECONDS = 15_000
const OVERFLOW_MESSAGE = 'The live trail ended because this subscriber could not keep up. Reconnect for a fresh view.'

const isLiveTrailBroker = (value: unknown): value is LiveTrailBroker =>
  typeof value === 'object' && value !== null && typeof Reflect.get(value, 'subscribe') === 'function'

const requester = (context: ResolverContext): SystemRequester => {
  const request = context.req as { user?: unknown; apiKeyAuth?: { apiKeyId?: unknown; groupId?: unknown; expiresAt?: unknown } }
  const key = request.apiKeyAuth
  return {
    user: request.user as SystemRequester['user'],
    ...(typeof key?.apiKeyId === 'number' && typeof key.groupId === 'number'
      ? { apiKey: { id: key.apiKeyId, groupId: key.groupId, expiresAt: typeof key.expiresAt === 'number' ? key.expiresAt : null } }
      : {})
  }
}

class AuthorizedLiveTrail implements AsyncIterableIterator<LiveTrailEvent> {
  readonly #source: LoggingLiveTrailSource
  readonly #context: ResolverContext
  #pending: Promise<IteratorResult<LoggingLiveTrailDelivery>> | null = null
  #timer: NodeJS.Timeout | undefined
  #closed = false

  constructor(source: LoggingLiveTrailSource, context: ResolverContext) {
    this.#source = source
    this.#context = context
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<LiveTrailEvent> {
    return this
  }

  async next(): Promise<IteratorResult<LiveTrailEvent>> {
    try {
      while (!this.#closed) {
        this.#pending ??= this.#source.next()
        const nextEvent = this.#pending.then(value => ({ type: 'event' as const, value }))
        const idle = new Promise<{ type: 'idle' }>(resolve => {
          this.#timer = setTimeout(() => resolve({ type: 'idle' }), LIVE_REVALIDATION_MILLISECONDS)
          this.#timer.unref()
        })
        let result: { type: 'event'; value: IteratorResult<LoggingLiveTrailDelivery> } | { type: 'idle' }
        try {
          result = await Promise.race([nextEvent, idle])
        } finally {
          clearTimeout(this.#timer)
          this.#timer = undefined
        }
        if (result.type === 'idle') {
          await getLoggingWorkspaceStore().authorizeLive(requester(this.#context))
          continue
        }
        this.#pending = null
        if (result.value.done) {
          await this.#close()
          return { value: undefined, done: true }
        }
        await getLoggingWorkspaceStore().authorizeLive(requester(this.#context))
        if (result.value.value.type === 'overflow') {
          await this.#close()
          return {
            value: {
              loggingLiveTrail: {
                timestamp: new Date(),
                level: 'warn',
                output: OVERFLOW_MESSAGE
              }
            },
            done: false
          }
        }
        const line = result.value.value.line
        return {
          value: {
            loggingLiveTrail: {
              timestamp: line.timestamp,
              level: line.level.length <= 32 ? line.level : 'info',
              output: redactLoggingLiveOutput(line.output)
            }
          },
          done: false
        }
      }
      return { value: undefined, done: true }
    } catch (error) {
      await this.#close()
      throw error
    }
  }

  async return(): Promise<IteratorResult<LiveTrailEvent>> {
    await this.#close()
    return { value: undefined, done: true }
  }

  async throw(error?: unknown): Promise<IteratorResult<LiveTrailEvent>> {
    await this.#close()
    throw error
  }

  async #close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    clearTimeout(this.#timer)
    this.#timer = undefined
    await this.#source.return?.()
  }
}

export default function createLoggingResolvers(runtime: GraphRuntime) {
  const broker = runtime.loggingLiveTrail
  if (!isLiveTrailBroker(broker)) throw new TypeError('Logging subscriptions require the live-trail broker')

  return {
    Query: {
      async logging() {
        return {}
      }
    },
    Mutation: {
      async logging() {
        return {}
      }
    },
    Subscription: {
      loggingLiveTrail: {
        async subscribe(_source: unknown, _args: unknown, context: ResolverContext) {
          await getLoggingWorkspaceStore().authorizeLive(requester(context))
          return new AuthorizedLiveTrail(broker.subscribe(), context)
        }
      }
    },
    LoggingQuery: {
      async loggers(_source: unknown, args: LoggersArgs, context: ResolverContext) {
        const workspace = await getLoggingWorkspaceStore().inspect(requester(context))
        const query = typeof args.filter === 'string' ? args.filter.trim().toLocaleLowerCase() : ''
        const loggers = workspace.destinations
          .filter(destination => !query || `${destination.key} ${destination.title} ${destination.description ?? ''}`.toLocaleLowerCase().includes(query))
          .map(destination => ({
            isEnabled: destination.isEnabled,
            key: destination.key,
            title: destination.title,
            description: destination.description,
            logo: destination.logo,
            website: destination.website,
            level: destination.level,
            config: destination.fields.map(field => ({
              key: field.key,
              value: JSON.stringify({
                type: field.type,
                title: field.title,
                hint: field.hint,
                sensitive: field.sensitive,
                value: field.sensitive ? (destination.secrets[field.key] ? '********' : '') : destination.config[field.key]
              })
            }))
          }))
        if (args.orderBy === 'key') loggers.sort((left, right) => left.key.localeCompare(right.key))
        else if (args.orderBy === 'title') loggers.sort((left, right) => left.title.localeCompare(right.title))
        return loggers
      }
    },
    LoggingMutation: {
      async updateLoggers() {
        return graphHelper.generateError(
          new errors.ApplicationError('Logging now uses reviewed workspace settings. Use /_api/logging/workspace.', { status: 410 })
        )
      }
    }
  }
}
