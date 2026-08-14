import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  canDeletePage,
  canReadPage,
  canWritePage,
  managesSystem,
  pageRoute,
  principalId,
  scopePageQuery,
  scopePageQueryForOwner
} from '../../helpers/page-access.ts'

beforeEach(() => {
  global.WIKI = {
    auth: {
      checkAccess: (user, permissions) => permissions.some(permission => user?.permissions?.includes(permission))
    }
  }
})

const owner = { id: 7, permissions: [] }
const otherUser = { id: 8, permissions: ['read:pages', 'write:pages', 'delete:pages'] }
const administrator = { id: 9, permissions: ['manage:system'] }
const publicPage = { visibility: 'public' as const, ownerId: null, localeCode: 'en', path: 'same/path' }
const privatePage = { visibility: 'private' as const, ownerId: 7, localeCode: 'en', path: 'same/path' }

describe('owner-scoped page access', () => {
  it('keeps public and private pages with the same locale/path independently addressable', () => {
    expect(pageRoute(publicPage)).toBe('/en/same/path')
    expect(pageRoute(privatePage)).toBe('/_private/en/same/path')
  })

  it('allows only the owner or a system administrator to read a private page', () => {
    expect(canReadPage(owner, privatePage)).toBe(true)
    expect(canReadPage(otherUser, privatePage)).toBe(false)
    expect(canReadPage(undefined, privatePage)).toBe(false)
    expect(canReadPage({ id: 2, permissions: [] }, privatePage)).toBe(false)
    expect(canReadPage(administrator, privatePage)).toBe(true)
  })

  it('does not let ordinary page permissions cross a private ownership boundary', () => {
    expect(canWritePage(otherUser, privatePage)).toBe(false)
    expect(canDeletePage(otherUser, privatePage)).toBe(false)
    expect(canWritePage(owner, privatePage)).toBe(true)
    expect(canDeletePage(owner, privatePage)).toBe(true)
  })

  it('preserves normal permission checks for public pages', () => {
    expect(canReadPage({ id: 2, permissions: ['read:pages'] }, publicPage)).toBe(true)
    expect(canWritePage(owner, publicPage)).toBe(false)
    expect(canWritePage(otherUser, publicPage)).toBe(true)
    expect(canDeletePage(otherUser, publicPage)).toBe(true)
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
