import { createHash } from 'node:crypto'

import type { KnowledgeProjectionView } from '../knowledge/projection.ts'
import {
  exportOkfLinks,
  okfConceptId,
  okfFilePath,
  renderOkfDocument,
  summarizeOkfTrust,
  validateStoredOkfMetadata,
  type OkfMetadata,
  type OkfTrustSummary
} from '../okf/format.ts'

export type PageAuthority =
  | { readonly state: 'valid'; readonly metadata: OkfMetadata; readonly trust: OkfTrustSummary }
  | { readonly state: 'missing' | 'invalid'; readonly metadata: null; readonly trust: null }

export interface CanonicalOkfPageInput {
  readonly pageId: number
  readonly versionId: number | null
  readonly sourceRevision: string | number | bigint
  readonly locale: string
  readonly path: string
  readonly title: string
  readonly description: string | null | undefined
  readonly tags: readonly string[]
  readonly visibility: 'public' | 'private'
  readonly content: string
  readonly authority: PageAuthority
  readonly knowledge: KnowledgeProjectionView | null
}

export interface CanonicalOkfPageDocument {
  readonly pageId: number
  readonly versionId: number | null
  readonly sourceRevision: string
  readonly resourceUri: string
  readonly conceptId: string
  readonly filePath: string
  readonly sha256: string
  readonly mediaType: 'text/markdown'
  readonly document: string
  readonly authority: PageAuthority
  readonly knowledge: KnowledgeProjectionView | null
  readonly citation: { readonly evidenceId: string; readonly kind: 'page'; readonly label: string; readonly href: string }
}

const canonicalRevision = (value: string | number | bigint): string => {
  const revision = String(value)
  if (!/^[1-9][0-9]*$/u.test(revision)) throw new Error('OKF source revision must be a canonical positive decimal')
  return revision
}

export const okfResourceUri = (pageId: number, versionId: number | null, sourceRevision: string | number | bigint): string => {
  if (!Number.isSafeInteger(pageId) || pageId < 1) throw new Error('OKF page ID must be a positive integer')
  const revision = canonicalRevision(sourceRevision)
  const version = versionId === null ? 'current' : String(versionId)
  if (version !== 'current' && !/^[1-9][0-9]*$/u.test(version)) throw new Error('OKF version ID must be a canonical positive decimal')
  return `wiki://pages/${pageId}/versions/${version}/revisions/${revision}/okf`
}

export const pageAuthority = (extra: unknown): PageAuthority => {
  if (typeof extra !== 'object' || extra === null || Array.isArray(extra) || !Object.hasOwn(extra, 'okf'))
    return { state: 'missing', metadata: null, trust: null }
  const validated = validateStoredOkfMetadata((extra as Record<string, unknown>).okf)
  return validated === null
    ? { state: 'invalid', metadata: null, trust: null }
    : { state: 'valid', metadata: validated.metadata, trust: validated.trust }
}

const canonicalMetadata = (input: CanonicalOkfPageInput): OkfMetadata => {
  if (input.authority.state !== 'valid') throw new Error(`Cannot serialize ${input.authority.state} OKF authority`)
  const metadata: OkfMetadata = { ...input.authority.metadata, title: input.title, tags: [...input.tags] }
  const description = input.description?.trim() ?? ''
  if (description.length > 0) metadata.description = input.description!
  else delete metadata.description
  const storedWiki = input.authority.metadata['x-wiki']
  metadata['x-wiki'] = {
    ...(typeof storedWiki === 'object' && storedWiki !== null && !Array.isArray(storedWiki) ? storedWiki : {}),
    page_id: input.pageId,
    source_revision: canonicalRevision(input.sourceRevision),
    visibility: input.visibility,
    knowledge: input.knowledge
  }
  return metadata
}

export const renderCanonicalOkfDocument = (input: CanonicalOkfPageInput): {
  readonly document: string
  readonly sha256: string
  readonly metadata: OkfMetadata
  readonly trust: OkfTrustSummary
} => {
  const metadata = canonicalMetadata(input)
  const document = renderOkfDocument(metadata, exportOkfLinks(input.content))
  return {
    document,
    sha256: createHash('sha256').update(document).digest('hex'),
    metadata,
    trust: summarizeOkfTrust(metadata)
  }
}

export const exportOkfPageLinks = exportOkfLinks

export const serializeCanonicalOkfPage = (input: CanonicalOkfPageInput): CanonicalOkfPageDocument => {
  const sourceRevision = canonicalRevision(input.sourceRevision)
  const rendered = renderCanonicalOkfDocument(input)
  const resourceUri = okfResourceUri(input.pageId, input.versionId, sourceRevision)
  const filePath = okfFilePath(input.locale, input.path)
  const citationHref = `${input.visibility === 'private' ? '/_private' : ''}/${input.locale}/${input.path}`
  return {
    pageId: input.pageId,
    versionId: input.versionId,
    sourceRevision,
    resourceUri,
    conceptId: okfConceptId(input.locale, input.path),
    filePath,
    sha256: rendered.sha256,
    mediaType: 'text/markdown',
    document: rendered.document,
    authority: input.authority,
    knowledge: input.knowledge,
    citation: {
      evidenceId: `page:${input.pageId}:revision:${sourceRevision}`,
      kind: 'page',
      label: input.title.trim() || input.path,
      href: citationHref
    }
  }
}
