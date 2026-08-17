import type { Knex } from 'knex'
import { z } from 'zod'

import { buildApprovedSkillBundle, parseSkillMarkdown, type ApprovedSkillBundle, type SkillResourceInput, SkillValidationError } from './parser.ts'
import { validateSkillVirtualPath } from './virtual-path.ts'

const PageRowSchema = z.object({
  id: z.coerce.number().int().positive(),
  path: z.string().min(1),
  content: z.string(),
  contentType: z.string(),
  sourceRevision: z.union([z.string(), z.number()]).transform(String),
  updatedAt: z.union([z.string(), z.date()]).transform(value => value instanceof Date ? value.toISOString() : value)
})
const AssetRowSchema = z.object({
  id: z.coerce.number().int().positive(),
  filename: z.string().min(1),
  hash: z.string().min(1),
  mime: z.string().min(1),
  updatedAt: z.union([z.string(), z.date()]).transform(value => value instanceof Date ? value.toISOString() : value),
  data: z.instanceof(Buffer)
})
const HistoryRowSchema = z.object({ id: z.coerce.number().int().positive() })

export interface SkillSourceMapping {
  readonly rootPageId: number
  readonly rootPath: string
  readonly assetFolderId: number | null
}

export interface ResolvedPageNativeSkillSource {
  readonly bundle: ApprovedSkillBundle
  readonly sourceRevision: string
  readonly sourceUpdatedAt: string
  readonly sourceHistoryId: number | null
}

const parseDbRow = <T>(schema: z.ZodType<T>, value: unknown, label: string): T => {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new SkillValidationError(`${label} is missing or has an invalid persisted shape`)
  return parsed.data
}

export const resolvePageNativeSkillSource = async (db: Knex, mapping: SkillSourceMapping): Promise<ResolvedPageNativeSkillSource> => {
  const rootPath = validateSkillVirtualPath(mapping.rootPath)
  const expectedName = rootPath.split('/').at(-1)
  if (!expectedName) throw new SkillValidationError('Skill root path has no name')

  const rootValue = await db('pages')
    .select('id', 'path', 'content', 'contentType', 'sourceRevision', 'updatedAt')
    .where({ id: mapping.rootPageId })
    .forUpdate()
    .first()
  const root = parseDbRow(PageRowSchema, rootValue, 'Skill root page')
  if (root.path !== rootPath || root.contentType !== 'markdown') throw new SkillValidationError('Skill root mapping no longer resolves to a Markdown page')
  const parsedEntry = parseSkillMarkdown(Buffer.from(root.content, 'utf8'), expectedName)

  const resources: SkillResourceInput[] = []
  for (const reference of parsedEntry.references) {
    if (reference.endsWith('.md')) {
      const pagePath = `${rootPath}/${reference.slice(0, -3)}`
      const pageValue = await db('pages')
        .select('id', 'path', 'content', 'contentType', 'sourceRevision', 'updatedAt')
        .where({ path: pagePath })
        .forUpdate()
        .first()
      const page = parseDbRow(PageRowSchema, pageValue, `Skill page resource ${reference}`)
      if (page.contentType !== 'markdown') throw new SkillValidationError(`Skill page resource ${reference} must be Markdown`)
      resources.push({
        path: reference,
        bytes: Buffer.from(page.content, 'utf8'),
        mediaType: 'text/markdown',
        sourceId: `page:${page.id}`,
        sourceRevision: page.sourceRevision
      })
      continue
    }

    const segments = reference.split('/')
    if (mapping.assetFolderId === null || segments.length !== 2 || (segments[0] !== 'assets' && segments[0] !== 'scripts')) {
      throw new SkillValidationError(`Skill asset resource ${reference} is outside the selected one-level asset folder`)
    }
    const assetValue = await db('assets')
      .innerJoin('assetData', 'assetData.id', 'assets.id')
      .select('assets.id', 'assets.filename', 'assets.hash', 'assets.mime', 'assets.updatedAt', 'assetData.data')
      .where({ 'assets.folderId': mapping.assetFolderId, 'assets.filename': segments[1] })
      .forUpdate()
      .first()
    const asset = parseDbRow(AssetRowSchema, assetValue, `Skill asset resource ${reference}`)
    resources.push({
      path: reference,
      bytes: asset.data,
      mediaType: asset.mime,
      sourceId: `asset:${asset.id}`,
      sourceRevision: asset.hash
    })
  }

  const historyValue = await db('pageHistory')
    .select('id')
    .where({ pageId: root.id, sourceRevision: root.sourceRevision })
    .orderBy('id', 'desc')
    .first()
  const history = historyValue === undefined ? null : parseDbRow(HistoryRowSchema, historyValue, 'Skill source history')
  return {
    bundle: buildApprovedSkillBundle(parsedEntry.bytes, expectedName, resources),
    sourceRevision: root.sourceRevision,
    sourceUpdatedAt: root.updatedAt,
    sourceHistoryId: history?.id ?? null
  }
}
