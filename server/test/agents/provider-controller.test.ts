import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import cookieParser from 'cookie-parser'
import express from 'express'
import session from 'express-session'
import createKnex, { type Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it } from '../bun-test.mts'

import createAgentsHostController from '../../controllers/agents-host.ts'
import { AgentRepositoryError } from '../../agents/repository.ts'

interface TestSessionState {
  agentCsrfToken?: string
}

const profileId = '00000000-0000-4000-8000-000000000001'
const conformedVersionId = '00000000-0000-4000-8000-000000000002'
const editedVersionId = '00000000-0000-4000-8000-000000000003'
const csrf = 'provider-controller-csrf-token-at-least-thirty-two-bytes'

const profile = {
  id: profileId,
  displayName: 'Concurrent provider',
  status: 'disabled' as const,
  isGlobalDefault: false,
  exposureMode: 'all_agent_users' as const,
  groupIds: [],
  policyVersion: 2,
  conformed: false,
  transportKind: 'openai-responses' as const,
  model: 'edited-model',
  utilityModel: null,
  destinationHost: 'provider.example.test',
  authMode: 'bearer' as const,
  secretConfigured: true,
  capabilities: {
    streaming: true,
    toolCalling: 'native' as const,
    parallelToolCalls: false,
    structuredOutput: 'native-json-schema' as const,
    usage: 'terminal' as const,
    cancellation: true,
    maxContextTokens: 32_000,
    maxOutputTokens: 4_000
  },
  capabilityRevision: 'cap-2',
  pricingRevision: 'price-2',
  createdAt: '2026-08-30T00:00:00.000Z',
  baseUrl: 'https://provider.example.test/v1',
  adapterConfig: { timeoutMs: 30_000, maxRetries: 0, additionalHeaders: {} },
  policies: {
    allowedModes: ['agent' as const],
    dailyTokens: 100_000,
    dailyCostMicros: 1_000_000,
    reservationTokens: 10_000,
    reservationCostMicros: 100_000,
    reservationMilliseconds: 60_000,
    promptVersion: 1,
    maxAttempts: 3
  }
}

const report = {
  id: '00000000-0000-4000-8000-000000000004',
  profileVersionId: conformedVersionId,
  status: 'passed' as const,
  checks: [],
  errorCode: null,
  message: null,
  startedAt: '2026-08-30T00:00:00.000Z',
  completedAt: '2026-08-30T00:00:01.000Z'
}

describe('agents-host provider version fencing', () => {
  let db: Knex
  let server: Server
  let baseUrl: string
  let cookie: string
  let enableArguments: readonly unknown[] | undefined

  beforeAll(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    const app = express()
    app.use(cookieParser())
    app.use(session({ secret: 'provider-controller-session-secret', resave: false, saveUninitialized: true }))
    app.get('/seed', (req, res) => {
      const state = req.session as typeof req.session & TestSessionState
      state.agentCsrfToken = csrf
      res.sendStatus(204)
    })
    app.use(
      createAgentsHostController({
        auth: {
          authenticate(req, _res, next) {
            req.authContext = { kind: 'user', userId: 7, ownershipUserId: 7, principal: { id: 7 } }
            req.user = { id: 7, permissions: ['manage:system'] } as Express.User
            next()
          }
        },
        config: {
          host: 'https://wiki.example.test',
          sessionSecret: 'provider-controller-token-secret',
          agents: {
            enabled: true,
            provider: { enabled: true },
            retention: { temporarySessionHours: 24 },
            skills: { enabled: false, namespace: 'system/agent-skills' },
            proposals: { enabled: false },
            writes: {
              enabled: false,
              create: { enabled: false },
              patch: { enabled: false },
              move: { enabled: false },
              restore: { enabled: false },
              delete: { enabled: false }
            }
          }
        },
        models: { knex: db },
        providerRegistry: {
          getAdmin: async () => profile,
          setEnabled: async (...args: readonly unknown[]) => {
            enableArguments = args
            if (args[3] !== editedVersionId) throw new AgentRepositoryError('PROFILE_VERSION_CHANGED', 'Provider profile version changed', 409)
          }
        },
        providerConformance: {
          run: async () => report
        }
      } as never)
    )
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const repositoryError = error as AgentRepositoryError
      res.status(repositoryError.status ?? 500).json({ error: repositoryError.code, message: repositoryError.message })
    })
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
    const seed = await fetch(`${baseUrl}/seed`)
    cookie = seed.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
    await db.destroy()
  })

  it('cannot enable edited version B from overlapping conformance of version A', async () => {
    const response = await fetch(`${baseUrl}/_api/agents/admin/profiles/${profileId}/connection-check`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'https://wiki.example.test',
        'sec-fetch-site': 'same-origin',
        'x-wiki-csrf': csrf
      },
      body: JSON.stringify({ enableOnSuccess: true })
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'PROFILE_VERSION_CHANGED', message: 'Provider profile version changed' })
    expect(enableArguments).toEqual([profileId, true, 7, conformedVersionId])
  })
})
