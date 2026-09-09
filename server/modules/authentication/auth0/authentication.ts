import { discovery } from 'openid-client'

import { asError, wiki, type AuthenticationConfig, type AuthenticationPlugin } from '../../types.ts'
import { OpenIDClientStrategy } from '../openid-client-strategy.ts'
import { providerRevisionFromConfig } from '../oauth-state.ts'

type LogoutAuthenticationPlugin = AuthenticationPlugin & {
  logout(conf: AuthenticationConfig): string
}

const issuerUrl = (domain: string): URL => new URL(domain.startsWith('http://') || domain.startsWith('https://') ? domain : `https://${domain}/`)

const plugin: LogoutAuthenticationPlugin = {
  async init(passport, conf) {
    const config = await discovery(issuerUrl(conf.domain), conf.clientId, { client_secret: conf.clientSecret })
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
          name: 'auth0'
        },
        async (req, tokens, cb) => {
          try {
            const claims = tokens.claims()
            if (!claims) throw new Error('Auth0 ID token claims are unavailable.')
            const profile = {
              ...claims,
              provider: 'auth0',
              id: claims.sub,
              user_id: claims.sub,
              displayName: claims.name ?? claims.nickname,
              picture: claims.picture,
              _json: claims,
              _raw: JSON.stringify(claims)
            }
            const user = await wiki.models.users.processProfile({
              providerKey: req.params.strategy,
              profile
            })
            cb(null, user)
          } catch (err: unknown) {
            cb(asError(err), null)
          }
        }
      )
    )
  },
  logout(conf) {
    return `https://${conf.domain}/v2/logout?${new URLSearchParams({ client_id: conf.clientId, returnTo: wiki.config.host }).toString()}`
  }
}

export default plugin
