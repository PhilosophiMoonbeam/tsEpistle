const fs = require('fs-extra')
const path = require('path')
const graphHelper = require('../../helpers/graph')
const authenticationOperations = require('../../operations/authentication')

/* global WIKI */

module.exports = {
  Query: {
    async authentication () { return {} }
  },
  Mutation: {
    async authentication () { return {} }
  },
  AuthenticationQuery: {
    metricsState: authenticationOperations.getMetricsState,
    async strategies () {
      return authenticationOperations.listDefinitions()
    },
    /**
     * Fetch active authentication strategies
     */
    async activeStrategies (obj, args, context, info) {
      return authenticationOperations.listActive(args.enabledOnly)
    }
  },
  AuthenticationMutation: {
    /**
     * Perform Login
     */
    async login (obj, args, context) {
      try {
        const authResult = await authenticationOperations.login(args, context)
        return {
          ...authResult,
          responseResult: graphHelper.generateSuccess('Login success')
        }
      } catch (err) {
        // LDAP Debug Flag
        if (args.strategy === 'ldap' && WIKI.config.flags.ldapdebug) {
          WIKI.logger.warn('LDAP LOGIN ERROR (c1): ', err)
        }

        return graphHelper.generateError(err)
      }
    },
    /**
     * Perform 2FA Login
     */
    async loginTFA (obj, args, context) {
      try {
        const authResult = await authenticationOperations.loginTfa(args, context)
        return {
          ...authResult,
          responseResult: graphHelper.generateSuccess('TFA success')
        }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    /**
     * Perform Mandatory Password Change after Login
     */
    async loginChangePassword (obj, args, context) {
      try {
        const authResult = await authenticationOperations.loginChangePassword(args, context)
        return {
          ...authResult,
          responseResult: graphHelper.generateSuccess('Password changed successfully')
        }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    /**
     * Perform Mandatory Password Change after Login
     */
    async forgotPassword (obj, args, context) {
      try {
        await authenticationOperations.forgotPassword(args, context)
        return {
          responseResult: graphHelper.generateSuccess('Password reset request processed.')
        }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    /**
     * Register a new account
     */
    async register (obj, args, context) {
      try {
        await authenticationOperations.register(args, context)
        return {
          responseResult: graphHelper.generateSuccess('Registration success')
        }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    /**
     * Set Metrics state
     */
    async setMetricsState (obj, args, context) {
      try {
        await authenticationOperations.setMetricsState(args.enabled)
        return {
          responseResult: graphHelper.generateSuccess('Metrics state changed successfully')
        }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    /**
     * Generate New Authentication Public / Private Key Certificates
     */
    async regenerateCertificates (obj, args, context) {
      try {
        await authenticationOperations.regenerateCertificates()
        return {
          responseResult: graphHelper.generateSuccess('Certificates have been regenerated successfully.')
        }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    /**
     * Reset Guest User
     */
    async resetGuestUser (obj, args, context) {
      try {
        await authenticationOperations.resetGuestUser()
        return {
          responseResult: graphHelper.generateSuccess('Guest user has been reset successfully.')
        }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    }
  },
  AuthenticationStrategy: {
    icon (ap, args) {
      return fs.readFile(path.join(WIKI.ROOTPATH, `assets/svg/auth-icon-${ap.key}.svg`), 'utf8').catch(err => {
        if (err.code === 'ENOENT') {
          return null
        }
        throw err
      })
    }
  }
}
