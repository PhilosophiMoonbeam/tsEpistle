import type { Knex } from 'knex'
import { asError, wiki, type AuthenticationConfig, type AuthenticationPlugin } from '../../types.ts'
import _ from 'lodash'

// ------------------------------------
// CAS Account
// ------------------------------------

import { FederatedLoginStore } from '../../../repositories/federated-login.ts'
import { CasStrategy } from './cas-strategy.ts'

const plugin: AuthenticationPlugin = {
  init (passport, conf) {
    const providerRevision = (conf as AuthenticationConfig & { adminRevision?: unknown }).adminRevision
    if (typeof providerRevision !== 'string' || providerRevision.length === 0) {
      throw new Error('CAS authentication requires a provider configuration revision.')
    }
    const store = new FederatedLoginStore(wiki.models.knex as unknown as Knex)
    passport.use(conf.key,
      new CasStrategy({
        version: conf.casVersion,
        ssoBaseURL: conf.casUrl,
        serverBaseURL: conf.baseUrl,
        serviceURL: conf.callbackURL,
        passReqToCallback: true,
        federation: {
          providerKey: conf.key,
          providerRevision,
          store
        }
      }, async (req, profile, cb) => {
        try {
          if (typeof profile === 'string') {
            throw new Error('CAS profile attributes are unavailable.')
          }
          const user = await wiki.models.users.processProfile({
            providerKey: req.params.strategy,
            profile: {
              ...profile,
              id: _.get(profile.attributes, conf.uniqueIdAttribute, profile.user),
              email: _.get(profile.attributes, conf.emailAttribute),
              name: _.get(profile.attributes, conf.displayNameAttribute, profile.user),
              picture: ''
            }
          })

          cb(null, user)
        } catch (err: unknown) {
          cb(asError(err))
        }
      })
    )
  }
}

export default plugin
