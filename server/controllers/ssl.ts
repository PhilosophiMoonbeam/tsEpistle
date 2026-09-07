import express from 'express'
import { publicTlsTarget } from '../repositories/tls-probe.ts'

interface RedirectPathAndQuery {
  pathname: string
  search: string
}

const configuredHttpsOrigin = (configuredHost: string | undefined): URL | null => (publicTlsTarget(configuredHost) ? new URL(configuredHost!) : null)

const safelyParsedPathAndQuery = (originalUrl: string): RedirectPathAndQuery | null => {
  try {
    const parsed = new URL(originalUrl, 'http://request.invalid')
    if (parsed.hash) return null
    return { pathname: parsed.pathname, search: parsed.search }
  } catch {
    return null
  }
}
export interface SslWiki {
  config: {
    host?: string
    server: { sslRedir: boolean }
    security?: { securityTrustProxy?: boolean }
  }
  logger: {
    info(message: string): void
    warn(message: string): void
  }
  servers: { servers: { https: { listening?: boolean } | null }; le?: { readonly challenge: { token: string; keyAuthorization?: string } | null } | null }
}

export default function createSslController(wiki: SslWiki): express.Router {
  const router = express.Router()

  /**
   * Let's Encrypt Challenge
   */
  router.get('/.well-known/acme-challenge/:token', (req, res) => {
    res.type('text/plain')
    res.set('Cache-Control', 'no-store')
    const challenge = wiki.servers.le?.challenge
    if (!challenge?.keyAuthorization) return res.status(418).end()
    if (challenge.token !== req.params.token) return res.status(406).send('Invalid Challenge Token!')
    return res.send(challenge.keyAuthorization)
  })

  /**
   * Redirect to HTTPS if HTTP Redirection is enabled
   */
  router.all('/{*sslRedirectPath}', (req, res, next) => {
    if (!wiki.config.server.sslRedir || req.secure) return next()
    if (!wiki.servers.servers.https?.listening && wiki.config.security?.securityTrustProxy !== true) return next()

    const redirectOrigin = configuredHttpsOrigin(wiki.config.host)
    if (!redirectOrigin) {
      wiki.logger.warn('(SSL) HTTPS redirect rejected because the configured site host is not a valid HTTPS origin.')
      return res.sendStatus(503)
    }

    const requestTarget = safelyParsedPathAndQuery(req.originalUrl)
    if (!requestTarget) return res.sendStatus(400)
    redirectOrigin.pathname = requestTarget.pathname
    redirectOrigin.search = requestTarget.search
    return res.redirect(redirectOrigin.href)
  })

  return router
}
