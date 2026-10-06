import type { Knex } from 'knex'
import { analyticsPolicyFromConfiguration, decideAnalyticsCollection } from '../../shared/analytics-policy.ts'
import type { AnalyticsInsights, AnalyticsRequestContext } from '../../shared/analytics-policy.ts'
import { publicationWindowOpen } from '../../shared/publication-window.ts'
import { publicationTimestampSql } from '../helpers/search-contract.ts'
import { analyticsConfiguration } from './analytics-runtime.ts'
import type { AnalyticsSetting } from './analytics-runtime.ts'
const dayOf = (date: Date): string => date.toISOString().slice(0, 10)
export const analyticsRetentionStart = (now: Date, days: number): string =>
  dayOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days + 1)))
const published = (page: Record<string, unknown>, now: Date): boolean => page.isPublished === true && publicationWindowOpen(page, now.getTime())
export const recordAnalyticsResponse = async (db: Knex, pageId: number, request: AnalyticsRequestContext, now = new Date()): Promise<boolean> =>
  db.transaction(async tx => {
    // Serialize with reviewed policy publication and erasure. Recheck policy and page state after response completion.
    const settings = await tx<AnalyticsSetting>('settings').whereIn('key', ['analyticsPolicy', 'offline']).orderBy('key').forShare()
    const configuration = analyticsConfiguration(settings),
      policy = analyticsPolicyFromConfiguration(configuration)
    if (!policy.localEnabled) return false
    const page = await tx('pages').where('id', pageId).forShare().first('id', 'path', 'visibility', 'isPublished', 'publishStartDate', 'publishEndDate')
    if (!page) return false
    const protection = await tx('pageAccessPasswords').where('pageId', pageId).first('pageId')
    const decision = decideAnalyticsCollection(policy, {
      ...request,
      path: page.path,
      visibility: page.visibility,
      published: published(page, now),
      protected: Boolean(protection),
      offline: configuration.offline === true
    })
    if (!decision.local) return false
    await tx('analyticsDaily')
      .insert({ day: dayOf(now), pageId, responses: 1 })
      .onConflict(['day', 'pageId'])
      .merge({ responses: tx.raw('"analyticsDaily".responses + 1') })
    return true
  })
export const pruneAnalyticsInsights = async (db: Knex, now = new Date()): Promise<number> =>
  db.transaction(async tx => {
    const settings = await tx<AnalyticsSetting>('settings').where('key', 'analyticsPolicy').forShare()
    const policy = analyticsPolicyFromConfiguration(analyticsConfiguration(settings))
    return Number(await tx('analyticsDaily').where('day', '<', analyticsRetentionStart(now, policy.retentionDays)).delete())
  })
export const readAnalyticsInsights = async (tx: Knex | Knex.Transaction, retentionDays: number, now = new Date()): Promise<AnalyticsInsights> => {
  const from = analyticsRetentionStart(now, retentionDays),
    through = dayOf(now)
  // Reports include only current shared, published, unprotected pages. Deletion cascades erase their counters.
  const scoped = () =>
    tx('analyticsDaily as d')
      .join('pages as p', 'p.id', 'd.pageId')
      .whereBetween('d.day', [from, through])
      .where({ 'p.visibility': 'public', 'p.isPublished': true })
      .whereRaw(`(NULLIF(p."publishStartDate", '') IS NULL OR ${publicationTimestampSql('p."publishStartDate"')} <= ?)`, [now.toISOString()])
      .whereRaw(`(NULLIF(p."publishEndDate", '') IS NULL OR ${publicationTimestampSql('p."publishEndDate"')} >= ?)`, [now.toISOString()])
      .whereNotExists(tx('pageAccessPasswords as protection').select(tx.raw('1')).whereRaw('protection."pageId" = p.id'))
  const totals = await scoped().sum({ responses: 'd.responses' }).countDistinct({ pages: 'd.pageId' }).first()
  const daily = await scoped()
    .select(tx.raw('d.day::text as day'))
    .sum<Array<{ day: string; responses: string }>>({ responses: 'd.responses' })
    .groupBy('d.day')
    .orderBy('d.day')
  const top = await scoped()
    .select('p.id', 'p.localeCode', 'p.path', 'p.title')
    .sum<Array<{ id: number; localeCode: string; path: string; title: string; responses: string }>>({ responses: 'd.responses' })
    .groupBy('p.id', 'p.localeCode', 'p.path', 'p.title')
    .orderBy('responses', 'desc')
    .orderBy('p.id')
    .limit(15)
  return {
    from,
    through,
    observedAt: now.toISOString(),
    totalResponses: Number(totals?.responses ?? 0),
    pages: Number(totals?.pages ?? 0),
    daily: daily.map(row => ({ day: String(row.day), responses: Number(row.responses) })),
    topPages: top.map(row => ({
      id: Number(row.id),
      locale: String(row.localeCode),
      path: String(row.path),
      title: String(row.title),
      responses: Number(row.responses)
    }))
  }
}
