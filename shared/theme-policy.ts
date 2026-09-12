import { z } from 'zod'
import { normalizeThemeColors } from './theme-colors.ts'
import { ThemePalettesSchema, normalizeThemePalettes, resolveThemePaletteId } from './theme-palettes.ts'

export const ReaderLayoutSchema = z.object({
  textSize: z.number().int().min(14).max(24),
  lineHeight: z.number().min(1.4).max(2),
  copyWidth: z.number().int().min(48).max(110)
}).strict()
export type ReaderLayout = z.infer<typeof ReaderLayoutSchema>
export const defaultReaderLayout: ReaderLayout = { textSize: 17, lineHeight: 1.68, copyWidth: 74 }
export const normalizeReaderLayout = (input: unknown): ReaderLayout => {
  const result = ReaderLayoutSchema.safeParse(input)
  return result.success ? result.data : { ...defaultReaderLayout }
}
export const ThemePolicySchema = z.object({
  theme: z.literal('default'),
  iconset: z.enum(['mdi', 'fa', 'fa4']),
  darkMode: z.boolean(),
  palettes: ThemePalettesSchema,
  activePaletteId: z.string(),
  tocPosition: z.enum(['left', 'right', 'off']),
  reading: ReaderLayoutSchema,
  injectCSS: z.string().max(65536),
  injectHead: z.string().max(65536),
  injectBody: z.string().max(65536)
}).strict().superRefine((value, ctx) => {
  if (!value.palettes.some(palette => palette.id === value.activePaletteId))
    ctx.addIssue({ code: 'custom', path: ['activePaletteId'], message: 'Choose a palette in this collection.' })
})
export type ThemePolicy = z.infer<typeof ThemePolicySchema>
export const themePolicyFromConfiguration = (configuration: Record<string, unknown>): ThemePolicy => {
  const raw = configuration.theming && typeof configuration.theming === 'object' ? configuration.theming as Record<string, unknown> : {}
  const palettes = normalizeThemePalettes(raw.palettes, normalizeThemeColors(raw.colors))
  return {
    theme: (raw.theme ?? 'default') as ThemePolicy['theme'],
    iconset: (raw.iconset ?? 'mdi') as ThemePolicy['iconset'],
    darkMode: raw.darkMode === true,
    palettes,
    activePaletteId: resolveThemePaletteId(raw.activePaletteId, palettes),
    tocPosition: (raw.tocPosition || 'left') as ThemePolicy['tocPosition'],
    reading: normalizeReaderLayout(raw.reading),
    injectCSS: typeof raw.injectCSS === 'string' ? raw.injectCSS : '',
    injectHead: typeof raw.injectHead === 'string' ? raw.injectHead : '',
    injectBody: typeof raw.injectBody === 'string' ? raw.injectBody : ''
  }
}
export const themeFieldLabels: Record<keyof ThemePolicy, string> = {
  theme: 'Reader theme', iconset: 'Icon library', darkMode: 'Legacy appearance default', palettes: 'Palette library',
  activePaletteId: 'Published palette', tocPosition: 'Contents position', reading: 'Reader typography',
  injectCSS: 'Custom CSS', injectHead: 'Head HTML', injectBody: 'Body HTML'
}
export const themeChangedFields = (before: ThemePolicy, after: ThemePolicy): Array<keyof ThemePolicy> =>
  (Object.keys(themeFieldLabels) as Array<keyof ThemePolicy>).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
export interface ThemePolicyEvent { id: string; actorId: number | null; reason: string; fields: string[]; createdAt: string }
export interface ThemeWorkspace {
  policy: ThemePolicy
  fingerprint: string
  history: ThemePolicyEvent[]
  runtime: { state: 'applied' | 'needs-attention'; observedAt: string }
  capabilities: { editCustomCode: boolean }
}
export interface ThemeWriteResult { activation: 'applied' | 'needs-attention' }
