import { asError, wiki, type AuthenticationPlugin } from '../../types.ts'

// ------------------------------------
// Okta Account
// ------------------------------------

import passportOktaOauthModule from 'passport-okta-oauth'
const OktaStrategy = passportOktaOauthModule.Strategy
import _ from 'lodash'

const plugin: AuthenticationPlugin = {
  init (passport, conf) {
    const audience = conf.audience
    if (typeof audience !== 'string') {
      throw new Error('Okta audience must be a string.')
    }
    passport.use(conf.key,
      new OktaStrategy({
        audience,
        clientID: conf.clientId,
        clientSecret: conf.clientSecret,
        idp: conf.idp,
        callbackURL: conf.callbackURL,
        response_type: 'code',
        passReqToCallback: true
      }, async (req, accessToken, refreshToken, profile, cb) => {
        try {
          const user = await wiki.models.users.processProfile({
            providerKey: req.params.strategy,
            profile: {
              ...profile,
              picture: _.get(profile, '_json.profile', '')
            }
          })
          cb(null, user)
        } catch (err: unknown) {
          cb(asError(err), null)
        }
      })
    )
  }
}

export default plugin
