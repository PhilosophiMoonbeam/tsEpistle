import { asError, wiki, type AuthenticationConfig, type AuthenticationPlugin } from '../../types.ts'

// ------------------------------------
// Auth0 Account
// ------------------------------------

import passportAuth0Module from 'passport-auth0'
const Auth0Strategy = passportAuth0Module.Strategy
type LogoutAuthenticationPlugin = AuthenticationPlugin & {
  logout(conf: AuthenticationConfig): string
}

const plugin: LogoutAuthenticationPlugin = {
  init (passport, conf) {
    passport.use(conf.key,
      new Auth0Strategy({
        domain: conf.domain,
        clientID: conf.clientId,
        clientSecret: conf.clientSecret,
        callbackURL: conf.callbackURL,
        passReqToCallback: true
      }, async (req, accessToken, refreshToken, extraParams, profile, cb) => {
        try {
          const user = await wiki.models.users.processProfile({
            providerKey: req.params.strategy,
            profile
          })
          cb(null, user)
        } catch (err: unknown) {
          cb(asError(err), null)
        }
      }
      ))
  },
  logout (conf) {
    return `https://${conf.domain}/v2/logout?${new URLSearchParams({ client_id: conf.clientId, returnTo: wiki.config.host }).toString()}`
  }
}

export default plugin
