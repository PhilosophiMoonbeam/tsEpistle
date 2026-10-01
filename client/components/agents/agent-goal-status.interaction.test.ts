import fs from 'node:fs'
import path from 'node:path'

import { compileStyle, compileTemplate, parse } from '@vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import { resetBody } from '../../test/browser-dom.mts'
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

resetBody()

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
  budgetPolicyVersion: 2,
  budgetSelection: 'pending',
  tokenTier: null,
  tokenAllowance: null,
  budgetCycle: 0,
  budgetLimitReason: null,
  canRenewTokenBudget: false,
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
      budgetAriaLabel,
      budgetMetrics,
      currentCycleTokens,
      currentCycleTokenLimit,
      formatBudgetValue,
      tokenTierLabel,
      budgetLimitReasonLabel,
      renewalAllowanceDescription,
      renewalAllowanceLabel,
      canRenewTokenBudget,
      progressLabel,
      timelinePrefix,
      timelineAt,
      timelineLabel,
      canPause,
      canResume,
      canCancel,
      runAction,
      renewBudget,
      confirmCancel,
      blockerMessages,
      blockerEntries,
      pendingAction,
      pendingActionLabel,
      networkBlocked,
      toggleAriaLabel,
      goalToggleTargetStyle,
      toggleExpanded,
      expanded,
      goalTitleId,
      goalStatusId,
      goalCollapsedObjectiveId,
      goalToggleId,
      goalDetailsId,
      goalBlockersTitleId,
      cancelDialogOpen,
      cancelGoalTitleId,
      goalBudgetTitleId
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

const goalStatusComponent = (goal: AgentGoalView, harness: GoalHarness) =>
  Object.assign(
    defineComponent({
      setup: () => ({ ...harness, goal, busy: false }),
      render: renderGoalTemplate
    }),
    { __scopeId: componentScopeId }
  )

const renderGoalStatus = async (goal: AgentGoalView, expanded = false): Promise<string> => {
  const component = goalStatusComponent(goal, loadGoal(goal, expanded))
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

  it('renders the peak resource budget across tokens, tools, and continuations, capped at 100 percent', async () => {
    const scenarios = [
      { goal: makeGoal({ consumedTokens: 750 }), percent: 75 },
      { goal: makeGoal({ consumedTokens: 100, consumedToolCalls: 8 }), percent: 80 },
      { goal: makeGoal({ consumedTokens: 100, continuationCount: 3 }), percent: 75 },
      { goal: makeGoal({ consumedTokens: 2_000 }), percent: 100 }
    ]
    for (const { goal, percent } of scenarios) {
      const document = new JSDOM(await renderGoalStatus(goal, true)).window.document
      expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe(String(percent))
      expect(document.querySelector('.agent-goal__progress-heading strong')?.textContent).toMatch(new RegExp(`\\b${percent}%`))
    }
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

  it('describes the objective and current expansion state in the rendered toggle label', async () => {
    for (const expanded of [false, true]) {
      const document = new JSDOM(await renderGoalStatus(makeGoal({ objective: 'Review the incident report' }), expanded)).window.document
      const toggle = document.querySelector<HTMLButtonElement>('.agent-goal__toggle')
      expect(toggle?.getAttribute('aria-expanded')).toBe(String(expanded))
      expect(toggle?.getAttribute('aria-label')).toContain('Review the incident report')
      expect(toggle?.getAttribute('aria-label')).toMatch(expanded ? /\bhide\b/i : /\bshow\b/i)
    }
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
  it('shows distinct cycle and lifetime usage with an explicit no-rollover renewal action', async () => {
    const renewableGoal = makeGoal({
      status: 'budget_limited',
      consumedTokens: 1_450,
      maxTokens: 1_500,
      budgetPolicyVersion: 2,
      budgetSelection: 'utility',
      tokenTier: 'small',
      tokenAllowance: 500,
      budgetCycle: 2,
      budgetLimitReason: 'tokens',
      canRenewTokenBudget: true
    })
    const renewable = await renderGoalStatus(renewableGoal, true)
    const renewableDocument = new JSDOM(renewable).window.document
    const facts = Array.from(renewableDocument.querySelectorAll('.agent-goal__renewal-facts > div'))
    const cycleFact = facts.find(fact => /\bcycle\b.*\busage\b/i.test(fact.querySelector('dt')?.textContent ?? ''))
    const lifetimeFact = facts.find(fact => /\blifetime\b.*\busage\b/i.test(fact.querySelector('dt')?.textContent ?? ''))
    expect(cycleFact?.querySelector('dd')?.textContent).toBe('450 of 500 tokens')
    expect(lifetimeFact?.querySelector('dd')?.textContent).toBe('1,450 tokens')
    const nextAllowanceFact = facts.find(fact => /\bnext\b.*\bcycle\b.*\ballowance\b/i.test(fact.querySelector('dt')?.textContent ?? ''))
    expect(nextAllowanceFact?.querySelector('dd')?.textContent).toMatch(/\bexactly\b.*\b500\b.*\btokens?\b/i)
    const disclosure = renewableDocument.querySelector('.agent-goal__renewal-copy[role="status"]')?.textContent ?? ''
    expect(disclosure).toMatch(/\bone\b.*\bcontinuation\b.*\b500-token\b.*\bcycle\b/i)
    expect(disclosure).toMatch(/\bunused\b.*\btokens?\b.*\bdo not\b.*\broll\s*over\b/i)

    const harness = loadGoal(renewableGoal, true)
    const host = document.createElement('div')
    document.body.append(host)
    const app = Vue.createApp(goalStatusComponent(renewableGoal, harness))
    app.use(createVuetify({ components: vuetifyComponents }))
    try {
      app.mount(host)
      const continueButton = host.querySelector<HTMLButtonElement>('.agent-goal__renewal button')
      if (!continueButton) throw new Error('Renewable token-budget action did not render')
      expect(continueButton.disabled).toBe(false)
      expect(continueButton.textContent).toContain('500')
      continueButton.click()
      await Vue.nextTick()
      expect(harness.emit).toHaveBeenCalledTimes(1)
      expect(harness.emit).toHaveBeenCalledWith('renew-budget')
    } finally {
      app.unmount()
      host.remove()
    }

    const nonRenewable = await renderGoalStatus(
      makeGoal({
        status: 'budget_limited',
        budgetSelection: 'utility',
        tokenTier: 'standard',
        tokenAllowance: 500,
        budgetCycle: 1,
        budgetLimitReason: 'tool_calls',
        canRenewTokenBudget: true
      }),
      true
    )
    expect(new JSDOM(nonRenewable).window.document.querySelector('.agent-goal__renewal button')).toBeNull()
  })

  it('preserves the truthful lifetime budget for historical rollover cycles', async () => {
    const html = await renderGoalStatus(
      makeGoal({
        status: 'budget_limited',
        budgetPolicyVersion: 1,
        budgetSelection: 'utility',
        tokenTier: 'standard',
        tokenAllowance: 100,
        budgetCycle: 2,
        consumedTokens: 95,
        maxTokens: 200,
        budgetLimitReason: 'tokens'
      }),
      true
    )
    const document = new JSDOM(html).window.document
    expect(document.querySelector('.agent-goal__renewal-facts')?.textContent).toContain('95 of 200 tokens')
  })
})
