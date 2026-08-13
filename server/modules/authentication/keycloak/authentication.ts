import { asError, wiki, type AuthenticationConfig, type AuthenticationPlugin } from '../../types.ts'
import _ from 'lodash'


// ------------------------------------
// Keycloak Account
// ------------------------------------

import KeycloakStrategy from '@exlinc/keycloak-passport'

interface KeycloakLogoutContext {
  req: {
    session: {
      keycloak_id_token?: string
    }
  }
}

interface KeycloakPlugin extends AuthenticationPlugin {
  logout(conf: AuthenticationConfig, context: KeycloakLogoutContext): string
}

const plugin: KeycloakPlugin = {
  init (passport, conf) {
    passport.use(conf.key,
      new KeycloakStrategy({
        authorizationURL: conf.authorizationURL,
        userInfoURL: conf.userInfoURL,
        tokenURL: conf.tokenURL,
        host: conf.host,
        realm: conf.realm,
        clientID: conf.clientId,
        clientSecret: conf.clientSecret,
        callbackURL: conf.callbackURL,
        passReqToCallback: true
      }, async (req, accessToken, refreshToken, results, profile, cb) => {
        let displayName = profile.username
        if (_.isString(profile.fullName) && profile.fullName.length > 0) {
          displayName = profile.fullName
        }
        try {
          const user = await wiki.models.users.processProfile({
            providerKey: req.params.strategy,
            profile: {
              id: profile.keycloakId,
              email: profile.email,
              name: displayName,
              picture: ''
            }
          })
          req.session.keycloak_id_token = results.id_token
          cb(null, user)
        } catch (err: unknown) {
          cb(asError(err))
        }
      })
    )
  },
  logout (conf, context) {
    if (!conf.logoutUpstream) {
      return '/'
    } else if (conf.logoutURL && conf.logoutURL.length > 5) {
      const idToken = context.req.session.keycloak_id_token
      const redirURL = encodeURIComponent(wiki.config.host)
      if (conf.logoutUpstreamRedirectLegacy) {
        // keycloak < 18
        return `${conf.logoutURL}?redirect_uri=${redirURL}`
      } else if (idToken) {
        // keycloak 18+
        return `${conf.logoutURL}?post_logout_redirect_uri=${redirURL}&id_token_hint=${idToken}`
      } else {
        // fall back to no redirect if keycloak_id_token isn't available
        return conf.logoutURL
      }
    } else {
      wiki.logger.warn('Keycloak logout URL is not configured!')
      return '/'
    }
  }
}

export default plugin
