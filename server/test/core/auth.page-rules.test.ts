
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import auth from '../../core/auth.ts'
import type { PageRuleAuthority } from '../../helpers/group-access.ts'

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

type TestUser = {
  id: number
  groups: Array<number | { id: number }>
  permissions: string[]
}

const user = (groups: Array<number | { id: number }> = [1], permissions = ['read:pages']): TestUser => ({
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
  const authorityFor = (
    requester: TestUser,
    groups: PageRuleAuthority['groups'] = [],
    tagAliases: Readonly<Record<string, string | null>> = {}
  ): PageRuleAuthority => Object.freeze({
    requester,
    permissions: Object.freeze([...requester.permissions]),
    groups: Object.freeze(groups),
    tagAliases: Object.freeze({ ...tagAliases })
  })


  it('denies missing principals, absent global permissions, and pages without a matching rule', () => {
    const noPermissions = user([1], [])
    const requester = user()

    expect(auth.checkAccess(undefined, ['read:pages'])).toBe(false)
    expect(auth.checkAccess(noPermissions, ['read:pages'])).toBe(false)
    expect(auth.checkAccess(requester, ['read:pages'])).toBe(true)
    expect(auth.checkPageAccess(requester, ['read:pages'], page, authorityFor(requester, [group(1, [])]))).toBe(false)
  })

  it('lets manage:system bypass global and page-scoped rules', () => {
    const requester = user([], ['manage:system'])
    expect(auth.checkPageAccess(requester, ['delete:pages'], page, authorityFor(requester))).toBe(true)
  })

  it('resolves old tag names in access rules and cached page labels, while archived names fail closed', () => {
    const requester = user()
    const accessGroup = group(1, [rule({ match: 'TAG', path: 'old-label' })])
    const aliases = { 'old-label': 'published', published: 'published', retired: null }
    const activeAuthority = authorityFor(requester, [accessGroup], aliases)

    expect(auth.checkPageAccess(requester, ['read:pages'], page, activeAuthority)).toBe(true)
    expect(auth.checkPageAccess(requester, ['read:pages'], { ...page, tags: [{ tag: 'old-label' }] }, activeAuthority)).toBe(true)

    const archivedAuthority = authorityFor(requester, [accessGroup], { ...aliases, 'old-label': null })
    expect(auth.checkPageAccess(requester, ['read:pages'], page, archivedAuthority)).toBe(false)
    expect(auth.checkPageAccess(requester, ['read:pages'], { ...page, tags: [{ tag: 'old-label' }] }, archivedAuthority)).toBe(false)

    const retiredAuthority = authorityFor(requester, [group(1, [rule({ match: 'TAG', path: 'retired' })])], aliases)
    expect(auth.checkPageAccess(requester, ['read:pages'], { ...page, tags: [{ tag: 'retired' }] }, retiredAuthority)).toBe(false)
  })

  it('uses the most specific matching path across groups regardless of group order', () => {
    const groups = [
      group(1, [rule({ deny: true, path: 'docs' })]),
      group(2, [rule({ path: 'docs/public' })])
    ]
    const firstRequester = user([1, 2])
    const secondRequester = user([2, 1])

    expect(auth.checkPageAccess(firstRequester, ['read:pages'], page, authorityFor(firstRequester, groups))).toBe(true)
    expect(auth.checkPageAccess(secondRequester, ['read:pages'], page, authorityFor(secondRequester, [...groups].reverse()))).toBe(true)
  })

  it('makes deny win an otherwise identical rule regardless of rule order', () => {
    const allow = rule({ match: 'EXACT', path: page.path })
    const deny = rule({ deny: true, match: 'EXACT', path: page.path })
    const requester = user()

    expect(auth.checkPageAccess(requester, ['read:pages'], page, authorityFor(requester, [group(1, [allow, deny])]))).toBe(false)
    expect(auth.checkPageAccess(requester, ['read:pages'], page, authorityFor(requester, [group(1, [deny, allow])]))).toBe(false)
  })

  it('makes an exact match outrank a prefix rule at equal specificity', () => {
    const allowExact = rule({ match: 'EXACT', path: page.path })
    const denyPrefix = rule({ deny: true, match: 'START', path: page.path })
    const requester = user()

    expect(auth.checkPageAccess(requester, ['read:pages'], page, authorityFor(requester, [group(1, [denyPrefix, allowExact])]))).toBe(true)
    expect(auth.checkPageAccess(requester, ['read:pages'], page, authorityFor(requester, [group(1, [allowExact, denyPrefix])]))).toBe(true)
  })

  it('applies locale, tag, role, and group-id constraints', () => {
    const groups = {
      first: group(1, [
        rule({ locales: ['fr'] }),
        rule({ match: 'TAG', path: 'published', roles: ['write:pages'] })
      ]),
      second: group(2, [rule({ match: 'TAG', path: 'published' })])
    }
    const firstRequester = user([{ id: 1 }])
    const secondRequester = user([{ id: 2 }])
    const wrongRoleRequester = user([{ id: 2 }], ['write:pages'])
    const unknownGroupRequester = user([{ id: 99 }])

    expect(auth.checkPageAccess(firstRequester, ['read:pages'], page, authorityFor(firstRequester, [groups.first]))).toBe(false)
    expect(auth.checkPageAccess(secondRequester, ['read:pages'], page, authorityFor(secondRequester, [groups.second]))).toBe(true)
    expect(auth.checkPageAccess(wrongRoleRequester, ['write:pages'], page, authorityFor(wrongRoleRequester, [groups.second]))).toBe(false)
    expect(auth.checkPageAccess(unknownGroupRequester, ['read:pages'], page, authorityFor(unknownGroupRequester))).toBe(false)
  })

  it('treats an invalid regular expression as non-matching instead of breaking access', () => {
    const requester = user()
    const matchingAuthority = authorityFor(requester, [group(1, [
      rule({ match: 'REGEX', path: '[invalid' }),
      rule({ match: 'EXACT', path: page.path })
    ])])

    expect(auth.checkPageAccess(requester, ['read:pages'], page, matchingAuthority)).toBe(true)

    const invalidOnlyAuthority = authorityFor(requester, [group(1, [rule({ match: 'REGEX', path: '[invalid' })])])
    expect(auth.checkPageAccess(requester, ['read:pages'], page, invalidOnlyAuthority)).toBe(false)
  })
})


