import { describe, expect, test } from 'vitest'
import type { ThemeInstance } from 'vuetify'
import { cloneThemeColors, DEFAULT_THEME_COLORS } from '../../shared/theme-colors.ts'
import { applyWikiThemeColors, createWikiThemes, resolveThemeName, WIKI_THEME_VARIATIONS } from './theme.ts'

describe('frontend theme helpers', () => {
  test('resolves user appearance before the site default', () => {
    expect(resolveThemeName('', false)).toBe('light')
    expect(resolveThemeName('', true)).toBe('dark')
    expect(resolveThemeName('light', true)).toBe('light')
    expect(resolveThemeName('dark', false)).toBe('dark')
    expect(resolveThemeName('system', false)).toBe('system')
  })

  test('creates independent light and dark Vuetify definitions', () => {
    const colors = cloneThemeColors(DEFAULT_THEME_COLORS)
    colors.dark.primary = '#ABCDEF'

    expect(createWikiThemes(colors)).toMatchObject({
      light: { dark: false, colors: { primary: DEFAULT_THEME_COLORS.light.primary } },
      dark: { dark: true, colors: { primary: '#ABCDEF' } }
    })
  })

  test('derives palette variations for every configurable semantic color', () => {
    expect(WIKI_THEME_VARIATIONS).toEqual({
      colors: ['primary', 'secondary', 'accent', 'info', 'success', 'warning', 'error'],
      lighten: 1,
      darken: 1
    })
  })

  test('updates both installed themes without discarding generated colors', () => {
    const colors = cloneThemeColors(DEFAULT_THEME_COLORS)
    colors.light.primary = '#123456'
    const theme = {
      themes: {
        value: {
          light: { dark: false, colors: { ...DEFAULT_THEME_COLORS.light, 'on-primary': '#FFFFFF' }, variables: {} },
          dark: { dark: true, colors: { ...DEFAULT_THEME_COLORS.dark, 'on-primary': '#000000' }, variables: {} }
        }
      }
    } as unknown as ThemeInstance

    applyWikiThemeColors(theme, colors)

    expect(theme.themes.value.light.colors.primary).toBe('#123456')
    expect(theme.themes.value.light.colors['on-primary']).toBe('#FFFFFF')
    expect(theme.themes.value.dark.colors.background).toBe(DEFAULT_THEME_COLORS.dark.background)
  })
})
