import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import type { AgentCompletionIssue, AgentGoalView } from '../../../shared/agents/contracts.ts'

interface Ref<T> {
  value: T
}

type GoalEmit = (event: 'update:expanded', value: boolean) => void

interface GoalHarness {
  statusLabel: Ref<string>
  statusColor: Ref<string>
  budgetPercent: Ref<number>
  blockerMessages: Ref<readonly AgentCompletionIssue[]>
  toggleAriaLabel: Ref<string>
  toggleExpanded: () => void
  emit: GoalEmit
}

const componentPath = path.join(process.cwd(), 'client/components/agents/agent-goal-status.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const script = source.match(/<script setup lang=["']ts["']>\s*([\s\S]*?)\s*<\/script>/)?.[1]
if (!script) throw new Error('agent-goal-status.vue script block was not found')

const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .*$/gm, ''))

const makeGoal = (overrides: Partial<AgentGoalView> = {}): AgentGoalView => ({
  id: 'goal-1',
  sessionId: 'session-1',
  objective: 'Prepare the release notes',
  status: 'active',
  version: 1,
  currentRunId: 'run-1',
  continuationCount: 1,
  maxContinuations: 4,
  consumedTokens: 300,
  maxTokens: 1_000,
  consumedToolCalls: 2,
  maxToolCalls: 10,
  startedAt: '2026-08-31T10:00:00.000Z',
  deadlineAt: '2026-09-01T10:00:00.000Z',
  completedAt: null,
  errorCode: null,
  errorMessage: null,
  completion: null,
  ...overrides
})

const loadGoal = (goal: AgentGoalView, expanded: boolean): GoalHarness => {
  const emit = vi.fn()
  const props = { goal, busy: false, runActive: false, expanded }
  const evaluate = new Function(
    'computed',
    'ref',
    'watch',
    'defineProps',
    'defineEmits',
    `${executableScript}\nreturn { statusLabel, statusColor, budgetPercent, blockerMessages, toggleAriaLabel, toggleExpanded }`
  ) as (...dependencies: unknown[]) => Omit<GoalHarness, 'emit'>
  const harness = evaluate(
    (getter: () => unknown) => ({
      get value() {
        return getter()
      }
    }),
    <T>(value: T): Ref<T> => ({ value }),
    () => undefined,
    () => props,
    () => emit
  )
  return { ...harness, emit }
}

describe('Agent goal status interaction', () => {
  it('assigns success, warning, and error tones to semantic goal states', () => {
    expect(loadGoal(makeGoal({ status: 'active' }), false).statusColor.value).toBe('success')
    expect(loadGoal(makeGoal({ status: 'completed' }), false).statusColor.value).toBe('success')

    for (const status of ['paused', 'blocked', 'budget_limited'] as const) {
      expect(loadGoal(makeGoal({ status }), false).statusColor.value).toBe('warning')
    }

    expect(loadGoal(makeGoal({ status: 'failed' }), false).statusColor.value).toBe('error')
  })

  it('calculates the peak resource budget across tokens, tools, and continuations', () => {
    const goal = makeGoal({
      consumedTokens: 750,
      maxTokens: 1_000,
      consumedToolCalls: 2,
      maxToolCalls: 10,
      continuationCount: 1,
      maxContinuations: 4
    })
    expect(loadGoal(goal, true).budgetPercent.value).toBe(75)

    expect(loadGoal(makeGoal({ consumedTokens: 2_000, maxTokens: 1_000 }), true).budgetPercent.value).toBe(100)
  })

  it('surfaces the goal error alongside completion blocker details', () => {
    const issue = { code: 'APPROVAL_REQUIRED', message: 'Approval is required before continuing.', retryable: true }
    const harness = loadGoal(
      makeGoal({
        status: 'failed',
        errorCode: 'PROVIDER_FAILED',
        errorMessage: 'The provider stopped responding.',
        completion: { outcome: 'partial', issues: [issue] }
      }),
      true
    )

    expect(harness.blockerMessages.value).toEqual([{ code: 'PROVIDER_FAILED', message: 'The provider stopped responding.', retryable: false }, issue])
  })

  it('describes the objective and current expansion state in the toggle label', () => {
    expect(loadGoal(makeGoal({ objective: 'Review the incident report' }), false).toggleAriaLabel.value).toBe(
      'Show durable goal details: Review the incident report'
    )
    expect(loadGoal(makeGoal({ objective: 'Review the incident report' }), true).toggleAriaLabel.value).toBe(
      'Hide durable goal details: Review the incident report'
    )
  })

  it('emits the inverse expanded state when the goal toggle is activated', () => {
    const collapsed = loadGoal(makeGoal(), false)
    collapsed.toggleExpanded()
    expect(collapsed.emit).toHaveBeenCalledWith('update:expanded', true)

    const expanded = loadGoal(makeGoal(), true)
    expanded.toggleExpanded()
    expect(expanded.emit).toHaveBeenCalledWith('update:expanded', false)
  })
})
