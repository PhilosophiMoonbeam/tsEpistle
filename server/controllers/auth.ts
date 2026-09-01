import express from 'express'
import type { Request, Response } from 'express'
import _ from 'lodash'
import commonHelper from '../helpers/common.ts'

interface AuthenticationStrategy {
  key: string
  strategyKey: string
}

export interface AuthWiki {
  models: {
    authentication: {
      getStrategy(key: string): Promise<{ selfRegistration: boolean }>
      query(): { orderBy(column: string): { first(): Promise<AuthenticationStrategy> } }
    }
    users: {
      login(input: Record<string, unknown>, context: { req: Request; res: Response }): Promise<{ jwt: string; redirect?: string }>
      logout(context: { req: Request; res: Response }): Promise<string>
    }
    userKeys: {
      validateToken(input: { kind: string; token: string; skipDelete?: boolean }): Promise<unknown>
    }
  }
  config: {
    logoUrl: string
    auth: {
      autoLogin: boolean
      hideLocal: boolean
      loginBgUrl: string
    }
    certs: {
      jwk: unknown
      public: string
    }
  }
  data: { authentication: Array<{ key: string; useForm: boolean }> }
  Error: { AuthRegistrationDisabled: new () => Error }
}

const DEFAULT_AUTH_BACKGROUND_URL = '/_assets/img/splash/tsfranki-orbit.svg'

const normalizeAuthBackgroundUrl = (backgroundUrl: unknown): string => {
  if (typeof backgroundUrl !== 'string') return DEFAULT_AUTH_BACKGROUND_URL
  const normalizedBackgroundUrl = backgroundUrl.trim()
  return normalizedBackgroundUrl || DEFAULT_AUTH_BACKGROUND_URL
}

export const normalizeFaviconUrl = (logoUrl: unknown): string => {
  if (typeof logoUrl !== 'string') return '/_assets/favicon.ico'
  const normalizedLogoUrl = logoUrl.trim()
  return normalizedLogoUrl || '/_assets/favicon.ico'
}

const routeParam = (req: Request, name: string): string => {
  const value = req.params[name]
  if (typeof value !== 'string') {
    throw new Error(`Route parameter ${name} is unavailable`)
  }
  return value
}

export default function createAuthController(wiki: AuthWiki): express.Router {
  const router = express.Router()

  /**
   * Login form
   */
  router.get('/login', async (req, res) => {
    _.set(res.locals, 'pageMeta.title', 'Login')

    // -> Bypass Login
    if (wiki.config.auth.autoLogin && !req.query.all) {
      const stg = await wiki.models.authentication.query().orderBy('order').first()
      const stgInfo = _.find(wiki.data.authentication, ['key', stg.strategyKey])
      if (stgInfo && !stgInfo.useForm) {
        return res.redirect(`/login/${stg.key}`)
      }
    }

    // -> Show Login
    const bgUrl = normalizeAuthBackgroundUrl(wiki.config.auth.loginBgUrl)
    res.render('login', { bgUrl, hideLocal: wiki.config.auth.hideLocal, faviconUrl: normalizeFaviconUrl(wiki.config.logoUrl) })
  })

  /**
   * Social Strategies Login
   */
  router.get('/login/:strategy', async (req, res, next) => {
    try {
      await wiki.models.users.login(
        {
          strategy: req.params.strategy
        },
        { req, res }
      )
    } catch (err) {
      next(err)
    }
  })

  /**
   * Social Strategies Callback
   */
  router.all('/login/:strategy/callback', async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      return next()
    }

    try {
      const authResult = await wiki.models.users.login(
        {
          strategy: req.params.strategy
        },
        { req, res }
      )
      res.cookie('jwt', authResult.jwt, commonHelper.getCookieOpts())

      const loginRedirectValue: unknown = req.cookies['loginRedirect']
      const loginRedirect = typeof loginRedirectValue === 'string' ? loginRedirectValue : undefined
      const isValidRedirect = loginRedirect !== undefined && loginRedirect.startsWith('/') && !loginRedirect.startsWith('//') && !loginRedirect.includes('://')
      if (loginRedirect === '/' && authResult.redirect) {
        res.clearCookie('loginRedirect')
        res.redirect(authResult.redirect)
      } else if (isValidRedirect) {
        res.clearCookie('loginRedirect')
        res.redirect(loginRedirect)
      } else {
        if (loginRedirect) {
          res.clearCookie('loginRedirect')
        }
        if (authResult.redirect) {
          res.redirect(authResult.redirect)
        } else {
          res.redirect('/')
        }
      }
    } catch (err) {
      next(err)
    }
  })

  /**
   * Logout
   */
  router.get('/logout', async (req, res, next) => {
    const redirURL = await wiki.models.users.logout({ req, res })
    req.logout(err => {
      if (err) return next(err)
      res.clearCookie('jwt')
      res.redirect(redirURL)
    })
  })

  /**
   * Register form
   */
  router.get('/register', async (req, res, next) => {
    _.set(res.locals, 'pageMeta.title', 'Register')
    const localStrg = await wiki.models.authentication.getStrategy('local')
    const bgUrl = normalizeAuthBackgroundUrl(wiki.config.auth.loginBgUrl)
    if (localStrg.selfRegistration) {
      res.render('register', {
        bgUrl,
        faviconUrl: normalizeFaviconUrl(wiki.config.logoUrl)
      })
    } else {
      next(new wiki.Error.AuthRegistrationDisabled())
    }
  })

  /**
   * Email verification landing page.
   *
   * A GET only validates and presents the confirmation action. The token is consumed by the explicit
   * POST from the login component, so automated mail-link scanners cannot activate the account.
   */
  router.get('/verify/:token', async (req, res, next) => {
    try {
      _.set(res.locals, 'pageMeta.title', 'Confirm Email Address')
      const token = routeParam(req, 'token')
      await wiki.models.userKeys.validateToken({ kind: 'verify', token, skipDelete: true })
      const bgUrl = normalizeAuthBackgroundUrl(wiki.config.auth.loginBgUrl)
      res.render('login', {
        bgUrl,
        hideLocal: wiki.config.auth.hideLocal,
        faviconUrl: normalizeFaviconUrl(wiki.config.logoUrl),
        verificationToken: token
      })
    } catch (err) {
      next(err)
    }
  })

  /**
   * Password reset landing page.
   *
   * GET validation is deliberately non-consuming. The token is consumed only after a valid password
   * is submitted to the reset endpoint.
   */
  router.get('/login-reset/:token', async (req, res, next) => {
    try {
      _.set(res.locals, 'pageMeta.title', 'Reset Password')
      const token = routeParam(req, 'token')
      await wiki.models.userKeys.validateToken({ kind: 'resetPwd', token, skipDelete: true })
      const bgUrl = normalizeAuthBackgroundUrl(wiki.config.auth.loginBgUrl)
      res.render('login', {
        bgUrl,
        hideLocal: wiki.config.auth.hideLocal,
        faviconUrl: normalizeFaviconUrl(wiki.config.logoUrl),
        resetPasswordToken: token
      })
    } catch (err) {
      next(err)
    }
  })

  /**
   * JWT Public Endpoints
   */
  router.get('/.well-known/jwk.json', function (req, res) {
    res.json(wiki.config.certs.jwk)
  })
  router.get('/.well-known/jwk.pem', function (req, res) {
    res.send(wiki.config.certs.public)
  })

  return router
}
