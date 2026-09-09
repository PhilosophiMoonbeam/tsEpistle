import type { Knex } from 'knex'
import { canReadPage, managesSystem, principalId, type PagePrincipal } from '../helpers/page-access.ts'
import type { PageRuleAuthority } from '../helpers/group-access.ts'
import { DISCUSSION_SETTINGS_LOCK } from './discussion-settings.ts'
import { DISCUSSION_PAGE_LOCK } from './discussion-moderation.ts'
import errors from './errors.ts'
import { rejectApiPrincipalMutation } from '../helpers/api-principal.ts'
const { ApplicationError } = errors
const POST_IDENTITY_LOCK = 72401642
export interface DiscussionPostInput { pageId: number; replyTo: number; content: string; render: string; user: { id: number; name: string; email: string; ip: string }; requester: PagePrincipal; sessionId: string }
interface Dependencies {
  db: Knex
  fallbackFeatures(): Record<string, unknown>
  loadPageRuleAuthority(requester: PagePrincipal, transaction: Knex.Transaction): Promise<PageRuleAuthority>
  canPost(requester: PagePrincipal, page: Record<string, unknown>, authority: PageRuleAuthority): boolean
  checkSpam(input: { page: Record<string, unknown>; comment: DiscussionPostInput; providerConfig: Record<string, unknown> }): Promise<void>
}
export const createDiscussionPostingStore = (deps: Dependencies) => ({
  async post(input: DiscussionPostInput): Promise<number> {
    rejectApiPrincipalMutation(input.requester)
    if (!Number.isSafeInteger(input.pageId) || input.pageId < 1 || input.pageId > 2147483647 || !Number.isSafeInteger(input.replyTo) || input.replyTo < 0 || input.replyTo > 2147483647 || typeof input.content !== 'string' || input.content.trim().length < 2 || input.content.length > 50000) throw new ApplicationError('Choose a page and enter a comment of 2 to 50,000 characters.', { status: 400 })
    return deps.db.transaction(async tx => {
      const page = await tx('pages').where('id', input.pageId).forShare().first()
      if (!page) throw new ApplicationError('Page not found.', { status: 404 })
      const tags = await tx('pageTags').join('tags', 'tags.id', 'pageTags.tagId').where('pageTags.pageId', page.id).select('tags.tag')
      page.tags = tags.map(row => ({ tag: row.tag }))
      const authority = await deps.loadPageRuleAuthority(input.requester, tx)
      if (!canReadPage(input.requester, page, authority)) throw new ApplicationError('Page not found.', { status: 404 })
      if (!deps.canPost(input.requester, page, authority)) throw new ApplicationError('You cannot post comments on this page.', { status: 403 })
      const protection = await tx('pageAccessPasswords').where('pageId', page.id).first()
      if (protection && !managesSystem(input.requester)) {
        const grant = input.sessionId && await tx('pageUnlockGrants').where({ pageId: page.id, sessionId: input.sessionId, userId: principalId(input.requester), passwordVersion: protection.version }).where('expiresAt', '>', new Date()).first('id')
        if (!grant) throw new ApplicationError('Unlock this page before joining its discussion.', { status: 403, code: 'PAGE_LOCKED' })
      }
      const identity = input.user.id === 2 ? `guest:${input.user.ip || 'unknown'}` : `user:${input.user.id}`
      await tx.raw('SELECT pg_advisory_xact_lock(?, hashtext(?))', [POST_IDENTITY_LOCK, identity])
      await tx.raw('SELECT pg_advisory_xact_lock_shared(?, ?)', [DISCUSSION_PAGE_LOCK, page.id])
      await tx.raw('SELECT pg_advisory_xact_lock_shared(?)', [DISCUSSION_SETTINGS_LOCK])
      const providers = await tx('commentProviders').orderBy('key').forShare().select('key', 'isEnabled', 'config')
      const featureRow = await tx('settings').where('key', 'features').forShare().first('value')
      const enabled = providers.filter(row => row.isEnabled), flags = featureRow?.value ?? deps.fallbackFeatures()
      if (!flags.featurePageComments) throw new ApplicationError('Discussions are currently paused.', { status: 409 })
      if (enabled.length !== 1 || enabled[0].key !== 'default') throw new ApplicationError('Built-in discussions are not the active provider.', { status: 409 })
      if ((await tx('pageDiscussionPolicy').where('pageId', page.id).first('closed'))?.closed) throw new ApplicationError('This discussion is closed to new comments.', { status: 409 })
      if (input.replyTo > 0 && !await tx('comments').where({ id: input.replyTo, pageId: page.id, isHidden: false }).first('id')) throw new ApplicationError('The comment you are replying to is unavailable.', { status: 409 })
      const minDelay = Number(enabled[0].config.minDelay)
      if (!Number.isSafeInteger(minDelay) || minDelay < 0 || minDelay > 86400) throw new ApplicationError('Discussion settings need administrator attention.', { status: 409 })
      const latestQuery = tx('comments').where('authorId', input.user.id)
      if (input.user.id === 2) latestQuery.where('ip', input.user.ip)
      const latest = await latestQuery.orderBy('createdAt', 'desc').first('createdAt')
      const retryAfterMilliseconds = latest ? new Date(latest.createdAt).valueOf() + minDelay * 1000 - Date.now() : 0
      if (retryAfterMilliseconds > 0) throw Object.assign(new ApplicationError('Please wait before posting another comment.', { status: 429 }), { retryAfterMilliseconds })
      // No third-party spam request for private or password-protected pages.
      // Page and policy locks remain held until the bounded check and insert finish.
      if (page.visibility === 'public' && !protection) await deps.checkSpam({ page, comment: input, providerConfig: enabled[0].config })
      const now = new Date().toISOString()
      const [row] = await tx('comments').insert({ content: input.content.trim(), render: input.render, replyTo: input.replyTo, pageId: page.id, authorId: input.user.id, name: input.user.name, email: input.user.email, ip: input.user.ip, createdAt: now, updatedAt: now }).returning('id')
      return Number(row.id)
    })
  }
})
