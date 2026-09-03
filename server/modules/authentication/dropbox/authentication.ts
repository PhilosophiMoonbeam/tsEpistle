import { asError, wiki, type AuthenticationPlugin } from '../../types.ts'

// ------------------------------------
// Dropbox Account
// ------------------------------------

import { DropboxStrategy } from './dropbox-strategy.ts'

const plugin: AuthenticationPlugin = {
  init(passport, conf) {
    passport.use(
      conf.key,
      new DropboxStrategy(
        {
          clientID: conf.clientId,
          clientSecret: conf.clientSecret,
          callbackURL: conf.callbackURL,
          passReqToCallback: true
        },
        async (req, accessToken, refreshToken, profile, cb) => {
          try {
            const user = await wiki.models.users.processProfile({
              providerKey: req.params.strategy,
              profile: {
                ...profile,
                picture: profile._json.profile_photo_url ?? ''
              }
            })
            cb(null, user)
          } catch (err: unknown) {
            cb(asError(err), null)
          }
        }
      )
    )
  }
}

export default plugin
