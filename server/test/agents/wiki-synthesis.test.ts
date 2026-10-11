import { axGlobals, AxMockAIService, type AxAIServiceOptions, type AxChatRequest, type AxChatResponse } from '@ax-llm/ax'
import { ProxyTracerProvider } from '@opentelemetry/api'
import * as markdownItModule from 'markdown-it'
import { formatAgentCitationMarkers } from '../../../client/components/agents/agent-citations.ts'
import { createWikiSynthesisProgram, createWikiSynthesisStreamGuard, encodeWikiSynthesisSources, renderWikiSynthesisAnswer, validateWikiSynthesisShape, type WikiSynthesisAnswer, type WikiSynthesisInput, type WikiSynthesisOptions, type WikiSynthesisSource, type WikiSynthesisStructure } from '../../agents/providers/wiki-synthesis.ts'
import { evaluateWikiSynthesisFixtures, optimizeWikiSynthesis, parseWikiSynthesisFixtures } from '../../agents/providers/wiki-synthesis-evaluation.ts'
import { synthesisAuthoredContentFromRequest, synthesisOwnedPacketIncludes, synthesisSourcesFromRequest } from './synthesis-fixture.ts'
import { describe, expect, it, vi } from '../bun-test.mts'

const MarkdownIt = 'default' in markdownItModule ? markdownItModule.default : markdownItModule
const markdown = (MarkdownIt as typeof markdownItModule.default)({ html: false, breaks: true, linkify: true, typographer: false })
const noLiteralStatements: ReadonlySet<string> = new Set()

