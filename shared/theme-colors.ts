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
    background: '#F4F1EA',
    surface: '#FCFBF8',
    primary: '#E88D1F',
    secondary: '#3B4D6B',
    accent: '#8C6239',
    info: '#2F6F9F',
    success: '#347A55',
    warning: '#A85B00',
    error: '#B33A45'
  },
  dark: {
    background: '#111317',
    surface: '#181B20',
    primary: '#F9A134',
    secondary: '#8CA2C6',
    accent: '#D4A373',
    info: '#73ADD3',
    success: '#72B38D',
    warning: '#E4A24B',
    error: '#D97A83'
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
