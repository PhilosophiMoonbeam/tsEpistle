import type { AxChatRequest, AxChatResponse } from '@ax-llm/ax'
import { type AgentActionSessionProvider, AxAgentEngine } from '../../agents/providers/engine.ts'
import type { AgentProviderFactory } from '../../agents/providers/factory.ts'
import type { AgentEngineRequest, AgentEngineResult } from '../../agents/runtime.ts'
import { describe, expect, it, vi } from '../bun-test.mts'
import { fullAxFixtureService, synthesisCollectionControl, synthesisFixtureAnswer, synthesisSourcesFromRequest } from './synthesis-fixture.ts'

const evidenceId = 'page:42:revision:1'

interface GroundingFixture {
  readonly execute: () => Promise<AgentEngineResult>
  readonly text: { readonly mock: { readonly calls: readonly [string][] } }
  readonly attempts: number
}

const request = (): AgentEngineRequest => ({
  authorizeMedia: async () => {},
  run: {
    id: '00000000-0000-4000-8000-000000000001',
    sessionId: '00000000-0000-4000-8000-000000000002',
    userMessageId: '00000000-0000-4000-8000-000000000003',
    assistantMessageId: '00000000-0000-4000-8000-000000000004',
    goalId: null,
    goalContinuation: null,
    ownerId: 7,
    clientRequestId: '00000000-0000-4000-8000-000000000005',
    clientRequestSha256: 'a'.repeat(64),
    status: 'running',
    providerProfileVersionId: '00000000-0000-4000-8000-000000000006',
    transportKind: 'openai-responses',
    model: 'gpt-test',
    executionMode: 'agent',
    googleSearchEnabled: false,
    capabilityRevision: 'cap-1',
    pricingRevision: 'price-1',
    totalTokens: 0,
    promptVersion: 1,
    attempts: 1,
    maxAttempts: 3,
    eventSequence: 0,
    leaseOwner: 'worker',
    leaseToken: '00000000-0000-4000-8000-000000000007',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    cancelRequestedAt: null,
    sideEffectsStarted: false,
    errorCode: null,
    errorMessage: null,
    queuedAt: '2026-08-17T00:00:00.000Z',
    startedAt: '2026-08-17T00:00:00.000Z',
    completedAt: null
  },
  messages: [{ role: 'user', content: 'Read page 42 and report the requested source fact.' }],
  memory: { user: [], agent: [] },
  skills: [],
  signal: new AbortController().signal,
  limits: { maxTurns: 8, maxToolCalls: 32, maxTokens: 100_000 }
})

// Exercise the real collection, exact typed binding, validation and publication
// boundary. The fixture supplies drafts, not their grounding verdicts.
const groundingFixture = (content: string, anchor: string, statement: string, rejected?: string): GroundingFixture => {
  let sourceReadRequested = false
  let attempts = 0
  const chat = vi.fn(async (input: Readonly<AxChatRequest>): Promise<AxChatResponse> => {
    const sources = synthesisSourcesFromRequest(input)
    if (sources.length > 0) {
      const source = sources.find(unit => unit.evidenceId === evidenceId && unit.kind !== 'page-title' && unit.text.includes(anchor))
      if (source === undefined) throw new Error(`The requested source unit was not delivered: ${anchor}`)
      attempts++
      return {
        results: [{ index: 0, content: synthesisFixtureAnswer(input, {
          claims: [{ evidenceId: source.evidenceId, sourceRevision: source.sourceRevision, unitId: source.unitId, statement: attempts === 1 && rejected !== undefined ? rejected : statement }]
        }) }],
        modelUsage: { ai: 'fixture', model: 'gpt-test', tokens: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } }
      }
    }
    const control = sourceReadRequested ? synthesisCollectionControl(input) : undefined
    if (control !== undefined) return control
    sourceReadRequested = true
    return {
      results: [{ index: 0, functionCalls: [{ id: 'read-source', type: 'function', function: { name: 'wiki_get_page', params: { id: 42 } } }] }],
      modelUsage: { ai: 'fixture', model: 'gpt-test', tokens: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } }
    }
  })
  const factory = {
    create: async () => ({
      service: fullAxFixtureService(chat),
      capabilities: { streaming: false, toolCalling: 'native', parallelToolCalls: false, structuredOutput: 'native-json-schema', usage: 'terminal', cancellation: true, maxContextTokens: 100_000, maxOutputTokens: 4_000 },
      transportKind: 'openai-responses',
      model: 'gpt-test',
      capabilityRevision: 'cap-1',
      pricingRevision: 'price-1',
      pricing: { revision: 'price-1', inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 }
    })
  } as unknown as AgentProviderFactory
  const invoke = vi.fn(async () => ({
    id: 42, locale: 'en', path: 'guide', sourceRevision: '1', title: 'Source Guide', contentType: 'markdown', content,
    citation: { evidenceId, label: 'Source Guide', href: '/en/guide' }
  }))
  const actions: AgentActionSessionProvider = {
    open: async () => ({
      authoritySha256: 'a'.repeat(64),
      functions: [{ name: 'pages.get', title: 'Read page', description: 'Read an authorized page.', parameters: { type: 'object', properties: { id: { type: 'number' } } }, risk: 'read', group: 'core' }],
      invoke,
      validateObservation: async () => true,
      snapshot: async () => ({}),
      close: async () => {}
    })
  }
  const text = vi.fn(async (_delta: string) => {})
  const event = vi.fn(async (_type: string, _data: unknown) => {})
  const execute = () => new AxAgentEngine(factory, actions).execute({ ...request(), messages: [{ role: 'user', content: `Read page 42 and report this fact: ${statement}` }] }, { text, event })
  return { execute, text, get attempts() { return attempts } }
}

