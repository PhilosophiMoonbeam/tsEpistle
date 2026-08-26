import { z } from 'zod'

export const PAGE_GUTTER_STYLES = ['columns', 'orbits', 'laurel', 'aurora', 'none', 'custom'] as const
export const DEFAULT_PAGE_GUTTER_STYLE = 'columns' as const
export const PAGE_GUTTER_CUSTOM_CSS_MAX_LENGTH = 4000

export const PageGutterStyleSchema = z.enum(PAGE_GUTTER_STYLES)
export const PageGutterCustomCssSchema = z.string()
  .max(PAGE_GUTTER_CUSTOM_CSS_MAX_LENGTH)
  .refine(value => !/[{}@]/.test(value), 'Custom gutter CSS must contain declarations only')

export type PageGutterStyle = z.infer<typeof PageGutterStyleSchema>

export const isPageGutterStyle = (value: unknown): value is PageGutterStyle => PageGutterStyleSchema.safeParse(value).success
export const isPageGutterCustomCss = (value: unknown): value is string => PageGutterCustomCssSchema.safeParse(value).success

export const normalizePageGutterStyle = (value: unknown): PageGutterStyle => {
  const result = PageGutterStyleSchema.safeParse(value)
  return result.success ? result.data : DEFAULT_PAGE_GUTTER_STYLE
}

export const normalizePageGutterCustomCss = (value: unknown): string => {
  const result = PageGutterCustomCssSchema.safeParse(value)
  return result.success ? result.data.trim() : ''
}
