import { createRequire } from 'node:module'
import type { Request } from 'express'
import type { Strategy as PassportStrategyContract } from 'passport'
import { Client, Filter, type ClientOptions, type Entry, type SearchOptions } from 'ldapts'

const require = createRequire(import.meta.url)
const PassportStrategy = require('passport-strategy') as new () => PassportStrategyContract & {
  error(error: Error): void
  fail(challenge: unknown, status?: number): void
  success(user: unknown, info?: unknown): void
}

type LdapRequest = Request & {
  params: { strategy: string }
}

type LdapClient = Pick<Client, 'bind' | 'search' | 'unbind'>
type LdapClientFactory = (options: ClientOptions) => LdapClient
type VerifyDone = (error: Error | null, user?: Record<string, unknown> | false, info?: unknown) => void
type Verify = (request: LdapRequest, profile: Record<string, unknown>, done: VerifyDone) => Promise<void> | void

type LdapServerOptions = ClientOptions & {
  bindDn?: string
  bindCredentials?: string
  searchBase: string
  searchFilter: string
  searchScope?: SearchOptions['scope']
  groupSearchBase?: string
  groupSearchFilter?: string
  groupSearchScope?: SearchOptions['scope']
  groupDnProperty?: string
  groupSearchAttributes?: string[]
  binaryAttributes?: string[]
}

type LdapStrategyOptions = {
  server: LdapServerOptions
  usernameField: string
  passwordField: string
  passReqToCallback: true
  clientFactory?: LdapClientFactory
}

type AuthenticateOptions = {
  accountDisabled?: string
  accountExpired?: string
  accountLockedOut?: string
  badRequestMessage?: string
  constraintViolation?: string
  invalidCredentials?: string
  invalidLogonHours?: string
  invalidWorkstation?: string
  noSuchObject?: string
  passwordExpired?: string
  passwordMustChange?: string
  userNotFound?: string
}

