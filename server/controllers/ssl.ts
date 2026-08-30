import express from 'express'
import _ from 'lodash'

interface RedirectPathAndQuery {
  pathname: string
  search: string
}

const configuredHttpsOrigin = (configuredHost: string | undefined): URL | null => {
  if (!configuredHost) return null
  try {
    const configured = new URL(configuredHost)
    if (
      (configured.protocol !== 'http:' && configured.protocol !== 'https:') ||
      !configured.hostname ||
      configured.username ||
      configured.password ||
      configured.pathname !== '/' ||
      configured.search ||
      configured.hash
    )
      return null

    const redirectOrigin = new URL(configured.origin)
    redirectOrigin.protocol = 'https:'
    return redirectOrigin
  } catch {
    return null
  }
}

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
    letsencrypt: {
      challenge: false | { token: string; keyAuthorization: string }
    }
    server: { sslRedir: boolean }
  }
  logger: {
    info(message: string): void
    warn(message: string): void
  }
  servers: { servers: { https: unknown } }
}

export default function createSslController(wiki: SslWiki): express.Router {
  const router = express.Router()

  /**
   * Let's Encrypt Challenge
   */
  router.get('/.well-known/acme-challenge/:token', (req, res) => {
    res.type('text/plain')
    if (_.get(wiki.config, 'letsencrypt.challenge', false)) {
      if (wiki.config.letsencrypt.challenge && wiki.config.letsencrypt.challenge.token === req.params.token) {
        res.send(wiki.config.letsencrypt.challenge.keyAuthorization)
        wiki.logger.info(`(LETSENCRYPT) Received valid challenge request. [ ACCEPTED ]`)
      } else {
        res.status(406).send('Invalid Challenge Token!')
        wiki.logger.warn(`(LETSENCRYPT) Received invalid challenge request. [ REJECTED ]`)
      }
    } else {
      res.status(418).end()
    }
  })

  /**
   * Redirect to HTTPS if HTTP Redirection is enabled
   */
  router.all('/{*sslRedirectPath}', (req, res, next) => {
    if (!wiki.config.server.sslRedir || req.secure || !wiki.servers.servers.https) return next()

    const redirectOrigin = configuredHttpsOrigin(wiki.config.host)
    if (!redirectOrigin) {
      wiki.logger.warn('(SSL) HTTPS redirect rejected because the configured site host is not a valid HTTP(S) origin.')
      return res.sendStatus(500)
    }

    const requestTarget = safelyParsedPathAndQuery(req.originalUrl)
    if (!requestTarget) return res.sendStatus(400)
    redirectOrigin.pathname = requestTarget.pathname
    redirectOrigin.search = requestTarget.search
    return res.redirect(redirectOrigin.href)
  })

  return router
}
