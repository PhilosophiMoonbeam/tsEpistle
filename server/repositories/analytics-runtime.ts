import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as yaml from 'js-yaml'
import type { Knex } from 'knex'
import {
  analyticsPolicyFromConfiguration,
  decideAnalyticsCollection,
  type AnalyticsProvider,
  type AnalyticsProviderDraft,
  type AnalyticsRequestContext
} from '../../shared/analytics-policy.ts'
import {
  analyticsDefinition,
  analyticsDestinations,
  analyticsProviderIssues,
  compileAnalyticsTemplate,
  emptyAnalyticsCode,
  type AnalyticsCode
} from '../../shared/analytics-providers.ts'
export interface AnalyticsRow {
  key: string
  isEnabled: boolean
  config: unknown
}
export interface AnalyticsSetting {
  key: string
  value: unknown
}
export const analyticsSettingKeys = ['analyticsPolicy', 'analyticsAdministration', 'offline']
export const analyticsRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
export const analyticsConfiguration = (rows: AnalyticsSetting[], fallback: Record<string, unknown> = {}) => ({
  ...fallback,
  ...Object.fromEntries(rows.map(row => [row.key, row.key === 'offline' ? (analyticsRecord(row.value).v ?? row.value) : row.value]))
})
export const analyticsDraftFromRow = (row: AnalyticsRow): AnalyticsProviderDraft => {
  const definition = analyticsDefinition(row.key),
    raw = analyticsRecord(row.config)
  return {
    key: row.key,
    isEnabled: row.isEnabled === true,
    config: Object.fromEntries(
      (definition?.fields ?? []).map(field => {
        const value = raw[field.key] ?? field.default
        if (field.kind === 'boolean' && typeof value === 'boolean') return [field.key, value ? 'true' : 'false']
        return [field.key, typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '']
      })
    )
  }
}
const templatePromises = new Map<string, Promise<AnalyticsCode>>()
export const readAnalyticsTemplate = async (serverPath: string, key: string): Promise<AnalyticsCode> => {
  if (!analyticsDefinition(key)) throw new Error('Analytics integration is unavailable.')
  const filename = path.join(serverPath, 'modules/analytics', key, 'code.yml')
  let promise = templatePromises.get(filename)
  if (!promise) {
    promise = (async () => {
      const stat = await fs.stat(filename)
      if (stat.size > 512 * 1024) throw new Error('Analytics template exceeds the supported size.')
      const value = analyticsRecord(yaml.load(await fs.readFile(filename, 'utf8'))),
        result = emptyAnalyticsCode()
      for (const section of ['head', 'bodyStart', 'bodyEnd'] as const) {
        if (value[section] !== undefined && typeof value[section] !== 'string') throw new Error('Analytics template is malformed.')
        result[section] = typeof value[section] === 'string' ? value[section] : ''
      }
      if (!Object.values(result).some(Boolean)) throw new Error('Analytics template is empty.')
      return result
    })()
    templatePromises.set(filename, promise)
    promise.catch(() => {
      if (templatePromises.get(filename) === promise) templatePromises.delete(filename)
    })
  }
  return promise
}
export const inspectAnalyticsProvider = async (row: AnalyticsRow, serverPath: string, available: ReadonlySet<string>): Promise<AnalyticsProvider> => {
  const definition = analyticsDefinition(row.key),
    draft = analyticsDraftFromRow(row),
    issues = analyticsProviderIssues(draft)
  let isAvailable = Boolean(definition && available.has(row.key)),
    destinations: string[] = []
  if (isAvailable) {
    try {
      const template = await readAnalyticsTemplate(serverPath, row.key)
      if (!issues.length) {
        compileAnalyticsTemplate(template, draft)
        destinations = analyticsDestinations(draft)
      }
    } catch {
      isAvailable = false
      issues.push('The bundled tracking template is unavailable or malformed.')
    }
  }
  if (!available.has(row.key)) issues.push('This provider is unavailable in this deployment.')
  return {
    ...(definition ?? {
      key: row.key,
      title: row.key,
      description: 'An unrecognized saved integration.',
      website: '',
      category: 'traffic' as const,
      capabilities: [],
      compatibility: 'Retained for inspection and disabling. No supported integration contract is installed.',
      fields: []
    }),
    ...draft,
    isAvailable,
    issues,
    destinations
  }
}
export interface AnalyticsSnapshot {
  rows: AnalyticsRow[]
  settings: AnalyticsSetting[]
  configuration: Record<string, unknown>
  revision: string
  policy: ReturnType<typeof analyticsPolicyFromConfiguration>
  offline: boolean
}
export const readAnalyticsSnapshot = async (db: Knex, fallback: Record<string, unknown> = {}): Promise<AnalyticsSnapshot> => {
  const tx = await db.transaction({ isolationLevel: 'repeatable read', readOnly: true })
  try {
    const settings = await tx<AnalyticsSetting>('settings').whereIn('key', ['analyticsPolicy', 'offline']).orderBy('key')
    const rows = await tx<AnalyticsRow>('analytics').orderBy('key')
    const configuration = analyticsConfiguration(settings, fallback),
      policy = analyticsPolicyFromConfiguration(
        configuration,
        rows.some(row => row.isEnabled)
      )
    await tx.commit()
    return {
      rows,
      settings,
      configuration,
      policy,
      offline: configuration.offline === true,
      revision: createHash('sha256')
        .update(JSON.stringify([settings, rows]))
        .digest('hex')
    }
  } catch (error) {
    await tx.rollback()
    throw error
  }
}
export const compileAnalyticsSnapshot = async (
  snapshot: AnalyticsSnapshot,
  request: AnalyticsRequestContext,
  serverPath: string,
  available: ReadonlySet<string>
) => {
  const decision = decideAnalyticsCollection(snapshot.policy, { ...request, offline: snapshot.offline }),
    code = emptyAnalyticsCode(),
    skipped: string[] = []
  if (decision.external) {
    for (const row of snapshot.rows.filter(row => row.isEnabled)) {
      try {
        if (!available.has(row.key)) throw new Error('Unavailable')
        const compiled = compileAnalyticsTemplate(await readAnalyticsTemplate(serverPath, row.key), analyticsDraftFromRow(row))
        for (const section of ['head', 'bodyStart', 'bodyEnd'] as const) code[section] += compiled[section]
      } catch {
        skipped.push(row.key)
      }
    }
  }
  return { decision, code, skipped, revision: snapshot.revision, hasExternalCode: Object.values(code).some(Boolean) }
}
