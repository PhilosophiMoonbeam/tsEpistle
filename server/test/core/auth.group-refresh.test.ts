import { DateTime } from 'luxon'
import { afterAll, describe, expect, it, vi } from '../bun-test.mts'
import auth from '../../core/auth.ts'
import type { PageRuleAuthority } from '../../helpers/group-access.ts'
const originalWiki = globalThis.WIKI
const original = { groups: auth.groups, tagAliases: auth.tagAliases, guest: auth.guest }
afterAll(() => {
  globalThis.WIKI = originalWiki
  Object.assign(auth, original)
})
describe('group authorization cache refresh', () => {
  it('clears caches after a failed refresh, rebuilds them on success, and preserves snapshotted authority', async () => {
    const group = {
      id: 3,
      permissions: ['read:pages'],
      pageRules: [{ match: 'START' as const, path: '', roles: ['read:pages'], deny: false, locales: [] }]
    }
    const refreshedGroup = { ...group, name: 'Refreshed', permissions: ['read:pages', 'write:pages'] }
    const tags = [
      { id: 8, tag: 'legacy', redirectToId: 9 },
      { id: 9, tag: 'current' }
    ]
    const query = vi.fn().mockRejectedValueOnce(new Error('Database unavailable')).mockResolvedValue([refreshedGroup])
    globalThis.WIKI = {
      config: {},
      configSvc: {},
      events: {},
      lang: {},
      logger: {},
      startedAt: {},
      models: { groups: { query }, tags: { query: async () => tags } }
    } as never
    auth.groups = { '3': group } as never
    auth.tagAliases = { old: 'new' }
    auth.guest = { cacheExpiration: DateTime.utc().plus({ minutes: 1 }) } as never
    const person = { id: 7, groups: [3], permissions: ['read:pages'] }
    const page = { path: 'docs', locale: 'en', tags: [] }
    const authority: PageRuleAuthority = Object.freeze({
      requester: person,
      permissions: Object.freeze(['read:pages']),
      groups: Object.freeze([Object.freeze({
        ...group,
        permissions: Object.freeze([...group.permissions]),
        pageRules: Object.freeze([...group.pageRules])
      })]),
      tagAliases: Object.freeze({})
    })

    expect(auth.checkPageAccess(person, ['read:pages'], page, authority)).toBe(true)
    await expect(auth.reloadGroups()).rejects.toThrow('Database unavailable')
    expect(auth.groups).toEqual({})
    expect(auth.tagAliases).toEqual({})
    expect(auth.guest.cacheExpiration < DateTime.utc()).toBe(true)
    expect(auth.checkPageAccess(person, ['read:pages'], page, authority)).toBe(true)
    await auth.reloadGroups()
    expect(auth.groups).toEqual({ '3': refreshedGroup })
    expect(auth.tagAliases).toEqual({ legacy: 'current', current: 'current' })
    expect(auth.checkPageAccess(person, ['read:pages'], page, authority)).toBe(true)
  })
})
