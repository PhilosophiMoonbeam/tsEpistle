import { Hash } from 'node:crypto'
import { load } from 'cheerio'
import { axGlobals, AxMockAIService, type AxAIServiceOptions, type AxChatRequest, type AxChatResponse, type AxGenOut, type AxResultPickerFunction } from '@ax-llm/ax'
import { ProxyTracerProvider } from '@opentelemetry/api'
import * as markdownItModule from 'markdown-it'
import { formatAgentCitationMarkers } from '../../../client/components/agents/agent-citations.ts'
import { createWikiSynthesisProgram, createWikiSynthesisStreamGuard, encodeWikiSynthesisAnswer, encodeWikiSynthesisSources, wikiSynthesisSourceRef, renderWikiSynthesisAnswer, validateWikiSynthesisShape, type WikiSynthesisAnswer, type WikiSynthesisInput, type WikiSynthesisOptions, type WikiSynthesisRead, type WikiSynthesisSource } from '../../agents/providers/wiki-synthesis.ts'
import { evaluateWikiSynthesisFixtures, optimizeWikiSynthesis, parseWikiSynthesisFixtures } from '../../agents/providers/wiki-synthesis-evaluation.ts'
import { synthesisReadsFromRequest, synthesisSourcesFromRequest } from './synthesis-fixture.ts'
import type { WikiSynthesisReferenceIndex } from '../../agents/providers/wiki-synthesis.ts'
import { describe, expect, it, vi } from '../bun-test.mts'

const MarkdownIt = 'default' in markdownItModule ? markdownItModule.default : markdownItModule
const markdown = (MarkdownIt as typeof markdownItModule.default)({ html: false, breaks: true, linkify: true, typographer: false })

const source: WikiSynthesisSource = {
  evidenceId: 'page:42:revision:7:section:1',
  sourceRevision: '7',
  unitId: 'read:physical:approval:7',
  readId: 'physical:approval:7',
  context: 'External publication only',
  text: 'External publication requires two approvals.',
  kind: 'source-read',
  complete: true
}

// These direct fixtures declare synthetic author content, not retrieved pages.
const fixtureReads = (sources: readonly WikiSynthesisSource[]): WikiSynthesisRead[] =>
  sources.map(source => ({
    evidenceId: source.evidenceId, sourceRevision: source.sourceRevision,
    readId: source.readId, title: source.context || null, representation: 'markdown',
    complete: source.complete, source: source.text
  }))
const encodeFixtureSources = (sources: readonly WikiSynthesisSource[]) => encodeWikiSynthesisSources(sources, fixtureReads(sources))
const input: WikiSynthesisInput = {
  userRequest: 'What approvals are required, and who approves?',
  ...encodeFixtureSources([source]),
  requestFacets: ['What approvals are required?', 'who approves?'],
  availableObservations: [],
  repairFeedback: ''
}
const answer = (changes: Partial<WikiSynthesisAnswer> = {}): WikiSynthesisAnswer => ({
  claims: [{ evidenceId: source.evidenceId, sourceRevision: source.sourceRevision, unitId: source.unitId, statement: source.text }],
  unresolvedFacets: [1],
  observations: [],
  recommendations: '',
  ...changes
})

const generate = (prediction: WikiSynthesisAnswer, sources: readonly WikiSynthesisSource[] = [source], options: WikiSynthesisOptions = {}, mode: 'native' | 'json_object' = 'native', wire: unknown = encodeWikiSynthesisAnswer(prediction)) => {
  const chat = vi.fn(async (_request: Readonly<AxChatRequest<unknown>>) => ({ results: [{ index: 0, content: JSON.stringify(wire), finishReason: 'stop' as const }] }))
  const service = new AxMockAIService<string>({
    features: { functions: false, streaming: false, structuredOutputs: mode === 'native', structuredOutputModes: [mode] },
    chatResponse: chat
  })
  const program = createWikiSynthesisProgram(sources, { facetCount: input.requestFacets.length, ...options })
  return { result: program.forward(service, { ...input, ...encodeFixtureSources(sources), availableObservations: [...(options.observations ?? [])] }, { structuredOutputMode: mode }), chat }
}

