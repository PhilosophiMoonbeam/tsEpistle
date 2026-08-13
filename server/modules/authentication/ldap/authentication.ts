import { asError, wiki, type AuthenticationConfig, type AuthenticationPlugin, type WikiUser } from '../../types.ts'

// ------------------------------------
// LDAP Account
// ------------------------------------

import { LdapStrategy } from './ldap-strategy.ts'
import { readFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import type { ConnectionOptions } from 'node:tls'
import _ from 'lodash'

interface GroupRow {
  id: number
}

interface WikiGroup extends GroupRow {
  name: string
}

interface GroupQuery {
  select(column: 'groups.id'): Promise<GroupRow[]>
  relate(groupId: number): Promise<unknown>
  unrelate(): {
    where(column: 'groupId', groupId: number): Promise<unknown>
  }
}

interface GroupRelatedUser extends WikiUser {
  $relatedQuery(relation: 'groups'): GroupQuery
}

const hasProperty = <Key extends PropertyKey>(
  value: object,
  key: Key
): value is Record<Key, unknown> => key in value

const isWikiGroup = (value: unknown): value is WikiGroup => (
  typeof value === 'object' && value !== null &&
  'id' in value && typeof value.id === 'number' &&
  'name' in value && typeof value.name === 'string'
)

const hasGroupRelations = (user: WikiUser): user is GroupRelatedUser => (
  typeof user.$relatedQuery === 'function'
)

const getStrategy = (req: IncomingMessage): string => {
  if ('params' in req && typeof req.params === 'object' && req.params !== null &&
    'strategy' in req.params && typeof req.params.strategy === 'string') {
    return req.params.strategy
  }
  throw new Error('Authentication strategy is missing from the request.')
}

const getGroupSearchScope = (scope: string): 'base' | 'one' | 'sub' => {
  if (scope === 'base' || scope === 'one' || scope === 'sub') {
    return scope
  }
  throw new Error(`Invalid LDAP group search scope: ${scope}`)
}

const plugin: AuthenticationPlugin = {
  init (passport, conf) {
    const server = {
      url: conf.url,
      bindDn: conf.bindDn,
      bindCredentials: conf.bindCredentials,
      searchBase: conf.searchBase,
      searchFilter: conf.searchFilter,
      tlsOptions: getTlsOptions(conf),
      ...conf.mapGroups && {
        groupSearchBase: conf.groupSearchBase,
        groupSearchFilter: conf.groupSearchFilter,
        groupSearchScope: getGroupSearchScope(conf.groupSearchScope),
        groupDnProperty: conf.groupDnProperty,
        groupSearchAttributes: [conf.groupNameField]
      },
      binaryAttributes: [conf.mappingPicture]
    }
    passport.use(conf.key,
      new LdapStrategy({
        server,
        usernameField: 'email',
        passwordField: 'password',
        passReqToCallback: true
      }, async (req, profile: Record<string, unknown>, cb) => {
        try {
          const userId = _.get(profile, conf.mappingUID, null)
          if (!userId) {
            throw new Error('Invalid Unique ID field mapping!')
          }

          const user = await wiki.models.users.processProfile({
            providerKey: getStrategy(req),
            profile: {
              id: userId,
              email: String(_.get(profile, conf.mappingEmail, '')).split(',')[0],
              displayName: _.get(profile, conf.mappingDisplayName, '???'),
              picture: _.get(profile, `_raw.${conf.mappingPicture}`, '')
            }
          })
          // map users LDAP groups to wiki groups with the same name, and remove any groups that don't match LDAP
          if (conf.mapGroups) {
            const ldapGroups = _.get(profile, '_groups')
            if (Array.isArray(ldapGroups)) {
              if (!hasGroupRelations(user)) {
                throw new Error('LDAP user does not support group relations.')
              }
              const groups = ldapGroups.flatMap((group: unknown) => {
                if (typeof group !== 'object' || group === null || !hasProperty(group, conf.groupNameField)) {
                  return []
                }
                const name = group[conf.groupNameField]
                return typeof name === 'string' ? [name] : []
              })
              const currentGroups = (await user.$relatedQuery('groups').select('groups.id')).map(group => group.id)
              const expectedGroups = Object.values<unknown>(wiki.auth.groups)
                .filter(isWikiGroup)
                .filter(group => groups.includes(group.name))
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
          if (wiki.config.flags.ldapdebug) {
            wiki.logger.warn('LDAP LOGIN ERROR (c2): ', err)
          }
          cb(asError(err))
        }
      }
      ))
  }
}

function getTlsOptions (conf: AuthenticationConfig): ConnectionOptions {
  if (!conf.tlsEnabled) {
    return {}
  }

  if (!conf.tlsCertPath) {
    return {
      rejectUnauthorized: conf.verifyTLSCertificate
    }
  }

  const caList: Buffer[] = []
  if (conf.verifyTLSCertificate) {
    caList.push(readFileSync(conf.tlsCertPath))
  }

  return {
    rejectUnauthorized: conf.verifyTLSCertificate,
    ca: caList
  }
}

export default plugin
