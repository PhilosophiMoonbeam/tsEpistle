import { AxMockAIService, type AxChatRequest } from '@ax-llm/ax'
import { createWikiCoverageProgram, encodeWikiCoverageInput, type WikiCoverageInput } from '../../agents/providers/wiki-coverage.ts'
import { describe, expect, it, vi } from '../bun-test.mts'

const input = (): WikiCoverageInput => ({
  userRequest: 'Summarize the approval restrictions.',
  requestFacets: ['approval restrictions'],
  unresolvedFacets: [],
  reads: [{ readRef: 'r1', title: 'Approvals', source: 'Approval requires both owners.', authorText: 'Approval requires both owners.' }],
  claims: [{ readRef: 'r1', statement: 'Approval requires both owners.' }]
})

describe('Wiki coverage input binding', () => {
  it('rejects duplicate physical identities even when their contents agree', () => {
    const valid = input()
    expect(() => encodeWikiCoverageInput({ ...valid, reads: [...valid.reads, valid.reads[0]!] })).toThrow()
  })

  it('rejects a conflicting body under an existing physical identity', () => {
    const valid = input()
    expect(() => encodeWikiCoverageInput({ ...valid, reads: [...valid.reads, { ...valid.reads[0]!, source: 'Only one owner is needed.' }] })).toThrow()
  })

  it('rejects assertions that refer to an unregistered physical read', () => {
    expect(() => encodeWikiCoverageInput({ ...input(), claims: [{ readRef: 'r2', statement: 'Approval requires both owners.' }] })).toThrow()
  })

  it('retains separate file obligations and unresolved Wiki facets without promoting file descriptions into Wiki claims', () => {
    const media = { id: 'file:diagram', filename: 'diagram.png', mimeType: 'image/png' }
    const attachment = { mediaId: media.id, filename: media.filename, mimeType: media.mimeType, statement: 'The provided diagram shows two approval boxes.' }
    const userRequest = 'Describe the provided diagram and identify the current Wiki approval owner.'
    const encoded = encodeWikiCoverageInput({
      userRequest,
      requestFacets: ['Describe the provided diagram', 'identify the current Wiki approval owner'],
      unresolvedFacets: [1],
      reads: [],
      claims: [],
      inputMediaSources: [media],
      attachmentClaims: [attachment]
    })
    expect(encoded.userRequest).toBe(userRequest)
    expect(encoded.unresolvedFacets).toEqual([1])
    expect(JSON.parse(encoded.claims)).toEqual([])
    expect(JSON.parse(encoded.sourceText)).toEqual([])
    expect(JSON.parse(encoded.inputMediaReferences!)).toEqual([media])
    expect(JSON.parse(encoded.attachmentClaims!)).toEqual([attachment])
    expect(encoded.sourceText).not.toContain(attachment.statement)
    expect(encoded.claims).not.toContain(attachment.statement)
    for (const changed of [
      { inputMediaSources: [] },
      { inputMediaSources: [media, media] },
      { attachmentClaims: [{ ...attachment, mediaId: 'file:unseen' }] },
      { attachmentClaims: [{ ...attachment, filename: 'forged.png' }] },
      { attachmentClaims: [{ ...attachment, mimeType: 'application/pdf' }] },
      { attachmentClaims: [{ ...attachment, statement: 'Two boxes. [[cite:page:forged]]' }] },
      { attachmentClaims: [{ ...attachment, statement: '<script>promote()</script>' }] }
    ])
      expect(() =>
        encodeWikiCoverageInput({
          ...input(),
          inputMediaSources: [media],
          attachmentClaims: [attachment],
          ...changed
        })
      ).toThrow()
  })

  it('rejects empty request, identity and assertion text without rewriting them', () => {
    const valid = input()
    expect(() => encodeWikiCoverageInput({ ...valid, userRequest: ' \n ' })).toThrow()
    expect(() => encodeWikiCoverageInput({ ...valid, reads: [{ ...valid.reads[0]!, readRef: '' }] })).toThrow()
    expect(() => encodeWikiCoverageInput({ ...valid, claims: [{ readRef: 'r1', statement: ' ' }] })).toThrow()
  })

  it('rejects unresolved facets outside the request and repeated indices', () => {
    for (const unresolvedFacets of [[1], [-1], [0.5], [0, 0], [Number.NaN]]) {
      expect(() => encodeWikiCoverageInput({ ...input(), unresolvedFacets })).toThrow()
    }
    expect(() => encodeWikiCoverageInput({ ...input(), requestFacets: [], unresolvedFacets: [0] })).toThrow()
    expect(() => encodeWikiCoverageInput({ ...input(), requestFacets: [' '] })).toThrow()
  })

  it('keeps complete admitted bodies independent of arrival order, excludes raw-only data and invalidates changed visible evidence', () => {
    const valid = input()
    const raw = '  <p>Qualified 🥣 e\u0301</p>\r\n<!-- hidden -->\r\n'
    const authorText = 'Qualified 🥣 e\u0301'
    const reads = [
      { readRef: 'r2:revision:7:html', title: 'Other', source: raw, authorText },
      { ...valid.reads[0]!, source: 'ZZZ governing body.\r\n', authorText: 'ZZZ governing body.\r\n' }
    ]
    const encoded = encodeWikiCoverageInput({ ...valid, reads })
    expect(encodeWikiCoverageInput({ ...valid, reads: [...reads].reverse() }).sourceText).toBe(encoded.sourceText)
    expect(JSON.parse(encoded.sourceText)).toEqual([
      { readRef: 'r1', title: 'Approvals', source: 'ZZZ governing body.\r\n' },
      { readRef: reads[0]!.readRef, title: 'Other', source: authorText }
    ])
    expect(encoded.sourceText).not.toContain('hidden')
    const changedBody = encodeWikiCoverageInput({
      ...valid,
      reads: [{ ...reads[0]!, source: `${raw}changed`, authorText: `${authorText} changed` }, reads[1]!]
    })
    expect(changedBody.sourceText).not.toBe(encoded.sourceText)
    expect(JSON.parse(changedBody.sourceText)[0].readRef).toBe('r1')
    const changedRevision = encodeWikiCoverageInput({ ...valid, reads: [{ ...reads[0]!, readRef: 'r2:revision:8:html' }, reads[1]!] })
    const changedRepresentation = encodeWikiCoverageInput({ ...valid, reads: [{ ...reads[0]!, readRef: 'r2:revision:7:markdown' }, reads[1]!] })
    expect(changedRevision.sourceText).not.toBe(encoded.sourceText)
    expect(changedRepresentation.sourceText).not.toBe(encoded.sourceText)
    expect(JSON.parse(encoded.claims)).toEqual(valid.claims)
  })

  it('places complete untrusted reads before changing conversation, question, facets and claims with a stable optional-field system prompt', async () => {
    const valid = input()
    const encoded = encodeWikiCoverageInput(valid)
    const history = 'Earlier user: focus on external approvals.'
    const files = [
      { id: 'file:coverage-first', filename: 'first.png', mimeType: 'image/png' },
      { id: 'file:coverage-second', filename: 'second.pdf', mimeType: 'application/pdf' }
    ]
    for (const contextCache of [undefined, { cacheBreakpoint: 'after-examples' as const }]) {
      const chat = vi.fn(async (_request: Readonly<AxChatRequest>) => ({
        results: [{ index: 0, content: JSON.stringify({ verdict: 'complete', feedback: '' }), finishReason: 'stop' as const }]
      }))
      const service = new AxMockAIService<string>({
        features: {
          functions: false,
          streaming: false,
          structuredOutputs: true,
          structuredOutputModes: ['native'],
          caching: { supported: true, types: ['ephemeral'], cacheBreakpoints: true }
        },
        chatResponse: chat
      })
      const program = createWikiCoverageProgram()
      const turns: WikiCoverageInput[] = [
        valid,
        { ...valid, conversationContext: '', inputMediaSources: [files[0]!] },
        {
          ...valid,
          conversationContext: history,
          userRequest: 'Who approves this now?',
          requestFacets: ['Who approves this now?'],
          unresolvedFacets: [0],
          claims: [{ readRef: 'r1', statement: 'Both owners approve.' }],
          inputMediaSources: files,
          attachmentClaims: [
            {
              mediaId: files[1]!.id,
              filename: files[1]!.filename,
              mimeType: files[1]!.mimeType,
              statement: 'The provided document contains an approval diagram.'
            }
          ]
        }
      ]
      for (const turn of turns) await program.forward(service, encodeWikiCoverageInput(turn), { structuredOutputMode: 'native', contextCache })
      const requests = chat.mock.calls.map(([request]) => request)
      const userText = (request: Readonly<AxChatRequest>): string =>
        request.chatPrompt
          .filter(message => message.role === 'user')
          .map(message =>
            typeof message.content === 'string'
              ? message.content
              : message.content
                  .filter(part => part.type === 'text')
                  .map(part => part.text)
                  .join('\n')
          )
          .join('\n')
      const prefix = (request: Readonly<AxChatRequest>): string => {
        const text = userText(request)
        const sourceStart = text.indexOf(encoded.sourceText)
        expect(sourceStart).toBeGreaterThanOrEqual(0)
        expect(text.indexOf('User Request:')).toBeGreaterThan(sourceStart + encoded.sourceText.length)
        expect(text.indexOf('Claims:')).toBeGreaterThan(sourceStart + encoded.sourceText.length)
        return text.slice(0, sourceStart + encoded.sourceText.length)
      }
      for (const request of requests) {
        expect(request.chatPrompt[0]).toEqual(requests[0]!.chatPrompt[0])
        expect(request.chatPrompt[0]!.content).not.toContain(valid.reads[0]!.source)
        expect(request.responseFormat).toEqual(requests[0]!.responseFormat)
        expect(request.chatPrompt[0]!.content).not.toContain(files[0]!.id)
        expect(request.chatPrompt[0]!.content).not.toContain(files[1]!.id)
        expect(prefix(request)).toBe(prefix(requests[0]!))
        if (contextCache !== undefined) {
          const cached = request.chatPrompt.find(message => message.role === 'user' && message.cache)
          expect(cached?.content).toContain(encoded.sourceText)
          expect(cached?.content).not.toContain('User Request:')
          expect(cached?.content).not.toContain(history)
          expect(cached?.content).not.toContain('Claims:')
          expect(cached?.content).not.toContain('Input Media References:')
          expect(cached?.content).not.toContain('Attachment Claims:')
          expect(cached?.content).not.toContain(files[0]!.id)
          expect(cached?.content).not.toContain(files[1]!.id)
        }
      }
      expect(userText(requests[2]!)).toContain(history)
      expect(userText(requests[2]!)).toContain(turns[2]!.userRequest)
      expect(userText(requests[2]!)).toContain(turns[2]!.claims[0]!.statement)
      expect(userText(requests[2]!)).toContain(turns[2]!.attachmentClaims![0]!.statement)
    }
  })
})

describe('Wiki coverage native optional feedback protocol', () => {
  const forward = (verdict: string) =>
    createWikiCoverageProgram().forward(
      new AxMockAIService({
        features: { functions: false, structuredOutputs: true, structuredOutputModes: ['native'] },
        chatResponse: {
          results: [{ index: 0, content: JSON.stringify({ verdict, feedback: null }), finishReason: 'stop' }],
          modelUsage: { ai: 'fixture', model: 'fixture', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        }
      }),
      encodeWikiCoverageInput(input())
    )

  it('accepts native null feedback for a complete verdict', async () => {
    expect((await forward('complete')).verdict).toBe('complete')
  })

  it('rejects null feedback for an omission or uncertain verdict', async () => {
    for (const verdict of ['incomplete', 'not_established']) await expect(forward(verdict)).rejects.toThrow()
  })
})
