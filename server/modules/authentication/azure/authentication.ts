import { synchronizeProviderGroups } from '../../../helpers/authentication-provisioning.ts'
import { asError, wiki, type AuthenticationPlugin } from '../../types.ts'
import { discovery } from 'openid-client'
import { OpenIDClientStrategy } from '../openid-client-strategy.ts'
import { providerRevisionFromConfig } from '../oauth-state.ts'
import _ from 'lodash'

const DISCOVERY_PATH = '/.well-known/openid-configuration'
interface AzureClaims extends Record<string, unknown> {
  email?: string
  groups?: unknown
  name?: string
  oid?: string
  preferred_username?: string
  sub?: string
}

const getIssuerUrl = (entryPoint: string): URL => new URL(entryPoint.endsWith(DISCOVERY_PATH) ? entryPoint.slice(0, -DISCOVERY_PATH.length) : entryPoint)

const getClaims = (claims: Record<string, unknown> | undefined): AzureClaims => claims ?? {}

const getClaimGroups = (claims: AzureClaims): string[] | undefined =>
  Array.isArray(claims.groups) ? claims.groups.filter((group): group is string => typeof group === 'string') : undefined

const plugin: AuthenticationPlugin = {
  async init(passport, conf) {
    const clientMetadata = typeof conf.clientSecret === 'string' && conf.clientSecret.length > 0
      ? { client_secret: conf.clientSecret }
      : undefined
    const config = await discovery(
      getIssuerUrl(conf.entryPoint),
      conf.clientId,
      clientMetadata
    )
    passport.use(
      conf.key,
      new OpenIDClientStrategy(
        {
          config,
          callbackURL: conf.callbackURL,
          providerKey: conf.key,
          providerRevision: providerRevisionFromConfig(conf),
          scope: 'openid profile email',
          passReqToCallback: true,
          name: 'azure'
        },
        async (req, tokens, cb) => {
          const claims = getClaims(tokens.claims())
          const groups = getClaimGroups(claims)
          try {
            const user = await wiki.models.users.processProfile({
              providerKey: req.params.strategy,
              profile: {
                id: claims.oid ?? claims.sub,
                displayName: claims.name,
                email: claims.email ?? claims.preferred_username,
                picture: ''
              }
            })
            if (conf.mapGroups) {
              if (groups) {
                const membership = await synchronizeProviderGroups({ userId: user.id, providerKey: String(req.params.strategy), groupNames: groups })
                Object.assign(user, { authVersion: membership.authVersion, adminRevision: membership.adminRevision })
                if (membership.changed) Reflect.deleteProperty(user, 'groups')
              }
            }
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
