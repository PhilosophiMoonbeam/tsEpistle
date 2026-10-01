import { advanceMarkdownCodeFenceState, type MarkdownCodeFenceState } from '../../../shared/markdown-code-fence.ts'

const MAX_METADATA_BYTES = 4 * 1_024
const MAX_REQUEST_FACETS = 16
const PLAN_OPEN = '<wiki-request-plan>'
const PLAN_CLOSE = '</wiki-request-plan>'
const COVERAGE_OPEN = '<wiki-answer-coverage>'
const COVERAGE_CLOSE = '</wiki-answer-coverage>'

export interface RootRequestFacet {
  readonly start: number
  readonly end: number
  readonly quote: string
  readonly coverage: 'source' | 'recent-window'
}

export interface RootResponseMetadata {
  readonly content: string
  readonly requestPlan?: readonly RootRequestFacet[]
  readonly unresolvedFacets?: readonly number[]
  readonly framingIssue?: string
  readonly metadataPresent?: true
  readonly answerCoveragePresent?: true
}

export const ROOT_REQUEST_COVERAGE_INSTRUCTIONS = `Optional internal root response metadata:
1. For scope-dependent completeness or evidence gaps, you may prepend <wiki-request-plan>{"facets":[{"start":0,"end":7,"quote":"Example","coverage":"source"}]}</wiki-request-plan> to your FIRST ordinary response only, alongside native calls or before a prompt tool envelope. Use exact current-user request substrings and the host-provided whole-request anchor when needed; example values apply only to a matching request. Use half-open UTF-16 indices with quotes matching their slices, 1–16 nonempty facets, and at most 4 KiB including the envelope. Never truncate or narrow the request to fit. The plan is then frozen.
2. Use "source" for ordinary content questions, including incidental recent-page research. Use "recent-window" only for a requested bounded recent listing or recap. The next successfully delivered root recent window binds the next such facet in request order; cover every row. Retrieved evidence does not expand the request.
3. Only for a no-call answer, prepend <wiki-answer-coverage>{"unresolved":[0]}</wiki-answer-coverage> for requested details not established by eligible cited evidence. List only unique unresolved facet indices. Keep all supported requested details in independently cited, source-faithful prose; do not replace them with a limitation. Put unverified requested details in metadata, not unsupported claims that a page or Wiki lacks them. The host separately renders the exact quoted request limitation; never write or imitate its notice prose.
4. Metadata envelopes must be leading, unique, closed, and ordered plan then coverage. Coverage never accompanies actions. Native calls remain native; for prompt actions, the remainder must be exactly one ordinary wiki-tool-call envelope. Add no notice fields. For answers, place the ordinary answer after metadata.
5. Metadata authorizes no action or factual claim and supplies no evidence. Omission proves neither support, completeness, nor readiness; do not generate an extra response to recover it.`

const objectValue = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))

const requestPlan = (value: unknown, userRequest: string): readonly RootRequestFacet[] | undefined => {
  if (!objectValue(value) || !exactKeys(value, ['facets']) || !Array.isArray(value.facets) || value.facets.length < 1 || value.facets.length > MAX_REQUEST_FACETS) return undefined
  const facets: RootRequestFacet[] = []
  for (const facet of value.facets) {
    if (
      !objectValue(facet) ||
      !exactKeys(facet, ['start', 'end', 'quote', 'coverage']) ||
      typeof facet.start !== 'number' ||
      typeof facet.end !== 'number' ||
      !Number.isSafeInteger(facet.start) ||
      !Number.isSafeInteger(facet.end) ||
      facet.start < 0 ||
      facet.end <= facet.start ||
      facet.end > userRequest.length ||
      typeof facet.quote !== 'string' ||
      userRequest.slice(facet.start, facet.end) !== facet.quote ||
      (facet.coverage !== 'source' && facet.coverage !== 'recent-window')
    ) return undefined
    facets.push(Object.freeze({ start: facet.start, end: facet.end, quote: facet.quote, coverage: facet.coverage }))
  }
  return Object.freeze(facets)
}

const answerCoverage = (value: unknown, facetCount: number | undefined): readonly number[] | undefined => {
  if (
    facetCount === undefined ||
    !Number.isSafeInteger(facetCount) ||
    facetCount < 0 ||
    facetCount > MAX_REQUEST_FACETS ||
    !objectValue(value) ||
    !exactKeys(value, ['unresolved']) ||
    !Array.isArray(value.unresolved) ||
    value.unresolved.length > facetCount
  ) return undefined
  const indices = new Set<number>()
  for (const index of value.unresolved) {
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= facetCount || indices.has(index)) return undefined
    indices.add(index)
  }
  return Object.freeze([...indices])
}

const reservedControlAt = (content: string, offset: number): boolean =>
  /^<\/?wiki-(?:request-plan|answer-coverage)(?=[\s/>]|$)/u.test(content.slice(offset, offset + 32))

