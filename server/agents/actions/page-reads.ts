import { z } from 'zod'

import type { RequestAuthContext } from '../../../shared/agents/contracts.ts'
import { type ActionAuthority, ActionKernel, ActionKernelError } from './kernel.ts'
import { issueWikiLineSnapshot } from '../patch/wiki-line-patch.ts'
const PageRowSchema = z.looseObject({
  id: z.coerce.number().int().positive().optional(),
  pageId: z.coerce.number().int().positive().optional(),
  locale: z.string().optional(),
  localeCode: z.string().optional(),
  path: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  contentType: z.string(),
  sourceRevision: z.union([z.string(), z.number()]),
  content: z.string().optional(),
  updatedAt: z.union([z.string(), z.date()]),
  visibility: z.enum(['public', 'private']).optional()
})
const SearchResponseSchema = z.looseObject({
  results: z.array(z.looseObject({
    path: z.string(),
    locale: z.string(),
    visibility: z.enum(['public', 'private']).optional()
  })),
  totalHits: z.coerce.number().int().nonnegative()
})
const RecentRowSchema = z.looseObject({ id: z.coerce.number().int().positive() })
const HistorySchema = z.looseObject({
  trail: z.array(z.looseObject({
    versionId: z.coerce.number().int().positive(),
    sourceRevision: z.union([z.string(), z.number()]),
    actionType: z.string(),
    versionDate: z.union([z.string(), z.date()]),
    authorName: z.string()
  })),
  total: z.coerce.number().int().nonnegative()
})
const LinksSchema = z.array(z.looseObject({
  id: z.coerce.number().int().positive(),
  links: z.array(z.string())
}))

interface PageOperations {
  search(input: Record<string, unknown>): Promise<unknown>
  get(input: Record<string, unknown>): Promise<unknown>
  getByPath(input: Record<string, unknown>): Promise<unknown>
  listRecent(requester?: Express.User): Promise<unknown>
  getHistory(input: Record<string, unknown>): Promise<unknown>
  getVersion(input: Record<string, unknown>): Promise<unknown>
  listLinks(input: Record<string, unknown>): Promise<unknown>
}

export interface PageReadActionDependencies {
  readonly operations: PageOperations
  readonly resolveRequester: (authority: ActionAuthority) => Promise<Express.User>
  readonly snapshotSigningSecret: Uint8Array
}

type PageGetInput = { readonly id: number } | { readonly path: string; readonly locale: string }
interface SearchInput { readonly query: string; readonly locale?: string; readonly limit: number; readonly offset: number }
interface PatchReadInput {
  readonly pageId: number
  readonly ranges?: readonly { readonly startLine: number; readonly endLine: number }[]
  readonly previousSnapshotToken?: string
}
interface RecentInput { readonly locale?: string; readonly limit: number }
interface HistoryInput { readonly pageId: number; readonly limit: number }
interface VersionInput { readonly pageId: number; readonly versionId: number }
interface LinksInput { readonly pageId: number; readonly limit: number }

const operationFailure = (message: string): ActionKernelError => new ActionKernelError('INVALID_PAGE_RESULT', message, 500)

const parsePage = (value: unknown, includeContent: boolean) => {
  const parsed = PageRowSchema.safeParse(value)
  if (!parsed.success || (includeContent && parsed.data.content === undefined)) throw operationFailure('Page operation returned an invalid bounded result')
  const row = parsed.data
  const id = row.id ?? row.pageId
  const locale = row.locale ?? row.localeCode
  if (!id || !locale) throw operationFailure('Page operation omitted page identity')
  return {
    id,
    locale,
    path: row.path,
    title: row.title,
    description: row.description ?? '',
    contentType: row.contentType,
    sourceRevision: String(row.sourceRevision),
    ...(includeContent ? { content: row.content as string, updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt } : {})
  }
}

const pageNotFound = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  if ('code' in error && error.code === 'PAGE_NOT_FOUND') return true
  return error.name.includes('PageNotFound')
}

const getPageBySelector = async (operations: PageOperations, requester: Express.User, input: PageGetInput): Promise<unknown> => {
  if ('id' in input) return operations.get({ id: input.id, requester })
  let privateFailure: unknown
  try {
    return await operations.getByPath({ path: input.path, locale: input.locale, visibility: 'private', requester })
  } catch (error: unknown) {
    privateFailure = error
  }
  if (!pageNotFound(privateFailure)) throw privateFailure
  return operations.getByPath({ path: input.path, locale: input.locale, visibility: 'public', requester })
}

const requesterFor = async (resolveRequester: PageReadActionDependencies['resolveRequester'], authority: ActionAuthority): Promise<Express.User> => {
  const requester = await resolveRequester(authority)
  if (!requester) throw new ActionKernelError('AUTHENTICATION_REQUIRED', 'The action principal no longer exists', 401)
  return requester
}
export const snapshotRequesterScope = (authority: ActionAuthority): string => authority.requester.kind === 'user'
  ? `request:${authority.requestId}:user:${authority.requester.userId}`
  : `request:${authority.requestId}:api-key:${authority.requester.apiKeyId}:group:${authority.requester.groupId}`


