import { describe, expect, test } from '../server/test/bun-test.mts'
import { ThemePolicySchema, themeChangedFields, themePolicyFromConfiguration } from './theme-policy.ts'

describe('theme navigation feedback policy', () => {
  test('preserves legacy route motion without enabling a new loading cue', () => {
    const policy = themePolicyFromConfiguration({})
    expect(policy.pageTransitions).toBe(true)
    expect(policy.showPageProgress).toBe(false)
    const { pageTransitions: _transitions, showPageProgress: _progress, ...legacy } = policy
    expect(ThemePolicySchema.parse(legacy)).toEqual(policy)
  })

  test('round-trips every independent boolean setting through saved configuration', () => {
    for (const pageTransitions of [false, true]) {
      for (const showPageProgress of [false, true]) {
        const policy = ThemePolicySchema.parse({ ...themePolicyFromConfiguration({}), pageTransitions, showPageProgress })
        const configuration = JSON.parse(JSON.stringify({ theming: policy }))
        expect(themePolicyFromConfiguration(configuration)).toEqual(policy)
      }
    }
  })

  test('rejects coercion and unreviewed fields while repairing malformed legacy configuration', () => {
    const policy = themePolicyFromConfiguration({})
    for (const invalid of ['false', 'true', 0, 1, null, {}]) {
      expect(ThemePolicySchema.safeParse({ ...policy, pageTransitions: invalid }).success).toBe(false)
      expect(ThemePolicySchema.safeParse({ ...policy, showPageProgress: invalid }).success).toBe(false)
      const legacy = themePolicyFromConfiguration({ theming: { pageTransitions: invalid, showPageProgress: invalid } })
      expect(legacy.pageTransitions).toBe(true)
      expect(legacy.showPageProgress).toBe(false)
    }
    expect(ThemePolicySchema.safeParse({ ...policy, arbitraryMotion: true }).success).toBe(false)
  })

  test('includes both settings in the reviewed change set without treating one as the other', () => {
    const saved = themePolicyFromConfiguration({})
    expect(themeChangedFields(saved, { ...saved, pageTransitions: false })).toEqual(['pageTransitions'])
    expect(themeChangedFields(saved, { ...saved, showPageProgress: true })).toEqual(['showPageProgress'])
    expect(themeChangedFields(saved, { ...saved, pageTransitions: false, showPageProgress: true })).toEqual(['pageTransitions', 'showPageProgress'])
  })
})
