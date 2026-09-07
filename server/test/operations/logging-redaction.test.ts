import { describe, expect, it } from '../bun-test.mts'
import { redactLoggingLiveOutput } from '../../operations/logging.ts'

describe('privileged live logging redaction', () => {
  it('removes credentials in quoted JSON fields, including escaped strings and nested data', () => {
    const input = JSON.stringify({ password: 'fixture-password', nested: { apiKey: 'fixture-api-key', access_token: 'fixture-access-token' }, secret: 'fixture-escaped-"value', message: 'operation failed' })
    const output = redactLoggingLiveOutput(input)
    for (const value of ['fixture-password', 'fixture-api-key', 'fixture-access-token', 'fixture-escaped']) expect(output).not.toContain(value)
    expect(output).toContain('operation failed')
  })
  it('removes connection URI credentials across database, Git and HTTP schemes', () => {
    for (const scheme of ['mongodb', 'mongodb+srv', 'postgresql', 'redis', 'https', 'ssh']) {
      const output = redactLoggingLiveOutput(`${scheme}://fixture-user:fixture-password@host.example.test/path`)
      expect(output).not.toContain('fixture-password')
      expect(output).not.toContain('fixture-user')
    }
  })
  it('retains ordinary diagnostic context while masking assignment and authorization values', () => {
    const output = redactLoggingLiveOutput('Job 42 failed password=fixture-password Authorization: Bearer fixture-token-value-123456; retry later')
    expect(output).toContain('Job 42 failed')
    expect(output).toContain('retry later')
    expect(output).not.toContain('fixture-password')
    expect(output).not.toContain('fixture-token')
  })
})