const source: WikiSynthesisSource = {
  evidenceId: 'page:42:revision:7:section:1',
  sourceRevision: '7',
  unitId: 'unit:approval',
  context: 'External publication only',
  text: 'External publication requires two approvals.',
  kind: 'prose',
  complete: true,
  literalStatement: null,
  packet: '{"statement":"External publication requires two approvals.","context":"External publication only"}'
}
const input: WikiSynthesisInput = {
  userRequest: 'What approvals are required, and who approves?',
  ...encodeWikiSynthesisSources([source]),
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

const generate = (prediction: WikiSynthesisAnswer, sources: readonly WikiSynthesisSource[] = [source], options: WikiSynthesisOptions = {}, mode: 'native' | 'json_object' = 'native') => {
  const chat = vi.fn(async (_request: Readonly<AxChatRequest<unknown>>) => ({ results: [{ index: 0, content: JSON.stringify(prediction), finishReason: 'stop' as const }] }))
  const service = new AxMockAIService<string>({
    features: { functions: false, streaming: false, structuredOutputs: mode === 'native', structuredOutputModes: [mode] },
    chatResponse: chat
  })
  const program = createWikiSynthesisProgram(sources, { facetCount: input.requestFacets.length, ...options })
  return { result: program.forward(service, { ...input, ...encodeWikiSynthesisSources(sources), availableObservations: [...(options.observations ?? [])] }, { structuredOutputMode: mode }), chat }
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

  it('resolves explicit quotation selections before public results and both host validation boundaries on native and JSON-object wire paths', async () => {
    const literalStatement = 'Status: Illustrative and untested | Scope: External publication only | Required approvals: **two**.'
    const quoted = { ...source, literalStatement }
    const selection = answer({ claims: [{ ...answer().claims[0]!, statement: '' }] })
    for (const mode of ['native', 'json_object'] as const) {
      const validateClaim = vi.fn((claim: WikiSynthesisAnswer['claims'][number]) => claim.statement === literalStatement)
      const validateAnswer = vi.fn((candidate: WikiSynthesisAnswer) => candidate.claims[0]?.statement === literalStatement)
      const generated = generate(selection, [quoted], { validateClaim, validateAnswer }, mode)
      const accepted = await generated.result
      expect(accepted.claims).toEqual([{ ...selection.claims[0]!, statement: literalStatement }])
      expect(validateClaim).toHaveBeenCalledTimes(1)
      expect(validateAnswer).toHaveBeenCalledTimes(1)
      expect(renderWikiSynthesisAnswer(accepted, new Set([literalStatement]))).toContain('Illustrative and untested')
      expect(generated.chat).toHaveBeenCalledTimes(1)
      const authored = generate(answer(), [quoted], { validateClaim: claim => claim.statement === source.text }, mode)
      expect((await authored.result).claims[0]?.statement).toBe(source.text)
    }
  })

  it('fails closed on invalid literal selections without synthesizing defaults or repairing output', async () => {
    const quoted = { ...source, literalStatement: source.text }
    const other = { ...quoted, evidenceId: 'page:99:revision:12', sourceRevision: '12', unitId: 'unit:owner' }
    const selected = { ...answer().claims[0]!, statement: '' }
    const { statement: _statement, ...missingStatement } = selected
    const cases = [
      { claim: selected, sources: [source] },
      { claim: selected, sources: [{ ...quoted, complete: false }] },
      { claim: { ...selected, unitId: 'unknown' }, sources: [quoted] },
      { claim: { ...selected, sourceRevision: '6' }, sources: [quoted] },
      { claim: { ...selected, unitId: other.unitId }, sources: [quoted, other] },
      { claim: missingStatement, sources: [quoted] },
      { claim: { ...selected, statement: ' \t ' }, sources: [quoted] },
      ...[null, '', ' \t ', '<script>forged</script>', 'Unsafe [[cite:other]]', 'é'.repeat(65_537)].map(literalStatement => ({
        claim: selected, sources: [{ ...quoted, literalStatement }]
      }))
    ]
    for (const mode of ['native', 'json_object'] as const) {
      for (const scenario of cases) {
        const generated = generate(answer({ claims: [scenario.claim] as WikiSynthesisAnswer['claims'] }), scenario.sources, {}, mode)
        await expect(generated.result).rejects.toThrow()
        expect(generated.chat).toHaveBeenCalledTimes(1)
      }
    }
    const denied = generate(answer({ claims: [selected] }), [quoted], { validateClaim: () => 'Source qualification is required.' })
    await expect(denied.result).rejects.toThrow('Source qualification is required')
    expect(denied.chat).toHaveBeenCalledTimes(1)
  })

  it('bounds cumulative canonical expansion by the existing provider content budget without clipping quotations', async () => {
    const quoted = { ...source, literalStatement: 'Exact authored assertion. '.repeat(200) }
    const selected = { ...answer().claims[0]!, statement: '' }
    const claims = Array.from({ length: 64 }, () => ({ ...selected }))
    for (const mode of ['native', 'json_object'] as const) {
      const generated = generate(answer({ claims }), [quoted], { maxOutputTokens: 1_024 }, mode)
      await expect(generated.result).rejects.toThrow('content byte limit')
      expect(generated.chat).toHaveBeenCalledTimes(1)
      const accepted = await generate(answer({ claims: [selected] }), [quoted], { maxOutputTokens: 1_024 }, mode).result
      expect(accepted.claims[0]?.statement).toBe(quoted.literalStatement)
    }
    const guard = createWikiSynthesisStreamGuard([quoted], { maxOutputTokens: 1_024 })
    expect(guard(`{"claims":[${JSON.stringify(selected)}`)).toBeUndefined()
    expect(guard(claims.slice(1).map(claim => `,${JSON.stringify(claim)}`).join(''))).toContain('content byte limit')
  })

  it('streams only canonical quotation selections through incomplete-array transitions and rejects truncated or failed terminal output', async () => {
    const quoted = { ...source, literalStatement: 'Status: Illustrative only | External publication requires two approvals.' }
    const selected = { ...answer().claims[0]!, statement: '' }
    const first = `{"claims":[${JSON.stringify(selected)},{"evidenceId":`
    const tail = `${JSON.stringify(selected.evidenceId)},"sourceRevision":"7","unitId":"unit:approval","statement":""}],"unresolvedFacets":[1],"observations":[],"recommendations":""}`
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
          for await (const chunk of program.streamingForward(service, { ...input, ...encodeWikiSynthesisSources([quoted]) }, { structuredOutputMode: mode })) {
            for (const claim of chunk.delta.claims ?? []) {
              expect(claim.statement).toBe(quoted.literalStatement)
              claims.push(claim)
            }
          }
        }
        if (finish === 'stop') {
          await consume()
          expect(claims).toEqual([{ ...selected, statement: quoted.literalStatement }, { ...selected, statement: quoted.literalStatement }])
        } else {
          await expect(consume()).rejects.toThrow()
        }
        expect(chat).toHaveBeenCalledTimes(1)
      }
    }
  })

  it('isolates canonical streaming byte allowances by sample index through repaired partial arrays', async () => {
    const quoted = { ...source, literalStatement: 'Exact authored assertion. '.repeat(1_200) }
    const selected = { ...answer().claims[0]!, statement: '' }
    const first = `{"claims":[${JSON.stringify(selected)},{"evidenceId":`
    const tail = `${JSON.stringify(selected.evidenceId)},"sourceRevision":"7","unitId":"unit:approval","statement":""}],"unresolvedFacets":[1],"observations":[],"recommendations":""}`
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
    for await (const chunk of program.streamingForward(service, { ...input, ...encodeWikiSynthesisSources([quoted]) }, { structuredOutputMode: 'native', sampleCount: 2 })) {
      if (chunk.delta.claims === undefined) continue
      const claims = samples.get(chunk.index) ?? []
      claims.push(...chunk.delta.claims)
      samples.set(chunk.index, claims)
    }
    expect([...samples.keys()].sort()).toEqual([0, 1])
    for (const claims of samples.values()) {
      expect(claims).toEqual([{ ...selected, statement: quoted.literalStatement }, { ...selected, statement: quoted.literalStatement }])
    }
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('preserves Markdown autolinks while refusing HTML tags in generated statements', async () => {
    const linkedSource = { ...source, text: 'Approval guide: <https://docs.company.test/approvals>.' }
    const prediction = answer({ claims: [{ evidenceId: source.evidenceId, sourceRevision: source.sourceRevision, unitId: source.unitId, statement: linkedSource.text }] })
    const accepted = await generate(prediction, [linkedSource]).result
    expect(renderWikiSynthesisAnswer(accepted, noLiteralStatements)).toContain('<https://docs.company.test/approvals>')
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
    const emptyContext = await program.forward(service, { ...input, ...encodeWikiSynthesisSources([]), requestFacets: [], availableObservations: [], repairFeedback: '' })
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
      results: [{ index: 0, content: fieldOutput(prediction.claims), finishReason: 'stop' as const }]
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
      chatResponse: { results: [{ index: 0, content: fieldOutput([{ ...prediction.claims[0], unitId: 'unit:invented' }]), finishReason: 'stop' }] }
    })
    await expect(program.forward(wrongBinding, input)).rejects.toThrow()
    const malformed = new AxMockAIService<string>({
      features: { functions: false, streaming: false, structuredOutputs: false, structuredOutputModes: [] },
      chatResponse: { results: [{ index: 0, content: fieldOutput([{ ...prediction.claims[0], statement: 17 }]), finishReason: 'stop' }] }
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
    expect(() => createWikiSynthesisProgram([source, { ...source, text: 'Publication requires no approval.' }])).toThrow('Conflicting source unit binding')
    expect(() => createWikiSynthesisProgram([source, { ...source, literalStatement: 'Publication requires no approval.' }])).toThrow('Conflicting source unit binding')
    expect(() => createWikiSynthesisProgram([source, { ...source, sourceRevision: '8' }])).toThrow('multiple source revisions')
  })

  it('does not deliver an unqualified approval fact or silently omit the requested approver disclosure', async () => {
    const policyBoundary: WikiSynthesisOptions = {
      validateClaim: claim => claim.statement.startsWith('External publication requires ') || 'The external-publication restriction must qualify the approval requirement.',
      validateAnswer: candidate => candidate.unresolvedFacets.includes(1) || 'The requested approver facet must remain unresolved.'
    }
    const unqualified = generate(answer({ claims: [{ ...answer().claims[0]!, statement: 'Publication requires two approvals.' }] }), [{ ...source, literalStatement: 'Publication requires two approvals.' }], policyBoundary)
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
    const other = { ...source, evidenceId: 'page:99:revision:12', sourceRevision: '12', unitId: 'unit:owner', text: 'The owner is Rowan.' }
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
      answer({ claims: [{ ...answer().claims[0]!, statement: `${source.text}\n\nAn unrelated invented assertion.` }] })
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
    const aurora: WikiSynthesisSource = { ...source, unitId: 'unit:aurora-record', kind: 'labeled-record', text: 'Record: Aurora | Owner: Rowan | Scope: External only', packet: '{"ownedFields":["Record","Owner","Scope"]}' }
    const boreal: WikiSynthesisSource = { ...source, evidenceId: 'page:43:revision:8', sourceRevision: '8', unitId: 'unit:boreal-record', kind: 'labeled-record', text: 'Record: Boreal | Owner: Sable | Scope: Internal only', packet: '{"ownedFields":["Record","Owner","Scope"]}' }
    const table = '| Record | Owner | Scope |\n| --- | --- | --- |\n| Aurora | Rowan | External only |'
    const otherTable = '| Record | Owner | Scope |\n| --- | --- | --- |\n| Boreal | Sable | Internal only |'
    const prediction = answer({ claims: [
      { evidenceId: aurora.evidenceId, sourceRevision: aurora.sourceRevision, unitId: aurora.unitId, statement: table },
      { evidenceId: boreal.evidenceId, sourceRevision: boreal.sourceRevision, unitId: boreal.unitId, statement: otherTable }
    ] })
    const policyBoundary: WikiSynthesisOptions = {
      validateClaim: (claim, bound) => {
        const expected = bound.unitId === 'unit:aurora-record'
          ? ['Record', 'Owner', 'Scope', 'Aurora', 'Rowan', 'External only']
          : ['Record', 'Owner', 'Scope', 'Boreal', 'Sable', 'Internal only']
        const cells = markdown.parse(claim.statement, {}).filter(token => token.type === 'inline').map(token => token.content)
        return cells.length === expected.length && cells.every((cell, index) => cell === expected[index]) || 'Every table header and factual cell must belong to its one source-owned record.'
      },
      validateAnswer: candidate => candidate.unresolvedFacets.includes(1) || 'The requested approver facet must remain unresolved.'
    }
    const accepted = await generate(prediction, [aurora, boreal], policyBoundary).result
    const rendered = renderWikiSynthesisAnswer(accepted, noLiteralStatements)
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
      await expect(unvalidated.result).rejects.toThrow('both source-local and whole-answer')
    }
  })

  it('permits escaped pipes and closed inline code in strict tables but never arbitrary Markdown blocks or lossy rows', () => {
    const table = '| Record | Literal |\n| --- | --- |\n| Aurora\\|Boreal | `a\\|b` |'
    expect(validateWikiSynthesisShape(answer({ claims: [{ ...answer().claims[0]!, statement: table }] }))).toBe(true)
    const rendered = renderWikiSynthesisAnswer(answer({ claims: [{ ...answer().claims[0]!, statement: table }] }), noLiteralStatements)
    expect(markdown.render(formatAgentCitationMarkers(rendered, () => ({ number: 1, label: 'Record', href: null })))).toContain('<code>a|b</code>')
    for (const statement of [
      `${table}\n\nAn uncited premise.`,
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
      expect(() => renderWikiSynthesisAnswer(answer({ claims: [{ ...answer().claims[0]!, statement }] }), noLiteralStatements)).toThrow()
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
      ({ results: [{ index: 0, content: JSON.stringify(answer()), finishReason: 'stop' as const }] }))
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
        chatResponse: { results: [{ index: 0, content: JSON.stringify(answer({ recommendations: 'The owner approves automatically.' })), finishReason: 'stop' }] }
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

describe('Wiki synthesis readable complete source transport', () => {
  const context = 'External publication only; internal drafts are excluded.'
  const condition = '20 minutes only after safe chilling below 5 °C for at least 2 hours; this estimate excludes accompaniments.'
  const physicalUnit = 'physical:complete-owned-record:unit:7'
  const notes = '  Retain authored leading and trailing whitespace. Authored ID: record:publication; UUID: 123e4567-e89b-12d3-a456-426614174000.\n'
  const authoredRecord = `Item: **Aurora**
Estimated total time: ${condition}
Scope: ${context}
Status: Illustrative and untested
Equipment: Covered container and thermometer
Additional notes: ${notes}Exception: Do not use the estimate for an unrefrigerated batch.
[Complete preparation and safety guide][safety]
`
  const authoredHeader = `# ${context}\n`
  const authoredLinkDefinition = '[safety]: /en/guides/preparation?batch=7#safety\n'
  const literalStatement = `Item: **Aurora** | Estimated total time: ${condition} | Scope: ${context} | Status: Illustrative and untested | Equipment: Covered container and thermometer | Additional notes: ${notes.trim()} | Exception: Do not use the estimate for an unrefrigerated batch.`
  const owned: WikiSynthesisStructure[] = [
    { id: 's1', kind: 'dependency', payload: { span: { start: 7, end: 507 }, text: authoredRecord } },
    { id: 's2', kind: 'dependency', payload: { span: { start: 0, end: 7 }, text: authoredHeader } },
    { id: 's3', kind: 'dependency', payload: { span: { start: 507, end: 607 }, text: authoredLinkDefinition } },
    { id: 's4', kind: 'closure', payload: [null, [], [], [], ['s1', 's2', 's3']] },
    { id: 's5', kind: 'dependency', payload: { span: { start: 0, end: 20 }, text: 'Unowned confidential sibling condition.' } },
    { id: 's6', kind: 'closure', payload: [null, [], [], [], ['s5']] }
  ]
  const bound = [0, 1].map(index => ({
    ...source, unitId: `unit:series${index}`, context, text: index === 0 ? condition : notes, literalStatement,
    packet: JSON.stringify(['context:publication', context, ['context:publication'], [index === 0 ? context : notes], [physicalUnit, 's4']])
  }))
  const other = {
    ...source, evidenceId: 'page:99:revision:7', unitId: 'unit:sibling', context, text: 'A separate sibling.', literalStatement: 'Unowned confidential sibling condition.',
    packet: JSON.stringify([null, null, [], [], ['physical:sibling', 's6']])
  }
  const opaque = {
    ...source, evidenceId: 'page:100:revision:7', unitId: 'unit:opaque-packet',
    packet: JSON.stringify({ textKey: 's1', structuralLabel: 7, labels: [7], nested: { identifier: 7 } })
  }
  const request = (sources: readonly WikiSynthesisSource[], structures: readonly WikiSynthesisStructure[] = owned): Readonly<AxChatRequest> => {
    const encoded = encodeWikiSynthesisSources(sources, structures)
    return { chatPrompt: [{ role: 'user', content: `User Request: Preserve complete source facts.\n\nSource Structures: ${encoded.sourceStructures}\n\nSource Bindings: ${encoded.sourceBindings}\n\nRequest Facets: []` }] }
  }

  it('round-trips every native projection and full authored record, governing header and link definition without borrowing sibling content', () => {
    const supplied = [...bound, other, opaque]
    const transported = request(supplied)
    const restored = synthesisSourcesFromRequest(transported)
    expect(restored.map(({ packet: _packet, ...source }) => source)).toEqual(
      supplied.map(({ packet: _packet, ...source }) => source)
    )
    const readable = synthesisAuthoredContentFromRequest(transported, bound[0]!)
    expect(readable).toEqual([authoredRecord, authoredHeader, authoredLinkDefinition])
    expect(JSON.parse(restored[0]!.packet)).toEqual({
      structuralLabel: context, labels: [context], authoredContent: readable
    })
    expect(JSON.parse(restored[1]!.packet)).toEqual({
      structuralLabel: context, labels: [notes], authoredContent: readable
    })
    expect(synthesisOwnedPacketIncludes(transported, bound[0]!, 'Unowned confidential sibling condition.')).toBe(false)
    expect(synthesisOwnedPacketIncludes(transported, other, 'Unowned confidential sibling condition.')).toBe(true)
    expect(synthesisOwnedPacketIncludes(transported, other, condition)).toBe(false)
    expect(JSON.parse(synthesisSourcesFromRequest(transported).at(-1)!.packet)).toEqual(JSON.parse(opaque.packet))
  })

  it('preserves complete nullable quotations, exact Unicode, Markdown, prerequisites and nondecimal identifiers without coercing opaque data', () => {
    const literalStatement = '  Status: Illustrative and untested | Item: **Aurora 🥣 e\u0301** | Estimated total time: 20 minutes only after safe chilling below 5 °C for at least 2 hours | Servings: 4 | Notes: `s1` is authored text; [guide](/safe?batch=7#冷却) | Final prerequisite: Use precooked safely chilled rice.  \r\n'.repeat(100)
    const repeated = { ...source, context: ' prefix '.repeat(100), text: literalStatement, unitId: 'unit:007', literalStatement }
    const sibling = { ...repeated, evidenceId: 'page:43:revision:7', unitId: 'unit:nondecimal', text: 'A different selected field retains the same complete original quotation.', packet: opaque.packet }
    const nullable = { ...repeated, evidenceId: 'page:44:revision:7', unitId: 'unit:null', literalStatement: null }
    const supplied = [repeated, sibling, nullable]
    const transported = request(supplied, [])
    expect(synthesisSourcesFromRequest(transported)).toEqual(supplied)
  })
})

describe('Wiki synthesis offline correction admission', () => {
  const fixtures = parseWikiSynthesisFixtures([{
    id: 'offline-correction', family: 'offline-correction', split: 'selection',
    provenance: { kind: 'synthetic', adjudication: 'Exact synthetic statement and explicitly unanswered approver facet.' },
    userRequest: input.userRequest, sourceUnits: [source], requestFacets: ['who approves?'],
    observations: [], repairFeedback: '', details: [], expectedUnresolvedFacets: [0], variants: []
  }], 'selection')
  const acceptedReceipt: AxChatResponse = { results: [{ index: 0, content: JSON.stringify(answer({ unresolvedFacets: [0] })), finishReason: 'stop' }] }

  it.each(['transport', 'error', 'length', 'invalid length'] as const)('does not replay failed offline inference as a schema correction (%s)', async failure => {
    const chat = vi.fn(async (): Promise<AxChatResponse> => acceptedReceipt)
    chat.mockImplementationOnce(async () => {
      if (failure === 'transport') throw new Error('Synthetic transport failure')
      return { results: [{ index: 0, content: failure === 'invalid length' ? '{"claims":[' : JSON.stringify(answer({ unresolvedFacets: [0] })), finishReason: failure === 'error' ? 'error' : 'length' }] }
    })
    const service = new AxMockAIService<string>({
      features: { functions: false, streaming: false, structuredOutputs: true, structuredOutputModes: ['native'] },
      chatResponse: chat
    })
    const report = await evaluateWikiSynthesisFixtures(fixtures, service, undefined, 1)
    expect(chat).toHaveBeenCalledTimes(1)
    expect(report).toMatchObject({ failedAttempts: 1, corrections: 0, meanScore: 0 })
  })

  it('admits one explicit offline correction after a completed invalid output', async () => {
    const chat = vi.fn(async (): Promise<AxChatResponse> => acceptedReceipt)
    chat.mockImplementationOnce(async () => ({
      results: [{ index: 0, content: JSON.stringify(answer({ claims: [{ ...answer().claims[0]!, unitId: 'unknown-unit' }], unresolvedFacets: [0] })), finishReason: 'stop' }]
    }))
    const service = new AxMockAIService<string>({
      features: { functions: false, streaming: false, structuredOutputs: true, structuredOutputModes: ['native'] },
      chatResponse: chat
    })
    const report = await evaluateWikiSynthesisFixtures(fixtures, service, undefined, 1)
    expect(chat).toHaveBeenCalledTimes(2)
    expect(report).toMatchObject({ failedAttempts: 1, corrections: 1, meanScore: 1 })
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
      sourceUnits: [{ ...source, evidenceId }],
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
  it('uses the same exact-source quotation authority only when an empty-selection claim completes', () => {
    const quoted = { ...source, literalStatement: 'Status: Illustrative only | External publication requires two approvals.' }
    const selected = { ...answer().claims[0]!, statement: '' }
    const valid = JSON.stringify(answer({ claims: [selected] }))
    for (let boundary = 0; boundary <= valid.length; boundary++) {
      const guard = createWikiSynthesisStreamGuard([quoted])
      expect(guard(valid.slice(0, boundary))).toBeUndefined()
      expect(guard(valid.slice(boundary))).toBeUndefined()
    }
    const other = { ...quoted, evidenceId: 'page:99:revision:12', sourceRevision: '12', unitId: 'unit:owner' }
    for (const scenario of [
      { claim: selected, sources: [source] },
      { claim: selected, sources: [{ ...quoted, complete: false }] },
      { claim: selected, sources: [{ ...quoted, literalStatement: 'Unsafe [[cite:other]]' }] },
      { claim: selected, sources: [{ ...quoted, literalStatement: 'é'.repeat(65_537) }] },
      { claim: { ...selected, unitId: 'unknown' }, sources: [quoted] },
      { claim: { ...selected, sourceRevision: '6' }, sources: [quoted] },
      { claim: { ...selected, unitId: other.unitId }, sources: [quoted, other] }
    ]) {
      const guard = createWikiSynthesisStreamGuard(scenario.sources)
      const claim = JSON.stringify(scenario.claim)
      expect(guard(`{"claims":[${claim.slice(0, -1)}`)).toBeUndefined()
      expect(guard('}')).toBeDefined()
      expect(guard(']}')).toBeDefined()
    }
  })

  it('accepts valid JSON split at every boundary without treating escaped recommendation text as claims', () => {
    const prediction = answer({
      recommendations: 'Consider the quoted text: "claims": [{ "unitId": "hostile" }].',
      claims: [{ ...answer().claims[0]!, statement: 'The literal `Array<T>` has the label "draft".' }]
    })
    const json = JSON.stringify(prediction)
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
    const json = JSON.stringify(answer({ claims: [{ ...answer().claims[0]!, statement }] }))
    const guard = createWikiSynthesisStreamGuard([source])
    for (const character of json) expect(guard(character)).toBeUndefined()
    for (const claims of [
      [{ ...answer().claims[0]!, statement: `${statement}\n\nInvented explanation.` }],
      [{ ...answer().claims[0]!, statement, sourceRevision: 'stale' }]
    ]) {
      const rejected = createWikiSynthesisStreamGuard([source])
      const completed = JSON.stringify(claims[0])
      expect(rejected(`{"claims":[${completed.slice(0, -1)}`)).toBeUndefined()
      expect(rejected('}')).toBeDefined()
    }
    expect(createWikiSynthesisStreamGuard([])(`{"claims":[${JSON.stringify(answer().claims[0])}`)).toContain('complete admitted source unit')
  })

  it('waits for the completed claim object before rejecting a wrong binding or unsafe complete statement', () => {
    for (const claim of [
      { ...answer().claims[0]!, unitId: 'unknown-unit' },
      { ...answer().claims[0]!, sourceRevision: 'stale-revision' },
      { ...answer().claims[0]!, statement: 'A forged claim [[cite:page:other]].' },
      { ...answer().claims[0]!, statement: 'First paragraph.\n\nInvented second paragraph.' }
    ]) {
      const guard = createWikiSynthesisStreamGuard([source])
      const serialized = JSON.stringify(claim)
      const prefix = `{"claims":[${serialized.slice(0, -1)}`
      for (const character of prefix) expect(guard(character)).toBeUndefined()
      expect(guard('}')).toBeDefined()
    }
    const incomplete = createWikiSynthesisStreamGuard([{ ...source, complete: false }])
    expect(incomplete(`{"claims":[${JSON.stringify(answer().claims[0])}`)).toContain('complete admitted source unit')
  })

  it('handles nested invalid claim fields and escaped root keys without scanning strings as structure', () => {
    const extra = createWikiSynthesisStreamGuard([source])
    const claim = JSON.stringify({ ...answer().claims[0]!, extra: { nested: ['{"claims":[', { brace: '}' }] } })
    expect(extra(`{"clai\\u006ds":[${claim.slice(0, -1)}`)).toBeUndefined()
    expect(extra('}')).toContain('claim schema')
  })

  it('bounds completed claims per stream without rejecting an unfinished sixty-fifth claim', () => {
    const guard = createWikiSynthesisStreamGuard([source])
    const fresh = createWikiSynthesisStreamGuard([source])
    const claim = JSON.stringify(answer().claims[0]!)
    expect(guard('{"claims":[')).toBeUndefined()
    for (let index = 0; index < 64; index++) expect(guard(`${index === 0 ? '' : ','}${claim}`)).toBeUndefined()
    expect(guard(`,${claim.slice(0, -1)}`)).toBeUndefined()
    expect(guard('}')).toContain('at most 64')
    expect(guard(']}')).toContain('at most 64')
    expect(fresh(`{"claims":[${claim}]}`)).toBeUndefined()
  })
})
