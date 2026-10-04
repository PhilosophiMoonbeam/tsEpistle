import fs from 'node:fs'
import path from 'node:path'
import i18next from 'i18next'
import { compileScript, parse } from '@vue/compiler-sfc'
import { resetBody } from '../../test/browser-dom.mts'
import * as Vue from 'vue'
import { createVuetify } from 'vuetify'
import * as vuetifyComponents from 'vuetify/components'
import { afterEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import type { AgentGoalView } from '../../../shared/agents/contracts.ts'
import { translateEnglish } from '../../test/english-translate.mts'

resetBody()
const english = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'server/locales/en.json'), 'utf8'))
await i18next.init({ lng: 'en', fallbackLng: 'en', defaultNS: 'common', initAsync: false, resources: { en: english } })

// Compile the real setup and template together; no private setup locals are exposed.
Bun.plugin({
  name: 'agent-goal-real-sfc-interactions',
  setup(builder) {
    builder.onLoad({ filter: /agent-goal-status\.vue$/ }, async ({ path: filename }) => {
      const parsed = parse(await Bun.file(filename).text(), { filename })
      if (parsed.errors.length) throw parsed.errors[0]
      const script = compileScript(parsed.descriptor, {
        id: 'agent-goal-interactions',
        genDefaultAs: '__component',
        inlineTemplate: true
      })
      return { loader: 'ts', contents: `${script.content}\nexport default __component;` }
    })
  }
})
// The SFC import intentionally follows loader registration; a static import runs before the test compiler exists.
const GoalStatus = (await import(path.join(process.cwd(), 'client/components/agents/agent-goal-status.vue'))).default

const makeGoal = (overrides: Partial<AgentGoalView> = {}): AgentGoalView => ({
  id: 'goal-1', sessionId: 'session-1', objective: 'Prepare the release notes', status: 'active', version: 1,
  currentRunId: 'run-1', continuationCount: 1, maxContinuations: 4, consumedTokens: 300, maxTokens: 1_000,
  consumedToolCalls: 2, maxToolCalls: 10, budgetPolicyVersion: 2, budgetSelection: 'pending', tokenTier: null,
  tokenAllowance: null, budgetCycle: 0, budgetLimitReason: null, canRenewTokenBudget: false,
  startedAt: '2026-08-31T10:00:00.000Z', deadlineAt: '2026-09-01T10:00:00.000Z', completedAt: null,
  errorCode: null, errorMessage: null, completion: null, ...overrides
})
const renewableGoal = () => makeGoal({
  status: 'budget_limited', consumedTokens: 1_450, maxTokens: 1_500, budgetSelection: 'utility',
  tokenTier: 'small', tokenAllowance: 500, budgetCycle: 2, budgetLimitReason: 'tokens', canRenewTokenBudget: true
})
const cleanups: Array<() => void> = []
const settle = async () => { await Vue.nextTick(); await Promise.resolve(); await Vue.nextTick() }
const mountGoal = (goal = makeGoal(), expanded = true) => {
  const state = Vue.reactive({ goal, expanded, busy: false, runActive: false, networkBlocked: false })
  const events = { pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(), renew: vi.fn(), expanded: vi.fn() }
  const host = document.createElement('div')
  document.body.append(host)
  const app = Vue.createApp({
    setup: () => () => Vue.h(GoalStatus, {
      ...state,
      'onUpdate:expanded': (value: boolean) => { state.expanded = value; events.expanded(value) },
      onPause: events.pause, onResume: events.resume, onCancel: events.cancel, 'onRenew-budget': events.renew
    })
  })
  app.use(createVuetify({ components: vuetifyComponents }))
  app.config.globalProperties.$t = (key: string, options = {}) => String(i18next.t(key, options))
  app.mount(host)
  cleanups.push(() => { app.unmount(); host.remove() })
  return { host, state, events }
}
const button = (root: ParentNode, label: RegExp): HTMLButtonElement => {
  const found = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(node => label.test(node.textContent ?? ''))
  if (!found) throw new Error(`Rendered action not found: ${label}`)
  return found
}
const dialog = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>('.v-overlay--active [role="dialog"], .v-overlay--active[role="dialog"]')
  if (!found) throw new Error('Mounted confirmation dialog not found')
  return found
}
const continueLabel = /continue.*token.*cycle/i
const fact = (root: ParentNode, label: RegExp) => {
  const term = Array.from(root.querySelectorAll('dt')).find(node => label.test(node.textContent ?? ''))
  return term?.parentElement?.querySelector('dd')?.textContent ?? ''
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  await i18next.changeLanguage('en')
  vi.setSystemTime()
  vi.restoreAllMocks()
  resetBody()
})