describe('Wiki source-bound typed synthesis', () => {
  it('preserves an unanswered requested facet through native and schema-validated JSON fallback', async () => {
    for (const mode of ['native', 'json_object'] as const) {
      const generated = generate(answer(), [source], {}, mode)
      const accepted = await generated.result
      expect(accepted.unresolvedFacets).toEqual([1])
      expect(generated.chat).toHaveBeenCalledTimes(1)
      const request = generated.chat.mock.calls[0]![0]
      expect(request.functions ?? []).toHaveLength(0)
      expect(request.responseFormat?.type).toBe(mode === 'native' ? 'json_schema' : 'json_object')
    }
  })

  it('preserves explicitly emitted faithful quotations through both host validation boundaries', async () => {
    const literalStatement = 'Status: Illustrative and untested | Scope: External publication only | Required approvals: **two**.'
    const quoted = { ...source, text: `${literalStatement}\n${source.text}` }
    const selection = answer({ claims: [{ ...answer().claims[0]!, statement: literalStatement }] })
    for (const mode of ['native', 'json_object'] as const) {
      const validateClaim = vi.fn((claim: WikiSynthesisAnswer['claims'][number]) => claim.statement === literalStatement)
      const validateAnswer = vi.fn((candidate: WikiSynthesisAnswer) => candidate.claims[0]?.statement === literalStatement)
      const generated = generate(selection, [quoted], { validateClaim, validateAnswer }, mode)
      const accepted = await generated.result
      expect(accepted.claims).toEqual([{ ...selection.claims[0]!, statement: literalStatement }])
      expect(validateClaim).toHaveBeenCalledTimes(1)
      expect(validateAnswer).toHaveBeenCalledTimes(1)
      expect(renderWikiSynthesisAnswer(accepted)).toContain('Illustrative and untested')
      expect(generated.chat).toHaveBeenCalledTimes(1)
      const authored = generate(answer(), [quoted], { validateClaim: claim => claim.statement === source.text }, mode)
      expect((await authored.result).claims[0]?.statement).toBe(source.text)
    }
  })


  it('rejects blank record proposals without publishing private unrequested fields and keeps explicit requested prose unchanged', async () => {
    const literalStatement = 'Name: Morgan Vale | Role: Fictional, non-operative logistics reviewer | Email: morgan@example.invalid | Phone: 000-000'
    const record = { ...source, text: literalStatement }
    const statement = 'Morgan Vale’s Role is a fictional, non-operative logistics reviewer.'
    for (const mode of ['native', 'json_object'] as const) {
      for (const blank of ['', ' \t ']) {
        const proposed = answer({ claims: [{ ...answer().claims[0]!, statement: blank }] })
        await expect(generate(proposed, [record], {}, mode).result).rejects.toThrow()
        const guard = createWikiSynthesisStreamGuard([record])
        expect(guard(JSON.stringify(encodeWikiSynthesisAnswer(proposed)))).toBeDefined()
        const wire = encodeWikiSynthesisAnswer(proposed)
        const service = new AxMockAIService<string>({
          features: { functions: false, streaming: true, structuredOutputs: mode === 'native', structuredOutputModes: [mode] },
          chatResponse: async () => new ReadableStream<AxChatResponse>({
            start(controller) {
              controller.enqueue({ results: [{ index: 0, content: `{"claims":[${JSON.stringify(wire.claims[0])},{"sourceRef":` }] })
              controller.enqueue({ results: [{ index: 0, content: `${JSON.stringify(wire.claims[0]!.sourceRef)},"statement":${JSON.stringify(statement)}}],"unresolvedFacets":[1],"observations":[]}`, finishReason: 'stop' }] })
              controller.close()
            }
          })
        })
        const published: WikiSynthesisAnswer['claims'] = []
        const consume = async () => {
          for await (const chunk of createWikiSynthesisProgram([record], { facetCount: 2 }).streamingForward(service, { ...input, ...encodeFixtureSources([record]) }, { structuredOutputMode: mode }))
            published.push(...(chunk.delta.claims ?? []))
        }
        await expect(consume()).rejects.toThrow()
        expect(published).toEqual([])
      }
      const requested = answer({ claims: [{ ...answer().claims[0]!, statement }] })
      const accepted = await generate(requested, [record], {
        validateClaim: claim => claim.statement === statement,
        validateAnswer: candidate => candidate.claims[0]?.statement === statement
      }, mode).result
      expect(accepted.claims).toEqual(requested.claims)
      const rendered = renderWikiSynthesisAnswer(accepted)
      expect(rendered).toBe(`${statement} [[cite:${record.evidenceId}]]`)
      const html = markdown.render(formatAgentCitationMarkers(rendered, () => ({ number: 1, label: 'Benchmark', href: null })))
      expect(html).not.toContain('Email')
      expect(html).not.toContain('Phone')
      expect(html).not.toContain('<h')
    }
  })

  it('renders independently validated selected-field comparisons and lists without native-whole-body expansion in final and streaming consumers', async () => {
    const readText = 'Fictional and non-operative. Both plans require manager approval.\n\n| Field | Atlas | Boreal |\n| --- | --- | --- |\n| Monthly fee | USD 120 | USD 180 |\n| Status | Pilot only | Pilot only |\n\nPrivate contact: keeper@example.test.'
    const bound = { ...source, text: readText }
    const statements = [
      'Both Atlas and Boreal require manager approval; the plans are fictional and non-operative.',
      'Fictional, non-operative pilot plans:\n\n| Plan | Monthly fee |\n| --- | --- |\n| Atlas | USD 120 |\n| Boreal | USD 180 |',
      'Fictional, non-operative pilot plans:\n\n- Atlas: USD 120 monthly.\n- Boreal: USD 180 monthly.'
    ]
    for (const mode of ['native', 'json_object'] as const) for (const statement of statements) {
      const predicted = answer({ claims: [{ ...answer().claims[0]!, statement }] })
      const validateClaim = vi.fn((_claim: WikiSynthesisAnswer['claims'][number], selected: WikiSynthesisSource) => selected.text === readText)
      const validateAnswer = vi.fn((_answer: WikiSynthesisAnswer, _rendered: string) => true)
      const options = { validateClaim, validateAnswer }
      const accepted = await generate(predicted, [bound], options, mode).result
      expect(accepted.claims).toEqual(predicted.claims)
      expect(validateClaim).toHaveBeenCalledTimes(1)
      expect(validateAnswer).toHaveBeenCalledTimes(1)
      const rendered = renderWikiSynthesisAnswer(accepted)
      expect(rendered).toBe(`${statement}${statement.includes('\n') ? '\n\n' : ' '}[[cite:${source.evidenceId}]]`)
      expect(rendered).not.toContain('keeper@example.test')
      expect(rendered).not.toContain('Status')
      const html = markdown.render(formatAgentCitationMarkers(rendered, () => ({ number: 1, label: 'Plans', href: null })))
      expect(html.match(/<strong>\[1\]<\/strong>/gu)).toHaveLength(1)
      if (statement.includes('| Plan |')) expect(html.match(/<table>/gu)).toHaveLength(1)
      if (statement.includes('- Atlas:')) expect(html.match(/<ul>/gu)).toHaveLength(1)
      const wire = JSON.stringify(encodeWikiSynthesisAnswer(predicted))
      const guard = createWikiSynthesisStreamGuard([bound])
      for (const character of wire) expect(guard(character)).toBeUndefined()
      const streaming = new AxMockAIService<string>({
        features: { functions: false, streaming: true, structuredOutputs: mode === 'native', structuredOutputModes: [mode] },
        chatResponse: async () => new ReadableStream<AxChatResponse>({
          start(controller) {
            controller.enqueue({ results: [{ index: 0, content: wire.slice(0, -1) }] })
            controller.enqueue({ results: [{ index: 0, content: '}', finishReason: 'stop' }] })
            controller.close()
          }
        })
      })
      const claims: WikiSynthesisAnswer['claims'] = []
      for await (const chunk of createWikiSynthesisProgram([bound], { facetCount: 2, ...options }).streamingForward(
        streaming, { ...input, ...encodeFixtureSources([bound]) }, { structuredOutputMode: mode }
      )) claims.push(...(chunk.delta.claims ?? []))
      expect(claims).toEqual(predicted.claims)
      expect(renderWikiSynthesisAnswer({ ...accepted, claims })).toBe(rendered)
      await expect(generate(predicted, [bound], { ...options, validateClaim: () => 'Independent proof rejected this assertion.' }, mode).result)
        .rejects.toThrow('Independent proof rejected')
    }
  })


  it('normalizes only harmless one-paragraph soft wraps before native semantic validation and final/stream Markdown rendering', async () => {
    const normalized = 'Morgan Vale’s fictional, non-operative Role is reviewer; the limit is USD 120. See [annex](/annex) and use `scope_id`.'
    const owned = { ...source, text: normalized }
    for (const mode of ['native', 'json_object'] as const) for (const ending of ['\n', '\r\n']) {
      const wrapped = normalized.replace('Role is', `Role${ending}is`).replace('See [annex]', `See${ending}[annex]`)
      const proposed = answer({ claims: [{ ...answer().claims[0]!, statement: wrapped }] })
      const validateClaim = vi.fn((claim: WikiSynthesisAnswer['claims'][number]) => claim.statement === normalized)
      const options = { validateClaim }
      const accepted = await generate(proposed, [owned], options, mode).result
      expect(accepted.claims[0]!.statement).toBe(normalized)
      expect(validateClaim.mock.calls[0]?.[0]).toEqual(accepted.claims[0])
      const rendered = renderWikiSynthesisAnswer(accepted)
      const html = markdown.render(formatAgentCitationMarkers(rendered, () => ({ number: 1, label: 'Role', href: null })))
      expect(html.match(/<p>/gu)).toHaveLength(1)
      expect(html).not.toContain('<br>')
      expect(load(html).text()).toContain('Morgan Vale’s fictional, non-operative Role is reviewer; the limit is USD 120.')
      expect(html).toContain('href="/annex"')
      expect(html).toContain('<code>scope_id</code>')
      const wire = encodeWikiSynthesisAnswer(proposed)
      const guard = createWikiSynthesisStreamGuard([owned])
      for (const character of JSON.stringify(wire)) expect(guard(character)).toBeUndefined()
      const service = new AxMockAIService<string>({
        features: { functions: false, streaming: true, structuredOutputs: mode === 'native', structuredOutputModes: [mode] },
        chatResponse: async () => new ReadableStream<AxChatResponse>({
          start(controller) {
            controller.enqueue({ results: [{ index: 0, content: JSON.stringify(wire), finishReason: 'stop' }] })
            controller.close()
          }
        })
      })
      const streamed: WikiSynthesisAnswer['claims'] = []
      for await (const chunk of createWikiSynthesisProgram([owned], { facetCount: 2, ...options }).streamingForward(service, {
        ...input, ...encodeFixtureSources([owned])
      }, { structuredOutputMode: mode })) streamed.push(...(chunk.delta.claims ?? []))
      expect(streamed).toEqual(accepted.claims)
      expect(renderWikiSynthesisAnswer({ ...accepted, claims: streamed })).toBe(rendered)
      await expect(generate(proposed, [owned], { validateClaim: () => false }, mode).result).rejects.toThrow()
    }
    for (const statement of [
      '# Morgan Vale\nRole is reviewer.', 'Morgan Vale\n---',
      '> Morgan Vale\n> Role: reviewer.', '    Morgan Vale\n    Role: reviewer.',
      '```\nMorgan Vale\n```', '<p>Morgan Vale\nRole is reviewer.</p>',
      'Morgan Vale\n[role]: /role', 'Morgan Vale  \nRole is reviewer.',
      'Morgan Vale\\\nRole is reviewer.', 'Morgan **Vale\nRole** is reviewer.',
      'Morgan `scope_\nid` is reviewer.', 'Morgan [Vale\nRole](/role) is reviewer.',
      'Morgan [Vale](/ro\nle) is reviewer.'
    ]) {
      const proposed = answer({ claims: [{ ...answer().claims[0]!, statement }] })
      await expect(generate(proposed).result).rejects.toThrow()
      expect(createWikiSynthesisStreamGuard([source])(JSON.stringify(encodeWikiSynthesisAnswer(proposed)))).toContain('Unsupported statement format')
    }
  })


  it('reports claim output bounds separately from format mismatch without disclosing statement text', () => {
    const statement = `Private wording ${'x'.repeat(70_000)}`
    const proposed = answer({ claims: [{ ...answer().claims[0]!, statement }] })
    const feedback = createWikiSynthesisStreamGuard([source], { maxOutputTokens: 1_024 })(JSON.stringify(encodeWikiSynthesisAnswer(proposed)))
    expect(feedback).toContain('output content byte limit')
    expect(feedback).not.toContain('Private wording')
  })

  it('retains trusted canonical host replacements without accepting replacement provenance outside the original registry', async () => {
    const quoted = { ...source, text: `Illustrative only: ${source.text}` }
    const wire = encodeWikiSynthesisAnswer(answer())
    for (const mode of ['native', 'json_object'] as const) {
      const service = new AxMockAIService<string>({
        features: { functions: false, streaming: false, structuredOutputs: mode === 'native', structuredOutputModes: [mode] },
        chatResponse: { results: [{ index: 0, content: JSON.stringify(wire), finishReason: 'stop' }] }
      })
      const program = createWikiSynthesisProgram([quoted], {
        facetCount: 2,
        validateAnswer: candidate => {
          candidate.claims[0] = { ...candidate.claims[0]!, statement: quoted.text }
          return true
        }
      })
      const expected = [{ ...answer().claims[0]!, statement: quoted.text }]
      expect((await program.forward(service, { ...input, ...encodeFixtureSources([quoted]) }, { structuredOutputMode: mode })).claims).toEqual(expected)
      const claims: WikiSynthesisAnswer['claims'] = []
      for await (const chunk of program.streamingForward(service, { ...input, ...encodeFixtureSources([quoted]) }, { structuredOutputMode: mode }))
        claims.push(...(chunk.delta.claims ?? []))
      expect(claims).toEqual(expected)
      const rejected = generate(answer(), [quoted], {
        validateAnswer: candidate => {
          candidate.claims[0] = { ...candidate.claims[0]!, unitId: 'unknown' }
          return true
        }
      }, mode)
      await expect(rejected.result).rejects.toThrow('exact original complete source binding')
    }
  })


  it('bounds cumulative explicit canonical statements by the existing provider content budget without clipping quotations', async () => {
    const quoted = { ...source, text: 'Exact authored assertion. '.repeat(200) }
    const selected = { ...answer().claims[0]!, statement: quoted.text }
    const claims = Array.from({ length: 64 }, () => ({ ...selected }))
    for (const mode of ['native', 'json_object'] as const) {
      const generated = generate(answer({ claims }), [quoted], { maxOutputTokens: 1_024 }, mode)
      await expect(generated.result).rejects.toThrow('content byte limit')
      expect(generated.chat).toHaveBeenCalledTimes(1)
      const accepted = await generate(answer({ claims: [selected] }), [quoted], { maxOutputTokens: 1_024 }, mode).result
      expect(accepted.claims[0]?.statement).toBe(quoted.text)
    }
    const guard = createWikiSynthesisStreamGuard([quoted], { maxOutputTokens: 1_024 })
    expect(guard(`{"claims":[${JSON.stringify(encodeWikiSynthesisAnswer(answer({ claims: [selected] })).claims[0])}`)).toBeUndefined()
    expect(guard(encodeWikiSynthesisAnswer(answer({ claims: claims.slice(1) })).claims.map(claim => `,${JSON.stringify(claim)}`).join(''))).toContain('content byte limit')
  })

  it('streams only explicit canonical quotations through incomplete-array transitions and rejects truncated or failed terminal output', async () => {
    const quoted = { ...source, text: 'Status: Illustrative only | External publication requires two approvals.' }
    const selected = { ...answer().claims[0]!, statement: quoted.text }
    const wire = encodeWikiSynthesisAnswer(answer({ claims: [selected] })).claims[0]!
    const first = `{"claims":[${JSON.stringify(wire)},{"sourceRef":${' '.repeat(192)}`
    const tail = `${JSON.stringify(wire.sourceRef)},"statement":${JSON.stringify(wire.statement)}}],"unresolvedFacets":[1],"observations":[],"recommendations":""}`
    for (const mode of ['native', 'json_object'] as const) {
      for (const finish of ['stop', 'length', 'error', 'truncated'] as const) {
        const chat = vi.fn(async () => new ReadableStream<AxChatResponse>({
          start(controller) {
            controller.enqueue({ results: [{ index: 0, content: first }] })
            if (finish !== 'truncated') controller.enqueue({ results: [{ index: 0, content: tail }] })
            controller.enqueue({ results: [{ index: 0, finishReason: finish === 'truncated' ? 'stop' : finish }] })
            controller.close()
          }
        }))
        const service = new AxMockAIService<string>({
          features: { functions: false, streaming: true, structuredOutputs: mode === 'native', structuredOutputModes: [mode] },
          chatResponse: chat
        })
        const program = createWikiSynthesisProgram([quoted], { facetCount: 2 })
        const claims: WikiSynthesisAnswer['claims'] = []
        const consume = async () => {
          for await (const chunk of program.streamingForward(service, { ...input, ...encodeFixtureSources([quoted]) }, { structuredOutputMode: mode })) {
            for (const claim of chunk.delta.claims ?? []) {
              expect(claim.statement).toBe(quoted.text)
              claims.push(claim)
            }
          }
        }
        if (finish === 'stop') {
          await consume()
          expect(claims).toEqual([{ ...selected, statement: quoted.text }, { ...selected, statement: quoted.text }])
        } else {
          await expect(consume()).rejects.toThrow()
        }
        expect(chat).toHaveBeenCalledTimes(1)
      }
    }
  })

  it('isolates canonical streaming byte allowances by sample index through repaired partial arrays', async () => {
    const quoted = { ...source, text: 'Exact authored assertion. '.repeat(1_200) }
    const selected = { ...answer().claims[0]!, statement: quoted.text }
    const wire = encodeWikiSynthesisAnswer(answer({ claims: [selected] })).claims[0]!
    const first = `{"claims":[${JSON.stringify(wire)},{"sourceRef":${' '.repeat(192)}`
    const tail = `${JSON.stringify(wire.sourceRef)},"statement":${JSON.stringify(wire.statement)}}],"unresolvedFacets":[1],"observations":[],"recommendations":""}`
    const chat = vi.fn(async () => new ReadableStream<AxChatResponse>({
      start(controller) {
        for (const content of [first, tail]) {
          controller.enqueue({ results: [{ index: 0, content }, { index: 1, content }] })
        }
        controller.enqueue({ results: [{ index: 0, finishReason: 'stop' }, { index: 1, finishReason: 'stop' }] })
        controller.close()
      }
    }))
    const service = new AxMockAIService<string>({
      features: { functions: false, streaming: true, structuredOutputs: true, structuredOutputModes: ['native'] },
      chatResponse: chat
    })
    const program = createWikiSynthesisProgram([quoted], { facetCount: 2, maxOutputTokens: 1_024 })
    const samples = new Map<number, WikiSynthesisAnswer['claims']>()
    for await (const chunk of program.streamingForward(service, { ...input, ...encodeFixtureSources([quoted]) }, { structuredOutputMode: 'native', sampleCount: 2 })) {
      if (chunk.delta.claims === undefined) continue
      const claims = samples.get(chunk.index) ?? []
      claims.push(...chunk.delta.claims)
      samples.set(chunk.index, claims)
    }
    expect([...samples.keys()].sort()).toEqual([0, 1])
    for (const claims of samples.values()) {
      expect(claims).toEqual([{ ...selected, statement: quoted.text }, { ...selected, statement: quoted.text }])
    }
    expect(chat).toHaveBeenCalledTimes(1)
    const picker: AxResultPickerFunction<AxGenOut> = selection => {
      expect(selection.type).toBe('fields')
      if (selection.type !== 'fields') throw new Error('Synthesis must not produce function samples')
      expect(selection.results).toHaveLength(2)
      for (const result of selection.results)
        expect(result.sample.claims).toEqual([{ ...selected, statement: quoted.text }, { ...selected, statement: quoted.text }])
      return 1
    }
    const options = { stream: true, structuredOutputMode: 'native' as const, sampleCount: 2, resultPicker: picker }
    expect((await program.forward(service, { ...input, ...encodeFixtureSources([quoted]) }, options)).claims)
      .toEqual(samples.get(1))
    const selectedClaims: WikiSynthesisAnswer['claims'] = []
    for await (const chunk of program.streamingForward(service, { ...input, ...encodeFixtureSources([quoted]) }, options))
      selectedClaims.push(...(chunk.delta.claims ?? []))
    expect(selectedClaims).toEqual(samples.get(1))
  })

  it('preserves Markdown autolinks while refusing HTML tags in generated statements', async () => {
    const linkedSource = { ...source, text: 'Approval guide: <https://docs.company.test/approvals>.' }
    const prediction = answer({ claims: [{ evidenceId: source.evidenceId, sourceRevision: source.sourceRevision, unitId: source.unitId, statement: linkedSource.text }] })
    const accepted = await generate(prediction, [linkedSource]).result
    expect(renderWikiSynthesisAnswer(accepted)).toContain('<https://docs.company.test/approvals>')
    for (const html of ['<a href="https://docs.company.test/approvals">Approval guide</a>.', '<svg:path>Approval guide</svg:path>.', '<script>Approval guide</script>.']) {
      const rejected = generate(answer({ claims: [{ ...prediction.claims[0]!, statement: html }] }), [linkedSource])
      await expect(rejected.result).rejects.toThrow()
      expect(rejected.chat).toHaveBeenCalledTimes(1)
    }
  })

  it('accepts empty first-turn context without invented placeholders and renders truthful inability', async () => {
    const prediction = answer({ claims: [], unresolvedFacets: [0, 1] })
    const generated = generate(prediction, [])
    const accepted = await generated.result
    expect(accepted).toMatchObject(prediction)
    expect(generated.chat).toHaveBeenCalledTimes(1)

    const empty = answer({ claims: [], unresolvedFacets: [] })
    const service = new AxMockAIService<string>({
      features: { functions: false, streaming: false, structuredOutputs: true, structuredOutputModes: ['native'] },
      chatResponse: { results: [{ index: 0, content: JSON.stringify(empty), finishReason: 'stop' }] }
    })
    const program = createWikiSynthesisProgram([])
    const emptyContext = await program.forward(service, { ...input, ...encodeFixtureSources([]), requestFacets: [], availableObservations: [], repairFeedback: '' })
    expect(emptyContext).toMatchObject(empty)
    const omittedContext = await program.forward(service, { userRequest: input.userRequest })
    expect(omittedContext).toMatchObject(empty)
  })

  it('parses typed field output on prompt-only profiles while retaining claim schema validation', async () => {
    const prediction = answer({ recommendations: 'Consider asking the owner to clarify the approvers.' })
    const fieldOutput = (claims: unknown) => [
      `Claims: ${JSON.stringify(claims)}`,
      'Unresolved Facets: [1]',
      'Observations: []',
      `Recommendations: ${prediction.recommendations}`
    ].join('\n')
    const chat = vi.fn(async (_request: Readonly<AxChatRequest<unknown>>) => ({
      results: [{ index: 0, content: fieldOutput(encodeWikiSynthesisAnswer(prediction).claims), finishReason: 'stop' as const }]
    }))
    const service = new AxMockAIService<string>({
      features: { functions: false, streaming: false, structuredOutputs: false, structuredOutputModes: [] },
      chatResponse: chat
    })
    const program = createWikiSynthesisProgram([source], { facetCount: 2, structured: false })
    const accepted = await program.forward(service, input)
    expect(accepted.claims).toEqual(prediction.claims)
    expect(accepted.unresolvedFacets).toEqual([1])
    expect(accepted.observations).toEqual([])
    expect(accepted.recommendations).toBe(prediction.recommendations)
    const wrongBinding = new AxMockAIService<string>({
      features: { functions: false, streaming: false, structuredOutputs: false, structuredOutputModes: [] },
      chatResponse: { results: [{ index: 0, content: fieldOutput([{ ...encodeWikiSynthesisAnswer(prediction).claims[0], sourceRef: wikiSynthesisSourceRef({ ...source, unitId: 'unit:invented' }) }]), finishReason: 'stop' }] }
    })
    await expect(program.forward(wrongBinding, input)).rejects.toThrow()
    const malformed = new AxMockAIService<string>({
      features: { functions: false, streaming: false, structuredOutputs: false, structuredOutputModes: [] },
      chatResponse: { results: [{ index: 0, content: fieldOutput([{ ...encodeWikiSynthesisAnswer(prediction).claims[0], statement: 17 }]), finishReason: 'stop' }] }
    })
    await expect(program.forward(malformed, input)).rejects.toThrow()
  })


  it('rejects unknown units, stale revisions, and incomplete source units without autonomous repair', async () => {
    const cases = [
      { prediction: answer({ claims: [{ ...answer().claims[0]!, unitId: 'unit:invented' }] }), sources: [source] },
      { prediction: answer({ claims: [{ ...answer().claims[0]!, sourceRevision: '6' }] }), sources: [source] },
      { prediction: answer(), sources: [{ ...source, complete: false }] }
    ]
    for (const scenario of cases) {
      const generated = generate(scenario.prediction, scenario.sources)
      await expect(generated.result).rejects.toThrow()
      expect(generated.chat).toHaveBeenCalledTimes(1)
    }
  })


  it('rejects conflicting unit bindings rather than letting the last source win', () => {
    expect(() => createWikiSynthesisProgram([source, { ...source, text: 'Publication requires no approval.' }])).toThrow()
    expect(() => createWikiSynthesisProgram([source, { ...source, sourceRevision: '8' }])).toThrow()
  })

  it('rejects distinct original bindings that collide on a short reference instead of rebinding either source', () => {
    const digest = vi.spyOn(Hash.prototype, 'digest').mockReturnValue('AAAAAAAAAAAAAAAA' as never)
    const other = { ...source, readId: 'physical:other:7', unitId: 'read:physical:other:7' }
    try {
      expect(() => createWikiSynthesisProgram([source, other])).toThrow('collided')
      expect(() => encodeFixtureSources([source, other])).toThrow('collided')
      expect(() => createWikiSynthesisStreamGuard([source, other])).toThrow('collided')
    } finally {
      digest.mockRestore()
    }
  })

  it('rejects legacy triples and malformed wire selectors before either public validation boundary', async () => {
    const selected = { sourceRef: wikiSynthesisSourceRef(source), statement: source.text }
    const foreign = { ...source, evidenceId: 'page:99:revision:12', sourceRevision: '12', readId: 'physical:owner:12', unitId: 'read:physical:owner:12' }
    for (const mode of ['native', 'json_object'] as const) {
      for (const claim of [
        answer().claims[0]!,
        { statement: source.text },
        { sourceRef: selected.sourceRef },
        { ...selected, sourceRef: ' ' },
        { ...selected, sourceRef: 'sAAAAAAAAAAAAAAAA' },
        { ...selected, sourceRef: wikiSynthesisSourceRef({ ...source, sourceRevision: 'stale' }) },
        { ...selected, sourceRef: wikiSynthesisSourceRef({ ...source, unitId: foreign.unitId }) },
        { ...selected, unitId: source.unitId },
        { ...selected, evidenceId: foreign.evidenceId },
        { ...selected, statement: ' \t ' },
        { ...selected, statement: 'x'.repeat(131_073) }
      ]) {
        const validateClaim = vi.fn(() => true)
        const validateAnswer = vi.fn(() => true)
        const generated = generate(answer(), [source, foreign], { validateClaim, validateAnswer }, mode, { ...answer(), claims: [claim] })
        await expect(generated.result).rejects.toThrow()
        expect(validateClaim).not.toHaveBeenCalled()
        expect(validateAnswer).not.toHaveBeenCalled()
        expect(generated.chat).toHaveBeenCalledTimes(1)
        const guard = createWikiSynthesisStreamGuard([source, foreign])
        const serialized = JSON.stringify(claim)
        expect(guard(`{"claims":[${serialized.slice(0, -1)}`)).toBeUndefined()
        expect(guard('}')).toBeDefined()
      }
    }
  })

  it('uses the post-admission output allowance for explicit statements while retaining vendor usage accounting', async () => {
    const quoted = { ...source, text: 'Exact authored assertion. '.repeat(3_000) }
    const prediction = answer({ claims: [{ ...answer().claims[0]!, statement: quoted.text }] })
    const validateClaim = vi.fn(() => true)
    let reduceAllowance = true
    let allowance = 4_096
    const service = new AxMockAIService<string>({
      features: { functions: false, streaming: false, structuredOutputs: true, structuredOutputModes: ['native'] },
      chatResponse: async () => {
        if (reduceAllowance) allowance = 1_024
        return { results: [{ index: 0, content: JSON.stringify(encodeWikiSynthesisAnswer(prediction)), finishReason: 'stop' }],
          modelUsage: { ai: 'fixture', model: 'fixture', tokens: { promptTokens: 10, completionTokens: 8, totalTokens: 18 } } }
      }
    })
    const program = createWikiSynthesisProgram([quoted], { facetCount: 2, maxOutputTokens: () => allowance, validateClaim })
    await expect(program.forward(service, { ...input, ...encodeFixtureSources([quoted]) })).rejects.toThrow()
    expect(validateClaim).not.toHaveBeenCalled()
    reduceAllowance = false
    allowance = 4_096
    program.resetUsage()
    const accepted = await program.forward(service, { ...input, ...encodeFixtureSources([quoted]) })
    expect(accepted.claims[0]?.statement).toBe(quoted.text)
    expect(program.getUsage()[0]?.tokens?.completionTokens).toBe(8)
  })

  it('does not deliver an unqualified approval fact or silently omit the requested approver disclosure', async () => {
    const policyBoundary: WikiSynthesisOptions = {
      validateClaim: claim => claim.statement.startsWith('External publication requires ') || 'The external-publication restriction must qualify the approval requirement.',
      validateAnswer: candidate => candidate.unresolvedFacets.includes(1) || 'The requested approver facet must remain unresolved.'
    }
    const unqualified = generate(answer({ claims: [{ ...answer().claims[0]!, statement: 'Publication requires two approvals.' }] }), [source], policyBoundary)
    await expect(unqualified.result).rejects.toThrow('external-publication restriction')
    expect(unqualified.chat).toHaveBeenCalledTimes(1)
    const omitted = generate(answer({ unresolvedFacets: [] }), [source], policyBoundary)
    await expect(omitted.result).rejects.toThrow('requested approver facet')
    expect(omitted.chat).toHaveBeenCalledTimes(1)
    const accepted = await generate(answer(), [source], policyBoundary).result
    expect(accepted.unresolvedFacets).toEqual([1])
  })

  it('delivers genuine standalone advice but rejects uncited declarative and explanatory premises', async () => {
    for (const recommendations of [
      'Consider asking the owner to clarify the approvers.',
      'You could keep a personal publication checklist.',
      'Which approver would you like to consult?',
      '- Review your checklist.\n- Ask the owner about approvers.'
    ]) {
      const accepted = await generate(answer({ recommendations })).result
      expect(validateWikiSynthesisShape(accepted)).toBe(true)
    }
    for (const recommendations of [
      'External publication requires two approvals.',
      'The owner processes approvals overnight. Consider sending the request early.',
      'Consider sending the request early because the owner processes approvals overnight.',
      'Since publication is already approved, use the public link.',
      'Review the checklist. The owner has approved publication.'
    ]) {
      const generated = generate(answer({ recommendations }))
      await expect(generated.result).rejects.toThrow('standalone imperative suggestions or questions')
      expect(generated.chat).toHaveBeenCalledTimes(1)
    }
  })

  it('rejects a unit owned by another complete binding without autonomous repair', async () => {
    const other = { ...source, evidenceId: 'page:99:revision:12', sourceRevision: '12', readId: 'physical:owner:12', unitId: 'read:physical:owner:12', text: 'The owner is Rowan.' }
    const crossed = generate(answer({ claims: [{ ...answer().claims[0]!, unitId: other.unitId }] }), [source, other])
    await expect(crossed.result).rejects.toThrow('complete admitted source unit')
    expect(crossed.chat).toHaveBeenCalledTimes(1)
  })

  it('only permits exact safe whitelist observations and prevents observation or recommendation citation injection', async () => {
    const observation = 'Search returned no candidates in the delivered window.'
    const accepted = generate(answer({ observations: [observation] }), [source], { observations: [observation] })
    expect((await accepted.result).observations).toEqual([observation])
    const unsafe = [
      answer({ observations: ['Search found no Wiki information.'] }),
      answer({ observations: [`${observation} [[cite:${source.evidenceId}]]`] }),
      answer({ observations: ['<!-- hide citations'] }),
      answer({ recommendations: `Use this unrelated premise [[cite:${source.evidenceId}]]` }),
      answer({ recommendations: '[policy]: /wrong-target' }),
    ]
    for (const prediction of unsafe) {
      const generated = generate(prediction, [source], { observations: [observation, `${observation} [[cite:${source.evidenceId}]]`, '<!-- hide citations'] })
      await expect(generated.result).rejects.toThrow()
      expect(generated.chat).toHaveBeenCalledTimes(1)
    }
  })

  it('bounds markers and unresolved indices and rejects duplicate requested facets', async () => {
    for (const indices of [[2], [-1], [0.5], [1, 1]]) {
      const generated = generate(answer({ unresolvedFacets: indices }))
      await expect(generated.result).rejects.toThrow()
      expect(generated.chat).toHaveBeenCalledTimes(1)
    }
    const claims = Array.from({ length: 64 }, () => ({ ...answer().claims[0]! }))
    const boundary = generate(answer({ claims }))
    expect((await boundary.result).claims).toHaveLength(64)
    const overflow = generate(answer({ claims: [...claims, { ...claims[0]! }] }))
    await expect(overflow.result).rejects.toThrow()
    expect(overflow.chat).toHaveBeenCalledTimes(1)
    const noFacets = generate(answer({ unresolvedFacets: [0] }), [source], { facetCount: 0 })
    await expect(noFacets.result).rejects.toThrow()
  })



  it('keeps source-owned record tables independent with visible citations rather than swallowing citations as extra cells', async () => {
    const aurora: WikiSynthesisSource = { ...source, readId: 'physical:aurora:7', unitId: 'read:physical:aurora:7', text: 'Record: Aurora | Owner: Rowan | Scope: External only' }
    const boreal: WikiSynthesisSource = { ...source, evidenceId: 'page:43:revision:8', sourceRevision: '8', readId: 'physical:boreal:8', unitId: 'read:physical:boreal:8', text: 'Record: Boreal | Owner: Sable | Scope: Internal only' }
    const table = '| Record | Owner | Scope |\n| --- | --- | --- |\n| Aurora | Rowan | External only |'
    const otherTable = '| Record | Owner | Scope |\n| --- | --- | --- |\n| Boreal | Sable | Internal only |'
    const prediction = answer({ claims: [
      { evidenceId: aurora.evidenceId, sourceRevision: aurora.sourceRevision, unitId: aurora.unitId, statement: table },
      { evidenceId: boreal.evidenceId, sourceRevision: boreal.sourceRevision, unitId: boreal.unitId, statement: otherTable }
    ] })
    const policyBoundary: WikiSynthesisOptions = {
      validateClaim: (claim, bound) => {
        const expected = bound.readId === aurora.readId
          ? ['Record', 'Owner', 'Scope', 'Aurora', 'Rowan', 'External only']
          : ['Record', 'Owner', 'Scope', 'Boreal', 'Sable', 'Internal only']
        const cells = markdown.parse(claim.statement, {}).filter(token => token.type === 'inline').map(token => token.content)
        return cells.length === expected.length && cells.every((cell, index) => cell === expected[index]) || 'Every table header and factual cell must belong to its one source-owned record.'
      },
      validateAnswer: candidate => candidate.unresolvedFacets.includes(1) || 'The requested approver facet must remain unresolved.'
    }
    const accepted = await generate(prediction, [aurora, boreal], policyBoundary).result
    const rendered = renderWikiSynthesisAnswer(accepted)
    const clientMarkdown = formatAgentCitationMarkers(rendered, evidenceId => ({ number: evidenceId === aurora.evidenceId ? 1 : 2, label: 'Bound record', href: null }))
    const html = markdown.render(clientMarkdown)
    expect(html).toContain('</table>\n<p><strong>[1]</strong></p>\n<table>')
    expect(html).toContain('</table>\n<p><strong>[2]</strong></p>')
    expect(html.match(/<table>/gu)).toHaveLength(2)
    for (const statement of [
      table.replace('Scope', 'Invented header'),
      table.replace('Rowan', 'Morgan'),
      `${table}\n| Boreal | Sable | Internal only |`
    ]) {
      const rejected = generate(answer({ claims: [{ ...prediction.claims[0]!, statement }] }), [aurora, boreal], policyBoundary)
      await expect(rejected.result).rejects.toThrow('Every table header and factual cell')
      expect(rejected.chat).toHaveBeenCalledTimes(1)
    }
    const missingDisclosure = generate({ ...prediction, unresolvedFacets: [] }, [aurora, boreal], policyBoundary)
    await expect(missingDisclosure.result).rejects.toThrow('requested approver facet')
    for (const options of [{}, { validateClaim: policyBoundary.validateClaim }, { validateAnswer: policyBoundary.validateAnswer }]) {
      const unvalidated = generate(prediction, [aurora, boreal], options)
      await expect(unvalidated.result).rejects.toThrow('both source and whole-answer')
    }
  })

  it('permits escaped pipes and closed inline code in strict tables but never arbitrary Markdown blocks or lossy rows', () => {
    const table = '| Record | Literal |\n| --- | --- |\n| Aurora\\|Boreal | `a\\|b` |'
    expect(validateWikiSynthesisShape(answer({ claims: [{ ...answer().claims[0]!, statement: table }] }))).toBe(true)
    const rendered = renderWikiSynthesisAnswer(answer({ claims: [{ ...answer().claims[0]!, statement: table }] }))
    expect(markdown.render(formatAgentCitationMarkers(rendered, () => ({ number: 1, label: 'Record', href: null })))).toContain('<code>a|b</code>')
    for (const statement of [
      '| Record | Owner |\n| --- | --- |\n| Aurora | |',
      'Requested record:\n\n| Record | Owner |\n| --- | --- |\n| Aurora | |'
    ]) expect(validateWikiSynthesisShape(answer({ claims: [{ ...answer().claims[0]!, statement }] }))).toBe(true)
    for (const statement of [
      `## Records\n${table}`,
      `- ${table}`,
      '<table><tr><td>Aurora</td></tr></table>',
      '[owner]: /invented-target',
      '| Record | Owner |\n| --- | --- |\n| Aurora |',
      '| Record | Owner |\n| --- | --- |\n| Aurora | Rowan | hidden |',
      '| Record | Owner |\n| --- | --- |',
      '| Record | Owner |\n| --- | --- |\n| Aurora | `unclosed |',
      `${table}\n[[cite:injected]]`
    ]) {
      expect(validateWikiSynthesisShape(answer({ claims: [{ ...answer().claims[0]!, statement }] }))).not.toBe(true)
      expect(() => renderWikiSynthesisAnswer(answer({ claims: [{ ...answer().claims[0]!, statement }] }))).toThrow()
    }
    expect(validateWikiSynthesisShape(answer({ observations: [table] }))).not.toBe(true)
    expect(validateWikiSynthesisShape(answer({ observations: ['First line.\nSecond line.'] }))).not.toBe(true)
  })

  it('never uses an inherited response cache and keeps raw-content diagnostic controls disabled on paid provider dispatches', async () => {
    const priorCache = axGlobals.cachingFunction
    const priorDebug = axGlobals.debug
    const priorTracer = axGlobals.tracer
    const inheritedTracer = new ProxyTracerProvider().getTracer('inherited-test-tracer')
    const inheritedSpans = vi.spyOn(inheritedTracer, 'startSpan')
    const cache = vi.fn(() => ({ ...answer({ recommendations: 'An unvalidated cached premise.' }) }))
    const logger = vi.fn()
    const chat = vi.fn(async (_request: Readonly<AxChatRequest<unknown>>, _options?: Readonly<AxAIServiceOptions>) =>
      ({ results: [{ index: 0, content: JSON.stringify(encodeWikiSynthesisAnswer(answer())), finishReason: 'stop' as const }] }))
    axGlobals.cachingFunction = cache
    axGlobals.debug = true
    axGlobals.tracer = inheritedTracer
    try {
      const service = new AxMockAIService<string>({
        features: { functions: false, streaming: false, structuredOutputs: true, structuredOutputModes: ['native'] },
        options: { debug: true, verbose: true, excludeContentFromTrace: false, includeRequestBodyInErrors: true, logger },
        chatResponse: chat
      })
      const program = createWikiSynthesisProgram([source], { facetCount: 2 })
      for (let attempt = 0; attempt < 2; attempt++) {
        await program.forward(service, input)
      }
      const invalidService = new AxMockAIService<string>({
        features: { functions: false, streaming: false, structuredOutputs: true, structuredOutputModes: ['native'] },
        options: { tracer: inheritedTracer, debug: true, verbose: true, logger },
        chatResponse: { results: [{ index: 0, content: JSON.stringify(encodeWikiSynthesisAnswer(answer({ recommendations: 'The owner approves automatically.' }))), finishReason: 'stop' }] }
      })
      await expect(program.forward(invalidService, input)).rejects.toThrow('standalone imperative suggestions or questions')
      expect(inheritedSpans).not.toHaveBeenCalled()
      expect(chat).toHaveBeenCalledTimes(2)
      expect(cache).not.toHaveBeenCalled()
      expect(logger).not.toHaveBeenCalled()
      for (const [, options] of chat.mock.calls) {
        expect(options).toMatchObject({ debug: false, verbose: false, excludeContentFromTrace: true, includeRequestBodyInErrors: false })
        expect(options!.tracer!.startSpan('privacy-check').isRecording()).toBe(false)
      }
    } finally {
      axGlobals.cachingFunction = priorCache
      axGlobals.debug = priorDebug
      axGlobals.tracer = priorTracer
      inheritedSpans.mockRestore()
    }
  })

  it('preserves host abort cancellation with cache-bypassing run control and never starts a continuation', async () => {
    const controller = new AbortController()
    let admit!: () => void
    const admitted = new Promise<void>(resolve => { admit = resolve })
    const chat = vi.fn(async (_request: Readonly<AxChatRequest<unknown>>, options?: Readonly<AxAIServiceOptions>) => {
      const signal = options!.abortSignal!
      admit()
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Host request cancelled.')), { once: true })
      })
    })
    const service = new AxMockAIService<string>({
      features: { functions: false, streaming: false, structuredOutputs: true, structuredOutputModes: ['native'] },
      chatResponse: chat
    })
    vi.spyOn(service, 'getFeatures').mockReturnValue({ ...service.getFeatures(), asyncTools: true })
    const session = vi.fn(async () => { throw new Error('A native session must not start for ordinary paid synthesis.') })
    Object.assign(service, { openChatSession: session })
    const program = createWikiSynthesisProgram([source], { facetCount: 2 })
    const pending = program.forward(service, input, { abortSignal: controller.signal })
    // Surface any pre-admission failure rather than waiting forever for chat.
    await Promise.race([
      admitted,
      pending.then(() => { throw new Error('Generation completed before provider admission.') })
    ])
    controller.abort()
    await expect(pending).rejects.toThrow('Host request cancelled')
    expect(chat).toHaveBeenCalledTimes(1)
    expect(session).not.toHaveBeenCalled()
  })
})

