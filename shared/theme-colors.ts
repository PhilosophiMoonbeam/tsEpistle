import { z } from 'zod'

export const THEME_COLOR_KEYS = [
  'background',
  'surface',
  'primary',
  'secondary',
  'accent',
  'info',
  'success',
  'warning',
  'error'
] as const

export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number]

const HexThemeColorSchema = z.string()
  .regex(/^#[0-9a-f]{6}$/i)
  .transform(value => value.toUpperCase())

export const ThemeModeColorsSchema = z.object({
  background: HexThemeColorSchema,
  surface: HexThemeColorSchema,
  primary: HexThemeColorSchema,
  secondary: HexThemeColorSchema,
  accent: HexThemeColorSchema,
  info: HexThemeColorSchema,
  success: HexThemeColorSchema,
  warning: HexThemeColorSchema,
  error: HexThemeColorSchema
}).strict()

export const ThemeColorsSchema = z.object({
  light: ThemeModeColorsSchema,
  dark: ThemeModeColorsSchema
}).strict()

export type ThemeModeColors = z.infer<typeof ThemeModeColorsSchema>
export type ThemeColors = z.infer<typeof ThemeColorsSchema>

export const DEFAULT_THEME_COLORS: ThemeColors = {
  light: {
    background: '#FFFFFF',
    surface: '#FFFFFF',
    primary: '#1867C0',
    secondary: '#48A9A6',
    accent: '#82B1FF',
    info: '#2196F3',
    success: '#4CAF50',
    warning: '#FB8C00',
    error: '#B00020'
  },
  dark: {
    background: '#121212',
    surface: '#212121',
    primary: '#2196F3',
    secondary: '#54B6B2',
    accent: '#448AFF',
    info: '#64B5F6',
    success: '#66BB6A',
    warning: '#FFA726',
    error: '#CF6679'
  }
}

export const isHexThemeColor = (value: unknown): value is string => HexThemeColorSchema.safeParse(value).success
export const isThemeColors = (value: unknown): value is ThemeColors => ThemeColorsSchema.safeParse(value).success

export const normalizeThemeColors = (value: unknown): ThemeColors => {
  const result = ThemeColorsSchema.safeParse(value)
  return result.success ? result.data : cloneThemeColors(DEFAULT_THEME_COLORS)
}

export const cloneThemeColors = (colors: ThemeColors): ThemeColors => ({
  light: { ...colors.light },
  dark: { ...colors.dark }
})
