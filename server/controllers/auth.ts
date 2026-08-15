/* global WIKI */

import express from 'express'
import type { Request, Response } from 'express'
import { createAuthRateLimiter, setAuthRateLimitHeaders } from '../helpers/auth-rate-limiter.ts'
import _ from 'lodash'
import commonHelper from '../helpers/common.ts'
import type { Knex } from 'knex'

interface AuthenticationStrategy {
  key: string
  strategyKey: string
}

interface AuthUser {
  id: number
}

interface AuthWiki {
  models: {
    knex: Knex
    authentication: {
      getStrategy(key: string): Promise<{ selfRegistration: boolean }>
      query(): { orderBy(column: string): { first(): Promise<AuthenticationStrategy> } }
    }
    users: {
      login(input: Record<string, unknown>, context: { req: Request; res: Response }): Promise<{ jwt: string; redirect?: string }>
      logout(context: { req: Request; res: Response }): Promise<string>
      query(): { patch(input: Record<string, unknown>): { where(column: string, value: unknown): Promise<unknown> } }
      refreshToken(user: AuthUser): Promise<{ token: string }>
    }
    userKeys: {
      validateToken(input: { kind: string; token: string }): Promise<AuthUser>
      generateToken(input: { userId: number; kind: string }): Promise<string>
    }
  }
  config: {
    auth: {
      autoLogin: boolean
      enforce2FA: boolean
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

const wiki = WIKI as unknown as AuthWiki

const routeParam = (req: Request, name: string): string => {
  const value = req.params[name]
  if (typeof value !== 'string') {
    throw new Error(`Route parameter ${name} is unavailable`)
  }
  return value
}



const router = express.Router()

const bruteforce = createAuthRateLimiter({
  knex: wiki.models.knex,
  keyPrefix: 'auth-html',
  onLimit: (_req, res, retryAfterMs) => {
    setAuthRateLimitHeaders(res, retryAfterMs)
    res.status(429).send('Too many failed attempts. Try again later.')
  }
})

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
  const bgUrl = !_.isEmpty(wiki.config.auth.loginBgUrl) ? wiki.config.auth.loginBgUrl : '/_assets/img/splash/1.jpg'
  res.render('login', { bgUrl, hideLocal: wiki.config.auth.hideLocal })
})

/**
 * Social Strategies Login
 */
router.get('/login/:strategy', async (req, res, next) => {
  try {
    await wiki.models.users.login({
      strategy: req.params.strategy
    }, { req, res })
  } catch (err) {
    next(err)
  }
})

/**
 * Social Strategies Callback
 */
router.all('/login/:strategy/callback', async (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'POST') { return next() }

  try {
    const authResult = await wiki.models.users.login({
      strategy: req.params.strategy
    }, { req, res })
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
  if (localStrg.selfRegistration) {
    res.render('register')
  } else {
    next(new wiki.Error.AuthRegistrationDisabled())
  }
})

/**
 * Verify
 */
router.get('/verify/:token', bruteforce.middleware, async (req, res, next) => {
  try {
    const token = routeParam(req, 'token')
    const usr = await wiki.models.userKeys.validateToken({ kind: 'verify', token })
    await wiki.models.users.query().patch({ isVerified: true }).where('id', usr.id)
    await bruteforce.reset(req)
    if (wiki.config.auth.enforce2FA) {
      res.redirect('/login')
    } else {
      const result = await wiki.models.users.refreshToken(usr)
      res.cookie('jwt', result.token, commonHelper.getCookieOpts())
      res.redirect('/')
    }
  } catch (err) {
    next(err)
  }
})

/**
 * Reset Password
 */
router.get('/login-reset/:token', bruteforce.middleware, async (req, res, next) => {
  try {
    const token = routeParam(req, 'token')
    const usr = await wiki.models.userKeys.validateToken({ kind: 'resetPwd', token })
    if (!usr) {
      throw new Error('Invalid Token')
    }
    await bruteforce.reset(req)

    const changePwdContinuationToken = await wiki.models.userKeys.generateToken({
      userId: usr.id,
      kind: 'changePwd'
    })
    const bgUrl = !_.isEmpty(wiki.config.auth.loginBgUrl) ? wiki.config.auth.loginBgUrl : '/_assets/img/splash/1.jpg'
    res.render('login', { bgUrl, hideLocal: wiki.config.auth.hideLocal, changePwdContinuationToken })
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

export default router
