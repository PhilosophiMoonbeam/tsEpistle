const _ = require('lodash')
const fs = require('fs-extra')
const path = require('path')
const graphHelper = require('../../helpers/graph')

/* global WIKI */

module.exports = {
  Query: {
    async authentication () { return {} }
  },
  Mutation: {
    async authentication () { return {} }
  },
  AuthenticationQuery: {
    metricsState () {
      return WIKI.config.metrics.isEnabled
    },
    async strategies () {
      return WIKI.data.authentication.map(stg => ({
        ...stg,
        isAvailable: stg.isAvailable === true,
        props: _.sortBy(_.transform(stg.props, (res, value, key) => {
          res.push({
            key,
            value: JSON.stringify(value)
          })
        }, []), 'key')
      }))
    },
    /**
     * Fetch active authentication strategies
     */
    async activeStrategies (obj, args, context, info) {
      let strategies = await WIKI.models.authentication.getStrategies()
      strategies = strategies.map(stg => {
        const strategyInfo = _.find(WIKI.data.authentication, ['key', stg.strategyKey]) || {}
        return {
          ...stg,
          strategy: strategyInfo,
          config: _.sortBy(_.transform(stg.config, (res, value, key) => {
            const configData = _.get(strategyInfo.props, key, false)
            if (configData) {
              res.push({
                key,
                value: JSON.stringify({
                  ...configData,
                  value
                })
              })
            }
          }, []), 'key')
        }
      })
      return args.enabledOnly ? _.filter(strategies, 'isEnabled') : strategies
    }
  },
  AuthenticationMutation: {
    /**
     * Perform Login
     */
    async login (obj, args, context) {
      try {
        const authResult = await WIKI.models.users.login(args, context)
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
        const authResult = await WIKI.models.users.loginTFA(args, context)
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
        const authResult = await WIKI.models.users.loginChangePassword(args, context)
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
        await WIKI.models.users.loginForgotPassword(args, context)
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
        await WIKI.models.users.register({ ...args, verify: true }, context)
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
      const previousState = WIKI.config.metrics.isEnabled

      try {
        WIKI.config.metrics.isEnabled = args.enabled
        await WIKI.metrics.init()

        const configSaved = await WIKI.configSvc.saveToDb(['metrics'])
        if (!configSaved) {
          throw new Error('Failed to persist metrics state change')
        }

        return {
          responseResult: graphHelper.generateSuccess('Metrics state changed successfully')
        }
      } catch (err) {
        WIKI.config.metrics.isEnabled = previousState

        try {
          await WIKI.metrics.init()
        } catch (rollbackErr) {
          return graphHelper.generateError(new Error(`Failed to rollback metrics runtime state: ${rollbackErr.message}`))
        }

        return graphHelper.generateError(err)
      }
    },
    /**
     * Generate New Authentication Public / Private Key Certificates
     */
    async regenerateCertificates (obj, args, context) {
      try {
        await WIKI.auth.regenerateCertificates()
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
        await WIKI.auth.resetGuestUser()
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
