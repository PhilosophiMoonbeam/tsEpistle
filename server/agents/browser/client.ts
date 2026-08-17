import { request as httpsRequest } from 'node:https'
import { z } from 'zod'
import type { BrowserWorkerAction, BrowserWorkerLimits, BrowserWorkerResult } from './runtime.ts'
import { BrowserWorkerError } from './errors.ts'
import { signBrowserEnvelope } from './protocol.ts'

const ResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('navigated'), observation: z.unknown() }),
  z.strictObject({ kind: z.literal('observed'), observation: z.unknown() }),
  z.strictObject({ kind: z.literal('acted'), observation: z.unknown() }),
  z.strictObject({ kind: z.literal('extracted'), url: z.string(), text: z.string(), links: z.array(z.strictObject({ text: z.string(), href: z.string() })), observedAt: z.string() }),
  z.strictObject({ kind: z.literal('screenshot'), bytes: z.string(), mimeType: z.literal('image/png'), width: z.number().int().positive(), height: z.number().int().positive() }),
  z.strictObject({ kind: z.literal('closed') })
])

export interface BrowserWorkerClientConfig {
  readonly url: string
  readonly keyId: string
  readonly signingSecret: Buffer
  readonly ca: Buffer
  readonly cert: Buffer
  readonly key: Buffer
  readonly timeoutMilliseconds?: number
}
export interface BrowserWorkerIdentity { readonly runId: string; readonly ownerId: number; readonly leaseToken: string; readonly contextId: string; readonly actionCallId: string; readonly sequence: number }

export class BrowserWorkerClient {
  readonly #config: BrowserWorkerClientConfig
  constructor(config: BrowserWorkerClientConfig) { this.#config = config }
  async execute(identity: BrowserWorkerIdentity, limits: BrowserWorkerLimits, action: BrowserWorkerAction, signal: AbortSignal): Promise<BrowserWorkerResult> {
    const mutableAction = action.kind === 'navigate' || action.kind === 'act' ? { ...action, attestedUrls: [...action.attestedUrls] } : action
    const payload = JSON.stringify(signBrowserEnvelope({ keyId: this.#config.keyId, ...identity, limits, action: mutableAction }, this.#config.signingSecret))
    const endpoint = new URL('/v1/actions', this.#config.url)
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpsRequest(endpoint, { method: 'POST', ca: this.#config.ca, cert: this.#config.cert, key: this.#config.key, rejectUnauthorized: true, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }, signal }, response => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength
          if (size > 4 * 1024 * 1024) req.destroy(new BrowserWorkerError('BROWSER_RESPONSE_TOO_LARGE', 'Browser worker response exceeds its size limit', 502))
          else chunks.push(chunk)
        })
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if ((response.statusCode ?? 500) >= 400) {
            let code = 'BROWSER_WORKER_REJECTED'; let message = 'Browser worker rejected the request'
            try { const error = JSON.parse(text) as { error?: unknown; message?: unknown }; if (typeof error.error === 'string') code = error.error; if (typeof error.message === 'string') message = error.message } catch { /* use bounded generic error */ }
            reject(new BrowserWorkerError(code, message, response.statusCode ?? 502))
          } else resolve(text)
        })
      })
      req.setTimeout(this.#config.timeoutMilliseconds ?? 20_000, () => req.destroy(new BrowserWorkerError('BROWSER_WORKER_TIMEOUT', 'Browser worker request timed out', 504)))
      req.on('error', reject)
      req.end(payload)
    })
    const parsed = ResultSchema.parse(JSON.parse(body))
    return parsed.kind === 'screenshot' ? { ...parsed, bytes: Buffer.from(parsed.bytes, 'base64') } : parsed as BrowserWorkerResult
  }
}
