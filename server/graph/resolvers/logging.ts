import graphHelper from '../../helpers/graph.ts'
import loggingOperations from '../../operations/logging.ts'

interface LoggersArgs { orderBy?: string | null }
interface UpdateLoggersArgs { loggers: unknown }
interface LiveTrailEvent {
  loggingLiveTrail: {
    timestamp: Date
    level: unknown
    output: unknown
  }
}

interface GraphEmitter {
  asyncIterableIterator<T>(trigger: string | readonly string[]): AsyncIterable<T>
}

const optionalString = (value: string | null | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined

const isGraphEmitter = (value: unknown): value is GraphEmitter =>
  typeof value === 'object' && value !== null &&
  typeof Reflect.get(value, 'asyncIterableIterator') === 'function'

const graphEmitter = WIKI.GQLEmitter
if (!isGraphEmitter(graphEmitter)) {
  throw new TypeError('Logging subscriptions require the GraphQL event emitter')
}

export default {
  Query: {
    async logging () { return {} }
  },
  Mutation: {
    async logging () { return {} }
  },
  Subscription: {
    loggingLiveTrail: {
      subscribe: () => graphEmitter.asyncIterableIterator<LiveTrailEvent>('livetrail')
    }
  },
  LoggingQuery: {
    async loggers (_obj: unknown, args: LoggersArgs) {
      return loggingOperations.listLoggers(optionalString(args.orderBy))
    }
  },
  LoggingMutation: {
    async updateLoggers (_obj: unknown, args: UpdateLoggersArgs) {
      try {
        await loggingOperations.updateLoggers(args.loggers)
        return { responseResult: graphHelper.generateSuccess('Loggers updated successfully') }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    }
  }
}
