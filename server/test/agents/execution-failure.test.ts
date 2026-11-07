import { describe, expect, it } from '../bun-test.mts'
import { AgentRepositoryError } from '../../agents/repository.ts'
import { classifyAgentExecutionFailure, normalizeAgentExecutionFailureDiagnostics } from '../../agents/providers/execution-failure.ts'

const sensitive = 'Bearer private-key; /private/source.webm; confidential document contents'

describe('Safe execution failures', () => {
  it('retains only observed response labels and bounded metadata through failure classification', () => {
    for (const responseIssue of ['length', 'refusal', 'malformed_output', 'response_limit', 'provider_error'] as const) {
      const cause = Object.assign(new AgentRepositoryError('INVALID_PROVIDER_RESPONSE', sensitive, 502), {
        agentDiagnostics: {
          responseIssue,
          response: { phase: 'wiki_synthesis', outputTokenLimit: 8192, reasoningTokens: 0, body: sensitive },
          details: sensitive
        }
      })
      const failure = classifyAgentExecutionFailure(new Error(sensitive, { cause }), 'provider_response')
      expect(failure.diagnostics).toEqual({ responseIssue, response: { phase: 'wiki_synthesis', outputTokenLimit: 8192, reasoningTokens: 0 } })
      expect(JSON.stringify(failure)).not.toContain(sensitive)
    }
    // A historical receipt at the cap is not evidence of a terminal reason.
    expect(normalizeAgentExecutionFailureDiagnostics({ current: { outputTokens: 8192 } })).toEqual({ current: { outputTokens: 8192 } })
  })

  it('omits unknown response labels, phases, unsafe counters and hostile getters', () => {
    for (const responseIssue of [undefined, null, 'LENGTH', 'content_filter', sensitive, ['length'], { code: 'length' }]) {
      expect(normalizeAgentExecutionFailureDiagnostics({ responseIssue })).toBeUndefined()
    }
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '8192', null]) {
      expect(
        normalizeAgentExecutionFailureDiagnostics({ response: { phase: sensitive, outputTokenLimit: value, reasoningTokens: value, message: sensitive } })
      ).toBeUndefined()
    }
    expect(
      normalizeAgentExecutionFailureDiagnostics({
        response: {
          phase: 'wiki_coverage',
          outputTokenLimit: Number.MAX_SAFE_INTEGER,
          get reasoningTokens() {
            throw new Error(sensitive)
          }
        },
        get responseIssue() {
          throw new Error(sensitive)
        }
      })
    ).toEqual({ response: { phase: 'wiki_coverage', outputTokenLimit: Number.MAX_SAFE_INTEGER } })
    expect(
      normalizeAgentExecutionFailureDiagnostics({
        get response() {
          throw new Error(sensitive)
        }
      })
    ).toBeUndefined()
    for (const response of [{}, [], null, sensitive, { phase: 'unknown', rawCode: sensitive }]) {
      expect(normalizeAgentExecutionFailureDiagnostics({ response })).toBeUndefined()
    }
  })

  it.each([
    ['AGENT_MEDIA_INPUT_UNSUPPORTED', 409],
    ['AGENT_MEDIA_INPUT_LIMIT', 413],
    ['INVALID_MEDIA_INPUT', 400],
    ['AGENT_MEDIA_DISABLED', 403],
    ['MEDIA_PROVIDER_CHANGED', 409],
    ['AGENT_EVENT_CORRUPT', 500],
    ['WIKI_VERIFICATION_UNAVAILABLE', 503],
    ['WIKI_VERIFICATION_BINDING_INVALID', 409],
    ['WIKI_VERIFICATION_PLAN_INVALID', 500],
    ['WIKI_VERIFICATION_PRICING_INVALID', 503],
    ['WIKI_VERIFICATION_FAILED', 503],
    ['DECISION_PROVIDER_UNAVAILABLE', 503],
    ['DECISION_PROVIDER_FAILED', 502],
    ['DECISION_PROVIDER_REVISION_CHANGED', 409]
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

  it('does not trust known-looking codes on untyped failures or unknown repository errors', () => {
    for (const error of [
      Object.assign(new Error(sensitive), { code: 'AGENT_MEDIA_INPUT_UNSUPPORTED', status: 409 }),
      Object.assign(new Error(sensitive), { code: 'WIKI_VERIFICATION_FAILED', status: 503 }),
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
