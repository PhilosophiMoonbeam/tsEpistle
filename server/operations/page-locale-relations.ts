import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { canReadPage, canWritePage, type PagePrincipal, type PageVisibility } from '../helpers/page-access.ts'
import errors from './errors.ts'

const { ApplicationError } = errors

interface LocaleRelationPage {
  id: number
  localeCode: string
  localeGroupId: string | null
  ownerId: number | null
  path: string
  title: string
  visibility: PageVisibility
}

export interface PageLocaleRelation {
  id: number
  locale: string
  path: string
  title: string
  visibility: PageVisibility
}

interface WikiLocaleRelationRuntime {
  models: { knex: Knex }
}

const runtime = (): WikiLocaleRelationRuntime => Reflect.get(globalThis, 'WIKI') as unknown as WikiLocaleRelationRuntime
const pageColumns = ['id', 'localeCode', 'localeGroupId', 'ownerId', 'path', 'title', 'visibility'] as const

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

const selectPages = (knex: Knex | Knex.Transaction) => knex<LocaleRelationPage>('pages').select(...pageColumns)

const isUniqueViolation = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false
  const code = 'code' in error ? String(error.code) : ''
  const message = 'message' in error ? String(error.message) : ''
  return code === '23505' || code === 'SQLITE_CONSTRAINT_UNIQUE' || /unique constraint/i.test(message)
}

export const listPageLocaleRelations = async (input: {
  pageId: number
  requester?: PagePrincipal
}): Promise<PageLocaleRelation[]> => {
  const pageId = positiveInteger(input.pageId, 'pageId')
  const page = await selectPages(runtime().models.knex).where({ id: pageId }).first()
  if (!page || !canReadPage(input.requester, page)) return notFound()
  if (!page.localeGroupId) return [toRelation(page)]

  const pages = await selectPages(runtime().models.knex)
    .where({ localeGroupId: page.localeGroupId })
    .orderBy('localeCode')
    .orderBy('id')

  return pages.filter(candidate => canReadPage(input.requester, candidate)).map(toRelation)
}

export const linkPageLocaleRelation = async (input: {
  pageId: number
  relatedPageId: number
  requester?: PagePrincipal
}): Promise<PageLocaleRelation[]> => {
  const pageId = positiveInteger(input.pageId, 'pageId')
  const relatedPageId = positiveInteger(input.relatedPageId, 'relatedPageId')
  if (pageId === relatedPageId) relationConflict('A page cannot be linked to itself as a translation.')

  try {
    await runtime().models.knex.transaction(async transaction => {
      const selected = await selectPages(transaction)
        .whereIn('id', [pageId, relatedPageId].sort((left, right) => left - right))
        .forUpdate()
      const page = selected.find(candidate => candidate.id === pageId)
      const relatedPage = selected.find(candidate => candidate.id === relatedPageId)
      if (!page || !relatedPage || !canReadPage(input.requester, page) || !canReadPage(input.requester, relatedPage)) return notFound()
      if (page.localeCode === relatedPage.localeCode) relationConflict(`The translation set already has a ${page.localeCode} page.`)

      const groupIds = [...new Set([page.localeGroupId, relatedPage.localeGroupId].filter((value): value is string => Boolean(value)))].sort()
      const members = groupIds.length === 0
        ? selected
        : await selectPages(transaction).whereIn('localeGroupId', groupIds).forUpdate()
      const affected = [...new Map([...members, page, relatedPage].map(candidate => [candidate.id, candidate])).values()]
      if (affected.some(candidate => !canWritePage(input.requester, candidate))) return forbidden()

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
        await transaction('pages').whereIn('id', movedIds).update({ localeGroupId: destinationGroupId })
      }
    })
  } catch (error) {
    if (isUniqueViolation(error)) relationConflict('That translation locale is already represented in this set.')
    throw error
  }

  return listPageLocaleRelations({ pageId, ...(input.requester === undefined ? {} : { requester: input.requester }) })
}

export const unlinkPageLocaleRelation = async (input: {
  pageId: number
  relatedPageId: number
  requester?: PagePrincipal
}): Promise<PageLocaleRelation[]> => {
  const pageId = positiveInteger(input.pageId, 'pageId')
  const relatedPageId = positiveInteger(input.relatedPageId, 'relatedPageId')
  if (pageId === relatedPageId) relationConflict('Select a different translation to unlink.')

  await runtime().models.knex.transaction(async transaction => {
    const selected = await selectPages(transaction)
      .whereIn('id', [pageId, relatedPageId].sort((left, right) => left - right))
      .forUpdate()
    const page = selected.find(candidate => candidate.id === pageId)
    const relatedPage = selected.find(candidate => candidate.id === relatedPageId)
    if (!page || !relatedPage || !canReadPage(input.requester, page) || !canReadPage(input.requester, relatedPage)) return notFound()
    if (!page.localeGroupId || page.localeGroupId !== relatedPage.localeGroupId) {
      relationConflict('These pages are not in the same translation set.')
    }
    if (!canWritePage(input.requester, page) || !canWritePage(input.requester, relatedPage)) return forbidden()

    await transaction('pages').where({ id: relatedPage.id }).update({ localeGroupId: null })
    const remaining = await transaction('pages')
      .select('id')
      .where({ localeGroupId: page.localeGroupId })
      .forUpdate() as Array<Pick<LocaleRelationPage, 'id'>>
    if (remaining.length === 1) {
      await transaction('pages').where({ id: remaining[0]!.id }).update({ localeGroupId: null })
    }
  })

  return listPageLocaleRelations({ pageId, ...(input.requester === undefined ? {} : { requester: input.requester }) })
}
