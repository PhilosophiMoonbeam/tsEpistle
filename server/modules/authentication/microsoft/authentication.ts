import { asError, wiki, type AuthenticationPlugin } from '../../types.ts'

// ------------------------------------
// Microsoft Account
// ------------------------------------

import passportMicrosoftModule from 'passport-microsoft'
const WindowsLiveStrategy = passportMicrosoftModule.Strategy
import _ from 'lodash'

const plugin: AuthenticationPlugin = {
  init (passport, conf) {
    passport.use(conf.key,
      new WindowsLiveStrategy({
        clientID: conf.clientId,
        clientSecret: conf.clientSecret,
        callbackURL: conf.callbackURL,
        scope: ['User.Read', 'email', 'openid', 'profile'],
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
