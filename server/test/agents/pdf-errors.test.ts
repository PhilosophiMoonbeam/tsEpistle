import { describe, expect, it } from '../bun-test.mts'
import { AgentPdfPreparationError, AGENT_PDF_ERRORS, type AgentPdfErrorCode } from '../../agents/pdf-preparation.ts'
import { AgentRepositoryError } from '../../agents/repository.ts'
import { classifyAgentExecutionFailure } from '../../agents/providers/execution-failure.ts'

describe('PDF public failures', () => {
  it('retains actionable fixed messages without parser diagnostics or document contents', () => {
    for (const [code, detail] of Object.entries(AGENT_PDF_ERRORS)) {
      const error = new AgentPdfPreparationError(code as AgentPdfErrorCode)
      error.message = '/private/document.pdf: sensitive contents'
      const result = classifyAgentExecutionFailure(error, 'context_admission')
      expect(result).toMatchObject({ code, status: detail.status, message: detail.message })
    }
    for (const code of ['AGENT_PDF_PAGE_LIMIT', 'AGENT_MEDIA_PART_LIMIT', 'AGENT_MEDIA_CONTEXT_LIMIT'] as const) {
      const result = classifyAgentExecutionFailure(new AgentRepositoryError(code, 'sensitive contents', 413), 'context_admission')
      expect(result.code).toBe(code)
      expect(result.status).toBe(413)
      expect(result.message).not.toContain('sensitive')
      expect(result.message).not.toBe('Agent inference failed')
    }
    expect(classifyAgentExecutionFailure(new Error('private parser failure'), 'context_admission').message).toBe('Agent inference failed')
  })
})
