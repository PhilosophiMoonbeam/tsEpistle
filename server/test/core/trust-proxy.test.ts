import { once } from 'node:events'
import type { AddressInfo } from 'node:net'

import express from 'express'
import { describe, expect, it } from '../bun-test.mts'

interface IdentityResponse {
  ip: string
  ips: string[]
}

const resolveIdentity = async (trustProxy: boolean, forwardedFor: string): Promise<IdentityResponse> => {
  const app = express()
  app.set('trust proxy', trustProxy)
  app.get('/identity', (req, res) => {
    res.json({ ip: req.ip, ips: req.ips })
  })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')

  try {
    const address = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${address.port}/identity`, {
      headers: { 'x-forwarded-for': forwardedFor }
    })
    expect(response.status).toBe(200)
    return await response.json() as IdentityResponse
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
}

describe('trusted proxy client identity', () => {
  it('ignores forwarding headers when no proxy is trusted', async () => {
    const identity = await resolveIdentity(false, '198.51.100.10')

    expect(identity.ip).toBe('127.0.0.1')
    expect(identity.ips).toEqual([])
  })

  it('resolves the client supplied by one trusted reverse proxy', async () => {
    const identity = await resolveIdentity(true, '198.51.100.20')

    expect(identity.ip).toBe('198.51.100.20')
    expect(identity.ips).toEqual(['198.51.100.20'])
  })

  it('resolves the left-most client through multiple trusted proxies', async () => {
    const identity = await resolveIdentity(true, '198.51.100.30, 10.0.0.20, 10.0.0.10')

    expect(identity.ip).toBe('198.51.100.30')
    expect(identity.ips).toEqual(['198.51.100.30', '10.0.0.20', '10.0.0.10'])
  })
})
