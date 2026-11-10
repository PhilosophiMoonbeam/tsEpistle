import fs from 'node:fs'
import { describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { groupPermissions, normalizeGroupRulePath, type GroupPageRule, type GroupPolicyDraft } from '../../../shared/group-policy.ts'
import { evaluateGroupAccess } from '../../../server/helpers/group-access.ts'

interface RuleState {
  draft: GroupPageRule
  modelValue: GroupPolicyDraft
  disabled: boolean
  editingId: string
  issue: string
  literalWarning: string
  $emit: ReturnType<typeof vi.fn>
  apply(): void
  literalIdentity(rule: GroupPageRule, authored?: boolean): string
}
function editor(rule: GroupPageRule): RuleState {
  const source = fs.readFileSync('client/components/admin/admin-groups-edit-rules.vue', 'utf8')
  const script = source.match(/<script lang="ts">([\s\S]*?)<\/script>/)![1]!
  const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .+$/gm, '').replace('export default', 'const component ='))
  const component = new Function('groupPermissions', 'normalizeGroupRulePath', 'AsyncState', compiled + ';return component')(groupPermissions, normalizeGroupRulePath, {})
  const state = { ...component.data.call({ $t: (key: string) => key }), draft: rule, disabled: false, editingId: '', modelValue: { name: 'Literal', description: '', formMfaRequired: false, redirectOnLogin: '/', permissions: ['read:pages', 'read:assets'], pageRules: [] }, $t: (key: string) => key, $emit: vi.fn() }
  for (const [key, method] of Object.entries(component.methods)) state[key] = (method as (...args: unknown[]) => unknown).bind(state)
  for (const [key, getter] of Object.entries(component.computed)) Object.defineProperty(state, key, { get: () => (getter as () => unknown).call(state) })
  return state as RuleState
}
const rule = (path: string, match: GroupPageRule['match'] = 'EXACT', deny = false): GroupPageRule => ({ id: 'literal', path, match, deny, roles: ['read:pages', 'read:assets'], locales: [] })
function saved(state: RuleState): GroupPageRule {
  state.apply()
  const emission = state.$emit.mock.calls.find((call: unknown[]) => call[0] === 'update:modelValue')!
  return (emission[1] as GroupPolicyDraft).pageRules[0]!
}
function allows(r: GroupPageRule, path: string, permission = 'read:pages', locale = 'en', tags: string[] = []) {
  return evaluateGroupAccess(['read:pages', 'read:assets'], [permission], [{ id: 9, name: 'Literal', pageRules: [r] }], { path, locale, tags: tags.map(tag => ({ tag })) }).allowed
}
describe('literal group rule authoring', () => {
  it('keeps case, Unicode form, slashes and percent text unchanged through applying a rule', () => {
    for (const path of ['Guide', 'guide', 'caf\u00e9', 'cafe\u0301', '/Guide', 'Guide/', 'Guide//child', 'Guide%2Fchild', 'Guide%20name']) {
      const state = editor(rule(path))
      expect(state.literalIdentity(state.draft, true)).toBe(JSON.stringify(path))
      const applied = saved(state)
      expect(applied.path).toBe(path)
      for (const permission of ['read:pages', 'read:assets']) {
        expect(allows(applied, path, permission)).toBe(true)
        expect(allows(applied, path + '/child', permission)).toBe(false)
      }
    }
  })
  it('does not conflate case, Unicode normalization or encoded slashes', () => {
    for (const [a, b] of [['Guide', 'guide'], ['caf\u00e9', 'cafe\u0301'], ['Guide%2Fchild', 'Guide/child'], ['/Guide', 'Guide']]) {
      expect(allows(saved(editor(rule(a!))), b!)).toBe(false)
    }
  })
  it('discloses existing whitespace and subtree normalization without rewriting displayed stored rules', () => {
    const state = editor(rule(' Guide/// ', 'SUBTREE'))
    expect(state.literalIdentity(state.draft)).toBe('" Guide/// "')
    expect(state.literalIdentity(state.draft, true)).toBe('"Guide"')
    const applied = saved(state)
    expect(applied.path).toBe('Guide')
    expect(allows(applied, 'Guide')).toBe(true)
    expect(allows(applied, 'Guide/child')).toBe(true)
    expect(allows(applied, 'Guidebook')).toBe(false)
  })
  it('keeps a leading slash and percent text literal when applying a rule', () => {
    for (const path of ['/Guide', 'Guide%2Fchild']) {
      const state = editor(rule(path))
      expect(saved(state).path).toBe(path)
    }
  })
  it('keeps deny and locale behavior in the real evaluator', () => {
    const applied = saved(editor({ ...rule('Guide', 'EXACT', true), locales: ['fr'] }))
    expect(allows(applied, 'Guide', 'read:pages', 'fr')).toBe(false)
    const allowed = { ...applied, deny: false }
    expect(allows(allowed, 'Guide', 'read:pages', 'fr')).toBe(true)
    expect(allows(allowed, 'Guide', 'read:pages', 'en')).toBe(false)
  })
  it('keeps tag and regex controls separate from literal warnings and matching', () => {
    const tag = editor(rule('/Tag%20', 'TAG'))
    expect(tag.literalWarning).toBe('')
    expect(allows(saved(tag), 'unrelated', 'read:pages', 'en', ['/Tag%20'])).toBe(true)
    const regex = editor(rule('^Guide/(one|two)$', 'REGEX'))
    expect(regex.literalWarning).toBe('')
    const applied = saved(regex)
    expect(allows(applied, 'Guide/one')).toBe(true)
    expect(allows(applied, 'guide/one')).toBe(false)
  })
  it('preserves prefix and suffix text matching rather than treating either as a subtree', () => {
    const prefix = saved(editor(rule('Guide', 'START')))
    expect(allows(prefix, 'Guidebook')).toBe(true)
    expect(allows(prefix, 'guidebook')).toBe(false)
    const suffix = saved(editor(rule('Guide', 'END')))
    expect(allows(suffix, 'OtherGuide')).toBe(true)
    expect(allows(suffix, 'OtherGuide/child')).toBe(false)
  })
})
