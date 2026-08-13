import _ from 'lodash'

interface ErrorLike { code?: unknown, message?: unknown, name?: unknown }
const graphHelper = {
  generateSuccess (message?: string | null) {
    return { succeeded: true, errorCode: 0, slug: 'ok', message: _.defaultTo(message, 'Operation succeeded.') }
  },
  generateError (errorValue: unknown, complete = true) {
    const source = errorValue as ErrorLike
    const error = { succeeded: false, errorCode: _.isFinite(source.code) ? source.code as number : 1, slug: source.name, message: source.message || 'An unexpected error occured.' }
    return complete ? { responseResult: error } : error
  }
}

export default graphHelper
