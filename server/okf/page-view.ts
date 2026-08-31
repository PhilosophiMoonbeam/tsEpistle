import type { Knex } from 'knex'
import { ZodError } from 'zod'
import { PageKnowledgeRepository } from '../knowledge/lifecycle.ts'
import { validateStoredOkfMetadata, type OkfMetadata, type OkfTrustSummary } from './format.ts'
import type { KnowledgeProjectionView } from '../knowledge/projection.ts'

export interface PageOkfView {
  readonly authority:
    | { readonly state: 'valid'; readonly metadata: OkfMetadata; readonly trust: OkfTrustSummary }
    | { readonly state: 'missing' | 'invalid'; readonly metadata: null; readonly trust: null }
  readonly projection:
    | { readonly state: 'current'; readonly value: KnowledgeProjectionView }
    | { readonly state: 'pending'; readonly value: null }
}

interface PageOkfViewInput {
  readonly knex: Knex
  readonly pageId: number
  readonly sourceRevision: string | number | bigint
  readonly extra: unknown
}

const authorityView = (extra: unknown): PageOkfView['authority'] => {
  if (typeof extra !== 'object' || extra === null || Array.isArray(extra) || !Object.hasOwn(extra, 'okf')) {
    return { state: 'missing', metadata: null, trust: null }
  }

  const authority = validateStoredOkfMetadata((extra as Record<string, unknown>).okf)
  return authority === null
    ? { state: 'invalid', metadata: null, trust: null }
    : { state: 'valid', metadata: authority.metadata, trust: authority.trust }
}

export const buildPageOkfView = async (input: PageOkfViewInput): Promise<PageOkfView> => {
  const sourceRevision = String(input.sourceRevision)
  let projection: KnowledgeProjectionView | null
  try {
    projection = await new PageKnowledgeRepository(input.knex).getCurrent(input.pageId)
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError) && !(error instanceof ZodError)) throw error
    projection = null
  }
  return {
    authority: authorityView(input.extra),
    projection:
      projection !== null && projection.sourceRevision === sourceRevision
        ? { state: 'current', value: projection }
        : { state: 'pending', value: null }
  }
}
