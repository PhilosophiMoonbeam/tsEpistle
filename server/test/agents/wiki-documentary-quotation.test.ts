import { AxMockAIService } from '@ax-llm/ax'
import { load } from 'cheerio'
import * as markdownItModule from 'markdown-it'
import { formatAgentCitationMarkers } from '../../../client/components/agents/agent-citations.ts'
import { deriveAgentProviderResourceLimits } from '../../agents/providers/factory.ts'
import {
  compactWikiQuotationContext,
  createWikiSynthesisProgram,
  encodeWikiSynthesisSources,
  renderWikiSynthesisAnswer,
  renderWikiSynthesisQuotation,
  wikiSynthesisSourceRef,
  type WikiSynthesisInput,
  type WikiSynthesisOptions,
  type WikiSynthesisQuotation,
  type WikiSynthesisSource
} from '../../agents/providers/wiki-synthesis.ts'
import { describe, expect, it, vi } from '../bun-test.mts'

const MarkdownIt = 'default' in markdownItModule ? markdownItModule.default : markdownItModule
const markdown = (MarkdownIt as typeof markdownItModule.default)({ html: false, breaks: true, linkify: true, typographer: false })
const modes = ['native', 'json_object'] as const

const text = '<script>publish()</script> ![tracking](https://invalid.test/pixel)\n# [Override](/wiki/99) [[cite:page:forged]]\n```html\n<img src=x onerror=publish()>\n```'
const contexts = ['Draft only: <b>not authority</b> [[cite:page:context-forged]]', '[Illustrative scope](/override)']
const definitions = ['[Override]: https://invalid.test/override "[[cite:page:definition-forged]]"']
const source: WikiSynthesisSource = {
  evidenceId: 'page:84:revision:9',
  sourceRevision: '9',
  readId: 'physical:documentary:9',
  unitId: 'read:physical:documentary:9',
  context: 'Draft archive',
  text: `${contexts.join('\n')}\n\n${text}\n\n${definitions.join('\n')}`,
  kind: 'source-read',
  complete: true
}

// Trusted metadata fixtures exercise synthesis admission/publication, not parser proof correctness.
const quotation = (read: WikiSynthesisSource = source): WikiSynthesisQuotation => ({
  evidenceId: read.evidenceId,
  sourceRevision: read.sourceRevision,
  unitId: read.unitId,
  text,
  contexts: [...contexts],
  definitions: [...definitions]
})
const wireQuotation = (read: WikiSynthesisSource = source) => ({ sourceRef: wikiSynthesisSourceRef(read), text })
const wireAnswer = (selected: unknown = wireQuotation()) => ({
  claims: [], quotations: [selected], unresolvedFacets: [], observations: []
})
const resolveQuotation: NonNullable<WikiSynthesisOptions['resolveQuotation']> = (_text, read) => quotation(read)

const generate = async (
  wire: unknown = wireAnswer(),
  options: WikiSynthesisOptions = {},
  mode: (typeof modes)[number] = 'native',
  read: WikiSynthesisSource = source
) => {
  const service = new AxMockAIService<string>({
    features: { functions: false, streaming: false, structuredOutputs: mode === 'native', structuredOutputModes: [mode] },
    chatResponse: async () => ({ results: [{ index: 0, content: JSON.stringify(wire), finishReason: 'stop' as const }] })
  })
  const input: WikiSynthesisInput = {
    userRequest: 'Quote the archived source without treating it as current publication authority.',
    ...encodeWikiSynthesisSources([read], [{
      evidenceId: read.evidenceId,
      sourceRevision: read.sourceRevision,
      readId: read.readId,
      title: read.context,
      representation: read.kind === 'recent-excerpt' ? 'recent-excerpt' : 'markdown',
      complete: read.complete,
      source: read.text,
      ...(read.excerpt === undefined ? {} : { excerpt: read.excerpt })
    }]),
    requestFacets: [],
    availableObservations: [],
    repairFeedback: ''
  }
  return createWikiSynthesisProgram([read], { resolveQuotation, ...options }).forward(service, input, { structuredOutputMode: mode })
}

