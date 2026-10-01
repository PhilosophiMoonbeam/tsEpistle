import { describe, expect, it } from '../bun-test.mts'

import { parsePromptToolCall } from '../../agents/providers/prompt-tools.ts'
import { extractRootRequestMetadata } from '../../agents/providers/request-coverage.ts'

const request = 'A😀 source and recent pages'
const first = { userRequest: request, firstResponse: true }
const facet = { start: 1, end: 3, quote: '😀', coverage: 'source' }
const plan = (value: unknown): string => `<wiki-request-plan>${JSON.stringify(value)}</wiki-request-plan>`
const coverage = (value: unknown): string => `<wiki-answer-coverage>${JSON.stringify(value)}</wiki-answer-coverage>`
const validPlan = plan({ facets: [facet, { start: 15, end: 27, quote: 'recent pages', coverage: 'recent-window' }] })
const action = '<wiki-tool-call>{"name":"wiki_get_page","arguments":{"id":42}}</wiki-tool-call>'

describe('root request metadata provenance and framing', () => {
  it('uses exact UTF-16 request anchors and preserves the strict prompt action remainder', () => {
    const result = extractRootRequestMetadata(` \n${validPlan}\n${action}\n`, first)
    expect(result.requestPlan).toEqual([
      { start: 1, end: 3, quote: '😀', coverage: 'source' },
      { start: 15, end: 27, quote: 'recent pages', coverage: 'recent-window' }
    ])
    expect(result.content).toBe(`\n${action}\n`)
    expect(result.metadataPresent).toBe(true)
    expect(result.framingIssue).toBeUndefined()
    expect(parsePromptToolCall(result.content, new Set(['wiki_get_page']))).toEqual({ name: 'wiki_get_page', params: { id: 42 } })
    expect(() => parsePromptToolCall(result.content, new Set())).toThrow(expect.objectContaining({ code: 'INVALID_PROVIDER_RESPONSE' }))
  })

  it('accepts plan, unresolved facets, and a factual body in the first no-call response', () => {
    const body = '\nA source-grounded answer. [[cite:page42]]\n'
    const result = extractRootRequestMetadata(`${validPlan}\n${coverage({ unresolved: [1] })}${body}`, first)
    expect(result.content).toBe(body)
    expect(result.unresolvedFacets).toEqual([1])
    expect(result.answerCoveragePresent).toBe(true)
    expect(result.framingIssue).toBeUndefined()
  })

  it('validates later answer coverage against the frozen plan count without introducing scope', () => {
    const result = extractRootRequestMetadata(`${coverage({ unresolved: [1, 0] })}\nPartial answer.`, { ...first, firstResponse: false, facetCount: 2 })
    expect(result.unresolvedFacets).toEqual([1, 0])
    expect(result.requestPlan).toBeUndefined()
    expect(result.content).toBe('\nPartial answer.')
    const laterPlan = extractRootRequestMetadata(`${validPlan}${action}`, { ...first, firstResponse: false, facetCount: 2 })
    expect(laterPlan.framingIssue).toBeDefined()
    expect(laterPlan.requestPlan).toBeUndefined()
  })

  it.each([
    { facets: [{ ...facet, start: 1, end: 2 }] },
    { facets: [{ ...facet, start: -1 }] },
    { facets: [{ ...facet, end: request.length + 1 }] },
    { facets: [{ ...facet, start: 1.5 }] },
    { facets: [{ ...facet, end: 1 }] },
    { facets: [{ ...facet, quote: 'source from a different message' }] },
    { facets: [{ ...facet, coverage: 'complete' }] },
    { facets: [{ ...facet, notice: 'No pages exist' }] },
    { facets: [facet], authorized: true },
    { facets: 'source' },
    { facets: [] },
    [facet]
  ])('treats a bounded invalid plan as unknown without obstructing an independently valid action: %j', value => {
    const result = extractRootRequestMetadata(`${plan(value)}${action}`, first)
    expect(result.requestPlan).toBeUndefined()
    expect(result.framingIssue).toBeUndefined()
    expect(result.metadataPresent).toBe(true)
    expect(parsePromptToolCall(result.content, new Set(['wiki_get_page']))).toEqual({ name: 'wiki_get_page', params: { id: 42 } })
  })

  it('binds quotes only to the supplied latest request, never an earlier request', () => {
    const result = extractRootRequestMetadata(`${validPlan}Answer.`, { userRequest: 'Another current request entirely', firstResponse: true })
    expect(result.requestPlan).toBeUndefined()
    expect(result.content).toBe('Answer.')
  })

  it('removes well-delimited invalid JSON but does not weaken strict action framing', () => {
    const result = extractRootRequestMetadata(`<wiki-request-plan>{broken}</wiki-request-plan>${action} extra prose`, first)
    expect(result.requestPlan).toBeUndefined()
    expect(result.framingIssue).toBeUndefined()
    expect(() => parsePromptToolCall(result.content, new Set(['wiki_get_page']))).toThrow(expect.objectContaining({ code: 'INVALID_PROVIDER_RESPONSE' }))
  })

  it('enforces the complete envelope byte limit without truncating metadata or the answer', () => {
    const short = plan({ facets: [facet] })
    const exact = short.replace('</wiki-request-plan>', `${' '.repeat(4_096 - Buffer.byteLength(short, 'utf8'))}</wiki-request-plan>`)
    expect(extractRootRequestMetadata(`${exact}Answer.`, first).requestPlan).toEqual([facet])
    const tooLarge = exact.replace('</wiki-request-plan>', ' </wiki-request-plan>')
    const result = extractRootRequestMetadata(`${tooLarge}Answer.`, first)
    expect(result.requestPlan).toBeUndefined()
    expect(result.content).toBe('Answer.')
    expect(result.framingIssue).toBeUndefined()
  })

  it('accepts sixteen anchored facets but rejects an over-limit plan in its entirety', () => {
    const userRequest = 'abcdefghijklmnopq'
    const facets = [...userRequest].map((quote, start) => ({ start, end: start + 1, quote, coverage: 'source' }))
    const context = { userRequest, firstResponse: true }
    const accepted = extractRootRequestMetadata(`${plan({ facets: facets.slice(0, 16) })}${coverage({ unresolved: [15] })}Answer.`, context)
    expect(accepted.unresolvedFacets).toEqual([15])
    const rejected = extractRootRequestMetadata(`${plan({ facets })}${coverage({ unresolved: [0] })}Answer.`, context)
    expect(rejected.requestPlan).toBeUndefined()
    expect(rejected.unresolvedFacets).toBeUndefined()
    expect(rejected.content).toBe('Answer.')
  })

  it.each([
    { unresolved: [2] },
    { unresolved: [-1] },
    { unresolved: [0.5] },
    { unresolved: ['0'] },
    { unresolved: [0, 0] },
    { unresolved: [0], notice: 'This fact is absent' },
    { unresolved: 'all' }
  ])('makes invalid coverage unavailable, never a facet exemption: %j', value => {
    const result = extractRootRequestMetadata(`${coverage(value)}Answer.`, { ...first, firstResponse: false, facetCount: 2 })
    expect(result.unresolvedFacets).toBeUndefined()
    expect(result.answerCoveragePresent).toBe(true)
    expect(result.content).toBe('Answer.')
    expect(result.framingIssue).toBeUndefined()
  })

  it('does not infer coverage or a plan from omission or a supplied count on the first response', () => {
    expect(extractRootRequestMetadata('Ordinary answer.', first)).toEqual({ content: 'Ordinary answer.' })
    const unknown = extractRootRequestMetadata(`${coverage({ unresolved: [0] })}Answer.`, { ...first, facetCount: 2 })
    expect(unknown.unresolvedFacets).toBeUndefined()
    const omitted = extractRootRequestMetadata(`${validPlan}Answer.`, first)
    expect(omitted.unresolvedFacets).toBeUndefined()
  })

  it.each([
    `${validPlan}${validPlan}${action}`,
    `${coverage({ unresolved: [] })}${validPlan}Answer.`,
    `${validPlan}${coverage({ unresolved: [] })}${coverage({ unresolved: [] })}Answer.`,
    '<wiki-request-plan>{"facets":[]}',
    '<wiki-answer-coverage>{"unresolved":[]}',
    `${validPlan}Prose.\n${coverage({ unresolved: [0] })}${action}`,
    `Prose before ${validPlan}${action}`,
    '<wiki-request-plan extra>{"facets":[]}</wiki-request-plan>',
    '</wiki-answer-coverage>Answer.',
    `"A literal." ${coverage({ unresolved: [0] })} "Another literal."`,
    `<wiki-request-plan>${validPlan}</wiki-request-plan>${action}`
  ])('rejects ambiguous controls without returning scope or a rewritten action: %s', content => {
    const result = extractRootRequestMetadata(content, first)
    expect(result.framingIssue).toBeDefined()
    expect(result.requestPlan).toBeUndefined()
    expect(result.unresolvedFacets).toBeUndefined()
    expect(result.content).toBe(content)
  })

  it('does not mistake reserved markers in exact quoted request JSON for nested controls', () => {
    const userRequest = 'Explain </wiki-request-plan> and <wiki-answer-coverage> literally'
    const anchored = { start: 0, end: userRequest.length, quote: userRequest, coverage: 'source' }
    const result = extractRootRequestMetadata(`${plan({ facets: [anchored] })}Answer.`, { userRequest, firstResponse: true })
    expect(result.requestPlan).toEqual([anchored])
    expect(result.content).toBe('Answer.')
    const unclosed = extractRootRequestMetadata(`<wiki-request-plan>${JSON.stringify({ facets: [anchored] })}`, { userRequest, firstResponse: true })
    expect(unclosed.framingIssue).toBeDefined()
  })

  it.each([
    `The source says "${validPlan}"; this is a quotation.`,
    `The source says '${validPlan}'; this is a quotation.`,
    `> ${validPlan}\n> Quoted source text.`,
    `    ${validPlan}`,
    `\t${validPlan}`,
    `\`${validPlan}\` is a code literal.`,
    `\`\`\`xml\n${validPlan}\n\`\`\`\nExplanation.`,
    `~~~xml\n${coverage({ unresolved: [0] })}\n~~~`,
    `Here is multiline inline code: \`\`\n${validPlan}\n\`\`.`,
    `Ordinary prose with a newline.\n\nNo controls here.`,
    ' \n\t'
  ])('preserves ordinary and literal-source content byte-for-byte: %s', content => {
    expect(extractRootRequestMetadata(content, first)).toEqual({ content })
  })
})
