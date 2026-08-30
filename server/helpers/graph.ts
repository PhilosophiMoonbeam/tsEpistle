import _ from 'lodash'

interface ErrorLike {
  code?: unknown
  message?: unknown
  name?: unknown
  originalError?: unknown
  status?: unknown
}

interface ErrorRuntime {
  logger?: { error?: (value: unknown) => void }
}

export const isPublicGraphError = (value: unknown): value is Error => {
  if (!(value instanceof Error)) return false
  const source = value as Error & ErrorLike
  if (source.originalError instanceof Error && source.originalError !== value) {
    return isPublicGraphError(source.originalError)
  }
  if (source.status !== undefined) {
    return typeof source.status === 'number' && Number.isInteger(source.status) && source.status >= 400 && source.status < 500
  }
  return _.isFinite(source.code) && typeof source.name === 'string' && source.name !== 'Error'
}

const unexpectedError = {
  succeeded: false,
  errorCode: 1,
  slug: 'unexpected',
  message: 'An unexpected error occurred.'
}

const graphHelper = {
  generateSuccess(message?: string | null) {
    return { succeeded: true, errorCode: 0, slug: 'ok', message: _.defaultTo(message, 'Operation succeeded.') }
  },
  generateError(value: unknown, complete = true) {
    const source: ErrorLike = value instanceof Error ? value : {}
    const error = isPublicGraphError(value)
      ? {
          succeeded: false,
          errorCode: _.isFinite(source.code) ? (source.code as number) : 1,
          slug: typeof source.name === 'string' ? source.name : undefined,
          message: typeof source.message === 'string' && source.message ? source.message : 'Request failed.'
        }
      : unexpectedError
    if (error === unexpectedError) {
      const runtime = (globalThis as typeof globalThis & { WIKI?: unknown }).WIKI as ErrorRuntime | undefined
      runtime?.logger?.error?.(value)
    }
    return complete ? { responseResult: error } : error
  }
}

export default graphHelper
