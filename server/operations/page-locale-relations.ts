import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { canReadPage, canWritePage, type PagePrincipal, type PageVisibility } from '../helpers/page-access.ts'
import type { PageRuleAuthority } from '../helpers/group-access.ts'
import errors from './errors.ts'
import { assertPagesEditUnlocked } from '../helpers/page-edit-lock.ts'

const { ApplicationError } = errors

interface LocaleRelationPage {
  id: number
  localeCode: string
  localeGroupId: string | null
  ownerId: number | null
  path: string
  title: string
  visibility: PageVisibility
  tags: Array<{ tag: string }>
}

type LocaleRelationPageRow = Omit<LocaleRelationPage, 'tags'>

export interface PageLocaleRelation {
  id: number
  locale: string
  path: string
  title: string
  visibility: PageVisibility
}

interface WikiLocaleRelationRuntime {
  auth: {
    loadPageRuleAuthority(requester: PagePrincipal | undefined, transaction?: Knex.Transaction): Promise<PageRuleAuthority>
  }
  models: { knex: Knex }
}

const runtime = (): WikiLocaleRelationRuntime => Reflect.get(globalThis, 'WIKI') as unknown as WikiLocaleRelationRuntime
const pageColumns = ['id', 'localeCode', 'localeGroupId', 'ownerId', 'path', 'title', 'visibility'] as const

const hydratePageTags = async (
  knex: Knex | Knex.Transaction,
  pages: LocaleRelationPageRow[]
): Promise<LocaleRelationPage[]> => {
  if (pages.length === 0) return []
  const tagRows = await knex<{ pageId: number; tag: string }>('pageTags')
    .select('pageTags.pageId', 'tags.tag')
    .innerJoin('tags', 'tags.id', 'pageTags.tagId')
    .whereIn('pageTags.pageId', pages.map(page => page.id))
    .orderBy('pageTags.pageId', 'asc')
    .orderBy('tags.tag', 'asc')
  const tagsByPage = new Map<number, Array<{ tag: string }>>()
  for (const row of tagRows) {
    const tags = tagsByPage.get(row.pageId) ?? []
    tags.push({ tag: row.tag })
    tagsByPage.set(row.pageId, tags)
  }
  return pages.map(page => ({ ...page, tags: tagsByPage.get(page.id) ?? [] }))
}

const positiveInteger = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ApplicationError(`${label} must be a positive integer`, { code: 'INVALID_INPUT', status: 400 })
  }
  return value
}

const notFound = (): never => {
  throw new ApplicationError('This page does not exist.', { code: 'PAGE_NOT_FOUND', status: 404 })
}

const forbidden = (): never => {
  throw new ApplicationError('You cannot change this page translation set.', { code: 'PAGE_UPDATE_FORBIDDEN', status: 403 })
}

const relationConflict = (message: string): never => {
  throw new ApplicationError(message, { code: 'PAGE_LOCALE_RELATION_CONFLICT', status: 409 })
}

const toRelation = (page: LocaleRelationPage): PageLocaleRelation => ({
  id: page.id,
  locale: page.localeCode,
  path: page.path,
  title: page.title,
  visibility: page.visibility
})

const selectPages = (knex: Knex | Knex.Transaction) => knex<LocaleRelationPageRow>('pages').select(...pageColumns)

const isUniqueViolation = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false
  const code = 'code' in error ? String(error.code) : ''
  const message = 'message' in error ? String(error.message) : ''
  return code === '23505' || code === 'SQLITE_CONSTRAINT_UNIQUE' || /unique constraint/i.test(message)
}

const listPageLocaleRelationsWithAuthority = async (input: {
  pageId: number
  requester?: PagePrincipal
  authority?: PageRuleAuthority
}): Promise<PageLocaleRelation[]> => {
  const pageRow = await selectPages(runtime().models.knex).where({ id: input.pageId }).first()
  const [page] = await hydratePageTags(runtime().models.knex, pageRow ? [pageRow] : [])
  const authority = input.authority ?? await runtime().auth.loadPageRuleAuthority(input.requester)
  if (!page || !canReadPage(input.requester, page, authority)) return notFound()
  if (!page.localeGroupId) return [toRelation(page)]

  const pages = await hydratePageTags(
    runtime().models.knex,
    await selectPages(runtime().models.knex)
      .where({ localeGroupId: page.localeGroupId })
      .orderBy('localeCode')
      .orderBy('id')
  )
  return pages.filter(candidate => canReadPage(input.requester, candidate, authority)).map(toRelation)
}

export const listPageLocaleRelations = async (input: {
  pageId: number
  requester?: PagePrincipal
}): Promise<PageLocaleRelation[]> => {
  const pageId = positiveInteger(input.pageId, 'pageId')
  return listPageLocaleRelationsWithAuthority({ pageId, requester: input.requester })
}