describe('group assignment authorization contract', () => {
  const originalWiki = Reflect.get(globalThis, 'WIKI')
  let assignmentGroups: Array<{ id: number; permissions: string[] }>

  beforeEach(() => {
    assignmentGroups = []
    Reflect.set(globalThis, 'WIKI', {
      config: {},
      configSvc: {},
      events: {},
      lang: {},
      logger: {},
      models: {
        groups: {
          query: () => ({
            whereIn: async (_column: string, ids: readonly number[]) => assignmentGroups.filter(candidate => ids.includes(candidate.id))
          })
        }
      },
      startedAt: {}
    })
  })

  afterEach(() => {
    if (originalWiki === undefined) Reflect.deleteProperty(globalThis, 'WIKI')
    else Reflect.set(globalThis, 'WIKI', originalWiki)
  })

  it.each(['write:users', 'manage:users', 'write:groups', 'manage:groups'])(
    'prevents delegated %s authority from assigning a write:scripts group',
    async permission => {
      assignmentGroups = [{ id: 7, permissions: ['read:pages', 'write:scripts'] }]

      await expect(auth.checkAssignUserToGroupAccess(user([], [permission]), [7])).resolves.toBe(false)
    }
  )

  it('allows only system authority to assign script groups while preserving ordinary assignments', async () => {
    assignmentGroups = [{ id: 7, permissions: ['write:scripts'] }]
    await expect(auth.checkAssignUserToGroupAccess(user([], ['manage:system']), [7])).resolves.toBe(true)

    assignmentGroups = [{ id: 8, permissions: ['read:pages', 'write:pages'] }]
    await expect(auth.checkAssignUserToGroupAccess(user([], ['manage:users']), [8])).resolves.toBe(true)
  })
})
