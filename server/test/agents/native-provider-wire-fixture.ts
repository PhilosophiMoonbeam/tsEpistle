import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import express from 'express'
import type { AgentProviderFactory } from '../../agents/providers/factory.ts'

const providerUrl = 'https://provider.example.test/v1/chat/completions'
export const nativeFixtureMemory = 'Prefers concise answers.'

type WireMessage = { role: string; content?: string | null; tool_call_id?: string }
type WireTool = { type: string; function: { name: string; parameters?: { properties?: Record<string, unknown> } } }
interface WireRequest {
  model: string
  stream?: boolean
  messages: WireMessage[]
  tools?: WireTool[]
  response_format?: { json_schema?: { schema?: { properties?: Record<string, unknown> } } }
}
type FactoryFetch = NonNullable<ConstructorParameters<typeof AgentProviderFactory>[2]>
type FactoryResolver = NonNullable<ConstructorParameters<typeof AgentProviderFactory>[3]>

export interface NativeProviderWireFixture {
  readonly implementation: FactoryFetch
  readonly resolve: FactoryResolver
  readonly requests: WireRequest[]
  readonly validatedUrls: string[]
  readonly resolvedHosts: string[]
  readonly receipts: unknown[]
  expectChanged(changed: boolean): void
  close(): Promise<void>
}

/** A wire responder, not an AI service mock. The factory validates the public URL
 * and DNS before this test-only adapter maps it to its owned loopback listener.
 * No dispatcher, redirect, proxy, hosts entry or external socket is used here.
 */
export const createNativeProviderWireFixture = async (): Promise<NativeProviderWireFixture> => {
  const requests: WireRequest[] = []
  const validatedUrls: string[] = []
  const resolvedHosts: string[] = []
  const receipts: unknown[] = []
  let expectedChanged = true
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.post('/v1/chat/completions', (req, res) => {
    const request = req.body as WireRequest
    requests.push(request)
    try {
      if (requests.length > 24 || request.stream === true || !Array.isArray(request.messages))
        throw new Error('Native fixture request bound or buffered wire contract exceeded')
      const toolNames = request.tools?.map(tool => tool.function.name) ?? []
      let content: string | null = null
      let call: { name: string; arguments: string } | undefined
      const probeResult = request.messages.find(message => message.role === 'tool' && message.tool_call_id === 'native-conformance-echo')
      const properties = request.response_format?.json_schema?.schema?.properties ??
        request.tools?.find(tool => tool.function.name === '__axOutput')?.function.parameters?.properties
      const text = request.messages.map(message => message.content ?? '').join('\n')
      if (probeResult) {
        const result = JSON.parse(probeResult.content ?? '{}') as { receipt?: string }
        if (!result.receipt) throw new Error('Native conformance receipt missing')
        content = `ACKNOWLEDGED ${result.receipt}`
      } else if (toolNames.includes('wiki_conformance_echo')) {
        const token = /with token ([0-9a-f-]{36})\./u.exec(text)?.[1]
        if (!token) throw new Error('Native conformance token missing')
        call = { name: 'wiki_conformance_echo', arguments: JSON.stringify({ token }) }
      } else if (properties && Object.hasOwn(properties, 'verdict') && Object.hasOwn(properties, 'feedback')) {
        content = JSON.stringify({ verdict: 'complete', feedback: '' })
      } else if ((properties && Object.hasOwn(properties, 'claims')) || (text.includes('Source Text: ') && text.includes('User Request: '))) {
        const observation = expectedChanged ? 'Memory operation changed user memory.' : 'Memory operation made no change to user memory.'
        const answer = { claims: [], unresolvedFacets: [], observations: [observation], recommendations: '' }
        content = request.response_format || toolNames.includes('__axOutput') ? JSON.stringify(answer) :
          `Claims: []\nUnresolved Facets: []\nObservations: ${JSON.stringify(answer.observations)}\nRecommendations: `
      } else if (toolNames.includes('wiki_manage_memory')) {
        const memoryResult = request.messages.find(message => message.role === 'tool' && message.tool_call_id === 'native-save-memory')
        if (!memoryResult) {
          call = { name: 'wiki_manage_memory', arguments: JSON.stringify({ action: 'add', target: 'user', content: nativeFixtureMemory }) }
        } else {
          const receipt = JSON.parse(memoryResult.content ?? '{}')
          receipts.push(receipt)
          if (!toolNames.includes('wiki_finish_collection')) throw new Error('Native collection control unavailable')
          call = { name: 'wiki_finish_collection', arguments: '{}' }
        }
      } else if (toolNames.includes('wiki_finish_collection')) {
        call = { name: 'wiki_finish_collection', arguments: '{}' }
      } else if (text === 'Reply with a short acknowledgement.') {
        content = 'READY'
      } else {
        throw new Error('Unexpected native provider request stage')
      }
      if (content !== null && toolNames.includes('__axOutput')) {
        call = { name: '__axOutput', arguments: content }
        content = null
      }
      const id = call?.name === 'wiki_conformance_echo' ? 'native-conformance-echo' :
        call?.name === 'wiki_manage_memory' ? 'native-save-memory' : `native-control-${requests.length}`
      res.json({
        id: randomUUID(), object: 'chat.completion', created: 1, model: request.model,
        choices: [{ index: 0, finish_reason: call ? 'tool_calls' : 'stop', message: {
          role: 'assistant', content,
          ...(call ? { tool_calls: [{ id, type: 'function', function: call }] } : {})
        } }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }
      })
    } catch {
      // Never echo prompts, credentials or native request bodies in diagnostics.
      res.status(500).json({ error: { code: 'NATIVE_FIXTURE_PROTOCOL', message: 'Unexpected bounded native fixture request.' } })
    }
  })
  const server = app.listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
  } catch (error) {
    server.closeAllConnections()
    server.close()
    throw error
  }
  const localOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const implementation = Object.assign(async (input: Parameters<FactoryFetch>[0], init?: Parameters<FactoryFetch>[1]): Promise<Response> => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url
    if (url !== providerUrl) throw new Error('Native fixture refuses an unmapped provider destination')
    validatedUrls.push(url)
    // Deliberately omit the public-host pinned dispatcher: only this adapter's
    // fixed loopback URL is dialled, after production origin/path/DNS admission.
    return fetch(`${localOrigin}/v1/chat/completions`, {
      method: init?.method, headers: init?.headers, body: init?.body,
      signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(5_000)]),
      redirect: 'error', credentials: 'omit'
    })
  }, { preconnect: () => {} }) as FactoryFetch
  const resolve = (async (hostname: string) => {
    if (hostname !== 'provider.example.test') throw new Error('Native fixture refuses unexpected DNS')
    resolvedHosts.push(hostname)
    return [{ address: '93.184.216.34', family: 4 }]
  }) as FactoryResolver
  return {
    implementation, resolve, requests, validatedUrls, resolvedHosts, receipts,
    expectChanged: (changed: boolean) => { expectedChanged = changed },
    close: async () => {
      const closed = Promise.withResolvers<void>()
      server.close(error => error ? closed.reject(error) : closed.resolve())
      server.closeAllConnections()
      await closed.promise
    }
  }
}