// Only protocol-looking controls outside quoted source and Markdown literals are ambiguous.
// No part of ordinary body text is rewritten by this scan.
const containsReservedControl = (content: string): boolean => {
  let fence: MarkdownCodeFenceState | null = null
  let inlineTicks = 0
  for (const line of content.split(/\r\n|\n|\r/u)) {
    const nextFence = advanceMarkdownCodeFenceState(line, fence)
    if (fence !== null || nextFence !== null) {
      fence = nextFence
      continue
    }
    if (/^(?: {4}|\t| {0,3}>)/u.test(line)) continue
    for (let offset = 0; offset < line.length; offset++) {
      const character = line[offset]
      if (character === '\\') {
        offset++
        continue
      }
      if (character === '`') {
        let end = offset + 1
        while (line[end] === '`') end++
        const length = end - offset
        if (inlineTicks === 0) inlineTicks = length
        else if (inlineTicks === length) inlineTicks = 0
        offset = end - 1
        continue
      }
      if (inlineTicks !== 0) continue
      if ((character === '"' || character === "'") && (offset === 0 || !/[\p{L}\p{N}]/u.test(line[offset - 1]!))) {
        let end = offset + 1
        let closing = -1
        while (end < line.length) {
          const literalOpen = line.startsWith(PLAN_OPEN, end) ? PLAN_OPEN : line.startsWith(COVERAGE_OPEN, end) ? COVERAGE_OPEN : undefined
          if (literalOpen !== undefined) {
            const block = leadingBlock(line, end, literalOpen, literalOpen === PLAN_OPEN ? PLAN_CLOSE : COVERAGE_CLOSE)
            if (block.framingIssue === undefined) {
              end = block.end
              continue
            }
          }
          if (line[end] === '\\') end++
          else if (line[end] === character) {
            closing = end
            break
          }
          end++
        }
        if (closing > offset) {
          offset = closing
          continue
        }
      }
      if (character === '<' && reservedControlAt(line, offset)) return true
    }
  }
  return false
}

interface LeadingBlock {
  readonly end: number
  readonly value?: unknown
  readonly framingIssue?: string
}

const leadingBlock = (content: string, start: number, open: string, close: string): LeadingBlock => {
  const valueStart = start + open.length
  let quoted = false
  let nested = false
  let closing = -1
  for (let offset = valueStart; offset < content.length; offset++) {
    const character = content[offset]
    if (quoted) {
      if (character === '\\') offset++
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') quoted = true
    else if (content.startsWith(close, offset)) {
      closing = offset
      break
    } else if (character === '<' && reservedControlAt(content, offset)) nested = true
  }
  // A closed envelope with broken JSON is still independently removable. Valid JSON
  // strings containing reserved tags were skipped above and never mistaken for controls.
  if (closing < 0) {
    try {
      JSON.parse(content.slice(valueStart))
      return { end: content.length, framingIssue: 'Unclosed root response metadata envelope' }
    } catch {
      // Broken JSON may still have an unambiguous closing delimiter.
    }
  }
  if (closing < 0) closing = content.indexOf(close, valueStart)
  if (closing < 0) return { end: content.length, framingIssue: 'Unclosed root response metadata envelope' }
  const end = closing + close.length
  if (nested) return { end, framingIssue: 'Nested root response metadata envelopes' }
  if (Buffer.byteLength(content.slice(start, end), 'utf8') > MAX_METADATA_BYTES) return { end }
  let value: unknown
  try {
    value = JSON.parse(content.slice(valueStart, closing))
  } catch {
    return { end }
  }
  return { end, value }
}

export const extractRootRequestMetadata = (
  content: string,
  context: { readonly userRequest: string; readonly firstResponse: boolean; readonly facetCount?: number }
): RootResponseMetadata => {
  let cursor = content.search(/\S/u)
  if (cursor < 0) return { content }
  const lineStart = Math.max(content.lastIndexOf('\n', cursor - 1), content.lastIndexOf('\r', cursor - 1)) + 1
  if (/^(?: {4}|\t)/u.test(content.slice(lineStart, cursor))) return { content }
  let bodyStart = cursor
  let plan: readonly RootRequestFacet[] | undefined
  let unresolved: readonly number[] | undefined
  let sawPlan = false
  let sawCoverage = false
  while (content.startsWith(PLAN_OPEN, cursor) || content.startsWith(COVERAGE_OPEN, cursor)) {
    const isPlan = content.startsWith(PLAN_OPEN, cursor)
    if ((isPlan && (sawPlan || sawCoverage || !context.firstResponse)) || (!isPlan && sawCoverage))
      return { content, framingIssue: 'Duplicate, out-of-order, or later request metadata envelope' }
    const block = leadingBlock(content, cursor, isPlan ? PLAN_OPEN : COVERAGE_OPEN, isPlan ? PLAN_CLOSE : COVERAGE_CLOSE)
    if (block.framingIssue !== undefined) return { content, framingIssue: block.framingIssue }
    if (isPlan) {
      sawPlan = true
      plan = requestPlan(block.value, context.userRequest)
    } else {
      sawCoverage = true
      unresolved = answerCoverage(block.value, context.firstResponse ? plan?.length : context.facetCount)
    }
    cursor = block.end
    bodyStart = block.end
    while (/\s/u.test(content[cursor] ?? '') && cursor < content.length) cursor++
  }
  const remainder = sawPlan || sawCoverage ? content.slice(bodyStart) : content
  if (containsReservedControl(remainder)) return { content, framingIssue: 'Malformed or misplaced root response metadata envelope' }
  return {
    content: remainder,
    ...(sawPlan || sawCoverage ? { metadataPresent: true as const } : {}),
    ...(sawCoverage ? { answerCoveragePresent: true as const } : {}),
    ...(plan === undefined ? {} : { requestPlan: plan }),
    ...(unresolved === undefined ? {} : { unresolvedFacets: unresolved })
  }
}
