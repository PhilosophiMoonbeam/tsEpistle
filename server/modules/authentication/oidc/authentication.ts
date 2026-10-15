import { mappedProviderProfile } from '../provider-profile.ts'
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
          try {
            const profile = Object.assign({}, idProfile, uiProfile)
            // Raw ID-token claims are not exposed on the parsed library profile.
            const claims: unknown = typeof idToken === 'string' ? JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) : {}
            const rawClaims = Object.assign({}, claims, _.get(uiProfile, '_json'))
            const picture = _.get(rawClaims, conf.pictureClaim, '')
            const verifiedEmailClaim = typeof conf.verifiedEmailClaim === 'string' && conf.verifiedEmailClaim ? conf.verifiedEmailClaim : 'email_verified'
            if (conf.requireVerifiedEmail === true && _.get(rawClaims, verifiedEmailClaim) !== true) {
              throw new Error('Provider email verification is required.')
            }
            const user = await wiki.models.users.processProfile({
              providerKey: req.params.strategy,
              profile: {
                ...profile,
                email: _.get(rawClaims, conf.emailClaim),
                displayName: _.get(rawClaims, conf.displayNameClaim, ''),
                picture: picture,
                providerProfile: mappedProviderProfile(rawClaims, { location: conf.locationClaim, jobTitle: conf.jobTitleClaim, pronouns: conf.pronounsClaim })
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
