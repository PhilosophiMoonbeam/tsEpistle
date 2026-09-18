import { readFileSync } from 'node:fs'
import { describe, expect, it } from '../bun-test.mts'

// Exercise the actual master lifecycle with controllable clocks and maintenance work.
const source = readFileSync(new URL('../../master.ts', import.meta.url), 'utf8')
const block = source.slice(source.indexOf('  let agentTimer:'), source.indexOf('  const agentsController ='))
const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(block)

describe('automatic Agent retention lifecycle', () => {
  it('runs without a configured provider, avoids overlap, retries safely and drains on shutdown', async () => {
    const timers = new Map<number, () => void>()
    const cleared: unknown[] = []
    const warnings: string[] = []
    const runs: Array<{ resolve: () => void; reject: (error: Error) => void }> = []
    const policy = { maintenanceBatchSize: 50, savedSessionDays: 90, mcpContentDays: 30, auditDays: 90 }
    let options: unknown
    const wiki: { models: { knex: object }; logger: { warn: (message: string) => void }; backgroundWorkers?: { start(): void; shutdown(): Promise<void> } } = {
      models: { knex: {} },
      logger: { warn: (message: string) => warnings.push(message) }
    }
    const install = new Function(
      'wiki',
      'agentLimits',
      'agentRuntime',
      'knowledgeLifecycle',
      'projectionLifecycle',
      'runAgentMaintenance',
      'setInterval',
      'clearInterval',
      compiled
    )
    install(
      wiki,
      { retention: policy },
      undefined,
      { runOnce: async () => {} },
      { runOnce: async () => {} },
      (_db: unknown, supplied: unknown) => {
        options = supplied
        return new Promise<void>((resolve, reject) => runs.push({ resolve, reject }))
      },
      (tick: () => void, ms: number) => {
        timers.set(ms, tick)
        return { unref() {} }
      },
      (timer: unknown) => cleared.push(timer)
    )
    wiki.backgroundWorkers!.start()
    wiki.backgroundWorkers!.start()
    expect(runs).toHaveLength(1)
    expect(options).toEqual({ batchSize: 50, savedSessionDays: 90, mcpContentDays: 30, auditDays: 90, compactDeltaDays: 1 })
    timers.get(600_000)!()
    expect(runs).toHaveLength(1)
    runs[0]!.reject(new Error('secret database detail'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(warnings).toEqual(['{"event":"agent.maintenance.failed","errorCode":"AGENT_MAINTENANCE_FAILED"}'])
    timers.get(600_000)!()
    expect(runs).toHaveLength(2)
    let stopped = false
    const shutdown = wiki.backgroundWorkers!.shutdown().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)
    runs[1]!.resolve()
    await shutdown
    expect(cleared).toHaveLength(4)
    timers.get(600_000)!()
    expect(runs).toHaveLength(2)
  })
})
