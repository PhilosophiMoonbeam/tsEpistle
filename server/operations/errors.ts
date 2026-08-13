interface ApplicationErrorOptions {
  code?: string
  status?: number
}

class ApplicationError extends Error {
  readonly status: number

  constructor (message: string, { code = 'APPLICATION_ERROR', status = 400 }: ApplicationErrorOptions = {}) {
    super(message)
    this.name = code
    this.status = status
  }
}

export default { ApplicationError }
