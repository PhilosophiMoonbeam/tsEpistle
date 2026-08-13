import { asError, wiki, type AuthenticationConfig, type AuthenticationPlugin, type WikiUser } from '../../types.ts'
import _ from 'lodash'


// ------------------------------------
// OAuth2 Account
// ------------------------------------

import passportOauth2Module from 'passport-oauth2'
const OAuth2Strategy = passportOauth2Module.Strategy

interface OAuth2Plugin extends AuthenticationPlugin {
  logout(conf: AuthenticationConfig): string
}

interface GroupRow { id: number }
interface WikiGroup extends GroupRow { name: string }
interface GroupQuery {
  select(column: 'groups.id'): Promise<GroupRow[]>
  relate(groupId: number): Promise<unknown>
  unrelate(): { where(column: 'groupId', groupId: number): Promise<unknown> }
}
interface GroupRelatedUser extends WikiUser {
  $relatedQuery(relation: 'groups'): GroupQuery
}

const isWikiGroup = (value: unknown): value is WikiGroup => (
  typeof value === 'object' && value !== null &&
  'id' in value && typeof value.id === 'number' &&
  'name' in value && typeof value.name === 'string'
)

const hasGroupRelations = (user: WikiUser): user is GroupRelatedUser => (
  typeof user.$relatedQuery === 'function'
)

const isOAuthProfile = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const plugin: OAuth2Plugin = {
  init (passport, conf) {
    const client = new OAuth2Strategy({
      authorizationURL: conf.authorizationURL,
      tokenURL: conf.tokenURL,
      clientID: conf.clientId,
      clientSecret: conf.clientSecret,
      userInfoURL: conf.userInfoURL,
      callbackURL: conf.callbackURL,
      passReqToCallback: true,
      scope: conf.scope,
      state: conf.enableCSRFProtection
    }, async (req, accessToken, refreshToken, profile, cb) => {
      try {
        const picture = _.get(profile, conf.pictureClaim, '')
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
        if (conf.mapGroups) {
          const groups = _.get(profile, conf.groupsClaim)
          if (Array.isArray(groups)) {
            if (!hasGroupRelations(user)) {
              throw new Error('OAuth2 user does not support group relations.')
            }
            const groupNames = groups.filter((group: unknown): group is string => typeof group === 'string')
            const currentGroups = (await user.$relatedQuery('groups').select('groups.id')).map(group => group.id)
            const expectedGroups = Object.values<unknown>(wiki.auth.groups)
              .filter(isWikiGroup)
              .filter(group => groupNames.includes(group.name))
              .map(group => group.id)
            for (const groupId of _.difference(expectedGroups, currentGroups)) {
              await user.$relatedQuery('groups').relate(groupId)
            }
            for (const groupId of _.difference(currentGroups, expectedGroups)) {
              await user.$relatedQuery('groups').unrelate().where('groupId', groupId)
            }
          }
        }
        cb(null, user)
      } catch (err: unknown) {
        cb(asError(err))
      }
    })

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
  logout (conf) {
    if (!conf.logoutURL) {
      return '/'
    } else {
      return conf.logoutURL
    }
  }
}

export default plugin
