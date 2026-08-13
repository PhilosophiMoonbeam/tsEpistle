class ApplicationError extends Error {
  constructor (message, { code = 'APPLICATION_ERROR', status = 400 } = {}) {
    super(message)
    this.name = code
    this.status = status
  }
}

module.exports = {
  ApplicationError
}
