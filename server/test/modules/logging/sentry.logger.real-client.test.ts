import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { LEVEL } from 'triple-beam'
import { describe, expect, it } from '../../bun-test.mts'
import { SentryLogger } from '../../../modules/logging/sentry/logger.ts'

describe('SentryLogger Node client', () => {
  it('delivers a warning envelope and waits for pending delivery during disposal', async () => {
    const received = Promise.withResolvers<{ method: string | undefined; url: string; body: string }>()
    const sockets = new Set<Socket>()
    let heldResponse: ServerResponse | undefined
    const server = createServer((request, response) => {
      heldResponse = response
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('error', received.reject)
      request.on('end', () => received.resolve({ method: request.method, url: request.url ?? '', body }))
    })
    server.on('connection', socket => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    const originalNoProxy = process.env.no_proxy
    // The SDK reads lowercase no_proxy; exempt only this loopback receiver.
    process.env.no_proxy = originalNoProxy ? `${originalNoProxy},127.0.0.1` : '127.0.0.1'
    let transport: SentryLogger | undefined
    let deliveryDeadline: NodeJS.Timeout | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const port = (server.address() as AddressInfo).port
      transport = new SentryLogger({ key: `http://public@127.0.0.1:${port}/1` })
      // Bound a missing real HTTP event; fake timers would freeze the unmocked SDK's flush timers too.
      deliveryDeadline = setTimeout(() => received.reject(new Error('Sentry warning envelope was not delivered.')), 1_500)
      transport.log({
        level: 'warn',
        [LEVEL]: 'warn',
        message: 'Sentry pending-delivery warning',
        operation: 'logging-destination-disposal',
        attempt: 7
      }, () => {})

      const request = await received.promise
      clearTimeout(deliveryDeadline)
      expect(request.method).toBe('POST')
      expect(new URL(request.url, `http://127.0.0.1:${port}`).pathname).toBe('/api/1/envelope/')
      const [, itemHeader, event] = request.body.trim().split('\n')
      expect(JSON.parse(itemHeader ?? '')).toMatchObject({ type: 'event' })
      expect(JSON.parse(event ?? '')).toMatchObject({
        message: 'Sentry pending-delivery warning',
        level: 'warning',
        extra: { operation: 'logging-destination-disposal', attempt: 7 }
      })

      let disposed = false
      const disposal = transport.dispose().then(() => { disposed = true })
      // Let an immediately resolved/no-op disposer settle while the HTTP response is held.
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(disposed).toBe(false)
      heldResponse?.end('{}')
      await disposal
      expect(disposed).toBe(true)
    } finally {
      clearTimeout(deliveryDeadline)
      if (heldResponse && !heldResponse.writableEnded) heldResponse.end('{}')
      try {
        await transport?.dispose()
      } finally {
        for (const socket of sockets) socket.destroy()
        try {
          if (server.listening) {
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
          }
        } finally {
          if (originalNoProxy === undefined) delete process.env.no_proxy
          else process.env.no_proxy = originalNoProxy
        }
      }
    }
  })
})
