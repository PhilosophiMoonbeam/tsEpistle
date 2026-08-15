import type { Knex } from 'knex'

import {
  BUILTIN_CONTENT_EXTENSIONS,
  CONTENT_EXTENSION_HOST_VERSION,
  contentExtensionCompatibility,
  type ContentExtensionDefinition
} from '../../shared/content-extensions.ts'

interface ContentExtensionRow {
  key: string
  isEnabled: boolean | number
  version: number
  updatedAt: Date | string
  updatedBy: number | null
}

interface ExtensionPage {
  id: number
  hash: string
  content: string
}

interface PageModel {
  deletePageFromCache(hash: string): Promise<unknown>
  renderPage(page: ExtensionPage): Promise<unknown>
}

interface WikiRuntime {
  events: { outbound: { emit(event: string, value: unknown): void } }
  models: { knex: Knex, pages: PageModel }
}

export interface ContentExtensionStatus extends ContentExtensionDefinition {
  isEnabled: boolean
  compatible: boolean
  diagnostic: string | null
}

export interface ContentExtensionStatusResponse {
  hostVersion: number
  extensions: ContentExtensionStatus[]
}


const statusForDefinition = (
  definition: ContentExtensionDefinition,
  row: Pick<ContentExtensionRow, 'key' | 'isEnabled' | 'version'> | undefined
): ContentExtensionStatus => {
  const hostCompatibility = contentExtensionCompatibility(definition)
  let compatible = hostCompatibility.compatible
  let diagnostic = hostCompatibility.diagnostic
  if (!row) {
    compatible = false
    diagnostic = `Extension "${definition.key}" is not installed in the content extension registry.`
  } else if (row.version !== definition.version) {
    compatible = false
    diagnostic = `Installed extension "${definition.key}" version ${row.version} does not match renderer version ${definition.version}.`
  }
  return {
    ...definition,
    isEnabled: Boolean(row?.isEnabled),
    compatible,
    diagnostic
  }
}

export const listContentExtensions = async (): Promise<ContentExtensionStatusResponse> => {
  const wiki = WIKI as unknown as WikiRuntime
  const rows = await wiki.models.knex<ContentExtensionRow>('contentExtensions')
    .select('key', 'isEnabled', 'version')
  const rowByKey = new Map(rows.map(row => [row.key, row]))
  return {
    hostVersion: CONTENT_EXTENSION_HOST_VERSION,
    extensions: BUILTIN_CONTENT_EXTENSIONS.map(definition => statusForDefinition(definition, rowByKey.get(definition.key)))
  }
}

const pageContainsExtension = (content: string, key: string): boolean => {
  const fences = /^```wiki-extension[ \t]*\r?\n([^\r\n]*)\r?\n```[ \t]*$/gm
  for (const match of content.matchAll(fences)) {
    try {
      const parsed: unknown = JSON.parse(match[1] ?? '')
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && Reflect.get(parsed, 'key') === key) {
        return true
      }
    } catch {
      // Invalid extension fences already render as escaped source and cannot leave active output behind.
    }
  }
  return false
}

export const rerenderPagesForContentExtension = async (key: string): Promise<number> => {
  const wiki = WIKI as unknown as WikiRuntime
  const candidates = await wiki.models.knex<ExtensionPage>('pages')
    .select('id', 'hash', 'content')
    .where('content', 'like', '%```wiki-extension%')
  const pages = candidates.filter(page => pageContainsExtension(page.content, key))

  for (const page of pages) {
    await wiki.models.pages.deletePageFromCache(page.hash)
    wiki.events.outbound.emit('deletePageFromCache', page.hash)
  }
  for (const page of pages) {
    await wiki.models.pages.renderPage(page)
  }
  return pages.length
}

class ContentExtensionOperationError extends Error {
  readonly status: number

  constructor (status: number, message: string) {
    super(message)
    this.status = status
  }
}

export const setContentExtensionEnabled = async (
  key: string,
  isEnabled: boolean,
  updatedBy: number | null
): Promise<ContentExtensionStatus> => {
  const definition = BUILTIN_CONTENT_EXTENSIONS.find(candidate => candidate.key === key)
  if (!definition) throw new ContentExtensionOperationError(404, 'Content extension not found.')

  const wiki = WIKI as unknown as WikiRuntime
  const knex = wiki.models.knex
  const current = await knex<ContentExtensionRow>('contentExtensions').where({ key }).first('key', 'isEnabled', 'version')
  if (!current) throw new ContentExtensionOperationError(404, 'Content extension not found.')
  await knex<ContentExtensionRow>('contentExtensions').where({ key }).update({
    isEnabled,
    updatedAt: new Date(),
    updatedBy
  })
  if (Boolean(current.isEnabled) !== isEnabled) {
    await rerenderPagesForContentExtension(key)
  }

  const response = await listContentExtensions()
  const updated = response.extensions.find(extension => extension.key === key)
  if (!updated) throw new ContentExtensionOperationError(404, 'Content extension not found.')
  return updated
}
