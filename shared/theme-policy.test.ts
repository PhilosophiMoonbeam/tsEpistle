import { describe, expect, test } from '../server/test/bun-test.mts'
import { cloneThemeColors, DEFAULT_THEME_COLORS } from './theme-colors.ts'
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

describe('saved reader presentation', () => {
  test('uses the reading defaults for absent or malformed legacy settings', () => {
    const expected = { textSize: 17, lineHeight: 1.68, copyWidth: 76 }
    expect(themePolicyFromConfiguration({}).reading).toEqual(expected)
    for (const reading of [
      null,
      {},
      { textSize: 20, lineHeight: 1.8 },
      { textSize: '20', lineHeight: 1.8, copyWidth: 90 },
      { textSize: 13, lineHeight: 1.8, copyWidth: 90 },
      { textSize: 20, lineHeight: 2.1, copyWidth: 90 },
      { textSize: 20, lineHeight: 1.8, copyWidth: 111 }
    ]) {
      expect(themePolicyFromConfiguration({ theming: { reading } }).reading).toEqual(expected)
    }
  })

  test('preserves saved custom reading values and palette colors across serialization', () => {
    const reading = { textSize: 20, lineHeight: 1.85, copyWidth: 92 }
    const colors = cloneThemeColors(DEFAULT_THEME_COLORS)
    colors.light.primary = '#27405A'
    colors.dark.surface = '#303B4C'
    const policy = themePolicyFromConfiguration({
      theming: { reading, colors }
    })
    expect(policy.reading).toEqual(reading)
    const palette = policy.palettes.find(item => item.id === policy.activePaletteId)!
    expect(palette.colors.light.primary).toBe('#27405A')
    expect(palette.colors.dark.surface).toBe('#303B4C')
    expect(themePolicyFromConfiguration(JSON.parse(JSON.stringify({ theming: policy })))).toEqual(policy)
  })

  test('keeps valid reader layout boundaries rather than resetting saved preferences', () => {
    for (const reading of [
      { textSize: 14, lineHeight: 1.4, copyWidth: 48 },
      { textSize: 24, lineHeight: 2, copyWidth: 110 }
    ]) {
      const policy = themePolicyFromConfiguration({ theming: { reading } })
      expect(ThemePolicySchema.parse(policy).reading).toEqual(reading)
      expect(themeChangedFields(policy, { ...policy, reading: { ...reading, copyWidth: 76 } })).toEqual(['reading'])
    }
  })
})
