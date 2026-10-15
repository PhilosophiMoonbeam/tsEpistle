import { mappedProviderProfile } from '../provider-profile.ts'
import { synchronizeProviderGroups } from '../../../helpers/authentication-provisioning.ts'
import { asError, wiki, type AuthenticationConfig, type AuthenticationPlugin } from '../../types.ts'

// ------------------------------------
// LDAP Account
// ------------------------------------

import { LdapStrategy } from './ldap-strategy.ts'
import { readFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import type { ConnectionOptions } from 'node:tls'
import _ from 'lodash'

const hasProperty = <Key extends PropertyKey>(value: object, key: Key): value is Record<Key, unknown> => key in value

const getStrategy = (req: IncomingMessage): string => {
  if ('params' in req && typeof req.params === 'object' && req.params !== null && 'strategy' in req.params && typeof req.params.strategy === 'string') {
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
  init(passport, conf) {
    const server = {
      url: conf.url,
      bindDn: conf.bindDn,
      bindCredentials: conf.bindCredentials,
      searchBase: conf.searchBase,
      searchFilter: conf.searchFilter,
      tlsOptions: getTlsOptions(conf),
      ...(conf.mapGroups && {
        groupSearchBase: conf.groupSearchBase,
        groupSearchFilter: conf.groupSearchFilter,
        groupSearchScope: getGroupSearchScope(conf.groupSearchScope),
        groupDnProperty: conf.groupDnProperty,
        groupSearchAttributes: [conf.groupNameField]
      }),
      binaryAttributes: [conf.mappingPicture]
    }
    passport.use(
      conf.key,
      new LdapStrategy(
        {
          server,
          usernameField: 'email',
          passwordField: 'password',
          passReqToCallback: true
        },
        async (req, profile: Record<string, unknown>, cb) => {
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
                picture: _.get(profile, `_raw.${conf.mappingPicture}`, ''),
                providerProfile: mappedProviderProfile(
                  profile,
                  { location: conf.mappingLocation, jobTitle: conf.mappingJobTitle, pronouns: conf.mappingPronouns },
                  true
                )
              }
            })
            // map users LDAP groups to wiki groups with the same name, and remove any groups that don't match LDAP
            if (conf.mapGroups) {
              const ldapGroups = _.get(profile, '_groups')
              if (Array.isArray(ldapGroups)) {
                const groups = ldapGroups.flatMap((group: unknown) => {
                  if (typeof group !== 'object' || group === null || !hasProperty(group, conf.groupNameField)) {
                    return []
                  }
                  const name = group[conf.groupNameField]
                  return typeof name === 'string' ? [name] : []
                })
                const membership = await synchronizeProviderGroups({ userId: user.id, providerKey: getStrategy(req), groupNames: groups })
                Object.assign(user, { authVersion: membership.authVersion, adminRevision: membership.adminRevision })
                if (membership.changed) Reflect.deleteProperty(user, 'groups')
              }
            }
            cb(null, user)
          } catch (err: unknown) {
            if (wiki.config.flags.ldapdebug) {
              wiki.logger.warn('LDAP LOGIN ERROR (c2): Authentication failed.')
            }
            cb(asError(err))
          }
        }
      )
    )
  }
}

function getTlsOptions(conf: AuthenticationConfig): ConnectionOptions {
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
