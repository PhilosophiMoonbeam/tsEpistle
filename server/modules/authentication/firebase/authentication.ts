import { asError, wiki, type AuthenticationPlugin } from '../../types.ts'

// ------------------------------------
// Firebase Account
// ------------------------------------

// INCOMPLETE / TODO

import passportGithub2Module from 'passport-github2'
const FirebaseStrategy = passportGithub2Module.Strategy
import _ from 'lodash'

const plugin: AuthenticationPlugin = {
  init (passport, conf) {
    passport.use(conf.key,
      new FirebaseStrategy({
        clientID: conf.clientId,
        clientSecret: conf.clientSecret,
        callbackURL: conf.callbackURL,
        scope: ['user:email']
      }, async (accessToken, refreshToken, profile, cb) => {
        try {
          const user = await wiki.models.users.processProfile({
            providerKey: conf.key,
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
