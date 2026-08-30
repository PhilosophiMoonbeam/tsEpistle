import { describe, expect, test } from '../../server/test/bun-test.mts'
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
    colors.light.primary = '#F9A134'
    colors.dark.primary = '#ABCDEF'
    colors.dark.secondary = '#A6A8AA'
    colors.dark.info = '#73ADD3'

    expect(createWikiThemes(colors)).toMatchObject({
      light: {
        dark: false,
        colors: {
          primary: '#F9A134',
          'on-primary': '#000000',
          'surface-bright': '#F8F9FA',
          'surface-light': '#F1F2F3',
          'surface-variant': '#F8F8F8',
          'on-surface-variant': '#000000',
          focus: '#000000'
        }
      },
      dark: {
        dark: true,
        colors: {
          primary: '#ABCDEF',
          secondary: '#A6A8AA',
          info: '#73ADD3',
          'on-primary': '#000000',
          'on-secondary': '#000000',
          'on-info': '#000000',
          'surface-bright': '#3E4144',
          'surface-light': '#313437',
          'surface-variant': '#1E2123',
          'on-surface-variant': '#FFFFFF',
          focus: '#FFFFFF'
        }
      }
    })
  })

  test('derives palette variations for every configurable semantic color', () => {
    expect(WIKI_THEME_VARIATIONS).toEqual({
      colors: ['primary', 'secondary', 'accent', 'info', 'success', 'warning', 'error'],
      lighten: 1,
      darken: 1
    })
  })

  test('updates configured and derived colors without discarding unrelated Vuetify-only colors', () => {
    const colors = cloneThemeColors(DEFAULT_THEME_COLORS)
    colors.light.primary = '#F9A134'
    const theme = {
      themes: {
        value: {
          light: {
            dark: false,
            colors: { ...DEFAULT_THEME_COLORS.light, 'on-primary': '#FFFFFF', 'surface-bright': '#EEEEEE', outline: '#DDDDDD' },
            variables: {}
          },
          dark: { dark: true, colors: { ...DEFAULT_THEME_COLORS.dark, 'on-primary': '#000000', outline: '#333333' }, variables: {} }
        }
      }
    } as unknown as ThemeInstance

    applyWikiThemeColors(theme, colors)

    expect(theme.themes.value.light.colors.primary).toBe('#F9A134')
    expect(theme.themes.value.light.colors['on-primary']).toBe('#000000')
    expect(theme.themes.value.dark.colors.background).toBe(DEFAULT_THEME_COLORS.dark.background)
    expect(theme.themes.value.light.colors['surface-bright']).toBe('#F8F9FA')
    expect(theme.themes.value.light.colors.outline).toBe('#DDDDDD')
    expect(theme.themes.value.dark.colors['on-primary']).toBe('#000000')
    expect(theme.themes.value.dark.colors.outline).toBe('#333333')
  })
})
