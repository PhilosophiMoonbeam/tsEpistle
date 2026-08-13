import { asError, wiki, type AuthenticationPlugin, type WikiUser } from '../../types.ts'
import _ from 'lodash'


// ------------------------------------
// SAML Account
// ------------------------------------

import { Strategy as SAMLStrategy, type PassportSamlConfig } from '@node-saml/passport-saml'

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

const asPassportUser = (user: object): Record<string, unknown> => (
  user as Record<string, unknown>
)

const getSignatureAlgorithm = (algorithm: string): 'sha1' | 'sha256' | 'sha512' => {
  if (algorithm === 'sha1' || algorithm === 'sha256' || algorithm === 'sha512') {
    return algorithm
  }
  throw new Error(`Invalid SAML signature algorithm: ${algorithm}`)
}

const getRacComparison = (comparison: string): 'exact' | 'minimum' | 'maximum' | 'better' => {
  if (comparison === 'exact' || comparison === 'minimum' || comparison === 'maximum' || comparison === 'better') {
    return comparison
  }
  throw new Error(`Invalid SAML authentication context comparison: ${comparison}`)
}

const getAudience = (value: unknown): string | undefined => {
  if (_.isEmpty(value)) {
    return undefined
  }
  if (typeof value === 'string') {
    return value
  }
  throw new Error('SAML audience must be a string.')
}

const plugin: AuthenticationPlugin = {
  init (passport, conf) {
    const audience = getAudience(conf.audience)
    const samlConfig: PassportSamlConfig = {
      callbackUrl: conf.callbackURL,
      entryPoint: conf.entryPoint,
      issuer: conf.issuer,
      idpCert: (conf.cert || '').split('|'),
      signatureAlgorithm: getSignatureAlgorithm(conf.signatureAlgorithm),
      digestAlgorithm: conf.digestAlgorithm,
      identifierFormat: conf.identifierFormat,
      wantAssertionsSigned: conf.wantAssertionsSigned,
      acceptedClockSkewMs: _.toSafeInteger(conf.acceptedClockSkewMs),
      disableRequestedAuthnContext: conf.disableRequestedAuthnContext,
      authnContext: (conf.authnContext || '').split('|'),
      racComparison: getRacComparison(conf.racComparison),
      forceAuthn: conf.forceAuthn,
      passive: conf.passive,
      providerName: conf.providerName,
      skipRequestCompression: conf.skipRequestCompression,
      authnRequestBinding: conf.authnRequestBinding,
      passReqToCallback: true,
      ...(audience === undefined ? {} : { audience }),
      ...!_.isEmpty(conf.privateKey) && { privateKey: conf.privateKey },
      ...!_.isEmpty(conf.decryptionPvk) && { decryptionPvk: conf.decryptionPvk }
    }

    passport.use(conf.key,
      new SAMLStrategy(samlConfig, async (req, profile, cb) => {
        try {
          if (!profile) {
            throw new Error('SAML profile is missing.')
          }
          const userId = _.get(profile, [conf.mappingUID], null) || _.get(profile, 'nameID', null)
          if (!userId) {
            throw new Error('Invalid or Missing Unique ID field!')
          }

          const user = await wiki.models.users.processProfile({
            providerKey: req.params.strategy,
            profile: {
              id: userId,
              email: _.get(profile, conf.mappingEmail, ''),
              displayName: _.get(profile, conf.mappingDisplayName, '???'),
              picture: _.get(profile, conf.mappingPicture, '')
            }
          })

          // map users provider groups to wiki groups with the same name, and remove any groups that don't match
          // Code copied from the LDAP implementation with a slight variation on the field we extract the value from
          // In SAML v2 groups come in profile.attributes and can be 1 string or an array of strings
          if (conf.mapGroups) {
            const attributes = typeof profile.attributes === 'object' && profile.attributes !== null
              ? profile.attributes
              : {}
            const mappedGroups = _.get(attributes, conf.mappingGroups)
            const groups = Array.isArray(mappedGroups) ? mappedGroups : mappedGroups ? [mappedGroups] : null

            if (groups) {
              if (!hasGroupRelations(user)) {
                throw new Error('SAML user does not support group relations.')
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

          cb(null, asPassportUser(user))
        } catch (err: unknown) {
          cb(asError(err))
        }
      }, (req, _profile, cb) => {
        cb(null, req.user === undefined ? undefined : asPassportUser(req.user))
      })
    )
  }
}

export default plugin