const expectPublication = async (fixture: GroundingFixture, statement: string, attempts: number) => {
  const result = await fixture.execute()
  expect(result.executionLimit).toBeUndefined()
  expect(fixture.text.mock.calls.map(([delta]) => delta).join('')).toContain(statement)
  expect(result.citations?.map(citation => citation.evidenceId)).toEqual([evidenceId])
  expect(fixture.attempts).toBe(attempts)
}

const quantityFact = 'The 300 g orzo quantity makes 4 servings; the chickpeas are measured before draining.'
const quantitySource = `# Source Guide\n\n## Notes\n\n${quantityFact}\n\nThe chickpeas are simmered after draining.`
const chilledFact = 'The soup may be served; only after it is safely chilled.'
const chilledSource = `# Source Guide\n\n## Safety\n\n${chilledFact}`
const elapsedSource = '# Source Guide\n\n## Recipe details\n\n| Detail | Value |\n| --- | --- |\n| Servings | 4 |\n| Cooking | 20 minutes |\n| Total elapsed time | 30 minutes |'

// Existing broad engine cases do not cover independent semicolon assertions
// inside one retained unit or a key-cell label containing a qualifier token.
describe('source-local grounding', () => {
  it.each([quantityFact, 'The 300 g orzo quantity makes 4 servings.', 'The chickpeas are measured before draining.'])('accepts the intact semicolon source and independently faithful assertion: %s', async statement => {
    await expectPublication(groundingFixture(quantitySource, '300 g', statement), statement, 1)
  })

  it('keeps an inline-code semicolon inside its exact source assertion', async () => {
    const statement = 'The diagnostic token is `alpha; before draining`.'
    const source = `# Source Guide\n\n${statement}`
    await expectPublication(groundingFixture(source, 'diagnostic token', statement), statement, 1)
  })

  it.each([
    ['changed quantity', quantityFact.replace('300 g', '350 g')],
    ['changed serving count', quantityFact.replace('4 servings', '6 servings')],
    ['dropped draining restriction', quantityFact.replace(' before draining', '')],
    ['changed timing operator', quantityFact.replace('before draining', 'after draining')],
    ['changed ingredient identity', quantityFact.replace('300 g orzo', '300 g chickpeas')],
    ['unrelated added assertion', `${quantityFact}; dragons guarantee free delivery.`],
    ['sibling assertion under the wrong unit', 'The chickpeas are simmered after draining.']
  ])('rejects %s without pooling source fragments or sibling units', async (_case, rejected) => {
    await expectPublication(groundingFixture(quantitySource, '300 g', quantityFact, rejected), quantityFact, 2)
  })

  it('accepts a faithfully attached safety continuation', async () => {
    await expectPublication(groundingFixture(chilledSource, 'safely chilled', chilledFact), chilledFact, 1)
  })

  it.each([
    ['dropped safe chilling', 'The soup may be served; only after it is chilled.'],
    ['dropped safety continuation', 'The soup may be served.'],
    ['changed negation', 'The soup may not be served; only after it is safely chilled.']
  ])('rejects %s on a semicolon-attached condition', async (_case, rejected) => {
    await expectPublication(groundingFixture(chilledSource, 'safely chilled', chilledFact, rejected), chilledFact, 2)
  })

  it.each([
    'Total elapsed time: 30 minutes.',
    'Detail: Total elapsed time; Value: 30 minutes.',
    '| Detail | Value |\n| --- | --- |\n| Total elapsed time | 30 minutes |'
  ])('accepts a faithful owned key/value row: %s', async statement => {
    await expectPublication(groundingFixture(elapsedSource, 'Total elapsed time', statement), statement, 1)
  })

  it.each([
    ['changed value', 'Total elapsed time: 40 minutes.'],
    ['sibling value', 'Total elapsed time: 20 minutes.'],
    ['sibling key and value', 'Servings: 4.'],
    ['changed row identity', 'Detail: Cooking; Value: 30 minutes.'],
    ['changed owner identity', 'Other Guide: Total elapsed time: 30 minutes.'],
    ['changed table value', '| Detail | Value |\n| --- | --- |\n| Total elapsed time | 20 minutes |']
  ])('rejects %s under the exact total-time row binding', async (_case, rejected) => {
    const statement = 'Total elapsed time: 30 minutes.'
    await expectPublication(groundingFixture(elapsedSource, 'Total elapsed time', statement, rejected), statement, 2)
  })

  it.each([
    ['faithful inherited restriction', undefined],
    ['dropped inherited restriction', 'Discount: 12%.'],
    ['changed inherited threshold', 'Discount: 12%, only for orders exceeding 30 chairs.']
  ])('preserves %s on an owned key/value row', async (_case, rejected) => {
    const source = '# Source Guide\n\n## Rates — only for orders exceeding 20 chairs\n\n| Detail | Value |\n| --- | --- |\n| Discount | 12% |\n| Surcharge | 8% |'
    const statement = 'Discount: 12%, only for orders exceeding 20 chairs.'
    await expectPublication(groundingFixture(source, 'Discount', statement, rejected), statement, rejected === undefined ? 1 : 2)
  })
})

