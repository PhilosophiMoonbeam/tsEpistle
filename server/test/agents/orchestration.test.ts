import { describe, expect, it } from '../bun-test.mts'

import {
  parseAgentTaskPlan,
  parseChildEvidencePacket,
  shouldPlanAgentResearch,
  validateChildEvidencePacket,
  type AgentResearchTask
} from '../../agents/orchestration.ts'

const task: AgentResearchTask = {
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'fact_check',
  title: 'Verify the deployment date',
  question: 'Which revision establishes the deployment date?',
  sourceScope: ['operations/deployments'],
  requiredEvidenceCount: 1
}

const packet = (overrides: Readonly<Record<string, unknown>> = {}): string => JSON.stringify({
  taskId: task.id,
  outcome: 'completed',
  claims: [{
    text: 'The deployment occurred on August 17. [[cite:page:42:section:1]]',
    evidenceIds: ['page:42:section:1'],
    sourceRevisionIds: ['rev-7'],
    confidence: 'high'
  }],
  conflicts: [],
  unanswered: [],
  recommendedFollowups: [],
  ...overrides
})

const planTask = (title: string, question: string, scope: string) => ({
  kind: 'source_scout',
  title,
  question,
  sourceScope: [scope],
  requiredEvidenceCount: 1
})

describe('agent orchestration contracts', () => {
  it('uses a deterministic conservative delegation gate', () => {
    expect(shouldPlanAgentResearch('Summarize the deployment guide.')).toBe(false)
    expect(shouldPlanAgentResearch('Compare the alpha and beta deployment guides.')).toBe(true)
    expect(shouldPlanAgentResearch('What changed in alpha? What changed in beta?')).toBe(true)
  })

  it('accepts only independent bounded task plans', () => {
    expect(parseAgentTaskPlan(JSON.stringify({ tasks: [] }), 6)).toEqual([])
    expect(parseAgentTaskPlan(JSON.stringify({ tasks: [
      planTask('Review alpha', 'What does alpha require?', 'alpha'),
      planTask('Review beta', 'What does beta require?', 'beta')
    ] }), 6)).toHaveLength(2)

    expect(() => parseAgentTaskPlan(JSON.stringify({ tasks: [planTask('Only task', 'What changed?', 'alpha')] }), 6)).toThrow('at least two')
    expect(() => parseAgentTaskPlan(JSON.stringify({ tasks: [
      planTask('Review alpha', 'What does alpha require?', 'shared'),
      planTask('Review beta', 'What does beta require?', 'shared')
    ] }), 6)).toThrow('overlapping')
    expect(() => parseAgentTaskPlan(JSON.stringify({ tasks: [
      { ...planTask('Review alpha', 'What does alpha require?', 'alpha'), unexpected: true },
      planTask('Review beta', 'What does beta require?', 'beta')
    ] }), 6)).toThrow('schema validation')
  })

  it('normalizes a strict typed child packet without optional undefined fields', () => {
    expect(parseChildEvidencePacket(packet())).toEqual({
      taskId: task.id,
      outcome: 'completed',
      claims: [{
        text: 'The deployment occurred on August 17. [[cite:page:42:section:1]]',
        evidenceIds: ['page:42:section:1'],
        sourceRevisionIds: ['rev-7'],
        confidence: 'high'
      }],
      conflicts: [],
      unanswered: [],
      recommendedFollowups: []
    })
    expect(() => parseChildEvidencePacket(packet({ extra: 'not allowed' }))).toThrow('schema validation')
  })

  it('accepts only evidence read by the owning child at the exact source revision', () => {
    const validated = validateChildEvidencePacket(packet(), task, new Map([['page:42:section:1', 'rev-7']]))
    expect(validated).toMatchObject({ evidenceCount: 1, evidenceIds: ['page:42:section:1'] })

    expect(() => validateChildEvidencePacket(packet(), task, new Map())).toThrow('did not read')
    expect(() => validateChildEvidencePacket(packet({
      claims: [{
        text: 'The deployment occurred on August 17.',
        evidenceIds: ['page:42:section:1'],
        sourceRevisionIds: ['rev-7'],
        confidence: 'high'
      }]
    }), task, new Map([['page:42:section:1', 'rev-7']]))).toThrow('exactly match')
    expect(() => validateChildEvidencePacket(packet({
      claims: [{
        text: 'The deployment occurred on August 17. [[cite:page:42:section:1]]',
        evidenceIds: ['page:42:section:1'],
        sourceRevisionIds: ['rev-8'],
        confidence: 'high'
      }]
    }), task, new Map([['page:42:section:1', 'rev-7']]))).toThrow('revision identity')
  })

  it('rejects undeclared claim citations even when the child read them', () => {
    expect(() => validateChildEvidencePacket(packet({
      claims: [{
        text: 'The deployment occurred on August 17. [[cite:page:42:section:1]] Another page agrees. [[cite:page:43]]',
        evidenceIds: ['page:42:section:1'],
        sourceRevisionIds: ['rev-7'],
        confidence: 'high'
      }]
    }), task, new Map([
      ['page:42:section:1', 'rev-7'],
      ['page:43', 'rev-8']
    ]))).toThrow('exactly match')
  })

  it('rejects false completion while preserving honest partial evidence', () => {
    expect(() => validateChildEvidencePacket(packet({ claims: [], outcome: 'completed' }), task, new Map())).toThrow('did not satisfy')
    expect(validateChildEvidencePacket(packet({
      outcome: 'partial',
      unanswered: ['A second source was unavailable.']
    }), task, new Map([['page:42:section:1', 'rev-7']])).packet.outcome).toBe('partial')
  })

  it('requires every conflict source to belong to the child read set', () => {
    const conflictPacket = packet({
      conflicts: [{
        claim: 'The deployment date differs between revisions.',
        evidenceIds: ['page:42', 'page:43'],
        explanation: 'The pages name different dates.'
      }]
    })
    expect(() => validateChildEvidencePacket(conflictPacket, task, new Map([
      ['page:42:section:1', 'rev-7'],
      ['page:42', 'rev-7']
    ]))).toThrow('did not read')
  })

  it('accepts a completed conflict-only finding with distinct owned sources', () => {
    const conflictTask: AgentResearchTask = {
      ...task,
      kind: 'conflict_check',
      requiredEvidenceCount: 2
    }
    const conflict = {
      claim: 'The deployment date differs between revisions.',
      evidenceIds: ['page:42', 'page:43'],
      explanation: 'The pages name different dates.'
    }
    const evidence = new Map([
      ['page:42', 'rev-7'],
      ['page:43', 'rev-8']
    ])

    expect(validateChildEvidencePacket(packet({
      claims: [],
      conflicts: [conflict]
    }), conflictTask, evidence)).toMatchObject({
      evidenceCount: 2,
      evidenceIds: ['page:42', 'page:43'],
      conflictEvidenceGroups: [['page:42', 'page:43']]
    })
    expect(() => validateChildEvidencePacket(packet({
      claims: [],
      conflicts: [{ ...conflict, evidenceIds: ['page:42', 'page:42'] }]
    }), conflictTask, evidence)).toThrow('distinct evidence sources')
  })
})
