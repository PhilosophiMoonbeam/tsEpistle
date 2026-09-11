import { createProductMetadata } from '../../core/product.ts'
import type { SystemWorkspace } from '../../../shared/system-workspace.ts'
export const systemWorkspaceFixture = (): SystemWorkspace => ({
  observedAt: '2026-09-06T12:00:00.000Z',
  product: createProductMetadata({ revision: 'a'.repeat(40), date: '2026-09-06T11:00:00.000Z' }),
  runtime: {
    instanceId: 'instance-private',
    hostname: 'private-host',
    platform: 'linux',
    architecture: 'x64',
    kernel: '6.8.0',
    container: true,
    bunVersion: '1.4.2',
    uptimeSeconds: 93782,
    processRssBytes: 210_000_000,
    heapUsedBytes: 85_000_000,
    heapTotalBytes: 95_000_000,
    systemMemoryBytes: 48_000_000_000,
    logicalCpuCount: 24,
    availableParallelism: 12,
    workingDirectory: '/private/workspace',
    configFile: '/private/config.yml',
    publicOrigin: 'https://private.example.test',
    offline: false,
    httpPort: 3000,
    httpsPort: null
  },
  database: { version: '17.6', latencyMs: 1.2, host: 'private-database', migrations: { applied: ['one.js'], pending: [], unknown: [] } },
  scheduler: { started: true, jobs: [] },
  queue: {
    counts: { pending: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
    due: 0,
    expiredLeases: 0,
    unsupported: 0,
    totalAttention: 0,
    attention: []
  }
})
