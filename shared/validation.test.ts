import { describe, expect, it } from 'vitest'

import validateValues from './validation.ts'

describe('shared validation', () => {
  it('returns flat, human-readable errors in schema order', () => {
    const result = validateValues({ email: 'invalid', name: 'x' }, {
      email: { email: true },
      name: { length: { minimum: 2, maximum: 255 } }
    }, { format: 'flat' })

    expect(result).toEqual([
      'Email is not a valid email',
      'Name is too short (minimum is 2 characters)'
    ])
  })

  it('preserves custom messages and attribute-specific results', () => {
    const result = validateValues({ password: 'secret', verifyPassword: 'different' }, {
      password: {
        presence: { allowEmpty: false, message: 'Password is required' }
      },
      verifyPassword: {
        equality: { attribute: 'password', message: 'Passwords do not match' }
      }
    }, { fullMessages: false })

    expect(result).toEqual({ verifyPassword: ['Passwords do not match'] })
  })

  it('accepts local HTTP URLs and rejects trailing slashes and data URLs', () => {
    const schema = {
      siteUrl: {
        url: {
          schemes: ['http', 'https'],
          allowLocal: true,
          allowDataUrl: false
        },
        format: {
          pattern: '^(?!.*/$).*$',
          message: 'must not have a trailing slash'
        }
      }
    }

    expect(validateValues({ siteUrl: 'http://localhost:3000' }, schema, { format: 'flat' })).toBeUndefined()
    expect(validateValues({ siteUrl: 'http://localhost:3000/' }, schema, { format: 'flat' })).toEqual([
      'Site Url must not have a trailing slash'
    ])
    expect(validateValues({ siteUrl: 'data:text/html,unsafe' }, schema, { format: 'flat' })).toEqual([
      'Site Url is not a valid url'
    ])
  })

  it('rejects oversized hostile email input without a vulnerable regular expression', () => {
    const hostile = `${'a'.repeat(100_000)}!@example.com`
    expect(validateValues({ email: hostile }, { email: { email: true } }, { format: 'flat' })).toEqual([
      'Email is not a valid email'
    ])
  })
})
