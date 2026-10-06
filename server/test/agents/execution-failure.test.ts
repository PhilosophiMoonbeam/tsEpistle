import { describe, expect, it } from '../bun-test.mts'
import { AgentRepositoryError } from '../../agents/repository.ts'
import { classifyAgentExecutionFailure } from '../../agents/providers/execution-failure.ts'

const sensitive = 'Bearer private-key; /private/source.webm; confidential document contents'

describe('Safe media execution failures', () => {
  it.each([
    ['AGENT_MEDIA_INPUT_UNSUPPORTED', 409],
    ['AGENT_MEDIA_INPUT_LIMIT', 413],
    ['INVALID_MEDIA_INPUT', 400],
    ['AGENT_MEDIA_DISABLED', 403],
    ['MEDIA_PROVIDER_CHANGED', 409],
    ['AGENT_EVENT_CORRUPT', 500]
  ] as const)('preserves typed %s without exposing repository details', (code, status) => {
    const cause = Object.assign(new AgentRepositoryError(code, sensitive, 500), {
      agentDiagnostics: { prompt: sensitive, credential: sensitive, providerTurn: 1 }
    })
    const failure = classifyAgentExecutionFailure(new Error(sensitive, { cause }), 'setup')
    expect(failure).toMatchObject({ code, status, stage: 'setup', diagnostics: { providerTurn: 1 } })
    expect(failure.message).not.toBe('Agent inference failed')
    expect(failure.message).not.toContain(sensitive)
    expect(failure.providerStatus).toBeUndefined()
    expect(JSON.stringify(failure)).not.toContain(sensitive)
  })

  it('does not trust media-looking codes on untyped failures or unknown repository errors', () => {
    for (const error of [
      Object.assign(new Error(sensitive), { code: 'AGENT_MEDIA_INPUT_UNSUPPORTED', status: 409 }),
      new AgentRepositoryError('UNTRUSTED_MEDIA_FAILURE', sensitive, 413)
    ]) {
      const failure = classifyAgentExecutionFailure(error, 'setup')
      expect(failure).toMatchObject({ code: 'PROVIDER_REQUEST_FAILED', status: 502, message: 'Agent inference failed' })
      expect(failure.diagnostics).toBeUndefined()
      expect(failure.providerStatus).toBeUndefined()
      expect(JSON.stringify(failure)).not.toContain(sensitive)
    }
  })
})