export const linkPageLocaleRelation = async (input: {
  pageId: number
  relatedPageId: number
  requester?: PagePrincipal
}): Promise<PageLocaleRelation[]> => {
  const pageId = positiveInteger(input.pageId, 'pageId')
  const relatedPageId = positiveInteger(input.relatedPageId, 'relatedPageId')
  if (pageId === relatedPageId) relationConflict('A page cannot be linked to itself as a translation.')

  let authority: PageRuleAuthority | undefined
  try {
    await runtime().models.knex.transaction(async transaction => {
      if (transaction.client.config.client === 'pg') await transaction.raw('SELECT pg_advisory_xact_lock(?)', [0x574c524c])
      const selectedRows = await selectPages(transaction).whereIn('id', [pageId, relatedPageId])
      const selected = await hydratePageTags(transaction, selectedRows)
      let page = selected.find(candidate => candidate.id === pageId)
      let relatedPage = selected.find(candidate => candidate.id === relatedPageId)
      if (!page || !relatedPage) return notFound()

      const groupIds = [...new Set([page.localeGroupId, relatedPage.localeGroupId].filter((value): value is string => Boolean(value)))].sort()
      const memberQuery = selectPages(transaction).whereIn('id', [pageId, relatedPageId])
      if (groupIds.length) memberQuery.orWhereIn('localeGroupId', groupIds)
      const affected = await hydratePageTags(transaction, await memberQuery.orderBy('id').forUpdate())
      // A concurrent native move may leave a set while these rows are acquired.
      if (selected.some(previous => !affected.some(current => current.id === previous.id && current.localeGroupId === previous.localeGroupId && current.localeCode === previous.localeCode))) {
        return relationConflict('The translation set changed. Reload it before trying again.')
      }
      page = affected.find(candidate => candidate.id === pageId)
      relatedPage = affected.find(candidate => candidate.id === relatedPageId)
      if (!page || !relatedPage) return notFound()
      const loadedAuthority = await runtime().auth.loadPageRuleAuthority(input.requester, transaction)
      authority = loadedAuthority
      if (!canReadPage(input.requester, page, loadedAuthority) || !canReadPage(input.requester, relatedPage, loadedAuthority)) return notFound()
      if (page.localeCode === relatedPage.localeCode) relationConflict(`The translation set already has a ${page.localeCode} page.`)
      if (affected.some(candidate => !canWritePage(input.requester, candidate, loadedAuthority))) return forbidden()

      const localeOwners = new Map<string, number>()
      for (const candidate of affected) {
        const owner = localeOwners.get(candidate.localeCode)
        if (owner !== undefined && owner !== candidate.id) {
          relationConflict(`The translation set already has a ${candidate.localeCode} page.`)
        }
        localeOwners.set(candidate.localeCode, candidate.id)
      }

      const destinationGroupId = page.localeGroupId ?? relatedPage.localeGroupId ?? randomUUID()
      const movedIds = affected.filter(candidate => candidate.localeGroupId !== destinationGroupId).map(candidate => candidate.id)
      if (movedIds.length > 0) {
        await assertPagesEditUnlocked(transaction, movedIds)
        await transaction('pages').whereIn('id', movedIds).update({ localeGroupId: destinationGroupId })
      }
    })
  } catch (error) {
    if (isUniqueViolation(error)) relationConflict('That translation locale is already represented in this set.')
    throw error
  }
  if (!authority) throw new Error('Page-rule authority was not loaded')

  return listPageLocaleRelationsWithAuthority({ pageId, requester: input.requester, authority })
}

export const unlinkPageLocaleRelation = async (input: {
  pageId: number
  relatedPageId: number
  requester?: PagePrincipal
}): Promise<PageLocaleRelation[]> => {
  const pageId = positiveInteger(input.pageId, 'pageId')
  const relatedPageId = positiveInteger(input.relatedPageId, 'relatedPageId')
  if (pageId === relatedPageId) relationConflict('Select a different translation to unlink.')

  let authority: PageRuleAuthority | undefined
  await runtime().models.knex.transaction(async transaction => {
    if (transaction.client.config.client === 'pg') await transaction.raw('SELECT pg_advisory_xact_lock(?)', [0x574c524c])
    const observed = await selectPages(transaction).where({ id: pageId }).first()
    if (!observed) return notFound()
    const memberQuery = selectPages(transaction).whereIn('id', [pageId, relatedPageId])
    if (observed.localeGroupId) memberQuery.orWhere('localeGroupId', observed.localeGroupId)
    const selected = await hydratePageTags(transaction, await memberQuery.orderBy('id').forUpdate())
    const page = selected.find(candidate => candidate.id === pageId)
    const relatedPage = selected.find(candidate => candidate.id === relatedPageId)
    if (!page || !relatedPage) return notFound()
    const loadedAuthority = await runtime().auth.loadPageRuleAuthority(input.requester, transaction)
    authority = loadedAuthority
    if (!canReadPage(input.requester, page, loadedAuthority) || !canReadPage(input.requester, relatedPage, loadedAuthority)) return notFound()
    if (!page.localeGroupId || page.localeGroupId !== relatedPage.localeGroupId) {
      relationConflict('These pages are not in the same translation set.')
    }
    if (!canWritePage(input.requester, page, loadedAuthority) || !canWritePage(input.requester, relatedPage, loadedAuthority)) return forbidden()

    const remaining = selected.filter(candidate => candidate.id !== relatedPage.id && candidate.localeGroupId === page.localeGroupId)
    const affectedIds = [relatedPage.id, ...(remaining.length === 1 ? [remaining[0]!.id] : [])]
    await assertPagesEditUnlocked(transaction, affectedIds)
    await transaction('pages').where({ id: relatedPage.id }).update({ localeGroupId: null })
    if (remaining.length === 1) {
      await transaction('pages').where({ id: remaining[0]!.id }).update({ localeGroupId: null })
    }
  })
  if (!authority) throw new Error('Page-rule authority was not loaded')
  return listPageLocaleRelationsWithAuthority({ pageId, requester: input.requester, authority })
}
