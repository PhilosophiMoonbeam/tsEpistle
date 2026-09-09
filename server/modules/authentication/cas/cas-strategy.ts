import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { XMLParser } from 'fast-xml-parser'
import type { Request } from 'express'
import type { Strategy as PassportStrategyContract } from 'passport'

import { persistFederatedLoginSession } from '../../../helpers/federated-login.ts'
import type { FederatedLoginConsumed, FederatedLoginIssueInput } from '../../../repositories/federated-login.ts'

const require = createRequire(import.meta.url)
const PassportStrategy = require('passport-strategy') as new () => PassportStrategyContract & {
  error(error: Error): void
  fail(challenge: unknown, status?: number): void
  redirect(url: string, status?: number): void
  success(user: unknown, info?: unknown): void
}

const maximumResponseBytes = 1024 * 1024

type CasProfile = string | {
  user: string
  attributes: Record<string, unknown>
}

type CasRequest = Request & {
  params: { strategy: string }
}

type VerifyDone = (error: Error | null, user?: Record<string, unknown> | false, info?: unknown) => void
type Verify = (request: CasRequest, profile: CasProfile, done: VerifyDone) => Promise<void> | void

type CasFederatedStore = {
  issue(input: FederatedLoginIssueInput): Promise<{ attemptId: string; state: string; issuedAt: Date; expiresAt: Date }>
  consume(input: {
    providerKey: string
    protocol: 'cas'
    providerRevision: string
    requestId?: string
    sessionId?: string
  }): Promise<FederatedLoginConsumed | null>
}

type CasFederationOptions = {
  providerKey: string
  providerRevision: string
  store: CasFederatedStore
}

type CasStrategyOptions = {
  version: string
  ssoBaseURL: string
  serverBaseURL: string
  serviceURL: string
  passReqToCallback: true
  federation: CasFederationOptions
}

type AuthenticateOptions = {
  loginParams?: Record<string, unknown>
}

const objectValue = (value: unknown): Record<string, unknown> | undefined => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
)

const firstValue = (value: unknown): unknown => Array.isArray(value) ? value[0] : value

const textValue = (value: unknown): string => {
  const first = firstValue(value)
  if (typeof first === 'string' || typeof first === 'number' || typeof first === 'boolean') return String(first)
  const object = objectValue(first)
  return object && '#text' in object ? textValue(object['#text']) : ''
}

const normalizeAttributes = (value: unknown): Record<string, unknown> => {
  const attributes = objectValue(firstValue(value))
  if (!attributes) return {}
  return Object.fromEntries(Object.entries(attributes).map(([key, entry]) => {
    const first = firstValue(entry)
    const text = textValue(first)
    return [key.toLowerCase(), text || first]
  }))
}

