import { synchronizeProviderGroups } from '../../../helpers/authentication-provisioning.ts'
import { oidcStateOptions } from '../oauth-state.ts'
import { asError, wiki, type AuthenticationConfig, type AuthenticationPlugin } from '../../types.ts'
import _ from 'lodash'

// ------------------------------------
// OpenID Connect Account
// ------------------------------------

import passportOpenidconnectModule from 'passport-openidconnect'
const OpenIDConnectStrategy = passportOpenidconnectModule.Strategy

interface OidcPlugin extends AuthenticationPlugin {
  logout(conf: AuthenticationConfig): string
}

const plugin: OidcPlugin = {
  init(passport, conf) {
    passport.use(
      conf.key,
      new OpenIDConnectStrategy(
        {
          authorizationURL: conf.authorizationURL,
          tokenURL: conf.tokenURL,
          clientID: conf.clientId,
          clientSecret: conf.clientSecret,
          issuer: conf.issuer,
          userInfoURL: conf.userInfoURL,
          callbackURL: conf.callbackURL,
          ...oidcStateOptions(conf),
          nonce: true,
          ...(typeof conf.maxAge === 'number' ? { maxAge: conf.maxAge } : {}),
          passReqToCallback: true,
          skipUserProfile: conf.skipUserProfile,
          acrValues: conf.acrValues
        },
        async (req, iss, uiProfile, idProfile, context, idToken, accessToken, refreshToken, params, cb) => {
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
                const groupNames = groups.filter((group: unknown): group is string => typeof group === 'string')
                const membership = await synchronizeProviderGroups({ userId: user.id, providerKey: String(req.params.strategy), groupNames: groupNames })
                Object.assign(user, { authVersion: membership.authVersion, adminRevision: membership.adminRevision })
                if (membership.changed) Reflect.deleteProperty(user, 'groups')
              }
            }
            cb(null, user)
          } catch (err: unknown) {
            cb(asError(err))
          }
        }
      )
    )
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
