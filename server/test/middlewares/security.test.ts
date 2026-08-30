import type { NextFunction, Request, Response } from 'express'
import { afterAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

interface SecurityConfig {
  securityIframe: boolean
  securityReferrerPolicy: boolean
  securityHSTS: boolean
  securityHSTSDuration: number
  securityOpenRedirect: boolean
  securityCSP: boolean
  securityCSPDirectives: string
}

const security: SecurityConfig = {
  securityIframe: true,
  securityReferrerPolicy: true,
  securityHSTS: true,
  securityHSTSDuration: 300,
  securityOpenRedirect: false,
  securityCSP: false,
  securityCSPDirectives: ''
}

// A static import would read WIKI before the test can install it, so load after stubbing module initialization.
vi.stubGlobal('WIKI', { config: { security } })
const { default: securityMiddleware } = await import('../../middlewares/security.ts')

afterAll(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  Object.assign(security, {
    securityIframe: true,
    securityReferrerPolicy: true,
    securityHSTS: true,
    securityHSTSDuration: 300,
    securityOpenRedirect: false,
    securityCSP: false,
    securityCSPDirectives: ''
  })
})

interface MiddlewareResult {
  headers: Array<[string, string]>
  nextCalls: number
}

const invokeMiddleware = (): MiddlewareResult => {
  const headers: Array<[string, string]> = []
  const req = {
    app: { disable: vi.fn() },
    url: '/test'
  } as unknown as Request
  const res = {
    set: (name: string, value: string) => {
      headers.push([name, value])
      return res
    }
  } as unknown as Response
  const next = vi.fn()

  securityMiddleware(req, res, next as NextFunction)

  return { headers, nextCalls: next.mock.calls.length }
}

const headerValues = (headers: Array<[string, string]>, name: string): string[] =>
  headers.filter(([headerName]) => headerName.toLowerCase() === name.toLowerCase()).map(([, value]) => value)

const expectExistingSecurityHeaders = (headers: Array<[string, string]>): void => {
  expect(headerValues(headers, 'Strict-Transport-Security')).toEqual(['max-age=300; includeSubDomains'])
  expect(headerValues(headers, 'X-Frame-Options')).toEqual(['deny'])
  expect(headerValues(headers, 'Referrer-Policy')).toEqual(['same-origin'])
  expect(headerValues(headers, 'X-Content-Type-Options')).toEqual(['nosniff'])
}

describe('security header middleware', () => {
  it('emits exactly one configured CSP header when enabled', () => {
    security.securityCSP = true
    security.securityCSPDirectives = "default-src 'self'; img-src 'self' data:"

    const { headers, nextCalls } = invokeMiddleware()

    expect(headerValues(headers, 'Content-Security-Policy')).toEqual(["default-src 'self'; img-src 'self' data:"])
    expectExistingSecurityHeaders(headers)
    expect(nextCalls).toBe(1)
  })

  it('does not emit a CSP header when disabled', () => {
    security.securityCSP = false
    security.securityCSPDirectives = "default-src 'none'"

    const { headers, nextCalls } = invokeMiddleware()

    expect(headerValues(headers, 'Content-Security-Policy')).toEqual([])
    expectExistingSecurityHeaders(headers)
    expect(nextCalls).toBe(1)
  })

  it('does not emit persisted directive values containing CR or LF', () => {
    security.securityCSP = true

    for (const directives of ["default-src 'self'\rX-Injected: true", "default-src 'self'\nX-Injected: true", "default-src 'self'\r\nX-Injected: true"]) {
      security.securityCSPDirectives = directives

      const { headers, nextCalls } = invokeMiddleware()

      expect(headerValues(headers, 'Content-Security-Policy')).toEqual([])
      expect(headerValues(headers, 'X-Injected')).toEqual([])
      expectExistingSecurityHeaders(headers)
      expect(nextCalls).toBe(1)
    }
  })
})
