import type { Knex } from 'knex'
import { DurableJobStore } from '../core/durable-jobs.ts'

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

interface WikiRuntime {
  models: { knex: Knex }
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
  await knex.transaction(async transaction => {
    const current = await transaction<ContentExtensionRow>('contentExtensions')
      .where({ key })
      .first('key', 'isEnabled', 'version')
    if (!current) throw new ContentExtensionOperationError(404, 'Content extension not found.')
    if (Boolean(current.isEnabled) === isEnabled) return
    await transaction<ContentExtensionRow>('contentExtensions').where({ key }).update({
      isEnabled,
      updatedAt: new Date(),
      updatedBy
    })
    const jobs = new DurableJobStore(transaction)
    await jobs.enqueue({
      type: 'rerender-content-extension',
      version: 1,
      payload: { key },
      maxAttempts: 5
    })
  })

  const response = await listContentExtensions()
  const updated = response.extensions.find(extension => extension.key === key)
  if (!updated) throw new ContentExtensionOperationError(404, 'Content extension not found.')
  return updated
}