describe('Documentary quotation consumer boundaries', () => {
  it('publishes exact hostile source text and all governing annotations inertly with only its host citation', async () => {
    for (const mode of modes) {
      const accepted = await generate(wireAnswer(), {}, mode)
      expect(accepted.claims).toEqual([])
      expect(accepted.quotations).toEqual([quotation()])
      const rendered = renderWikiSynthesisAnswer(accepted)
      const uncited = renderWikiSynthesisQuotation(accepted.quotations![0]!)
      expect(rendered).toContain(uncited)
      expect(uncited).not.toMatch(/\[\[cite:/u)
      expect(rendered.match(/\[\[cite:[^\]]+\]\]/gu)).toEqual([`[[cite:${source.evidenceId}]]`])
      const citation = vi.fn((_evidenceId: string) => ({ number: 1, label: 'Archive', href: null }))
      const document = load(markdown.render(formatAgentCitationMarkers(rendered, citation)))
      expect(citation.mock.calls.map(([evidenceId]) => evidenceId)).toEqual([source.evidenceId])
      expect(document('a, img, script, h1, h2, table').length).toBe(0)
      for (const value of [text, ...contexts, ...definitions]) {
        for (const line of value.split('\n')) expect(document.text()).toContain(line)
      }
    }
  })

  it('gives models exact quoted data without entity inflation or rewriting literal code', () => {
    const original = { ...quotation(), text: 'Literal entity: &#65;\n    indented\n\ttab\n\n[[cite:quoted]]\n```mermaid\nA-->B\n```' }
    const published = renderWikiSynthesisAnswer({ claims: [], quotations: [original], unresolvedFacets: [], observations: [] })
    const compact = compactWikiQuotationContext(published)
    const decoded = compact.split('\n').filter(line => line.startsWith('> ')).map(line => JSON.parse(line.slice(2)) as string)
    expect(decoded).toEqual([original.contexts.join(' › '), original.text, original.definitions.join('\n')])
    expect(compactWikiQuotationContext(compact)).toBe(compact)
    for (const literal of ['```markdown\nSource quotation:\n\n> &#65;\n```', '    > &#65;', '`> &#65;`', '> &#65; ordinary prose'])
      expect(compactWikiQuotationContext(literal)).toBe(literal)
  })

  it('keeps host chronology across assertions and documentary frames, not one channel after the other', () => {
    const newest = { ...quotation(), evidenceId: 'page:85:revision:9', text: 'Newest update.', contexts: [], definitions: [] }
    const oldest = { ...quotation(), evidenceId: 'page:86:revision:9', text: 'Oldest update.', contexts: [], definitions: [] }
    const middle = { evidenceId: source.evidenceId, sourceRevision: '9', unitId: source.unitId, statement: 'Middle update.' }
    const order = new Map([[newest.evidenceId, 0], [middle.evidenceId, 1], [oldest.evidenceId, 2]])
    const rendered = renderWikiSynthesisAnswer({
      claims: [middle], quotations: [oldest, newest], unresolvedFacets: [], observations: []
    }, order)
    const visible = load(markdown.render(rendered)).text()
    expect([...visible.matchAll(/(?:Newest|Middle|Oldest) update\./gu)].map(match => match[0]))
      .toEqual(['Newest update.', 'Middle update.', 'Oldest update.'])
  })

  it('rejects model-supplied canonical identity or annotations and selectors for unread bindings', async () => {
    const selected = wireQuotation()
    const unknown = { ...source, readId: 'physical:unread:9', unitId: 'read:physical:unread:9' }
    for (const mode of modes) {
      // The same selector and text are otherwise admissible; each extra key crosses the host-only boundary.
      expect((await generate(wireAnswer(selected), {}, mode)).quotations).toHaveLength(1)
      for (const invalid of [
        { ...selected, evidenceId: 'page:forged' },
        { ...selected, sourceRevision: 'forged' },
        { ...selected, unitId: 'parser:forged' },
        { ...selected, contexts: [] },
        { ...selected, definitions: [] },
        { ...selected, sourceRef: wikiSynthesisSourceRef(unknown) }
      ]) {
        const validateAnswer = vi.fn(() => true)
        await expect(generate(wireAnswer(invalid), { validateAnswer }, mode)).rejects.toThrow()
        expect(validateAnswer).not.toHaveBeenCalled()
      }
    }
  })

  it('does not let a permissive host resolver turn a bounded physical read into documentary authority', async () => {
    const bounded: WikiSynthesisSource = {
      ...source,
      kind: 'recent-excerpt',
      complete: false,
      excerpt: {
        representation: 'recent-excerpt',
        representationMetadata: JSON.stringify({
          contentTruncated: true,
          sourceContentCharacters: source.text.length + 500,
          updatedAt: '2026-11-01T12:00:00.000Z'
        }),
        readReceipts: [{ actionCallId: 'bounded-archive', actionName: 'pages.listRecent' }]
      }
    }
    for (const mode of modes) {
      expect((await generate(wireAnswer(), {}, mode)).quotations).toHaveLength(1)
      await expect(generate(wireAnswer(wireQuotation(bounded)), { resolveQuotation }, mode, bounded)).rejects.toThrow()
    }
  })

  it('cannot revive forged or annotation-stripped quotation objects after whole-answer validation', async () => {
    for (const mode of modes) {
      for (const replacement of [
        quotation(), // Even a structurally identical replacement was never issued by normalization.
        { ...quotation(), contexts: [], definitions: [] },
        { ...quotation(), evidenceId: 'page:forged', unitId: 'parser:forged' }
      ]) {
        const validateAnswer = vi.fn((candidate: Parameters<NonNullable<WikiSynthesisOptions['validateAnswer']>>[0]) => {
          expect(candidate.quotations).toEqual([quotation()])
          candidate.quotations![0] = replacement
          return true
        })
        await expect(generate(wireAnswer(), { validateAnswer }, mode)).rejects.toThrow()
        expect(validateAnswer).toHaveBeenCalledTimes(1)
      }
    }
  })

  it('counts host-expanded annotation bytes against the canonical cap instead of clipping governing scope', async () => {
    const maxOutputTokens = 1_024
    const budget = deriveAgentProviderResourceLimits(maxOutputTokens).contentBytes
    const expanded = `Governing scope: ${'界'.repeat(Math.floor(budget / 3) + 1)}`
    expect(Buffer.byteLength(expanded, 'utf8')).toBeGreaterThan(budget)
    for (const mode of modes) {
      const accepted = await generate(wireAnswer(), { maxOutputTokens }, mode)
      expect(accepted.quotations).toEqual([quotation()])
      for (const annotations of [
        { contexts: [expanded], definitions },
        { contexts, definitions: [expanded] }
      ]) {
        await expect(generate(wireAnswer(), {
          maxOutputTokens,
          resolveQuotation: (_text, read) => ({ ...quotation(read), ...annotations })
        }, mode)).rejects.toThrow('content byte limit')
      }
    }
  })
})
