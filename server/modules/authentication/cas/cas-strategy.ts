import { createRequire } from 'node:module'
import { XMLParser } from 'fast-xml-parser'
import type { Request } from 'express'
import type { Strategy as PassportStrategyContract } from 'passport'

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

type CasStrategyOptions = {
  version: string
  ssoBaseURL: string
  serverBaseURL: string
  serviceURL: string
  passReqToCallback: true
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
    this.version = options.version
    this.ssoBaseURL = options.ssoBaseURL
    this.serverBaseURL = options.serverBaseURL
    this.serviceURL = options.serviceURL
    this.verify = verify
  }

  service (request: Request): string {
    const service = new URL(this.serviceURL || request.originalUrl, this.serverBaseURL)
    service.searchParams.delete('ticket')
    return service.toString()
  }

  override authenticate (request: CasRequest, options: AuthenticateOptions = {}): void {
    const relayState = firstValue(request.query.RelayState)
    if (typeof relayState === 'string' && relayState) {
      request.logout(error => {
        if (error) {
          this.error(error)
          return
        }
        const logout = this.casUrl('/logout')
        logout.searchParams.set('_eventId', 'next')
        logout.searchParams.set('RelayState', relayState)
        this.redirect(logout.toString())
      })
      return
    }

    const service = this.service(request)
    const ticket = firstValue(request.query.ticket)
    if (typeof ticket !== 'string' || !ticket) {
      const login = this.casUrl('/login')
      login.searchParams.set('service', service)
      for (const [key, value] of Object.entries(options.loginParams ?? {})) {
        if (value !== undefined && value !== null && value !== false) login.searchParams.set(key, String(value))
      }
      this.redirect(login.toString())
      return
    }

    void this.validate(ticket, service)
      .then(profile => this.verify(request, profile, (error, user, info) => {
        if (error) {
          this.error(error)
        } else if (!user) {
          this.fail(info, 401)
        } else {
          this.success(user, info)
        }
      }))
      .catch(error => this.error(error instanceof Error ? error : new Error(String(error))))
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

export { CasStrategy, type CasProfile, type CasRequest, type CasStrategyOptions, type VerifyDone }
