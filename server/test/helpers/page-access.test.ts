import { beforeEach, describe, expect, it, vi } from '../bun-test.mts'

import {
  canDeletePage,
  canReadPage,
  canWritePage,
  isValidPageRuleRegex,
  managesSystem,
  pageRoute,
  pageRuleRegexMatches,
  principalId,
  scopePageQuery,
  scopePageQueryForOwner
} from '../../helpers/page-access.ts'
import type { PagePrincipal } from '../../helpers/page-access.ts'
import type { PageRuleAuthority } from '../../helpers/group-access.ts'

beforeEach(() => {
  global.WIKI = {
    auth: {
      checkAccess: (user, permissions) => permissions.some(permission => user?.permissions?.includes(permission)),
      checkPageAccess: (user, permissions, _context, authority: PageRuleAuthority) =>
        authority.requester === user &&
        (authority.permissions.includes('manage:system') || permissions.some(permission => authority.permissions.includes(permission)))
    }
  }
})

const owner = { id: 7, permissions: [] }
const otherUser = { id: 8, permissions: ['read:pages', 'write:pages', 'delete:pages'] }
const administrator = { id: 9, permissions: ['manage:system'] }
const publicPage = { visibility: 'public' as const, ownerId: null, localeCode: 'en', path: 'same/path', tags: [] }
const privatePage = { visibility: 'private' as const, ownerId: 7, localeCode: 'en', path: 'same/path' }

const authorityFor = (requester: PagePrincipal): PageRuleAuthority => Object.freeze({
  requester,
  permissions: Object.freeze(Array.isArray(requester?.permissions) ? [...requester.permissions] : []),
  groups: Object.freeze([]),
  tagAliases: Object.freeze({})
})

describe('owner-scoped page access', () => {
  it('keeps public and private pages with the same locale/path independently addressable', () => {
    expect(pageRoute(publicPage)).toBe('/en/same/path')
    expect(pageRoute(privatePage)).toBe('/_private/en/same/path')
  })

  it('allows only the owner or a system administrator to read a private page', () => {
    const anonymous = undefined
    const unrelatedUser = { id: 2, permissions: [] }
    expect(canReadPage(owner, privatePage, authorityFor(owner))).toBe(true)
    expect(canReadPage(otherUser, privatePage, authorityFor(otherUser))).toBe(false)
    expect(canReadPage(anonymous, privatePage, authorityFor(anonymous))).toBe(false)
    expect(canReadPage(unrelatedUser, privatePage, authorityFor(unrelatedUser))).toBe(false)
    expect(canReadPage(administrator, privatePage, authorityFor(administrator))).toBe(true)
  })

  it('does not let ordinary page permissions cross a private ownership boundary', () => {
    expect(canWritePage(otherUser, privatePage, authorityFor(otherUser))).toBe(false)
    expect(canDeletePage(otherUser, privatePage, authorityFor(otherUser))).toBe(false)
    expect(canWritePage(owner, privatePage, authorityFor(owner))).toBe(true)
    expect(canDeletePage(owner, privatePage, authorityFor(owner))).toBe(true)
  })

  it('never treats a synthetic API principal as private-page owner', () => {
    const apiPrincipal = {
      id: 1,
      ownershipUserId: null,
      permissions: ['read:pages', 'write:pages', 'delete:pages']
    }
    const userOnePrivatePage = { ...privatePage, ownerId: 1 }
    expect(principalId(apiPrincipal)).toBeNull()
    expect(canReadPage(apiPrincipal, userOnePrivatePage, authorityFor(apiPrincipal))).toBe(false)
    expect(canWritePage(apiPrincipal, userOnePrivatePage, authorityFor(apiPrincipal))).toBe(false)
    expect(canDeletePage(apiPrincipal, userOnePrivatePage, authorityFor(apiPrincipal))).toBe(false)
  })

  it('preserves normal permission checks for public pages', () => {
    const reader = { id: 2, permissions: ['read:pages'] }
    expect(canReadPage(reader, publicPage, authorityFor(reader))).toBe(true)
    expect(canWritePage(owner, publicPage, authorityFor(owner))).toBe(false)
    expect(canWritePage(otherUser, publicPage, authorityFor(otherUser))).toBe(true)
    expect(canDeletePage(otherUser, publicPage, authorityFor(otherUser))).toBe(true)
  })


  it('recognizes only valid principals and explicit system managers', () => {
    expect(principalId(owner)).toBe(7)
    expect(principalId({ id: 1 })).toBe(1)
    expect(principalId({ id: 2 })).toBeNull()
    expect(principalId({ id: 0 })).toBeNull()
    expect(principalId({ id: Number.NaN })).toBeNull()
    expect(managesSystem(administrator)).toBe(true)
    expect(managesSystem(otherUser)).toBe(false)
  })

  it('validates and safely evaluates administrator-supplied regular expressions', () => {
    expect(isValidPageRuleRegex('^docs/(public|shared)/')).toBe(true)
    expect(pageRuleRegexMatches('^docs/(public|shared)/', 'docs/public/guide')).toBe(true)
    expect(pageRuleRegexMatches('^docs/(public|shared)/', 'private/guide')).toBe(false)
    expect(isValidPageRuleRegex('[invalid')).toBe(false)
    expect(pageRuleRegexMatches('[invalid', 'docs/public/guide')).toBe(false)
  })

  it('scopes database queries to public rows plus the current owner, or all rows for administrators', () => {
    const where = vi.fn()
    const orWhere = vi.fn()
    const wherePublic = vi.fn((criteria, callback) => {
      const applyScope = typeof criteria === 'function' ? criteria : callback
      if (typeof applyScope === 'function') applyScope({ where, orWhere })
    })
    const query = { where: wherePublic, orWhere }
    expect(scopePageQuery(query, owner)).toBe(query)
    expect(wherePublic).toHaveBeenCalledOnce()
    expect(where).toHaveBeenCalledWith('visibility', 'public')
    expect(orWhere).toHaveBeenCalledWith({ visibility: 'private', ownerId: 7 })

    wherePublic.mockClear()
    expect(scopePageQuery(query, administrator, { includeAllForSystemManager: true })).toBe(query)
    expect(wherePublic).not.toHaveBeenCalled()
  })

  it('scopes non-request rendering and history queries to an explicit owner', () => {
    const where = vi.fn()
    const orWhere = vi.fn()
    const query = {
      where: vi.fn(callback => {
        callback({ where, orWhere })
        return query
      }),
      orWhere
    }

    expect(scopePageQueryForOwner(query, 7, { table: 'pageHistory' })).toBe(query)
    expect(where).toHaveBeenCalledWith('pageHistory.visibility', 'public')
    expect(orWhere).toHaveBeenCalledWith({
      'pageHistory.visibility': 'private',
      'pageHistory.ownerId': 7
    })
  })
})
