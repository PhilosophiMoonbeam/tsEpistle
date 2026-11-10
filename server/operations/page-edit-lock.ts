import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { PageEditLockInputSchema, type PageEditLockView } from '../../shared/page-edit-lock.ts'
import { pageEditLocked, type PageEditLockRow } from '../helpers/page-edit-lock.ts'
import { canReadPage, canWritePage, managesSystem, type PagePrincipal, type PageVisibilityRecord } from '../helpers/page-access.ts'
import type { PageRuleAuthority } from '../helpers/group-access.ts'
import type { LiveNotePrincipal } from './live-notes.ts'
import { lockSearchIndex, lockSearchPage } from '../helpers/search-contract.ts'
import { publicationWindowOpen } from '../../shared/publication-window.ts'
import { authorizePageCreationAccount } from './live-notes.ts'
import { pageRequiresUnlock } from './page-protection.ts'
import errors from './errors.ts'

interface LockPage extends PageVisibilityRecord { id: number; isPublished: boolean | number; publishStartDate: string | null; publishEndDate: string | null }
interface ContextInput { requester: PagePrincipal; pageId: number; sessionId: string }
interface LockWiki { models: { knex: Knex }; auth: { loadPageRuleAuthority(requester: PagePrincipal, transaction: Knex.Transaction): Promise<PageRuleAuthority> } }
const runtime = (): LockWiki => WIKI as unknown as LockWiki
const missing = (): never => { throw new errors.ApplicationError('Page not found.', { status: 404, code: 'PAGE_NOT_FOUND' }) }
const currentAccount = async (transaction: Knex.Transaction, input: ContextInput) => {
  if (!input.sessionId || !input.requester || 'api' in input.requester || 'grp' in input.requester) throw new errors.ApplicationError('A current interactive human session is required.', { status: 401, code: 'AUTH_REQUIRED' })
  const account = await authorizePageCreationAccount(transaction, input.requester)
  if ((account.id !== 1 && (Reflect.get(account, 'isSystem') === true || Reflect.get(account, 'isSystem') === 1)) || account.email === 'api@localhost') throw new errors.ApplicationError('A current interactive human session is required.', { status: 401, code: 'AUTH_REQUIRED' })
  return account
}
const authorizePage = async (transaction: Knex.Transaction, input: ContextInput, requester: LiveNotePrincipal, mutation: boolean): Promise<boolean> => {
  const page = await transaction<LockPage>('pages').where({ id: input.pageId }).forUpdate().first()
  if (!page) return missing()
  page.tags = await transaction('pageTags').join('tags', 'tags.id', 'pageTags.tagId').where('pageTags.pageId', page.id).select('tags.tag')
  const authority = await runtime().auth.loadPageRuleAuthority(requester, transaction)
  if (!canReadPage(requester, page, authority) || (!(page.isPublished === true || page.isPublished === 1) || !publicationWindowOpen(page)) && !canWritePage(requester, page, authority)) return missing()
  if (await pageRequiresUnlock({ requester, pageId: page.id, sessionId: input.sessionId, transaction, readOnly: true })) return missing()
  const manager = managesSystem(requester)
  if (mutation && !manager) throw new errors.ApplicationError('Current manage:system authority is required.', { status: 403, code: 'PAGE_EDIT_LOCK_FORBIDDEN' })
  return manager
}
const view = (row: PageEditLockRow | undefined, manager: boolean): PageEditLockView => ({
  isEditLocked: pageEditLocked(row), lockVersion: String(row?.lockVersion ?? 0), canManage: manager,
  updatedAt: manager && row ? new Date(row.updatedAt).toISOString() : null,
  updatedBy: manager && row ? row.updatedBy : null, reason: manager && row ? row.reason : null
})
export const getPageEditLock = (input: ContextInput): Promise<PageEditLockView> => runtime().models.knex.transaction(async transaction => {
  const requester = await currentAccount(transaction, input)
  const manager = await authorizePage(transaction, input, requester, false)
  return view(await transaction<PageEditLockRow>('pageEditLocks').where({ pageId: input.pageId }).first(), manager)
})
export const setPageEditLock = (input: ContextInput & { input: unknown }): Promise<PageEditLockView> => {
  const parsed = PageEditLockInputSchema.safeParse(input.input)
  if (!parsed.success) throw new errors.ApplicationError('A lock state, current lock version and a single-line reason of 1–500 characters are required.', { status: 400, code: 'INVALID_INPUT' })
  return runtime().models.knex.transaction(async transaction => {
    const requester = await currentAccount(transaction, input)
    await lockSearchIndex(transaction, false)
    await lockSearchPage(transaction, input.pageId)
    await authorizePage(transaction, input, requester, true)
    const previous = await transaction<PageEditLockRow>('pageEditLocks').where({ pageId: input.pageId }).forUpdate().first()
    const version = String(previous?.lockVersion ?? 0)
    if (version !== parsed.data.expectedLockVersion || BigInt(version) >= 9223372036854775807n) throw new errors.ApplicationError('The edit-lock policy changed. Reload it before trying again.', { status: 409, code: 'PAGE_EDIT_LOCK_CONFLICT' })
    const now = new Date(), lockVersion = (BigInt(version) + 1n).toString()
    const row: PageEditLockRow = { pageId: input.pageId, isEditLocked: parsed.data.isEditLocked, lockVersion, updatedBy: requester.id, reason: parsed.data.reason, updatedAt: now }
    await transaction('pageEditLocks').insert(row).onConflict('pageId').merge(row)
    await transaction('pageEditLockAudit').insert({ id: randomUUID(), pageId: input.pageId, lockVersion, wasEditLocked: pageEditLocked(previous), isEditLocked: parsed.data.isEditLocked, actorId: requester.id, reason: parsed.data.reason, createdAt: now })
    return view(row, true)
  })
}
