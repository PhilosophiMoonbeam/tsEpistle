import { asError, wiki, type AuthenticationConfig, type AuthenticationPlugin } from '../../types.ts'

// ------------------------------------
// Google ID Account
// ------------------------------------

import passportGoogleOauth20Module from 'passport-google-oauth20'
const GoogleStrategy = passportGoogleOauth20Module.Strategy
import _ from 'lodash'
type LogoutAuthenticationPlugin = AuthenticationPlugin & {
  logout(conf: AuthenticationConfig): string
}

const plugin: LogoutAuthenticationPlugin = {
  init (passport, conf) {
    const strategy = new GoogleStrategy({
      clientID: conf.clientId,
      clientSecret: conf.clientSecret,
      callbackURL: conf.callbackURL,
      passReqToCallback: true
    }, async (req, accessToken, refreshToken, profile, cb) => {
      try {
        wiki.logger.info(`Google OAuth: Processing profile for user ${profile.id || profile.displayName}`)

        // Validate hosted domain if configured
        if (conf.hostedDomain && profile._json.hd !== conf.hostedDomain) {
          throw new Error(`Google authentication failed: User must be from domain ${conf.hostedDomain}, but got ${profile._json.hd || 'unknown'}`)
        }

        const user = await wiki.models.users.processProfile({
          providerKey: req.params.strategy,
          profile: {
            ...profile,
            picture: _.get(profile, 'photos[0].value', '')
          }
        })

        wiki.logger.info(`Google OAuth: Successfully authenticated user ${user.email}`)
        cb(null, user)
      } catch (err: unknown) {
        const error = asError(err)
        wiki.logger.warn(`Google OAuth: Authentication failed for strategy ${req.params.strategy}:`, err)
        // Provide more user-friendly error messages
        if (error.message.includes('domain')) {
          cb(new Error(`Google authentication failed: ${error.message}`), null)
        } else if (error.message.includes('email')) {
          cb(new Error('Google authentication failed: Email address is required but not available. Please ensure your Google account has a verified email address.'), null)
        } else if (err instanceof wiki.Error.AuthAccountBanned) {
          cb(asError(err), null)
        } else {
          cb(new Error(`Google authentication failed: ${error.message || 'Unknown error'}`), null)
        }
      }
    })

    if (conf.hostedDomain) {
      strategy.authorizationParams = function (options: Record<string, unknown>) {
        void options
        return {
          hd: conf.hostedDomain
        }
      }
    }

    passport.use(conf.key, strategy)
  },
  logout (conf) {
    void conf
    return '/'
  }
}

export default plugin
