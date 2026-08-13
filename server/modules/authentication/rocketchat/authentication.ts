import { asError, wiki, type AuthenticationConfig, type AuthenticationPlugin } from '../../types.ts'
import _ from 'lodash'


// ------------------------------------
// Rocket.chat Account
// ------------------------------------

import passportOauth2Module from 'passport-oauth2'
const OAuth2Strategy = passportOauth2Module.Strategy

interface RocketChatPlugin extends AuthenticationPlugin {
  logout(conf: AuthenticationConfig): string
}

interface RocketChatProfileResponse extends Record<string, unknown> {
  _id: string
  username: string
  name?: string
  emails: [{ address: string }, ...Array<{ address: string }>]
}

const isRocketChatProfile = (value: unknown): value is RocketChatProfileResponse => {
  if (typeof value !== 'object' || value === null ||
    !('_id' in value) || typeof value._id !== 'string' ||
    !('username' in value) || typeof value.username !== 'string' ||
    ('name' in value && value.name !== undefined && typeof value.name !== 'string') ||
    !('emails' in value) || !Array.isArray(value.emails) || value.emails.length === 0) {
    return false
  }
  const primaryEmail: unknown = value.emails[0]
  return typeof primaryEmail === 'object' && primaryEmail !== null &&
    'address' in primaryEmail && typeof primaryEmail.address === 'string'
}

const plugin: RocketChatPlugin = {
  init (passport, conf) {
    const siteURL = conf.siteURL.slice(-1) === '/' ? conf.siteURL.slice(0, -1) : conf.siteURL

    const strategyInstance = new OAuth2Strategy({
      authorizationURL: `${siteURL}/oauth/authorize`,
      tokenURL: `${siteURL}/oauth/token`,
      clientID: conf.clientId,
      clientSecret: conf.clientSecret,
      callbackURL: conf.callbackURL,
      passReqToCallback: true
    }, async (req, accessToken, refreshToken, profile, cb) => {
      try {
        const user = await wiki.models.users.processProfile({
          providerKey: req.params.strategy,
          profile
        })
        cb(null, user)
      } catch (err: unknown) {
        cb(asError(err))
      }
    })

    strategyInstance.userProfile = function (accessToken, cb) {
      this._oauth2.get(`${siteURL}/api/v1/me`, accessToken, (err, body, response) => {
        void response
        if (err) {
          wiki.logger.warn('Rocket.chat - Failed to fetch user profile.')
          return cb(asError(err))
        }
        try {
          const profile: unknown = JSON.parse(body)
          if (!isRocketChatProfile(profile)) {
            throw new Error('Rocket.Chat user profile response is invalid.')
          }
          cb(null, {
            id: profile._id,
            displayName: _.isEmpty(profile.name) ? profile.username : profile.name,
            email: profile.emails[0].address,
            picture: profile.avatarUrl
          })
        } catch (err: unknown) {
          wiki.logger.warn('Rocket.chat - Failed to parse user profile.')
          cb(asError(err))
        }
      })
    }

    passport.use(conf.key, strategyInstance)
  },
  logout (conf) {
    if (!conf.logoutURL) {
      return '/'
    } else {
      return conf.logoutURL
    }
  }
}

export default plugin