describe('record and continuation restriction boundaries', () => {
  it('keeps a negated coordinating continuation attached to its permission', async () => {
    const statement = 'The soup may be served; but not before it is safely chilled.'
    const source = `# Source Guide\n\n## Safety\n\n${statement}`
    await expectPublication(groundingFixture(source, 'safely chilled', statement, 'The soup may be served.'), statement, 2)
  })

  it('requires exclusivity from the owned identifying cell', async () => {
    const source = '# Source Guide\n\n## Access\n\n| Rule | Result |\n| --- | --- |\n| Only approved staff | Approved staff may access |'
    const statement = 'Rule: Only approved staff; Result: Approved staff may access.'
    await expectPublication(groundingFixture(source, 'Approved staff may access', statement, 'Result: Approved staff may access.'), statement, 2)
  })

  it('requires the complete numerical condition from the owned identifying cell', async () => {
    const source = '# Source Guide\n\n## Rates\n\n| Rule | Result |\n| --- | --- |\n| Only orders exceeding 20 chairs | Discount: 12% |'
    const statement = 'Rule: Only orders exceeding 20 chairs; Result: Discount: 12%.'
    await expectPublication(groundingFixture(source, 'Discount: 12%', statement, 'Result: Discount: 12%, only orders.'), statement, 2)
  })

  it('retains a never-negated safety continuation', async () => {
    const statement = 'The soup may be served; but never before it is safely chilled.'
    const source = `# Source Guide\n\n## Safety\n\n${statement}`
    await expectPublication(groundingFixture(source, 'safely chilled', statement, 'The soup may be served.'), statement, 2)
  })

  it('requires temporal qualification from the owned identifying value', async () => {
    const source = '# Source Guide\n\n## Prices\n\n| Detail | Value |\n| --- | --- |\n| Historical price | 12 EUR |'
    const statement = 'Detail: Historical price; Value: 12 EUR.'
    await expectPublication(groundingFixture(source, '12 EUR', statement, 'Value: 12 EUR.'), statement, 2)
  })

  it('keeps numerical row identity separate from its numerical value', async () => {
    const source = '# Source Guide\n\n## Batches\n\n| Detail | Value |\n| --- | --- |\n| Batch 42 | 30 minutes |'
    const statement = 'Detail: Batch 42; Value: 30 minutes.'
    await expectPublication(groundingFixture(source, '30 minutes', statement, 'Detail: Batch 43; Value: 30 minutes.'), statement, 2)
  })
})
