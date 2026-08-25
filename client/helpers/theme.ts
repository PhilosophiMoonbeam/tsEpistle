import type { ThemeDefinition, ThemeInstance } from 'vuetify'
import type { ThemeColors } from '../../shared/theme-colors.ts'

export type WikiThemeName = 'light' | 'dark' | 'system'

export const resolveThemeName = (appearance: string, siteDarkMode: boolean): WikiThemeName => {
  if (appearance === 'dark' || appearance === 'light' || appearance === 'system') return appearance
  return siteDarkMode ? 'dark' : 'light'
}

export const WIKI_THEME_VARIATIONS = {
  colors: ['primary', 'secondary', 'accent', 'info', 'success', 'warning', 'error'],
  lighten: 1,
  darken: 1
}

export const createWikiThemes = (colors: ThemeColors): Record<'light' | 'dark', ThemeDefinition> => ({
  light: {
    dark: false,
    colors: { ...colors.light }
  },
  dark: {
    dark: true,
    colors: { ...colors.dark }
  }
})

export const applyWikiThemeColors = (theme: ThemeInstance, colors: ThemeColors): void => {
  Object.assign(theme.themes.value.light.colors, colors.light)
  Object.assign(theme.themes.value.dark.colors, colors.dark)
}
