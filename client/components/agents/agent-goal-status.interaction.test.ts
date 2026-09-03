import fs from 'node:fs'
import path from 'node:path'

import { compileStyle, compileTemplate, parse } from '@vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import * as Vue from 'vue'
import { createSSRApp, defineComponent } from 'vue'
import type { RenderFunction } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createVuetify } from 'vuetify'
import * as vuetifyComponents from 'vuetify/components'
import { describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import type { AgentCompletionIssue, AgentGoalView } from '../../../shared/agents/contracts.ts'

interface Ref<T> {
  value: T
}

type GoalEmit = (event: 'update:expanded', value: boolean) => void

interface GoalHarness {
  [key: string]: unknown
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
const descriptor = parse(source, { filename: componentPath }).descriptor
const script = descriptor.scriptSetup?.content
const template = descriptor.template?.content
if (!script || !template) throw new Error('agent-goal-status.vue template or script block was not found')

const componentStyleId = 'agent-goal-status-interaction'
const componentScopeId = `data-v-${componentStyleId}`
const componentStyles = descriptor.styles
  .map(style => {
    const compiled = compileStyle({
      source: style.content,
      filename: componentPath,
      id: componentStyleId,
      scoped: style.scoped
    })
    if (compiled.errors.length > 0) {
      throw new Error(`Could not compile agent-goal-status.vue styles: ${compiled.errors.join(', ')}`)
    }
    return compiled.code
  })
  .join('\n')

const compiledTemplate = compileTemplate({
  source: template,
  filename: componentPath,
  id: componentStyleId,
  compilerOptions: { mode: 'function' }
})
if (compiledTemplate.errors.length > 0) throw new Error(`Could not compile agent-goal-status.vue: ${compiledTemplate.errors.join(', ')}`)
const renderGoalTemplate = new Function('Vue', compiledTemplate.code)(Vue) as RenderFunction

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
  const props = Vue.reactive({ goal, busy: false, runActive: false, expanded })
  const evaluate = new Function(
    'computed',
    'ref',
    'watch',
    'defineProps',
    'defineModel',
    'defineEmits',
    `${executableScript}\nreturn {
      statusLabel,
      statusColor,
      statusIcon,
      budgetPercent,
      blockerMessages,
      toggleAriaLabel,
      goalToggleTargetStyle,
      toggleExpanded,
      expanded,
      goalStatusId,
      goalCollapsedObjectiveId,
      goalToggleId,
      goalDetailsId,
      cancelDialogOpen,
      cancelGoalTitleId
    }`
  ) as (...dependencies: unknown[]) => Omit<GoalHarness, 'emit'>
  const harness = evaluate(
    Vue.computed,
    Vue.ref,
    () => undefined,
    () => props,
    () =>
      Vue.computed({
        get: () => props.expanded,
        set: (value: boolean) => {
          props.expanded = value
          emit('update:expanded', value)
        }
      }),
    () => emit
  )
  return { ...harness, emit }
}

const renderGoalStatus = async (goal: AgentGoalView): Promise<string> => {
  const harness = loadGoal(goal, false)
  const component = Object.assign(
    defineComponent({
      setup: () => ({ ...harness, goal, busy: false }),
      render: renderGoalTemplate
    }),
    { __scopeId: componentScopeId }
  )
  const app = createSSRApp(component)
  app.use(createVuetify({ components: vuetifyComponents }))
  return renderToString(app)
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

  it('renders both goal-toggle dimensions at least 44px with a compact control height', async () => {
    const renderedHtml = (await renderGoalStatus(makeGoal())).replace(/var\(\s*--wiki-control-height(?:\s*,\s*[^)]+)?\)/g, '40px')
    const dom = new JSDOM(
      `<!doctype html><html><head><style>${componentStyles}</style></head><body><main style="--wiki-control-height: 40px">${renderedHtml}</main></body></html>`
    )
    const toggle = dom.window.document.querySelector<HTMLElement>('.agent-goal__toggle')
    if (!toggle) throw new Error('Rendered goal toggle was not found')

    const computed = dom.window.getComputedStyle(toggle)
    expect(Number.parseFloat(computed.minWidth)).toBeGreaterThanOrEqual(44)
    expect(Number.parseFloat(computed.minHeight)).toBeGreaterThanOrEqual(44)
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