const valueAt = (value: unknown, field: string): unknown => {
  let current = value
  for (const key of field.replaceAll(']', '').split('[')) {
    if (typeof current !== 'object' || current === null || !(key in current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

const stringAt = (entry: Entry, field: string): string => {
  const value = entry[field]
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' ? first : ''
}

const safeUnbind = async (client: LdapClient): Promise<void> => {
  try {
    await client.unbind()
  } catch {
    // The connection may already be closed after an LDAP operation failure.
  }
}

class LdapStrategy extends PassportStrategy {
  override readonly name = 'ldapauth'
  readonly options: LdapStrategyOptions
  readonly verify: Verify
  readonly createClient: LdapClientFactory

  constructor (options: LdapStrategyOptions, verify: Verify) {
    super()
    if (!verify) throw new TypeError('LDAP authentication strategy requires a verify callback.')
    if (!options.server.searchFilter.includes('{{username}}')) {
      throw new TypeError('LDAP search filter must contain {{username}}.')
    }
    this.options = options
    this.verify = verify
    this.createClient = options.clientFactory ?? (clientOptions => new Client(clientOptions))
  }

  override authenticate (request: LdapRequest, options: AuthenticateOptions = {}): void {
    const usernameValue = valueAt(request.body, this.options.usernameField) ?? valueAt(request.query, this.options.usernameField)
    const passwordValue = valueAt(request.body, this.options.passwordField) ?? valueAt(request.query, this.options.passwordField)
    if (typeof usernameValue !== 'string' || !usernameValue || typeof passwordValue !== 'string' || !passwordValue) {
      this.fail({ message: options.badRequestMessage ?? 'Missing credentials' }, 400)
      return
    }

    void this.authenticateCredentials(usernameValue, passwordValue)
      .then(profile => this.verify(request, profile, (error, user, info) => {
        if (error) {
          this.error(error)
        } else if (!user) {
          this.fail(info)
        } else {
          this.success(user, info)
        }
      }))
      .catch((error: unknown) => this.handleAuthenticationError(error, options))
  }

  private async authenticateCredentials (username: string, password: string): Promise<Record<string, unknown>> {
    const { server } = this.options
    const clientOptions: ClientOptions = {
      url: server.url,
      ...(server.timeout !== undefined && { timeout: server.timeout }),
      ...(server.connectTimeout !== undefined && { connectTimeout: server.connectTimeout }),
      ...(server.tlsOptions !== undefined && { tlsOptions: server.tlsOptions }),
      ...(server.strictDN !== undefined && { strictDN: server.strictDN })
    }
    const adminClient = this.createClient(clientOptions)
    try {
      if (server.bindDn !== undefined && server.bindDn !== null) {
        await adminClient.bind(server.bindDn, server.bindCredentials ?? '')
      }
      const userSearch = await adminClient.search(server.searchBase, {
        scope: server.searchScope ?? 'sub',
        filter: server.searchFilter.replaceAll('{{username}}', Filter.escape(username)),
        ...(server.binaryAttributes !== undefined && { explicitBufferAttributes: server.binaryAttributes })
      })
      if (userSearch.searchEntries.length === 0) throw new LdapUserNotFoundError()
      if (userSearch.searchEntries.length !== 1) {
        throw new Error(`LDAP user search returned ${userSearch.searchEntries.length} entries.`)
      }

      const [entry] = userSearch.searchEntries
      if (!entry) throw new LdapUserNotFoundError()
      const userClient = this.createClient(clientOptions)
      try {
        await userClient.bind(entry.dn, password)
      } finally {
        await safeUnbind(userClient)
      }

      const profile: Record<string, unknown> = { ...entry }
      if (server.binaryAttributes?.length) {
        profile._raw = Object.fromEntries(server.binaryAttributes.flatMap(attribute => {
          const value = entry[attribute]
          return Buffer.isBuffer(value) || (Array.isArray(value) && value.every(Buffer.isBuffer))
            ? [[attribute, value]]
            : []
        }))
      }

      if (server.groupSearchBase && server.groupSearchFilter) {
        const dnProperty = server.groupDnProperty ?? 'dn'
        const groupFilter = server.groupSearchFilter
          .replaceAll('{{dn}}', Filter.escape(stringAt(entry, dnProperty)))
          .replaceAll('{{username}}', Filter.escape(stringAt(entry, 'uid')))
        const groupSearch = await adminClient.search(server.groupSearchBase, {
          scope: server.groupSearchScope ?? 'sub',
          filter: groupFilter,
          ...(server.groupSearchAttributes !== undefined && { attributes: server.groupSearchAttributes })
        })
        profile._groups = groupSearch.searchEntries
      }

      return profile
    } finally {
      await safeUnbind(adminClient)
    }
  }

  private handleAuthenticationError (error: unknown, options: AuthenticateOptions): void {
    const normalized = error instanceof Error ? error : new Error(String(error))
    if (normalized instanceof LdapUserNotFoundError) {
      this.fail({ message: options.userNotFound ?? 'Invalid username/password' }, 401)
      return
    }
    if (normalized.name === 'NoSuchObjectError') {
      this.fail({ message: options.noSuchObject ?? 'Bad search base' }, 401)
      return
    }
    if (normalized.name === 'ConstraintViolationError') {
      this.fail({ message: options.constraintViolation ?? 'Exceeded password retry limit, account locked' }, 401)
      return
    }
    if (normalized.name === 'InvalidCredentialsError') {
      const messages: Record<string, string> = {
        '530': options.invalidLogonHours ?? 'Not Permitted to login at this time',
        '531': options.invalidWorkstation ?? 'Not permitted to log on at this workstation',
        '532': options.passwordExpired ?? 'Password expired',
        '533': options.accountDisabled ?? 'Account disabled',
        '534': options.accountDisabled ?? 'Account disabled',
        '701': options.accountExpired ?? 'Account expired',
        '773': options.passwordMustChange ?? 'User must reset password',
        '775': options.accountLockedOut ?? 'User account locked'
      }
      const code = normalized.message.match(/data ([0-9a-f]+), v[0-9a-f]+/i)?.[1]
      this.fail({ message: code && messages[code] ? messages[code] : options.invalidCredentials ?? 'Invalid username/password' }, 401)
      return
    }
    this.error(normalized)
  }
}

class LdapUserNotFoundError extends Error {
  override readonly name = 'LdapUserNotFoundError'
}

export {
  LdapStrategy,
  type LdapClient,
  type LdapClientFactory,
  type LdapRequest,
  type LdapServerOptions,
  type LdapStrategyOptions,
  type VerifyDone
}
