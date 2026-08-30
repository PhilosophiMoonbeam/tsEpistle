import { z } from 'zod'
import {
  cloneThemeColors,
  DEFAULT_THEME_COLORS,
  ThemeColorsSchema,
  type ThemeColors
} from './theme-colors.ts'

export const DEFAULT_THEME_PALETTE_ID = 'luminous-archive'
export const MAX_THEME_PALETTES = 24

export const ThemePaletteSchema = z.object({
  id: z.string().trim().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().trim().min(1).max(80),
  colors: ThemeColorsSchema
}).strict()

export const ThemePalettesSchema = z.array(ThemePaletteSchema)
  .min(1)
  .max(MAX_THEME_PALETTES)
  .superRefine((palettes, context) => {
    const ids = new Set<string>()
    for (const [index, palette] of palettes.entries()) {
      if (ids.has(palette.id)) {
        context.addIssue({
          code: 'custom',
          message: 'Theme palette identifiers must be unique.',
          path: [index, 'id']
        })
      }
      ids.add(palette.id)
    }
  })

export type ThemePalette = z.infer<typeof ThemePaletteSchema>

export const cloneThemePalette = (palette: ThemePalette): ThemePalette => ({
  id: palette.id,
  name: palette.name,
  colors: cloneThemeColors(palette.colors)
})

export const cloneThemePalettes = (palettes: ThemePalette[]): ThemePalette[] => palettes.map(cloneThemePalette)

export const createDefaultThemePalette = (colors: ThemeColors = DEFAULT_THEME_COLORS): ThemePalette => ({
  id: DEFAULT_THEME_PALETTE_ID,
  name: 'Luminous Archive',
  colors: cloneThemeColors(colors)
})

export const isThemePalettes = (value: unknown): value is ThemePalette[] => ThemePalettesSchema.safeParse(value).success

export const normalizeThemePalettes = (
  value: unknown,
  fallbackColors: ThemeColors = DEFAULT_THEME_COLORS
): ThemePalette[] => {
  const result = ThemePalettesSchema.safeParse(value)
  return result.success ? cloneThemePalettes(result.data) : [createDefaultThemePalette(fallbackColors)]
}

export const resolveThemePaletteId = (value: unknown, palettes: ThemePalette[]): string => {
  if (typeof value === 'string' && palettes.some(palette => palette.id === value)) return value
  return palettes[0]?.id ?? DEFAULT_THEME_PALETTE_ID
}
