/** @vitest-environment node */

import { beforeEach, describe, expect, it } from 'vitest'

import auth from '../../core/auth.ts'

type PageRule = {
  deny: boolean
  locales?: string[]
  match: 'START' | 'END' | 'REGEX' | 'TAG' | 'EXACT'
  path: string
  roles: string[]
}

const page = {
  locale: 'en',
  path: 'docs/public/guide',
  tags: [{ tag: 'published' }]
}

const user = (groups: Array<number | { id: number }> = [1], permissions = ['read:pages']) => ({
  id: 7,
  groups,
  permissions
})

const group = (id: number, pageRules: PageRule[]) => ({
  id,
  permissions: ['read:pages'],
  pageRules
})

const rule = (overrides: Partial<PageRule> = {}): PageRule => ({
  deny: false,
  match: 'START',
  path: 'docs',
  roles: ['read:pages'],
  ...overrides
})

describe('page-rule authorization contract', () => {
  beforeEach(() => {
    auth.groups = {}
  })

  it('denies missing principals, absent global permissions, and pages without a matching rule', () => {
    auth.groups = { '1': group(1, []) }

    expect(auth.checkAccess(undefined, ['read:pages'])).toBe(false)
    expect(auth.checkAccess(user([1], []), ['read:pages'])).toBe(false)
    expect(auth.checkAccess(user(), ['read:pages'])).toBe(true)
    expect(auth.checkAccess(user(), ['read:pages'], page)).toBe(false)
  })

  it('lets manage:system bypass global and page-scoped rules', () => {
    expect(auth.checkAccess(user([], ['manage:system']), ['delete:pages'], page)).toBe(true)
  })

  it('uses the most specific matching path across groups regardless of group order', () => {
    auth.groups = {
      '1': group(1, [rule({ deny: true, path: 'docs' })]),
      '2': group(2, [rule({ path: 'docs/public' })])
    }

    expect(auth.checkAccess(user([1, 2]), ['read:pages'], page)).toBe(true)
    expect(auth.checkAccess(user([2, 1]), ['read:pages'], page)).toBe(true)
  })

  it('makes deny win an otherwise identical rule regardless of rule order', () => {
    const allow = rule({ match: 'EXACT', path: page.path })
    const deny = rule({ deny: true, match: 'EXACT', path: page.path })

    auth.groups = { '1': group(1, [allow, deny]) }
    expect(auth.checkAccess(user(), ['read:pages'], page)).toBe(false)

    auth.groups = { '1': group(1, [deny, allow]) }
    expect(auth.checkAccess(user(), ['read:pages'], page)).toBe(false)
  })

  it('makes an exact match outrank a prefix rule at equal specificity', () => {
    const allowExact = rule({ match: 'EXACT', path: page.path })
    const denyPrefix = rule({ deny: true, match: 'START', path: page.path })

    auth.groups = { '1': group(1, [denyPrefix, allowExact]) }
    expect(auth.checkAccess(user(), ['read:pages'], page)).toBe(true)

    auth.groups = { '1': group(1, [allowExact, denyPrefix]) }
    expect(auth.checkAccess(user(), ['read:pages'], page)).toBe(true)
  })

  it('applies locale, tag, role, and group-id constraints', () => {
    auth.groups = {
      '1': group(1, [
        rule({ locales: ['fr'] }),
        rule({ match: 'TAG', path: 'published', roles: ['write:pages'] })
      ]),
      '2': group(2, [rule({ match: 'TAG', path: 'published' })])
    }

    expect(auth.checkAccess(user([{ id: 1 }]), ['read:pages'], page)).toBe(false)
    expect(auth.checkAccess(user([{ id: 2 }]), ['read:pages'], page)).toBe(true)
    expect(auth.checkAccess(user([{ id: 2 }]), ['write:pages'], page)).toBe(false)
    expect(auth.checkAccess(user([{ id: 99 }]), ['read:pages'], page)).toBe(false)
  })

  it('treats an invalid regular expression as non-matching instead of breaking access', () => {
    auth.groups = {
      '1': group(1, [
        rule({ match: 'REGEX', path: '[invalid' }),
        rule({ match: 'EXACT', path: page.path })
      ])
    }

    expect(() => auth.checkAccess(user(), ['read:pages'], page)).not.toThrow()
    expect(auth.checkAccess(user(), ['read:pages'], page)).toBe(true)

    auth.groups = { '1': group(1, [rule({ match: 'REGEX', path: '[invalid' })]) }
    expect(auth.checkAccess(user(), ['read:pages'], page)).toBe(false)
  })
})
