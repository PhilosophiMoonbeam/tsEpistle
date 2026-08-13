import { asError, wiki, type AuthenticationPlugin } from '../../types.ts'

// ------------------------------------
// Facebook Account
// ------------------------------------

import passportFacebookModule from 'passport-facebook'
const FacebookStrategy = passportFacebookModule.Strategy
import _ from 'lodash'

const plugin: AuthenticationPlugin = {
  init (passport, conf) {
    passport.use(conf.key,
      new FacebookStrategy({
        clientID: conf.clientId,
        clientSecret: conf.clientSecret,
        callbackURL: conf.callbackURL,
        profileFields: ['id', 'displayName', 'email', 'photos'],
        authType: 'reauthenticate',
        passReqToCallback: true
      }, async (req, accessToken, refreshToken, profile, cb) => {
        try {
          const user = await wiki.models.users.processProfile({
            providerKey: req.params.strategy,
            profile: {
              ...profile,
              picture: _.get(profile, 'photos[0].value', '')
            }
          })
          cb(null, user)
        } catch (err: unknown) {
          cb(asError(err), null)
        }
      }
      ))
  }
}

export default plugin
