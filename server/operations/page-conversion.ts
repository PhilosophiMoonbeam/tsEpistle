import { z } from 'zod'
import type Page from '../models/pages.ts'
import type { WikiAuth } from '../controllers/_types.ts'
import { canWritePage, principalId, type PagePrincipal } from '../helpers/page-access.ts'
import { rejectApiPrincipalMutation } from '../helpers/api-principal.ts'
import { runPageConversion } from '../helpers/page-conversion-process.ts'
import { retainPageConversionReview, type PageConversionReview } from '../helpers/page-conversion-review.ts'
import { assertPageUnlocked } from './page-protection.ts'
import errors from './errors.ts'

interface ConversionRuntime {
  auth: WikiAuth
  config: { lang: { namespacing?: boolean } }
  models: {
    pages: typeof Page
    renderers: { getRenderingPipeline(contentType: string): Promise<Array<{ key: string; config: Record<string, unknown>; children: Array<{ key: string; config: Record<string, unknown> }> }>> }
  }
}
export interface PageConversionContext {
  requester: PagePrincipal
  sessionId?: string
  signal?: AbortSignal
}
const Input = z.object({ editor: z.enum(['markdown', 'visual-markdown']), expectedSourceRevision: z.string().regex(/^[1-9][0-9]*$/) }).strict()

/** Authorized, mutation-free review. A fresh read after isolated work prevents stale-source disclosure. */
export async function reviewPageConversion(pageId: number, raw: unknown, context: PageConversionContext): Promise<PageConversionReview> {
  const wiki = WIKI as unknown as ConversionRuntime
  rejectApiPrincipalMutation(context.requester)
  const userId = principalId(context.requester)
  if (userId === null || !Number.isSafeInteger(pageId) || pageId < 1) throw new errors.ApplicationError('Page not found.', { code: 'PAGE_NOT_FOUND', status: 404 })
  const parsed = Input.safeParse(raw)
  if (!parsed.success) throw new errors.ApplicationError('Choose a Markdown editor and the current source revision.', { code: 'INVALID_INPUT', status: 400 })
  const { editor, expectedSourceRevision } = parsed.data
  const readAuthorized = async (): Promise<Page> => {
    const page = await wiki.models.pages.query().findById(pageId).withGraphFetched('tags')
    const authority = await wiki.auth.loadPageRuleAuthority(context.requester)
    if (!page || !canWritePage(context.requester, page, authority)) throw new errors.ApplicationError('Page not found.', { code: 'PAGE_NOT_FOUND', status: 404 })
    await assertPageUnlocked({ requester: context.requester, pageId, sessionId: context.sessionId ?? '' })
    if (String(page.sourceRevision) !== expectedSourceRevision) throw new errors.ApplicationError('Page source changed. Refresh before reviewing.', { code: 'CONVERSION_REVIEW_STALE', status: 409 })
    if (page.contentType !== 'html') throw new errors.ApplicationError('Source review is available for HTML to Markdown conversion only.', { code: 'CONVERSION_REFUSED', status: 422 })
    return page
  }
  const page = await readAuthorized()
  const pipeline = await wiki.models.renderers.getRenderingPipeline('markdown')
  const markdown = pipeline.find(stage => stage.key === 'markdownCore')
  if (!markdown) throw new errors.ApplicationError('Enable the native Markdown renderer before reviewing conversion.', { code: 'CONVERSION_REFUSED', status: 422 })
  const result = await runPageConversion({ source: page.content, page: { path: page.path, localeCode: page.localeCode }, config: markdown.config, children: markdown.children.map(child => ({ key: child.key, config: child.config })), namespaced: wiki.config.lang.namespacing === true }, context.signal)
  const current = await readAuthorized()
  if (current.content !== page.content) throw new errors.ApplicationError('Page source changed. Review again.', { code: 'CONVERSION_REVIEW_STALE', status: 409 })
  if (context.signal?.aborted) throw new DOMException('Conversion cancelled.', 'AbortError')
  return retainPageConversionReview({ pageId, sourceRevision: expectedSourceRevision, editor, userId, source: page.content, sessionBinding: context.sessionId ?? '' }, result)
}
