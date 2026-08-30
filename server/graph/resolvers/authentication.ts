import type { Request } from 'express'

import path from 'node:path'

import fs from 'fs-extra'

import graphHelper from '../../helpers/graph.ts'
import authenticationOperations from '../../operations/authentication.ts'
import type { GraphRuntime } from '../index.ts'

type ResolverArgs = Record<string, unknown>
interface ActiveStrategiesArgs {
  enabledOnly?: boolean | null
}
interface MetricsStateArgs {
  enabled: boolean
}
interface ResolverContext {
  req: Request
}
interface AuthenticationConfig {
  flags: { ldapdebug: boolean }
}
type AuthenticationResult = Record<string, unknown>
interface WikiLogger {
  warn(message: string, error: unknown): void
}

const optionalBoolean = (value: boolean | null | undefined): boolean | undefined => (typeof value === 'boolean' ? value : undefined)

const isAuthenticationConfig = (value: unknown): value is AuthenticationConfig => {
  if (typeof value !== 'object' || value === null) return false
  const flags = Reflect.get(value, 'flags')
  return typeof flags === 'object' && flags !== null && typeof Reflect.get(flags, 'ldapdebug') === 'boolean'
}

const isAuthenticationResult = (value: unknown): value is AuthenticationResult => typeof value === 'object' && value !== null && !Array.isArray(value)

const isWikiLogger = (value: unknown): value is WikiLogger => typeof value === 'object' && value !== null && typeof Reflect.get(value, 'warn') === 'function'

const normalizeResult = (result: unknown): AuthenticationResult => {
  if (!isAuthenticationResult(result)) {
    throw new TypeError('Authentication operation must return an object')
  }
  return result
}

export default function createAuthenticationResolvers(runtime: GraphRuntime) {
  const rootPath = runtime.ROOTPATH
  const config = runtime.config
  const logger = runtime.logger
  if (typeof rootPath !== 'string' || !isAuthenticationConfig(config) || !isWikiLogger(logger)) {
    throw new TypeError('Authentication resolvers require the root path, config, and logger')
  }
  const ldapDebug = config.flags.ldapdebug

  return {
    Query: {
      async authentication() {
        return {}
      }
    },
    Mutation: {
      async authentication() {
        return {}
      }
    },
    AuthenticationQuery: {
      metricsState: authenticationOperations.getMetricsState,
      async strategies() {
        return authenticationOperations.listDefinitions()
      },
      async activeStrategies(_obj: unknown, args: ActiveStrategiesArgs) {
        return authenticationOperations.listActive(optionalBoolean(args.enabledOnly))
      }
    },
    AuthenticationMutation: {
      async login(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
        try {
          const authResult = normalizeResult(await authenticationOperations.login(args, context))
          return { ...authResult, responseResult: graphHelper.generateSuccess('Login success') }
        } catch (err: unknown) {
          if (args.strategy === 'ldap' && ldapDebug) {
            logger.warn('LDAP LOGIN ERROR (c1): ', err)
          }
          return graphHelper.generateError(err)
        }
      },
      async loginTFA(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
        try {
          const authResult = normalizeResult(await authenticationOperations.loginTfa(args, context))
          return { ...authResult, responseResult: graphHelper.generateSuccess('TFA success') }
        } catch (err: unknown) {
          return graphHelper.generateError(err)
        }
      },
      async loginChangePassword(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
        try {
          const authResult = normalizeResult(await authenticationOperations.loginChangePassword(args, context))
          return { ...authResult, responseResult: graphHelper.generateSuccess('Password changed successfully') }
        } catch (err: unknown) {
          return graphHelper.generateError(err)
        }
      },
      async forgotPassword(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
        try {
          await authenticationOperations.forgotPassword(args, context)
          return { responseResult: graphHelper.generateSuccess('Password reset request processed.') }
        } catch (err: unknown) {
          return graphHelper.generateError(err)
        }
      },
      async register(_obj: unknown, args: ResolverArgs, context: ResolverContext) {
        try {
          await authenticationOperations.register(args, context)
          return { responseResult: graphHelper.generateSuccess('Registration success') }
        } catch (err: unknown) {
          return graphHelper.generateError(err)
        }
      },
      async setMetricsState(_obj: unknown, args: MetricsStateArgs) {
        try {
          await authenticationOperations.setMetricsState(args.enabled)
          return { responseResult: graphHelper.generateSuccess('Metrics state changed successfully') }
        } catch (err: unknown) {
          return graphHelper.generateError(err)
        }
      },
      async regenerateCertificates() {
        try {
          await authenticationOperations.regenerateCertificates()
          return { responseResult: graphHelper.generateSuccess('Certificates have been regenerated successfully.') }
        } catch (err: unknown) {
          return graphHelper.generateError(err)
        }
      },
      async resetGuestUser() {
        try {
          await authenticationOperations.resetGuestUser()
          return { responseResult: graphHelper.generateSuccess('Guest user has been reset successfully.') }
        } catch (err: unknown) {
          return graphHelper.generateError(err)
        }
      }
    },
    AuthenticationStrategy: {
      icon(strategy: { key: string }) {
        return fs.readFile(path.join(rootPath, `assets/svg/auth-icon-${strategy.key}.svg`), 'utf8').catch((err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') {
            return null
          }
          throw err
        })
      }
    }
  }
}