export const registerPageReadActions = (kernel: ActionKernel, dependencies: PageReadActionDependencies): void => {
  const operations = dependencies.operations

  kernel.register('pages.search', async (rawInput, context) => {
    const input = rawInput as SearchInput
    const requester = await requesterFor(dependencies.resolveRequester, context.authority)
    const rawResponse = await operations.search({
      query: input.query,
      ...(input.locale ? { locale: input.locale } : {}),
      limit: input.offset + input.limit,
      requester
    })
    const response = SearchResponseSchema.safeParse(rawResponse)
    if (!response.success) throw operationFailure('Page search returned an invalid result')
    const selected = response.data.results.slice(input.offset, input.offset + input.limit)
    const hydrated = await Promise.all(selected.map(async result => {
      try {
        const page = await operations.getByPath({
          path: result.path,
          locale: result.locale,
          visibility: result.visibility ?? 'public',
          requester
        })
        return parsePage(page, false)
      } catch (error: unknown) {
        if (pageNotFound(error)) return null
        throw error
      }
    }))
    const results = hydrated.filter(result => result !== null)
    return { results, total: response.data.totalHits, truncated: response.data.totalHits > input.offset + results.length }
  })

  kernel.register('pages.get', async (rawInput, context) => {
    const requester = await requesterFor(dependencies.resolveRequester, context.authority)
    return parsePage(await getPageBySelector(operations, requester, rawInput as PageGetInput), true)
  })
  kernel.register('pages.readForPatch', async (rawInput, context) => {
    const input = rawInput as PatchReadInput
    const requester = await requesterFor(dependencies.resolveRequester, context.authority)
    const page = parsePage(await operations.get({ id: input.pageId, requester }), true)
    if (page.contentType !== 'markdown') throw new ActionKernelError('UNSUPPORTED_CONTENT_TYPE', 'Only Markdown pages support hashline snapshots', 409)
    if (page.content === undefined) throw operationFailure('Page operation omitted Markdown source')
    return issueWikiLineSnapshot({
      page: { id: page.id, locale: page.locale, path: page.path, contentType: 'markdown' },
      sourceRevision: page.sourceRevision,
      source: page.content,
      requesterScope: snapshotRequesterScope(context.authority),
      signingSecret: dependencies.snapshotSigningSecret,
      ...(input.ranges ? { requestedRanges: input.ranges } : {}),
      ...(input.previousSnapshotToken ? { previousSnapshotToken: input.previousSnapshotToken } : {})
    })
  })


  kernel.register('pages.listRecent', async (rawInput, context) => {
    const input = rawInput as RecentInput
    const requester = await requesterFor(dependencies.resolveRequester, context.authority)
    const recent = z.array(RecentRowSchema).safeParse(await operations.listRecent(requester))
    if (!recent.success) throw operationFailure('Recent page operation returned an invalid result')
    const hydrated = await Promise.all(recent.data.slice(0, input.limit).map(async item => {
      try {
        const page = parsePage(await operations.get({ id: item.id, requester }), false)
        return !input.locale || page.locale === input.locale ? page : null
      } catch (error: unknown) {
        if (pageNotFound(error)) return null
        throw error
      }
    }))
    return { pages: hydrated.filter(result => result !== null) }
  })

  kernel.register('pages.listHistory', async (rawInput, context) => {
    const input = rawInput as HistoryInput
    const requester = await requesterFor(dependencies.resolveRequester, context.authority)
    const history = HistorySchema.safeParse(await operations.getHistory({ id: input.pageId, offsetPage: 0, offsetSize: input.limit, requester }))
    if (!history.success) throw operationFailure('Page history operation returned an invalid result')
    return {
      versions: history.data.trail.slice(0, input.limit).map(version => ({
        id: version.versionId,
        sourceRevision: String(version.sourceRevision),
        action: version.actionType,
        versionDate: version.versionDate instanceof Date ? version.versionDate.toISOString() : version.versionDate,
        authorName: version.authorName
      }))
    }
  })

  kernel.register('pages.getVersion', async (rawInput, context) => {
    const input = rawInput as VersionInput
    const requester = await requesterFor(dependencies.resolveRequester, context.authority)
    const value = await operations.getVersion({ pageId: input.pageId, versionId: input.versionId, requester })
    if (!value) throw new ActionKernelError('PAGE_NOT_FOUND', 'Page version is unavailable', 404)
    const parsed = parsePage(value, true)
    const versionDate = z.looseObject({ versionDate: z.union([z.string(), z.date()]) }).safeParse(value)
    if (!versionDate.success) throw operationFailure('Page version operation omitted its date')
    return {
      ...parsed,
      versionId: input.versionId,
      versionDate: versionDate.data.versionDate instanceof Date ? versionDate.data.versionDate.toISOString() : versionDate.data.versionDate
    }
  })

  kernel.register('pages.listLinks', async (rawInput, context) => {
    const input = rawInput as LinksInput
    const requester = await requesterFor(dependencies.resolveRequester, context.authority)
    const page = parsePage(await operations.get({ id: input.pageId, requester }), false)
    const rows = LinksSchema.safeParse(await operations.listLinks({ locale: page.locale, requester }))
    if (!rows.success) throw operationFailure('Page links operation returned an invalid result')
    const selected = rows.data.find(row => row.id === input.pageId)
    const links = (selected?.links ?? []).slice(0, input.limit).map(target => ({
      label: target,
      target,
      kind: /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) ? 'external' as const : 'page' as const
    }))
    return { links, truncated: (selected?.links.length ?? 0) > links.length }
  })
}

export const registerWikiPageReadActions = async (
  kernel: ActionKernel,
  resolveRequester: PageReadActionDependencies['resolveRequester'],
  snapshotSigningSecret: Uint8Array
): Promise<void> => {
  const operations = (await import('../../operations/pages.ts')).default
  registerPageReadActions(kernel, { operations, resolveRequester, snapshotSigningSecret })
}

export const authorityAuthContext = (authority: ActionAuthority, principal: Express.User): RequestAuthContext<Express.User> => {
  if (authority.requester.kind === 'user') {
    return { kind: 'user', userId: authority.requester.userId, ownershipUserId: authority.requester.userId, principal }
  }
  return {
    kind: 'apiKey',
    apiKeyId: authority.requester.apiKeyId,
    groupId: authority.requester.groupId,
    ownershipUserId: null,
    principal
  }
}
