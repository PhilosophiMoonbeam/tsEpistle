import { randomUUID } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import { DEFAULT_AGENT_ORCHESTRATION_LIMITS } from '../../agents/orchestration.ts'
import { AxAgentEngine } from '../../agents/providers/engine.ts'
import { AgentProviderFactory } from '../../agents/providers/factory.ts'
import { AgentProviderRegistry } from '../../agents/providers/registry.ts'
import type { AgentSecretRegistry } from '../../agents/providers/secrets.ts'
import { AgentProductRuntime, type AgentDispatchBudget, type AgentDispatchBudgetReservation, type AgentEngine } from '../../agents/runtime.ts'
import type { PostgresTestConnection } from '../postgres-test-connection.mts'

const publicEndpoint = 'https://restart-provider.example.test/v1/chat/completions'
const secrets: AgentSecretRegistry = {
  has: reference => reference === 'env:DISPATCH_RESTART_FIXTURE_KEY',
  get: reference => (reference === 'env:DISPATCH_RESTART_FIXTURE_KEY' ? 'nonbilled-loopback-only' : null),
  store: () => {
    throw new Error('Restart fixture cannot store credentials')
  },
  delete: () => false
}

export const createRestartRegistry = (db: Knex): AgentProviderRegistry =>
  new AgentProviderRegistry(db, secrets, {
    currentKeyId: 'restart-fixture',
    keys: { 'restart-fixture': 'nonbilled-restart-profile-resolution-only' }
  })

/** Keep the real native producer, exposure calculation and runtime budget. Only
 * the admitted public provider destination is mapped to an owned HTTP listener,
 * as in native-provider-wire-fixture.ts; nothing can reach a billed provider.
 */
export const createRestartRuntime = (db: Knex, localOrigin: string): AgentProductRuntime => {
  const origin = new URL(localOrigin)
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.pathname !== '/' || !origin.port || origin.username || origin.password)
    throw new Error('Restart fixture requires its owned loopback listener')
  // Observe the existing producer→budget boundary, not the accounting journal.
  // Unused sequence/admission capacity must never become the expected charge.
  const pendingDispatches = new Map<number, AgentDispatchBudgetReservation>()
  const observeBudget = (budget: AgentDispatchBudget): AgentDispatchBudget => ({
    async reserve(maximum) {
      const reservation = await budget.reserve(maximum)
      pendingDispatches.set(reservation.id, reservation)
      return reservation
    },
    reconcile: (reservation, actual) => budget.reconcile(reservation, actual),
    async release(reservation) {
      await budget.release(reservation)
      pendingDispatches.delete(reservation.id)
    },
    consumeTool: () => budget.consumeTool(),
    get unsettledExposure() {
      return budget.unsettledExposure
    },
    ...(budget.reserveSequence === undefined
      ? {}
      : {
          async reserveSequence(maximum: Parameters<AgentDispatchBudget['reserve']>[0]) {
            const sequence = await budget.reserveSequence!(maximum)
            return Object.assign(observeBudget(sequence), {
              resizeUndispatched: (maximum: Parameters<typeof sequence.resizeUndispatched>[0]) => sequence.resizeUndispatched(maximum),
              close: () => sequence.close()
            })
          }
        })
  })
  type FactoryFetch = NonNullable<ConstructorParameters<typeof AgentProviderFactory>[2]>
  type FactoryResolver = NonNullable<ConstructorParameters<typeof AgentProviderFactory>[3]>
  const implementation = Object.assign(
    async (input: Parameters<FactoryFetch>[0], init?: Parameters<FactoryFetch>[1]): Promise<Response> => {
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url
      if (url !== publicEndpoint) throw new Error('Restart fixture refuses an unmapped provider destination')
      const reservation = pendingDispatches.values().next().value
      if (!reservation || pendingDispatches.size !== 1) throw new Error('Native request must have exactly one pending dispatch reservation')
      pendingDispatches.delete(reservation.id)
      const headers = new Headers(init?.headers)
      headers.set('x-restart-dispatch-tokens', String(reservation.tokens))
      headers.set('x-restart-dispatch-cost-micros', String(reservation.costMicros))
      return fetch(`${origin.origin}/v1/chat/completions`, {
        method: init?.method,
        headers,
        body: init?.body,
        signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]),
        redirect: 'error',
        credentials: 'omit'
      })
    },
    { preconnect: () => {} }
  ) as FactoryFetch
  const resolve = (async (hostname: string) => {
    if (hostname !== 'restart-provider.example.test') throw new Error('Restart fixture refuses unexpected DNS')
    return [{ address: '93.184.216.34', family: 4 }]
  }) as FactoryResolver
  const factory = new AgentProviderFactory(db, secrets, implementation, resolve)
  const nativeEngine = new AxAgentEngine(factory)
  const engine: AgentEngine = {
    preflight: request => nativeEngine.preflight(request),
    execute: (request, sink) =>
      nativeEngine.execute(
        {
          ...request,
          ...(request.dispatchBudget === undefined ? {} : { dispatchBudget: observeBudget(request.dispatchBudget) })
        },
        sink
      )
  }
  // generation-only admission never calls native decision/utility providers.
  return new AgentProductRuntime(db, createRestartRegistry(db), engine, {
    memorySigningSecret: 'nonbilled-restart-memory-context-only',
    workerId: `dispatch-restart-${randomUUID()}`,
    globalConcurrency: 1,
    perUserConcurrency: 1,
    leaseMilliseconds: 60_000,
    heartbeatMilliseconds: 1_000,
    orchestration: { ...DEFAULT_AGENT_ORCHESTRATION_LIMITS, enabled: false },
    goals: { enabled: false, maxContinuations: 1, maxTokens: 500_000, maxToolCalls: 8, maxDurationMilliseconds: 60_000 }
  })
}

export interface RestartWorkerConfiguration {
  readonly connection: PostgresTestConnection
  readonly schema: string
  readonly localOrigin: string
}

if (import.meta.main) {
  const configuration = JSON.parse(process.env.WIKI_DISPATCH_RESTART_WORKER ?? 'null') as RestartWorkerConfiguration | null
  // The parent passes only its canonical runner assignment and owned per-case
  // schema. Never derive a database from an application/maintained connection.
  if (
    !configuration ||
    !/^agent_media_test_[0-9a-f]{32}$/.test(configuration.schema) ||
    configuration.connection.database !== process.env.WIKI_TEST_POSTGRES_DATABASE ||
    !/^tsepistle_test_[0-9a-f]{16}_[0-9a-z]+_dispatch_restart_test$/.test(configuration.connection.database)
  )
    throw new Error('Restart worker requires an isolated native runner assignment')
  const db = createKnex({ client: 'pg', connection: configuration.connection, searchPath: [configuration.schema], pool: { min: 0, max: 4 } })
  const runtime = createRestartRuntime(db, configuration.localOrigin)
  try {
    if (!(await runtime.runOnce())) throw new Error('Restart worker did not claim the admitted run')
    throw new Error('Restart worker unexpectedly passed the blocked transport')
  } finally {
    // The regression deliberately bypasses this with SIGKILL. Normal startup or
    // protocol failures still dispose of the child runtime and connection pool.
    await runtime.shutdown()
    await db.destroy()
  }
}
