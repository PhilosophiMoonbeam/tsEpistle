import { asError, wiki, type AuthenticationPlugin, type WikiUser } from '../../types.ts'
import { discovery } from 'openid-client'
import { Strategy } from 'openid-client/passport'
import _ from 'lodash'

const DISCOVERY_PATH = '/.well-known/openid-configuration'
interface GroupRelationRow {
  id: number
}

interface GroupRelationMutationQuery extends PromiseLike<number> {
  where(column: 'groupId', value: number): GroupRelationMutationQuery
}

interface GroupRelationQuery extends PromiseLike<GroupRelationRow[]> {
  relate(groupId: number): Promise<number | number[]>
  select(column: 'groups.id'): GroupRelationQuery
  unrelate(): GroupRelationMutationQuery
}

interface UserWithGroupRelations extends WikiUser {
  $relatedQuery(relation: 'groups'): GroupRelationQuery
}

interface AuthGroup {
  id: number
  name: string
}

interface AzureClaims extends Record<string, unknown> {
  email?: string
  groups?: unknown
  name?: string
  oid?: string
  preferred_username?: string
  sub?: string
}

const hasGroupRelations = (user: WikiUser): user is UserWithGroupRelations => (
  '$relatedQuery' in user && typeof user.$relatedQuery === 'function'
)

const isAuthGroup = (value: unknown): value is AuthGroup => (
  typeof value === 'object' &&
  value !== null &&
  'id' in value &&
  typeof value.id === 'number' &&
  'name' in value &&
  typeof value.name === 'string'
)

const getAuthGroups = (groups: object): AuthGroup[] => Object.values(groups).filter(isAuthGroup)

const getIssuerUrl = (entryPoint: string): URL => new URL(
  entryPoint.endsWith(DISCOVERY_PATH)
    ? entryPoint.slice(0, -DISCOVERY_PATH.length)
    : entryPoint
)

const getClaims = (claims: Record<string, unknown> | undefined): AzureClaims => claims ?? {}

const getClaimGroups = (claims: AzureClaims): string[] | undefined => (
  Array.isArray(claims.groups)
    ? claims.groups.filter((group): group is string => typeof group === 'string')
    : undefined
)

const plugin: AuthenticationPlugin = {
  async init (passport, conf) {
    const config = await discovery(getIssuerUrl(conf.entryPoint), conf.clientId)
    passport.use(conf.key,
      new Strategy({
        config,
        callbackURL: conf.callbackURL,
        scope: 'openid profile email',
        passReqToCallback: true
      }, async (req, tokens, cb) => {
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
            if (!hasGroupRelations(user)) throw new TypeError('Authenticated user does not support group relations')
            if (groups) {
              const currentGroups = (await user.$relatedQuery('groups').select('groups.id')).map(group => group.id)
              const expectedGroups = getAuthGroups(wiki.auth.groups).filter(group => groups.includes(group.name)).map(group => group.id)
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
          cb(asError(err), null)
        }
      })
    )
  }
}

export default plugin
