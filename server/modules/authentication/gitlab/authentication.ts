import { asError, wiki, type AuthenticationPlugin } from '../../types.ts'

// ------------------------------------
// GitLab Account
// ------------------------------------

import passportGitlab2Module from 'passport-gitlab2'
const GitLabStrategy = passportGitlab2Module.Strategy
import _ from 'lodash'

const plugin: AuthenticationPlugin = {
  init (passport, conf) {
    passport.use(conf.key,
      new GitLabStrategy({
        clientID: conf.clientId,
        clientSecret: conf.clientSecret,
        callbackURL: conf.callbackURL,
        baseURL: conf.baseUrl,
        authorizationURL: conf.authorizationURL || (conf.baseUrl + '/oauth/authorize'),
        tokenURL: conf.tokenURL || (conf.baseUrl + '/oauth/token'),
        scope: ['read_user'],
        passReqToCallback: true
      }, async (req, accessToken, refreshToken, profile, cb) => {
        try {
          const user = await wiki.models.users.processProfile({
            providerKey: req.params.strategy,
            profile: {
              ...profile,
              picture: _.get(profile, 'avatarUrl', '')
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