describe('Agent goal status interaction', () => {
  it('keeps a readable live status and references only mounted disclosure content', async () => {
    const { host, state, events } = mountGoal(makeGoal(), false)
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-expanded]')!
    const status = host.querySelector('[role="status"][aria-live="polite"]')!
    expect(status.textContent?.trim()).toBeTruthy()
    expect(status.getAttribute('aria-hidden')).toBeNull()
    expect(toggle.getAttribute('aria-label')).toContain(state.goal.objective)
    expect(toggle.getAttribute('aria-controls')).toBeNull()
    toggle.click()
    await settle()
    expect(events.expanded).toHaveBeenCalledWith(true)
    expect(host.querySelector('[role="status"][aria-live="polite"]')).toBe(status)
    const controlledId = toggle.getAttribute('aria-controls')!
    expect(document.getElementById(controlledId)?.getAttribute('role')).toBe('region')
    state.goal.status = 'completed'
    await settle()
    expect(status.textContent).toContain(translateEnglish('common:agentGoalStatus.completed'))
    toggle.click()
    await settle()
    expect(events.expanded).toHaveBeenLastCalledWith(false)
    expect(toggle.getAttribute('aria-controls')).toBeNull()
    expect(host.querySelector('[role="status"][aria-live="polite"]')).toBe(status)
  })

  it('refreshes mounted status, numbers and timeline when the language changes', async () => {
    i18next.addResourceBundle('de', 'common', { agentGoalStatus: { progress: 'In Bearbeitung', currentCycleTokens: 'Token im aktuellen Zyklus', completed: 'Abgeschlossen' } }, true, true)
    const { host, state } = mountGoal(makeGoal({ consumedTokens: 1_450, maxTokens: 2_000, tokenAllowance: 2_000, budgetCycle: 1 }))
    const status = host.querySelector('[aria-live="polite"]')!
    const timestamp = host.querySelector('time')!
    await i18next.changeLanguage('de')
    await settle()
    expect(status.textContent).toBe('In Bearbeitung')
    expect(fact(host, /Token im aktuellen Zyklus/)).toContain('1.450')
    expect(timestamp.textContent).toBe(new Intl.DateTimeFormat('de', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp.dateTime)))
    state.goal.status = 'completed'
    await settle()
    expect(status.textContent).toBe('Abgeschlossen')
  })

  it('updates the timeline year on a goal update', async () => {
    vi.setSystemTime(new Date('2026-12-30T12:00:00.000Z'))
    const { host, state } = mountGoal(makeGoal({ deadlineAt: '2026-12-31T10:00:00.000Z' }))
    expect(host.querySelector('time')?.textContent).not.toContain('2026')
    vi.setSystemTime(new Date('2027-01-01T12:00:00.000Z'))
    state.goal.version += 1
    await settle()
    expect(host.querySelector('time')?.textContent).toContain('2026')
  })

  it('reports peak resource usage across tokens, tools and continuations, capped at 100 percent', () => {
    for (const [overrides, percent] of [
      [{ consumedTokens: 750 }, 75], [{ consumedTokens: 100, consumedToolCalls: 8 }, 80],
      [{ consumedTokens: 100, continuationCount: 3 }, 75], [{ consumedTokens: 2_000 }, 100]
    ] as const) {
      const { host } = mountGoal(makeGoal(overrides))
      expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe(String(percent))
    }
  })

  it('renders both the provider error and completion blockers', () => {
    const { host } = mountGoal(makeGoal({ status: 'failed', errorCode: 'PROVIDER_FAILED', errorMessage: 'Provider stopped responding.', completion: { outcome: 'partial', issues: [{ code: 'APPROVAL_REQUIRED', message: 'Approval required before continuing.', retryable: true }] } }))
    expect(host.textContent).toContain('Provider stopped responding.')
    expect(host.textContent).toContain('Approval required before continuing.')
  })

  it('shows independent cycle and lifetime values and discloses no rollover before confirmed renewal', async () => {
    const { host, state, events } = mountGoal(renewableGoal())
    expect(fact(host, /current.*cycle.*usage/i)).toBe('450 of 500 tokens')
    expect(fact(host, /lifetime.*usage/i)).toBe('1,450 tokens')
    expect(fact(host, /next.*cycle.*allowance/i)).toMatch(/exactly.*500.*tokens/i)
    button(host, continueLabel).click()
    await settle()
    expect(events.renew).not.toHaveBeenCalled()
    const confirmation = dialog()
    expect(fact(confirmation, /current.*cycle.*usage/i)).toBe('450 of 500 tokens')
    expect(fact(confirmation, /lifetime.*usage/i)).toBe('1,450 tokens')
    expect(confirmation.textContent).toMatch(/unused.*tokens.*do not.*roll\s*over/i)
    button(confirmation, /^cancel$/i).click()
    await settle()
    expect(events.renew).not.toHaveBeenCalled()
    expect(state.goal.budgetCycle).toBe(2)
    expect(state.goal.consumedTokens).toBe(1_450)
    button(host, continueLabel).click()
    await settle()
    const confirm = button(dialog(), continueLabel)
    confirm.click()
    confirm.click()
    await settle()
    expect(events.renew).toHaveBeenCalledTimes(1)
  })

  it('blocks renewal confirmation while busy, disconnected or no longer admitted', async () => {
    for (const guard of ['busy', 'network', 'stale', 'runActive'] as const) {
      const { host, state, events } = mountGoal(renewableGoal())
      button(host, continueLabel).click()
      await settle()
      const confirm = button(dialog(), continueLabel)
      if (guard === 'busy') state.busy = true
      if (guard === 'network') state.networkBlocked = true
      if (guard === 'stale') state.goal.canRenewTokenBudget = false
      if (guard === 'runActive') state.runActive = true
      await settle()
      expect(confirm.disabled).toBe(true)
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await settle()
      expect(events.renew).not.toHaveBeenCalled()
      // Close each isolated mount before admitting the next dialog.
      cleanups.pop()!()
    }
  })

  it('does not offer renewal for a non-token limit and preserves historical lifetime accounting', () => {
    const unavailable = mountGoal(makeGoal({ ...renewableGoal(), budgetLimitReason: 'tool_calls' }))
    expect(Array.from(unavailable.host.querySelectorAll('button')).some(node => continueLabel.test(node.textContent ?? ''))).toBe(false)
    const historical = mountGoal(makeGoal({ ...renewableGoal(), budgetPolicyVersion: 1, tokenAllowance: 100, consumedTokens: 95, maxTokens: 200 }))
    expect(fact(historical.host, /lifetime.*budget/i)).toBe('95 of 200 tokens')
  })

  it('guards pause and resume and requires confirmation to cancel a goal', async () => {
    const { host, state, events } = mountGoal()
    state.busy = true
    await settle()
    expect(button(host, /^pause$/i).disabled).toBe(true)
    button(host, /^pause$/i).click()
    expect(events.pause).not.toHaveBeenCalled()
    state.busy = false
    state.networkBlocked = true
    await settle()
    expect(button(host, /^pause$/i).disabled).toBe(true)
    state.networkBlocked = false
    await settle()
    button(host, /^pause$/i).click()
    expect(events.pause).toHaveBeenCalledTimes(1)
    state.goal.status = 'paused'
    state.runActive = true
    await settle()
    expect(Array.from(host.querySelectorAll('button')).some(node => /resume goal/i.test(node.textContent ?? ''))).toBe(false)
    state.runActive = false
    await settle()
    button(host, /resume goal/i).click()
    expect(events.resume).toHaveBeenCalledTimes(1)
    button(host, /^cancel goal$/i).click()
    await settle()
    expect(events.cancel).not.toHaveBeenCalled()
    button(dialog(), /keep goal/i).click()
    await settle()
    expect(events.cancel).not.toHaveBeenCalled()
    button(host, /^cancel goal$/i).click()
    await settle()
    state.networkBlocked = true
    await settle()
    expect(button(dialog(), /^cancel goal$/i).disabled).toBe(true)
    state.networkBlocked = false
    await settle()
    button(dialog(), /^cancel goal$/i).click()
    await settle()
    expect(events.cancel).toHaveBeenCalledTimes(1)
  })
})
