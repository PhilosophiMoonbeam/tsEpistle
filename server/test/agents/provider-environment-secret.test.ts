/** @vitest-environment node */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { DatabaseAgentSecretRegistry, environmentSecretValue } from '../../agents/providers/secrets.ts'

const secretName = 'WIKI_TEST_AGENT_PROVIDER_SECRET'
const fileVariable = `${secretName}_FILE`
const directories: string[] = []

afterEach(() => {
  delete process.env[secretName]
  delete process.env[fileVariable]
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('agent provider environment secrets', () => {
  it('reads a mounted secret file while preserving inline-variable precedence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wiki-agent-secret-'))
    directories.push(directory)
    const secretFile = join(directory, 'provider-key')
    writeFileSync(secretFile, 'mounted-provider-key\n', { mode: 0o600 })
    process.env[fileVariable] = secretFile

    const registry = new DatabaseAgentSecretRegistry({} as never, { currentKeyId: 'test', keys: { test: Buffer.alloc(32) } })
    expect(environmentSecretValue(secretName)).toBe('mounted-provider-key')
    expect(await registry.has(`env:${secretName}`)).toBe(true)
    expect(await registry.get(`env:${secretName}`)).toBe('mounted-provider-key')

    process.env[secretName] = 'inline-provider-key'
    expect(await registry.get(`env:${secretName}`)).toBe('inline-provider-key')
  })
})
