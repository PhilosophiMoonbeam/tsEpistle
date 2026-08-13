import express from 'express'
import _ from 'lodash'
interface SslWiki {
  config: {
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

const wiki = WIKI as unknown as SslWiki


const router = express.Router()

/* global WIKI */

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
  if (wiki.config.server.sslRedir && !req.secure && wiki.servers.servers.https) {
    return res.redirect(`https://${req.hostname}${req.originalUrl}`)
  } else {
    next()
  }
})

export default router
