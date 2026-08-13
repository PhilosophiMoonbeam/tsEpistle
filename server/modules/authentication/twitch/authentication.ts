import { asError, wiki, type AuthenticationPlugin } from '../../types.ts'
import type { Request } from 'express'
import type { Profile as PassportProfile } from 'passport'

// ------------------------------------
// Twitch Account
// ------------------------------------

import passportTwitchStrategyModule from 'passport-twitch-strategy'
const TwitchStrategy = passportTwitchStrategyModule.Strategy
import _ from 'lodash'
type TwitchProfile = PassportProfile & {
  readonly profile_image_url?: string
}

type VerifyDone = (error: Error | null, user?: Express.User | false | null) => void

const plugin: AuthenticationPlugin = {
  init (passport, conf) {
    const twitchOptions = {
      clientID: conf.clientId,
      clientSecret: conf.clientSecret,
      callbackURL: conf.callbackURL,
      scope: '',
      passReqToCallback: true
    }
    passport.use(conf.key,
      new TwitchStrategy(twitchOptions, async (
        req: Request,
        accessToken: string,
        refreshToken: string,
        profile: TwitchProfile,
        cb: VerifyDone
      ) => {
        try {
          const user = await wiki.models.users.processProfile({
            providerKey: req.params.strategy,
            profile: {
              ...profile,
              picture: _.get(profile, 'profile_image_url', '')
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
