import { asError, wiki, type AuthenticationConfig, type AuthenticationPlugin, type WikiUser } from '../../types.ts'
import _ from 'lodash'


// ------------------------------------
// OpenID Connect Account
// ------------------------------------

import passportOpenidconnectModule from 'passport-openidconnect'
const OpenIDConnectStrategy = passportOpenidconnectModule.Strategy

interface OidcPlugin extends AuthenticationPlugin {
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

const plugin: OidcPlugin = {
  init (passport, conf) {
    passport.use(conf.key,
      new OpenIDConnectStrategy({
        authorizationURL: conf.authorizationURL,
        tokenURL: conf.tokenURL,
        clientID: conf.clientId,
        clientSecret: conf.clientSecret,
        issuer: conf.issuer,
        userInfoURL: conf.userInfoURL,
        callbackURL: conf.callbackURL,
        passReqToCallback: true,
        skipUserProfile: conf.skipUserProfile,
        acrValues: conf.acrValues
      }, async (req, iss, uiProfile, idProfile, context, idToken, accessToken, refreshToken, params, cb) => {
        const profile = Object.assign({}, idProfile, uiProfile)
        const picture = _.get(profile, '_json.' + conf.pictureClaim, '')

        try {
          const user = await wiki.models.users.processProfile({
            providerKey: req.params.strategy,
            profile: {
              ...profile,
              email: _.get(profile, '_json.' + conf.emailClaim),
              displayName: _.get(profile, '_json.' + conf.displayNameClaim, ''),
              picture: picture
            }
          })
          if (conf.mapGroups) {
            const groups = _.get(profile, '_json.' + conf.groupsClaim)
            if (Array.isArray(groups)) {
              if (!hasGroupRelations(user)) {
                throw new Error('OpenID Connect user does not support group relations.')
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
    )
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
