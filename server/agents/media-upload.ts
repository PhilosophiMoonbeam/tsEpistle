import type { Request, RequestHandler, Response } from 'express'
import { AgentRepositoryError } from './repository.ts'

/** Bounds memory-backed uploads before multipart parsing, including image decoding and persistence. */
export class AgentMediaUploadGate {
  #active = 0
  readonly #owners = new Map<number, number>()

  async run<T>(ownerId: number, operation: () => Promise<T>): Promise<T> {
    const ownerActive = this.#owners.get(ownerId) ?? 0
    if (this.#active >= 2 || ownerActive >= 1)
      throw new AgentRepositoryError('AGENT_MEDIA_UPLOAD_BUSY', 'Uploads are busy. Wait for an attachment to finish and try again.', 429)
    this.#active += 1
    this.#owners.set(ownerId, ownerActive + 1)
    try {
      return await operation()
    } finally {
      this.#active -= 1
      const remaining = (this.#owners.get(ownerId) ?? 1) - 1
      if (remaining === 0) this.#owners.delete(ownerId)
      else this.#owners.set(ownerId, remaining)
    }
  }
}

export const parseAgentMediaUpload = (parse: RequestHandler, req: Request, res: Response, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    let settled = false
    const complete = (error?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve()
    }
    const abort = (): void => {
      complete(new AgentRepositoryError('AGENT_MEDIA_UPLOAD_ABORTED', 'Attachment upload was cancelled.', 400))
      req.destroy()
    }
    const timeout = setTimeout(() => {
      complete(new AgentRepositoryError('AGENT_MEDIA_UPLOAD_TIMEOUT', 'Attachment upload timed out. Try again.', 408))
      req.destroy()
    }, 120_000)
    timeout.unref()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) return abort()
    try {
      parse(req, res, error =>
        complete(error ? new AgentRepositoryError('INVALID_AGENT_MEDIA', 'Choose one PDF up to 100 MB, or an image or recording up to 10 MB.', 400) : undefined)
      )
    } catch (error) {
      complete(error)
    }
  })
