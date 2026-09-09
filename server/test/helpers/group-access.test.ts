import { describe, expect, it } from '../bun-test.mts'
import { createApiPrincipal, isApiPrincipal } from '../../helpers/api-principal.ts'
import { evaluateGroupAccess, pageRuleRequesterBinding, type AccessRule } from '../../helpers/group-access.ts'
const rule = (id: string, path: string, match: AccessRule['match'] = 'START', deny = false, values: Partial<AccessRule> = {}): AccessRule => ({
  id,
  path,
  match,
  deny,
  roles: ['read:pages'],
  locales: [],
  ...values
})
const evaluate = (rules: AccessRule[], path = 'guides/start') =>
  evaluateGroupAccess(['read:pages'], ['read:pages'], [{ id: 3, name: 'Readers', pageRules: rules }], { path, locale: 'en' })
describe('Group access explanation and enforcement', () => {
  it('binds explicit API principals to their exact key and group without a human owner', () => {
    const first = createApiPrincipal(7, 3, ['read:pages'])
    const second = createApiPrincipal(8, 3, ['read:pages'])
    expect(isApiPrincipal(first)).toBe(true)
    expect(first).not.toHaveProperty('id')
    expect(pageRuleRequesterBinding(first)).toEqual({ kind: 'apiKey', apiKeyId: 7, groupId: 3 })
    expect(pageRuleRequesterBinding(second)).toEqual({ kind: 'apiKey', apiKeyId: 8, groupId: 3 })
    expect(pageRuleRequesterBinding({ id: 1, api: 7, grp: 3, ownershipUserId: null, groups: [3] })).toEqual({ kind: 'anonymous' })
  })
  it('requires both global permission and a matching page grant', () => {
    expect(evaluate([]).allowed).toBe(false)
    expect(evaluate([rule('all', '')]).allowed).toBe(true)
    expect(evaluateGroupAccess([], ['read:pages'], [{ id: 3, pageRules: [rule('all', '')] }], { path: 'home' })).toMatchObject({
      allowed: false,
      reason: 'The required global permission is missing.'
    })
    expect(evaluateGroupAccess(['manage:system'], ['read:pages'], [], { path: 'home' }).allowed).toBe(true)
  })
  it('selects longer text before match type and deny wins a matching tie', () => {
    const result = evaluate([rule('all', ''), rule('deny-guides', 'guides', 'START', true), rule('specific', 'guides/start', 'EXACT')])
    expect(result.allowed).toBe(true)
    expect(result.rules.filter(r => r.outcome === 'winner').map(r => r.ruleId)).toEqual(['specific'])
    for (const rules of [
      [rule('allow', 'guides'), rule('deny', 'guides', 'START', true)],
      [rule('deny', 'guides', 'START', true), rule('allow', 'guides')]
    ]) {
      expect(evaluate(rules).allowed).toBe(false)
      expect(evaluate(rules).rules.find(r => r.ruleId === 'deny')?.outcome).toBe('winner')
    }
    expect(evaluate([rule('regex', '.+', 'REGEX', true), rule('prefix', 'guides')]).allowed).toBe(true)
  })
  it('uses type priority only when matching text lengths tie', () => {
    const result = evaluate([rule('prefix', 'guides/start', 'START', true), rule('exact', 'guides/start', 'EXACT')])
    expect(result.allowed).toBe(true)
    expect(result.rules.find(r => r.ruleId === 'exact')?.outcome).toBe('winner')
  })
  it('explains locale, action and match exclusions without granting access', () => {
    const result = evaluate([
      rule('fr', '', 'START', false, { locales: ['fr'] }),
      rule('edit', '', 'START', false, { roles: ['write:pages'] }),
      rule('other', 'other'),
      rule('bad', '[', 'REGEX')
    ])
    expect(result.allowed).toBe(false)
    expect(result.rules.map(r => r.outcome)).toEqual(['locale', 'permission', 'no-match', 'no-match'])
  })
  it('combines memberships and resolves taxonomy aliases and archive state', () => {
    const groups = [
      { id: 3, pageRules: [rule('all', '')] },
      { id: 4, pageRules: [rule('restricted', 'old-tag', 'TAG', true)] }
    ]
    const result = evaluateGroupAccess(['read:pages'], ['read:pages'], groups, { path: 'home', tags: [{ tag: 'canonical' }] }, { 'old-tag': 'canonical' })
    expect(result.allowed).toBe(false)
    expect(result.rules.find(r => r.outcome === 'winner')?.groupId).toBe(4)
    expect(evaluateGroupAccess(['read:pages'], ['read:pages'], groups, { path: 'home', tags: [{ tag: 'old-tag' }] }, { 'old-tag': null }).allowed).toBe(true)
  })
  it('matches suffixes and regexes without treating paths as regular expressions', () => {
    expect(evaluate([rule('suffix', 'start', 'END')]).allowed).toBe(true)
    expect(evaluate([rule('regex', '^guides/[a-z]+$', 'REGEX')]).allowed).toBe(true)
    expect(evaluate([rule('literal', 'guides/.*', 'START')]).allowed).toBe(false)
  })
})
