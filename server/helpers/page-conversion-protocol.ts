import { z } from 'zod'

export const PAGE_CONVERSION_LIMITS = Object.freeze({
  inputBytes: 256 * 1024,
  outputBytes: 1024 * 1024,
  wireBytes: 4 * 1024 * 1024,
  nodes: 10_000,
  depth: 64,
  tableCells: 2000,
  tableRows: 200,
  tableColumns: 50,
  concurrency: 2,
  deadlineMs: 5000,
  rssBytes: 256 * 1024 * 1024,
  monitorMs: 25,
  reviewTtlMs: 5 * 60_000,
  reviews: 16
})

export const ConversionReportSchema = z.object({
  warnings: z.array(z.string().max(2048)).max(32),
  differences: z.object({ text: z.boolean(), code: z.boolean(), links: z.boolean(), tables: z.boolean() }).strict(),
  roundtripSource: z.string().max(PAGE_CONVERSION_LIMITS.outputBytes),
  previewHtml: z.string().max(PAGE_CONVERSION_LIMITS.outputBytes),
  renderer: z.string().max(256)
}).strict()
export const ConversionResultSchema = z.object({
  candidate: z.string().max(PAGE_CONVERSION_LIMITS.outputBytes),
  report: ConversionReportSchema
}).strict()
export type ConversionResult = z.infer<typeof ConversionResultSchema>

export interface ConversionWorkerInput {
  source: string
  page: { path: string; localeCode: string }
  config: Record<string, unknown>
  children: Array<{ key: string; config: Record<string, unknown> }>
  namespaced: boolean
}
