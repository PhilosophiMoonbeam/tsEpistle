import { synchronizeProviderGroups } from '../../../helpers/authentication-provisioning.ts'
import { asError, wiki, type AuthenticationConfig, type AuthenticationPlugin } from '../../types.ts'
import { oauth2StateOptions } from '../oauth-state.ts'
import _ from 'lodash'

// ------------------------------------
// OAuth2 Account
// ------------------------------------

import passportOauth2Module from 'passport-oauth2'
const OAuth2Strategy = passportOauth2Module.Strategy

interface OAuth2Plugin extends AuthenticationPlugin {
  logout(conf: AuthenticationConfig): string
}

const isOAuthProfile = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const plugin: OAuth2Plugin = {
  init(passport, conf) {
    const client = new OAuth2Strategy(
      {
        authorizationURL: conf.authorizationURL,
        tokenURL: conf.tokenURL,
        clientID: conf.clientId,
        clientSecret: conf.clientSecret,
        userInfoURL: conf.userInfoURL,
        callbackURL: conf.callbackURL,
        ...oauth2StateOptions(conf),
        passReqToCallback: true,
        scope: conf.scope
      },
      async (req, accessToken, refreshToken, profile, cb) => {
        try {
          const picture = _.get(profile, conf.pictureClaim, '')
          let groupNames: string[] | undefined
          if (conf.mapGroups && _.has(profile, conf.groupsClaim)) {
            const groups: unknown = _.get(profile, conf.groupsClaim)
            if (!Array.isArray(groups) || groups.length > 2000) {
              throw new Error('Provider group claim is invalid.')
            }
            for (const group of groups) {
              if (typeof group !== 'string' || group.length > 255) {
                throw new Error('Provider group claim is invalid.')
              }
            }
            groupNames = groups
          }
          const user = await wiki.models.users.processProfile({
            providerKey: req.params.strategy,
            profile: {
              ...profile,
              id: _.get(profile, conf.userIdClaim),
              displayName: _.get(profile, conf.displayNameClaim, '???'),
              email: _.get(profile, conf.emailClaim),
              picture: picture
            }
          })
          if (groupNames !== undefined) {
            const membership = await synchronizeProviderGroups({ userId: user.id, providerKey: String(req.params.strategy), groupNames })
            Object.assign(user, { authVersion: membership.authVersion, adminRevision: membership.adminRevision })
            if (membership.changed) Reflect.deleteProperty(user, 'groups')
          }
          cb(null, user)
        } catch (err: unknown) {
          cb(asError(err))
        }
      }
    )

    client.userProfile = function (accesstoken, done) {
      this._oauth2._useAuthorizationHeaderForGET = !conf.useQueryStringForAccessToken
      this._oauth2.get(conf.userInfoURL, accesstoken, (err, data) => {
        if (err) {
          return done(asError(err))
        }
        try {
          const profile: unknown = JSON.parse(data)
          if (!isOAuthProfile(profile)) {
            throw new Error('OAuth2 user profile response must be an object.')
          }
          done(null, profile)
        } catch (err: unknown) {
          done(asError(err))
        }
      })
    }
    passport.use(conf.key, client)
  },
  logout(conf) {
    if (!conf.logoutURL) {
      return '/'
    } else {
      return conf.logoutURL
    }
  }
}

export default plugin