describe('Wiki synthesis complete registered read transport', () => {
  const body = '  # Aurora 🥣 e\u0301\r\nIllustrative only.\r\nEstimated time: 20 minutes.\r\nPrivate contact: keeper@example.test.\r\n<!-- not factual authority -->\r\n```ts\r\nconst authored = 7;\r\n```\r\n  ';
  const root: WikiSynthesisSource = { ...source, evidenceId: 'page:42:revision:7', readId: 'physical:42:7', unitId: 'read:physical:42:7', context: 'Aurora', text: body };
  const read: WikiSynthesisRead = { evidenceId: root.evidenceId, sourceRevision: '7', readId: root.readId, title: 'Aurora', representation: 'markdown', complete: true, source: body };
  const request = (sources: readonly WikiSynthesisSource[], reads: readonly WikiSynthesisRead[]): Readonly<AxChatRequest> => {
    const encoded = encodeWikiSynthesisSources(sources, reads);
    return { chatPrompt: [{ role: 'user', content: `User Request: Preserve requested facts.\n\nSource Text: ${encoded.sourceText}\n\nSource References: ${encoded.sourceReferences}\n\nRequest Facets: []` }] };
  };

  it('delivers unchanged full author bytes once and a text-free read locator through the real program consumer', async () => {
    const chat = vi.fn(async (_request: Readonly<AxChatRequest>) => ({ results: [{ index: 0, content: JSON.stringify({ claims: [], unresolvedFacets: [], observations: [] }), finishReason: 'stop' as const }] }));
    const service = new AxMockAIService<string>({ features: { functions: false, streaming: false, structuredOutputs: true, structuredOutputModes: ['native'] }, chatResponse: chat });
    const encoded = encodeWikiSynthesisSources([root], [read]);
    await createWikiSynthesisProgram([root]).forward(service, { ...input, ...encoded, requestFacets: [] });
    const delivered = synthesisSourcesFromRequest(chat.mock.calls[0]![0]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toBe(body);
    expect(delivered[0]!.readText).toBe(body);
    expect(encoded.sourceText.split(body)).toHaveLength(2);
    expect(JSON.parse(encoded.sourceReferences)).toEqual({ reads: { [wikiSynthesisSourceRef(root)]: { readRef: 'd0', evidenceId: root.evidenceId, sourceRevision: '7' } } });
    expect(encoded.sourceReferences).not.toContain('keeper@example.test');
  });

  it('shares body bytes only across compatible physical read aliases while every ref decodes to its original owner', () => {
    const section = { ...root, evidenceId: `${root.evidenceId}:section:1` };
    const reads = [read, { ...read, evidenceId: section.evidenceId }];
    const encoded = encodeWikiSynthesisSources([root, section], reads);
    const index = JSON.parse(encoded.sourceReferences) as WikiSynthesisReferenceIndex;
    expect(Object.keys(index.reads)).toHaveLength(2);
    expect(index.reads[wikiSynthesisSourceRef(root)]!.readRef).toBe(index.reads[wikiSynthesisSourceRef(section)]!.readRef);
    expect(encoded.sourceText.split(body)).toHaveLength(2);
    const delivered = synthesisSourcesFromRequest(request([root, section], reads));
    expect(delivered.map(row => row.evidenceId)).toEqual([root.evidenceId, section.evidenceId]);
    for (const row of delivered) expect(row.text).toBe(body);
    expect(synthesisReadsFromRequest(request([root, section], reads))).toHaveLength(1);
  });

  it('keeps separately equal reads and repeated authored records distinct without a derived record catalog', () => {
    const repeated = 'Name: Aurora | Value: 20 minutes\nName: Aurora | Value: 20 minutes\n';
    const first = { ...root, text: repeated };
    const second = { ...first, evidenceId: 'page:99:revision:7', readId: 'physical:99:7', unitId: 'read:physical:99:7' };
    const encoded = encodeWikiSynthesisSources([first, second], [{ ...read, source: repeated }, { ...read, evidenceId: second.evidenceId, readId: second.readId, source: repeated }]);
    const index = JSON.parse(encoded.sourceReferences) as WikiSynthesisReferenceIndex;
    expect(index.reads[wikiSynthesisSourceRef(first)]!.readRef).not.toBe(index.reads[wikiSynthesisSourceRef(second)]!.readRef);
    expect(encoded.sourceText.split(repeated)).toHaveLength(3);
    expect(Object.keys(index.reads)).toHaveLength(2);
    expect(encoded.sourceReferences).not.toContain('record');
  });

  it('rejects mismatched, expired, foreign or incompatible physical read bindings instead of reconstructing content', () => {
    for (const invalid of [{ ...read, source: body.trim() }, { ...read, sourceRevision: '6' }, { ...read, evidenceId: 'page:99:revision:7' }, { ...read, readId: 'physical:foreign:7' }, { ...read, complete: false }])
      expect(() => encodeWikiSynthesisSources([root], [invalid])).toThrow();
    expect(() => createWikiSynthesisProgram([{ ...root, unitId: 'paragraph:derived' }])).toThrow();
    expect(() => encodeWikiSynthesisSources([root], [read, { ...read, representation: 'html' }])).toThrow();
    expect(() => encodeWikiSynthesisSources([root], [read, { ...read, title: 'Conflicting title' }])).toThrow();
    expect(() => encodeWikiSynthesisSources([root], [read, { ...read, readId: 'physical:other:7' }])).toThrow();
  });

  it('preserves truncated original data without making an incomplete read selectable', () => {
    const incomplete = { ...root, complete: false };
    const encoded = encodeWikiSynthesisSources([incomplete], [{ ...read, complete: false }]);
    expect(encoded.sourceText).toContain(body);
    expect(JSON.parse(encoded.sourceReferences)).toEqual({ reads: {} });
    expect(synthesisSourcesFromRequest(request([incomplete], [{ ...read, complete: false }]))).toEqual([]);
    expect(createWikiSynthesisStreamGuard([incomplete])(JSON.stringify({ claims: [{ sourceRef: wikiSynthesisSourceRef(incomplete), statement: 'Estimated time: 20 minutes.' }] }))).toBeDefined();
  });

  it.each([100_000, 128_000])('keeps twelve complete long reads inside the unchanged %i-byte consumer budget with no body copy in the index', async budget => {
    const sources: WikiSynthesisSource[] = [];
    const reads: WikiSynthesisRead[] = [];
    const bodies: string[] = [];
    for (let index = 0; index < 12; index++) {
      const authored = `# Record ${index} 🥣\r\n` + 'Safely chill below 5 °C for at least two hours before service. '.repeat(72) + `\r\nPrivate contact: keeper${index}@example.test.\r\n`;
      const readId = `physical:capacity:${index}`;
      const evidenceId = `page:capacity:${index}:revision:7`;
      bodies.push(authored);
      sources.push({ ...root, evidenceId, readId, unitId: `read:${readId}`, text: authored });
      reads.push({ ...read, evidenceId, readId, source: authored });
    }
    const encoded = encodeWikiSynthesisSources(sources, reads);
    expect(Object.keys((JSON.parse(encoded.sourceReferences) as WikiSynthesisReferenceIndex).reads)).toHaveLength(12);
    expect(Buffer.byteLength(encoded.sourceReferences)).toBeLessThan(3_000);
    const chat = vi.fn(async (request: Readonly<AxChatRequest>) => {
      expect(Buffer.byteLength(JSON.stringify(request), 'utf8') + 2_500 + 8_192).toBeLessThan(budget);
      return { results: [{ index: 0, content: JSON.stringify({ claims: [], unresolvedFacets: [], observations: [] }), finishReason: 'stop' as const }] };
    });
    const service = new AxMockAIService<string>({ features: { functions: false, streaming: false, structuredOutputs: true, structuredOutputModes: ['native'] }, chatResponse: chat });
    await createWikiSynthesisProgram(sources).forward(service, { ...input, ...encoded, requestFacets: [] });
    expect(synthesisReadsFromRequest(chat.mock.calls[0]![0]).map(row => row.readText)).toEqual(bodies);
    expect(synthesisSourcesFromRequest(chat.mock.calls[0]![0]).map(row => row.text)).toEqual(bodies);
    expect(chat).toHaveBeenCalledTimes(1);
  });
})

describe('Wiki synthesis offline correction admission', () => {
  const correctionRead = `${source.context}\n${source.text}\nUnrequested retention rule: keep approval records for seven years.\n`
  const fixtures = parseWikiSynthesisFixtures([{
    id: 'offline-correction', family: 'offline-correction', split: 'selection',
    provenance: { kind: 'synthetic', adjudication: 'Exact synthetic statement and explicitly unanswered approver facet.' },
    userRequest: input.userRequest, sources: [{ ...source, text: correctionRead }], sourceReads: [{ ...fixtureReads([source])[0]!, source: correctionRead }], requestFacets: ['who approves?'],
    observations: [], repairFeedback: '', details: [], expectedUnresolvedFacets: [0], variants: [{ id: 'reference', category: 'adjudicated explicit assertion', expected: 'accept', answer: answer({ unresolvedFacets: [0] }) }]
  }], 'selection')
  const acceptedReceipt: AxChatResponse = { results: [{ index: 0, content: JSON.stringify(encodeWikiSynthesisAnswer(answer({ unresolvedFacets: [0] }))), finishReason: 'stop' }] }

  it.each(['transport', 'error', 'length', 'invalid length'] as const)('does not replay failed offline inference as a schema correction (%s)', async failure => {
    const chat = vi.fn(async (): Promise<AxChatResponse> => acceptedReceipt)
    chat.mockImplementationOnce(async () => {
      if (failure === 'transport') throw new Error('Synthetic transport failure')
      return { results: [{ index: 0, content: failure === 'invalid length' ? '{"claims":[' : JSON.stringify(encodeWikiSynthesisAnswer(answer({ unresolvedFacets: [0] }))), finishReason: failure === 'error' ? 'error' : 'length' }] }
    })
    const service = new AxMockAIService<string>({
      features: { functions: false, streaming: false, structuredOutputs: true, structuredOutputModes: ['native'] },
      chatResponse: chat
    })
    const report = await evaluateWikiSynthesisFixtures(fixtures, service, undefined, 1)
    expect(chat).toHaveBeenCalledTimes(1)
    expect(report).toMatchObject({ failedAttempts: 1, corrections: 0, meanScore: 0 })
  })

  it('admits one explicit offline correction after a completed invalid output without losing unrequested read content', async () => {
    const chat = vi.fn(async (_request: Readonly<AxChatRequest>): Promise<AxChatResponse> => acceptedReceipt)
    chat.mockImplementationOnce(async () => ({
      results: [{ index: 0, content: JSON.stringify(encodeWikiSynthesisAnswer(answer({ claims: [{ ...answer().claims[0]!, unitId: 'unknown-unit' }], unresolvedFacets: [0] }))), finishReason: 'stop' }]
    }))
    const service = new AxMockAIService<string>({
      features: { functions: false, streaming: false, structuredOutputs: true, structuredOutputModes: ['native'] },
      chatResponse: chat
    })
    const report = await evaluateWikiSynthesisFixtures(fixtures, service, undefined, 1)
    expect(chat).toHaveBeenCalledTimes(2)
    expect(report).toMatchObject({ failedAttempts: 1, corrections: 1, meanScore: 1 })
    for (const [request] of chat.mock.calls)
      expect(synthesisSourcesFromRequest(request)[0]!.readText).toBe(correctionRead)
  })

  it('isolates offline student and GEPA teacher failures from inherited recording tracers', async () => {
    const priorTracer = axGlobals.tracer
    const inheritedTracer = new ProxyTracerProvider().getTracer('offline-inherited-tracer')
    const backingTracer = new ProxyTracerProvider().getTracer('offline-span-fixture')
    const recordedExceptions: unknown[] = []
    const inheritedSpans = vi.spyOn(inheritedTracer, 'startSpan').mockImplementation(() => {
      const span = backingTracer.startSpan('offline-private-fixture')
      vi.spyOn(span, 'isRecording').mockReturnValue(true)
      vi.spyOn(span, 'recordException').mockImplementation(exception => { recordedExceptions.push(exception) })
      return span
    })
    const privateMarker = 'synthetic-private-failed-output'
    const studentChat = vi.fn(async () => ({ results: [{ index: 0, content: privateMarker, finishReason: 'stop' as const }] }))
    const teacherChat = vi.fn(async () => { throw new Error(privateMarker) })
    const studentAI = new AxMockAIService<string>({
      features: { functions: false, streaming: false, structuredOutputs: true, structuredOutputModes: ['native'] },
      options: { tracer: inheritedTracer }, chatResponse: studentChat
    })
    const teacherAI = new AxMockAIService<string>({
      features: { functions: false, streaming: false, structuredOutputs: true, structuredOutputModes: ['native'] },
      options: { tracer: inheritedTracer }, chatResponse: teacherChat
    })
    const train = parseWikiSynthesisFixtures(['offline-private-train-a', 'offline-private-train-b'].map(evidenceId => ({
      ...fixtures[0]!, id: evidenceId, family: evidenceId, split: 'train',
      sources: [{ ...source, evidenceId }], sourceReads: fixtureReads([{ ...source, evidenceId }]),
      variants: [{ id: 'reference', category: 'reference', expected: 'accept', answer: answer({ claims: [{ ...answer().claims[0]!, evidenceId }], unresolvedFacets: [0] }) }]
    })), 'train')
    const selection = parseWikiSynthesisFixtures([{ ...fixtures[0]!, variants: [{ id: 'reference', category: 'reference', expected: 'accept', answer: answer({ unresolvedFacets: [0] }) }] }], 'selection')
    axGlobals.tracer = inheritedTracer
    try {
      await evaluateWikiSynthesisFixtures(fixtures, studentAI)
      await expect(optimizeWikiSynthesis({
        train, selection, studentAI, teacherAI, maximumMetricCalls: 6, trials: 1,
        saveArtifact: async () => { throw new Error('A failed proposal must not save an artifact') },
        loadFinal: async () => { throw new Error('A failed proposal must not load final fixtures') }
      })).rejects.toThrow('did not evaluate a changed candidate')
      expect(studentChat).toHaveBeenCalled()
      expect(teacherChat).toHaveBeenCalled()
      expect(recordedExceptions).toHaveLength(0)
      expect(inheritedSpans).not.toHaveBeenCalled()
    } finally {
      axGlobals.tracer = priorTracer
      inheritedSpans.mockRestore()
    }
  })
})

describe('Wiki synthesis incremental stable-invariant guard', () => {

  it('accepts valid JSON split at every boundary without treating escaped recommendation text as claims', () => {
    const prediction = answer({
      recommendations: 'Consider the quoted text: "claims": [{ "unitId": "hostile" }].',
      claims: [{ ...answer().claims[0]!, statement: 'The literal `Array<T>` has the label "draft".' }]
    })
    const json = JSON.stringify(encodeWikiSynthesisAnswer(prediction))
    for (let boundary = 0; boundary <= json.length; boundary++) {
      const guard = createWikiSynthesisStreamGuard([source])
      expect(guard(json.slice(0, boundary))).toBeUndefined()
      expect(guard(json.slice(boundary))).toBeUndefined()
    }
    const characterGuard = createWikiSynthesisStreamGuard([source])
    for (const character of json) expect(characterGuard(character)).toBeUndefined()
    const nested = createWikiSynthesisStreamGuard([source])
    expect(nested('{"extra":{"claims":[{"unitId":"hostile"}]},"claims":[]}')).toBeUndefined()
  })

  it('admits rendering-safe complete table blocks incrementally without allowing unfinished prose or wrong source triples', () => {
    const statement = '| Record | Literal |\n| --- | --- |\n| Aurora | `a\\|b` |'
    const json = JSON.stringify(encodeWikiSynthesisAnswer(answer({ claims: [{ ...answer().claims[0]!, statement }] })))
    const guard = createWikiSynthesisStreamGuard([source])
    for (const character of json) expect(guard(character)).toBeUndefined()
    for (const claims of [
      [{ ...answer().claims[0]!, statement: `${statement}\n\n<script>Invented explanation.</script>` }],
      [{ ...answer().claims[0]!, statement, sourceRevision: 'stale' }]
    ]) {
      const rejected = createWikiSynthesisStreamGuard([source])
      const completed = JSON.stringify(encodeWikiSynthesisAnswer(answer({ claims })).claims[0])
      expect(rejected(`{"claims":[${completed.slice(0, -1)}`)).toBeUndefined()
      expect(rejected('}')).toBeDefined()
    }
    expect(createWikiSynthesisStreamGuard([])(`{"claims":[${JSON.stringify(encodeWikiSynthesisAnswer(answer()).claims[0])}`)).toContain('complete admitted source unit')
  })

  it('waits for the completed claim object before rejecting a wrong binding or unsafe complete statement', () => {
    for (const claim of [
      { ...answer().claims[0]!, unitId: 'unknown-unit' },
      { ...answer().claims[0]!, sourceRevision: 'stale-revision' },
      { ...answer().claims[0]!, statement: 'A forged claim [[cite:page:other]].' },
      { ...answer().claims[0]!, statement: 'First paragraph.\n\n# Injected heading' }
    ]) {
      const guard = createWikiSynthesisStreamGuard([source])
      const serialized = JSON.stringify(encodeWikiSynthesisAnswer(answer({ claims: [claim] })).claims[0])
      const prefix = `{"claims":[${serialized.slice(0, -1)}`
      for (const character of prefix) expect(guard(character)).toBeUndefined()
      expect(guard('}')).toBeDefined()
    }
    const incomplete = createWikiSynthesisStreamGuard([{ ...source, complete: false }])
    expect(incomplete(`{"claims":[${JSON.stringify(encodeWikiSynthesisAnswer(answer()).claims[0])}`)).toContain('complete admitted source unit')
  })

  it('handles nested invalid claim fields and escaped root keys without scanning strings as structure', () => {
    const extra = createWikiSynthesisStreamGuard([source])
    const claim = JSON.stringify({ ...encodeWikiSynthesisAnswer(answer()).claims[0]!, extra: { nested: ['{"claims":[', { brace: '}' }] } })
    expect(extra(`{"clai\\u006ds":[${claim.slice(0, -1)}`)).toBeUndefined()
    expect(extra('}')).toContain('claim schema')
  })

  it('bounds completed claims per stream without rejecting an unfinished sixty-fifth claim', () => {
    const guard = createWikiSynthesisStreamGuard([source])
    const fresh = createWikiSynthesisStreamGuard([source])
    const claim = JSON.stringify(encodeWikiSynthesisAnswer(answer()).claims[0]!)
    expect(guard('{"claims":[')).toBeUndefined()
    for (let index = 0; index < 64; index++) expect(guard(`${index === 0 ? '' : ','}${claim}`)).toBeUndefined()
    expect(guard(`,${claim.slice(0, -1)}`)).toBeUndefined()
    expect(guard('}')).toContain('at most 64')
    expect(guard(']}')).toContain('at most 64')
    expect(fresh(`{"claims":[${claim}]}`)).toBeUndefined()
  })
})