class CasStrategy extends PassportStrategy {
  override readonly name = 'cas'
  readonly version: string
  readonly ssoBaseURL: string
  readonly serverBaseURL: string
  readonly serviceURL: string
  readonly federation: CasFederationOptions
  readonly verify: Verify
  readonly parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    trimValues: true,
    parseTagValue: false,
    processEntities: false,
    parseAttributeValue: false
  })

  constructor (options: CasStrategyOptions, verify: Verify) {
    super()
    if (!verify) throw new TypeError('CAS authentication strategy requires a verify callback.')
    if (!['CAS1.0', 'CAS3.0'].includes(options.version)) {
      throw new TypeError(`Unsupported CAS version ${options.version}.`)
    }
    const casUrl = new URL(options.ssoBaseURL)
    if (casUrl.protocol !== 'https:' && casUrl.protocol !== 'http:') {
      throw new TypeError('CAS server URL must use HTTP or HTTPS.')
    }
    if (!options.federation || !options.federation.providerKey || !options.federation.providerRevision) {
      throw new TypeError('CAS authentication requires durable federation correlation.')
    }
    this.version = options.version
    this.ssoBaseURL = options.ssoBaseURL
    this.serverBaseURL = options.serverBaseURL
    this.serviceURL = options.serviceURL
    this.verify = verify
    this.federation = options.federation
  }

  service (request: Request, requestId?: string): string {
    const service = new URL(this.serviceURL || request.originalUrl, this.serverBaseURL)
    service.searchParams.delete('ticket')
    service.searchParams.delete('state')
    const callbackRequestId = firstValue(request.query?.state)
    const nonce = requestId ?? (typeof callbackRequestId === 'string' && callbackRequestId ? callbackRequestId : undefined)
    if (nonce) service.searchParams.set('state', nonce)
    return service.toString()
  }

  override authenticate (request: CasRequest, options: AuthenticateOptions = {}): void {
    void this.authenticateRequest(request, options).catch(error => {
      this.error(error instanceof Error ? error : new Error(String(error)))
    })
  }

  private async authenticateRequest (request: CasRequest, options: AuthenticateOptions): Promise<void> {
    const ticket = firstValue(request.query.ticket)
    if (typeof ticket !== 'string' || !ticket) {
      const requestId = randomBytes(32).toString('base64url')
      const service = this.service(request, requestId)
      await this.issue(request, service, requestId)
      const login = this.casUrl('/login')
      login.searchParams.set('service', service)
      for (const [key, value] of Object.entries(options.loginParams ?? {})) {
        if (value !== undefined && value !== null && value !== false) login.searchParams.set(key, String(value))
      }
      this.redirect(login.toString())
      return
    }

    const requestId = firstValue(request.query.state)
    if (typeof requestId !== 'string' || !requestId) {
      this.fail(null, 403)
      return
    }
    const service = this.service(request, requestId)
    const consumed = await this.consume(request, requestId)
    if (!consumed || !this.matchesService(consumed, requestId, service)) {
      this.fail(null, 403)
      return
    }

    const profile = await this.validate(ticket, service)
    await this.verify(request, profile, (error, user, info) => {
      if (error) {
        this.error(error)
      } else if (!user) {
        this.fail(info, 401)
      } else {
        this.success(user, info)
      }
    })
  }

  private async issue (request: CasRequest, serviceUrl: string, requestId: string): Promise<void> {
    const sessionId = await persistFederatedLoginSession(request)
    await this.federation.store.issue({
      sessionId,
      providerKey: this.federation.providerKey,
      protocol: 'cas',
      providerRevision: this.federation.providerRevision,
      payload: { serviceUrl, requestId }
    })
  }

  private async consume (request: CasRequest, requestId: string): Promise<FederatedLoginConsumed | null> {
    return await this.federation.store.consume({
      providerKey: this.federation.providerKey,
      protocol: 'cas',
      providerRevision: this.federation.providerRevision,
      requestId,
      ...(typeof request.sessionID === 'string' && request.sessionID ? { sessionId: request.sessionID } : {})
    })
  }

  private matchesService (consumed: FederatedLoginConsumed, requestId: string, serviceUrl: string): boolean {
    const payload = consumed.payload
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false
    return 'serviceUrl' in payload &&
      payload.serviceUrl === serviceUrl &&
      'requestId' in payload &&
      payload.requestId === requestId
  }

  private casUrl (path: string): URL {
    const url = new URL(this.ssoBaseURL)
    url.pathname = `${url.pathname.replace(/\/$/, '')}${path}`
    url.search = ''
    url.hash = ''
    return url
  }

  private async validate (ticket: string, service: string): Promise<CasProfile> {
    const endpoint = this.casUrl(this.version === 'CAS1.0' ? '/validate' : '/p3/serviceValidate')
    endpoint.searchParams.set('ticket', ticket)
    endpoint.searchParams.set('service', service)

    const response = await fetch(endpoint, {
      headers: { accept: this.version === 'CAS1.0' ? 'text/plain' : 'application/xml, text/xml' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    })
    if (!response.ok) throw new Error(`CAS ticket validation failed with HTTP ${response.status}.`)
    const contentLength = Number(response.headers.get('content-length') ?? 0)
    if (contentLength > maximumResponseBytes) throw new Error('CAS ticket validation response is too large.')
    const body = await this.readResponse(response)

    return this.version === 'CAS1.0' ? this.parseCas1(body) : this.parseCas3(body)
  }

  private async readResponse (response: Response): Promise<string> {
    if (!response.body) return ''
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const chunks: string[] = []
    let bytesRead = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytesRead += value.byteLength
      if (bytesRead > maximumResponseBytes) {
        await reader.cancel()
        throw new Error('CAS ticket validation response is too large.')
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  }

  private parseCas1 (body: string): string {
    const [status, user] = body.trim().split(/\r?\n/, 2)
    if (status !== 'yes' || !user) throw new Error('CAS authentication failed.')
    return user
  }

  private parseCas3 (body: string): CasProfile {
    const parsed = objectValue(this.parser.parse(body))
    const serviceResponse = objectValue(parsed?.serviceResponse)
    const failure = objectValue(firstValue(serviceResponse?.authenticationFailure))
    if (failure) {
      const code = textValue(failure['@_code'])
      throw new Error(`CAS authentication failed${code ? ` (${code})` : ''}.`)
    }

    const success = objectValue(firstValue(serviceResponse?.authenticationSuccess))
    const user = textValue(success?.user)
    if (!success || !user) throw new Error('CAS ticket validation returned an invalid response.')
    return {
      user,
      attributes: normalizeAttributes(success.attributes)
    }
  }
}

export { CasStrategy, type CasFederationOptions, type CasProfile, type CasRequest, type CasStrategyOptions, type VerifyDone }
