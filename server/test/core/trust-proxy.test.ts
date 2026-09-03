import { once } from 'node:events'
import type { AddressInfo } from 'node:net'

import express from 'express'
import session from 'express-session'
import { sessionCookieOptions } from '../../helpers/session-cookie.ts'
import { describe, expect, it } from '../bun-test.mts'

interface IdentityResponse {
  ip: string
  ips: string[]
}

const resolveIdentity = async (trustProxy: boolean, forwardedFor: string): Promise<IdentityResponse> => {
  const app = express()
  app.set('trust proxy', trustProxy ? 1 : false)
  app.get('/identity', (req, res) => {
    res.json({ ip: req.ip, ips: req.ips })
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')

  try {
    const address = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${address.port}/identity`, {
      headers: { 'x-forwarded-for': forwardedFor }
    })
    expect(response.status).toBe(200)
    return (await response.json()) as IdentityResponse
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
}

const withAuthorizationSession = async <Result>(
  currentPublicHost: () => string,
  trustProxy: boolean,
  exercise: (baseUrl: string) => Promise<Result>
): Promise<Result> => {
  const app = express()
  app.set('trust proxy', trustProxy ? 1 : false)
  const currentSessionCookieOptions = sessionCookieOptions(currentPublicHost)
  app.use(
    session({
      secret: 'test-session-secret-at-least-32-characters',
      resave: false,
      saveUninitialized: false,
      cookie: currentSessionCookieOptions
    })
  )
  app.use((req, _res, next) => {
    if (!req.session) return next()

    const cookieOptions = currentSessionCookieOptions()
    if (Boolean(req.session.cookie.secure) === Boolean(cookieOptions.secure)) {
      Object.assign(req.session.cookie, cookieOptions)
      return next()
    }

    req.session.regenerate(error => {
      if (error) return next(error)
      Object.assign(req.session.cookie, currentSessionCookieOptions())
      next()
    })
  })
  app.get('/authorize', (req, res) => {
    req.session.pageUnlockEstablishedAt = (req.session.pageUnlockEstablishedAt ?? 0) + 1
    res.sendStatus(204)
  })
  app.get('/authorization', (req, res) => {
    res.json({ authorized: (req.session.pageUnlockEstablishedAt ?? 0) > 0 })
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')

  try {
    const address = server.address() as AddressInfo
    return await exercise(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
}

describe('trusted proxy client identity', () => {
  it('ignores forwarding headers when no proxy is trusted', async () => {
    const identity = await resolveIdentity(false, '198.51.100.10')

    expect(identity.ip).toBe('127.0.0.1')
    expect(identity.ips).toEqual([])
  })

  it('resolves the client supplied by one trusted reverse proxy', async () => {
    const identity = await resolveIdentity(true, '198.51.100.20')

    expect(identity.ip).toBe('198.51.100.20')
    expect(identity.ips).toEqual(['198.51.100.20'])
  })

  it('ignores prepended forwarding values beyond the one trusted proxy', async () => {
    const first = await resolveIdentity(true, '198.51.100.30, 10.0.0.10')
    const second = await resolveIdentity(true, '203.0.113.40, 10.0.0.10')

    expect(first).toEqual({ ip: '10.0.0.10', ips: ['10.0.0.10'] })
    expect(second).toEqual(first)
  })
})

describe('authorization session cookie security', () => {
  it('serializes secure cookie attributes behind the trusted TLS proxy without issuing the identifier on plaintext', async () => {
    await withAuthorizationSession(
      () => 'https://wiki.example.test',
      true,
      async baseUrl => {
        const plaintextResponse = await fetch(`${baseUrl}/authorize`)
        expect(plaintextResponse.status).toBe(204)
        expect(plaintextResponse.headers.get('set-cookie')).toBeNull()

        const secureResponse = await fetch(`${baseUrl}/authorize`, {
          headers: { 'x-forwarded-proto': 'https' }
        })
        expect(secureResponse.status).toBe(204)
        const attributes = (secureResponse.headers.get('set-cookie') ?? '').split(';').map(attribute => attribute.trim())
        expect(attributes[0]).toMatch(/^connect\.sid=/)
        expect(attributes).toContain('Secure')
        expect(attributes).toContain('HttpOnly')
        expect(attributes).toContain('SameSite=Lax')
      }
    )
  })

  it('issues and accepts a non-Secure session cookie for an HTTP localhost host', async () => {
    await withAuthorizationSession(
      () => 'http://localhost:3000',
      false,
      async baseUrl => {
        const authorizationResponse = await fetch(`${baseUrl}/authorize`)
        expect(authorizationResponse.status).toBe(204)
        const attributes = (authorizationResponse.headers.get('set-cookie') ?? '').split(';').map(attribute => attribute.trim())
        expect(attributes[0]).toMatch(/^connect\.sid=/)
        expect(attributes).not.toContain('Secure')
        expect(attributes).toContain('HttpOnly')
        expect(attributes).toContain('SameSite=Lax')

        const authorizedResponse = await fetch(`${baseUrl}/authorization`, {
          headers: { cookie: attributes[0] }
        })
        expect(authorizedResponse.status).toBe(200)
        expect(await authorizedResponse.json()).toEqual({ authorized: true })
      }
    )
  })

  it('rotates existing sessions when the public host protocol changes without remounting', async () => {
    let currentPublicHost = 'http://localhost:3000'

    await withAuthorizationSession(
      () => currentPublicHost,
      true,
      async baseUrl => {
        const initialResponse = await fetch(`${baseUrl}/authorize`)
        expect(initialResponse.status).toBe(204)
        const initialAttributes = (initialResponse.headers.get('set-cookie') ?? '').split(';').map(attribute => attribute.trim())
        const httpSessionCookie = initialAttributes[0]
        expect(httpSessionCookie).toMatch(/^connect\.sid=/)
        expect(initialAttributes).not.toContain('Secure')
        expect(initialAttributes).toContain('HttpOnly')
        expect(initialAttributes).toContain('SameSite=Lax')

        const initiallyAuthorizedResponse = await fetch(`${baseUrl}/authorization`, {
          headers: { cookie: httpSessionCookie }
        })
        expect(initiallyAuthorizedResponse.status).toBe(200)
        expect(await initiallyAuthorizedResponse.json()).toEqual({ authorized: true })

        currentPublicHost = 'https://wiki.example.test'

        const plaintextResponse = await fetch(`${baseUrl}/authorize`, {
          headers: { cookie: httpSessionCookie }
        })
        expect(plaintextResponse.status).toBe(204)
        expect(plaintextResponse.headers.get('set-cookie')).toBeNull()

        const invalidatedHttpSessionResponse = await fetch(`${baseUrl}/authorization`, {
          headers: {
            cookie: httpSessionCookie,
            'x-forwarded-proto': 'https'
          }
        })
        expect(invalidatedHttpSessionResponse.status).toBe(200)
        expect(invalidatedHttpSessionResponse.headers.get('set-cookie')).toBeNull()
        expect(await invalidatedHttpSessionResponse.json()).toEqual({ authorized: false })

        const secureResponse = await fetch(`${baseUrl}/authorize`, {
          headers: {
            cookie: httpSessionCookie,
            'x-forwarded-proto': 'https'
          }
        })
        expect(secureResponse.status).toBe(204)
        const secureAttributes = (secureResponse.headers.get('set-cookie') ?? '').split(';').map(attribute => attribute.trim())
        const httpsSessionCookie = secureAttributes[0]
        expect(httpsSessionCookie).toMatch(/^connect\.sid=/)
        expect(httpsSessionCookie).not.toBe(httpSessionCookie)
        expect(secureAttributes).toContain('Secure')
        expect(secureAttributes).toContain('HttpOnly')
        expect(secureAttributes).toContain('SameSite=Lax')

        const securelyAuthorizedResponse = await fetch(`${baseUrl}/authorization`, {
          headers: {
            cookie: httpsSessionCookie,
            'x-forwarded-proto': 'https'
          }
        })
        expect(securelyAuthorizedResponse.status).toBe(200)
        expect(await securelyAuthorizedResponse.json()).toEqual({ authorized: true })

        currentPublicHost = 'http://localhost:3000'

        const revertedResponse = await fetch(`${baseUrl}/authorize`, {
          headers: { cookie: httpsSessionCookie }
        })
        expect(revertedResponse.status).toBe(204)
        const revertedAttributes = (revertedResponse.headers.get('set-cookie') ?? '').split(';').map(attribute => attribute.trim())
        const revertedSessionCookie = revertedAttributes[0]
        expect(revertedSessionCookie).toMatch(/^connect\.sid=/)
        expect(revertedSessionCookie).not.toBe(httpsSessionCookie)
        expect(revertedAttributes).not.toContain('Secure')
        expect(revertedAttributes).toContain('HttpOnly')
        expect(revertedAttributes).toContain('SameSite=Lax')

        const invalidatedHttpsSessionResponse = await fetch(`${baseUrl}/authorization`, {
          headers: { cookie: httpsSessionCookie }
        })
        expect(invalidatedHttpsSessionResponse.status).toBe(200)
        expect(invalidatedHttpsSessionResponse.headers.get('set-cookie')).toBeNull()
        expect(await invalidatedHttpsSessionResponse.json()).toEqual({ authorized: false })

        const stillAuthorizedResponse = await fetch(`${baseUrl}/authorization`, {
          headers: { cookie: revertedSessionCookie }
        })
        expect(stillAuthorizedResponse.status).toBe(200)
        expect(await stillAuthorizedResponse.json()).toEqual({ authorized: true })
      }
    )
  })
})
