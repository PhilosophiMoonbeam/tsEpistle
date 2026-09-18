import type { LookupAddress } from 'node:dns'
import { createServer } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { type Dispatcher, type RequestInit as UndiciRequestInit, fetch as undiciFetch } from 'undici/index.js'
import { type AgentProviderFetch, createGuardedProviderFetch } from '../../agents/providers/factory.ts'
import { describe, expect, it } from '../bun-test.mts'

describe('provider connection reuse', () => {
  it('checks DNS again at connection time with the real default transport', async () => {
    let resolutions = 0
    const resolve = async (): Promise<LookupAddress[]> => [{ address: ++resolutions === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }]
    const guarded = createGuardedProviderFetch('https://provider.example.test/v1', '/responses', {}, undefined, resolve as never)
    await expect(Promise.resolve(guarded('https://provider.example.test/v1/responses', { signal: AbortSignal.timeout(2_000) }))).rejects.toMatchObject({
      cause: { code: 'PROVIDER_EGRESS_DENIED' }
    })
    expect(resolutions).toBe(2)
  })

  it('reuses a socket across request wrappers after a chat pause while rechecking DNS and keeping credentials per request', async () => {
    const sockets = new Set<Socket>()
    const credentials: (string | undefined)[] = []
    const server = createServer((request, response) => {
      sockets.add(request.socket)
      credentials.push(request.headers.authorization)
      // Exercise the client fallback timeout, without a server timeout hint.
      response.setHeader('connection', 'keep-alive')
      response.removeHeader('keep-alive')
      if (request.headers['x-fixture-stream']) {
        if (request.headers['x-fixture-error']) response.statusCode = 500
        response.setHeader('content-type', 'text/event-stream')
        response.write('data: hello\n\n')
        return
      }
      response.end('{}')
    })
    server.keepAliveTimeout = 60_000
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    let privateAddress = false
    let resolutions = 0
    const resolve = async (): Promise<LookupAddress[]> => {
      resolutions++
      return [{ address: privateAddress ? '127.0.0.1' : '93.184.216.34', family: 4 }]
    }
    const dispatchers: Dispatcher[] = []
    // Only the injected test transport remaps the approved URL to a local server.
    const implementation = (async (_input: unknown, init: UndiciRequestInit): Promise<Response> => {
      if (!init.dispatcher) throw new Error('Missing provider dispatcher')
      dispatchers.push(init.dispatcher)
      return (await undiciFetch(origin, init)) as unknown as Response
    }) as AgentProviderFetch
    try {
      const first = createGuardedProviderFetch(
        'https://provider.example.test/v1',
        '/responses',
        { authorization: 'Bearer first-fixture' },
        implementation,
        resolve as never
      )
      expect(await (await first('https://provider.example.test/v1/responses')).text()).toBe('{}')
      // Longer than Undici's original four-second idle window, including timer granularity.
      await delay(6_100)
      const second = createGuardedProviderFetch(
        'https://provider.example.test/v1',
        '/interactions',
        { authorization: 'Bearer second-fixture' },
        implementation,
        resolve as never
      )
      expect(await (await second('https://provider.example.test/v1/interactions')).text()).toBe('{}')
      expect(dispatchers[0]).toBe(dispatchers[1])
      expect(sockets.size).toBe(1)
      expect(credentials).toEqual(['Bearer first-fixture', 'Bearer second-fixture'])
      expect(resolutions).toBe(2)
      privateAddress = true
      await expect(Promise.resolve(second('https://provider.example.test/v1/interactions'))).rejects.toMatchObject({ code: 'PROVIDER_EGRESS_DENIED' })
      expect(resolutions).toBe(3)
      expect(dispatchers).toHaveLength(2)
      privateAddress = false
      const controller = new AbortController()
      const streaming = await first('https://provider.example.test/v1/responses', {
        headers: { 'x-fixture-stream': 'true' },
        signal: controller.signal
      })
      const reader = streaming.body!.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: hello\n\n')
      controller.abort()
      await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
      reader.releaseLock()
      expect(await (await second('https://provider.example.test/v1/interactions')).text()).toBe('{}')
      expect(sockets.size).toBe(2)
      await expect(
        Promise.resolve(
          first('https://provider.example.test/v1/responses', {
            headers: { 'x-fixture-stream': 'true', 'x-fixture-error': 'true' },
            signal: AbortSignal.timeout(200)
          })
        )
      ).rejects.toMatchObject({ code: 'HTTP_500' })
    } finally {
      await dispatchers[0]?.destroy()
      await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
    }
  }, 15_000)

  it('cancels rejected redirect and oversized error bodies', async () => {
    for (const status of [302, 500]) {
      let cancelled = false
      const implementation = (async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true
            }
          }),
          {
            status,
            headers: status === 500 ? { 'content-length': '1000000' } : { location: 'https://other.example.test/' }
          }
        )) as unknown as AgentProviderFetch
      const resolve = async (): Promise<LookupAddress[]> => [{ address: '93.184.216.34', family: 4 }]
      const guarded = createGuardedProviderFetch('https://provider.example.test/v1', '/responses', {}, implementation, resolve as never)
      await expect(Promise.resolve(guarded('https://provider.example.test/v1/responses'))).rejects.toMatchObject({
        code: status === 302 ? 'PROVIDER_REDIRECT_DENIED' : 'HTTP_500'
      })
      expect(cancelled).toBe(true)
    }
  })
})
