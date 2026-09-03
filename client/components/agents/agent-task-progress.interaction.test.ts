import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from '../../../server/test/bun-test.mts'
import type { AgentTaskView } from '../../../shared/agents/contracts.ts'

interface Ref<T> {
  value: T
}
type WatchSource<T = unknown> = (() => T) | Ref<T>

interface TaskHarness {
  props: { tasks: readonly AgentTaskView[] }
  detailsOpen: Ref<boolean>
  userExpanded: Ref<boolean | null>
  tick: Ref<number>
  handleSummaryActivation: () => void
  handleToggle: (event: Event) => void
}

const componentPath = path.join(process.cwd(), 'client/components/agents/agent-task-progress.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const script = source.match(/<script setup lang=["']ts["']>\s*([\s\S]*?)\s*<\/script>/)?.[1]
if (!script) throw new Error('agent-task-progress.vue script block was not found')

const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .*$/gm, ''))

const makeTask = (overrides: Partial<AgentTaskView> = {}): AgentTaskView => ({
  id: 'task-1',
  runId: 'run-1',
  kind: 'source_scout',
  title: 'Review sources',
  question: 'Which sources support the release?',
  sourceScope: [],
  requiredEvidenceCount: 1,
  status: 'running',
  subagentRunId: 'subagent-1',
  attempt: 1,
  outcome: null,
  evidenceCount: 0,
  errorCode: null,
  errorMessage: null,
  createdAt: '2026-09-03T10:00:00.000Z',
  startedAt: '2026-09-03T10:00:01.000Z',
  completedAt: null,
  ...overrides
})

const loadTasks = (tasks: readonly AgentTaskView[]): TaskHarness => {
  const watchers: Array<() => void> = []
  let currentTasks = tasks
  const props = {
    get tasks(): readonly AgentTaskView[] {
      return currentTasks
    },
    set tasks(value: readonly AgentTaskView[]) {
      currentTasks = value
      for (const notify of watchers) notify()
    }
  }
  const evaluate = new Function(
    'computed',
    'onBeforeUnmount',
    'onMounted',
    'ref',
    'watch',
    'defineProps',
    `${executableScript}\nreturn { detailsOpen, userExpanded, tick, handleSummaryActivation, handleToggle }`
  ) as (...dependencies: unknown[]) => Omit<TaskHarness, 'props'>
  const harness = evaluate(
    (getter: () => unknown) => ({
      get value() {
        return getter()
      }
    }),
    () => undefined,
    () => undefined,
    <T>(value: T): Ref<T> => ({ value }),
    <T>(source: WatchSource<T> | readonly WatchSource<T>[], callback: (value: T | readonly T[], oldValue: T | readonly T[]) => void) => {
      const isSourceArray = (candidate: WatchSource<T> | readonly WatchSource<T>[]): candidate is readonly WatchSource<T>[] => Array.isArray(candidate)
      const readSource = (entry: WatchSource<T>): T => (typeof entry === 'function' ? entry() : entry.value)
      const snapshot = (): T | readonly T[] => (isSourceArray(source) ? source.map(readSource) : readSource(source))
      let oldValue = snapshot()
      watchers.push(() => {
        const value = snapshot()
        callback(value, oldValue)
        oldValue = value
      })
    },
    () => props
  )
  return { ...harness, props }
}

const cleanCompletion = makeTask({
  status: 'completed',
  outcome: 'completed',
  evidenceCount: 1,
  completedAt: '2026-09-03T10:00:10.000Z'
})

describe('Agent task progress disclosure', () => {
  it('does not treat a programmatic initial toggle as manual intent and auto-collapses clean completion', () => {
    const harness = loadTasks([makeTask()])

    expect(harness.detailsOpen.value).toBe(true)
    harness.handleToggle({ currentTarget: { open: true } } as unknown as Event)
    expect(harness.userExpanded.value).toBeNull()

    harness.props.tasks = [cleanCompletion]
    expect(harness.detailsOpen.value).toBe(false)
  })

  it('preserves genuine user disclosure choices across duration ticks', () => {
    const userClosed = loadTasks([makeTask()])
    userClosed.handleSummaryActivation()
    userClosed.handleToggle({ currentTarget: { open: false } } as unknown as Event)
    userClosed.tick.value += 1
    userClosed.handleToggle({ currentTarget: { open: true } } as unknown as Event)
    expect(userClosed.userExpanded.value).toBe(false)
    expect(userClosed.detailsOpen.value).toBe(false)

    const userOpened = loadTasks([cleanCompletion])
    userOpened.handleSummaryActivation()
    userOpened.handleToggle({ currentTarget: { open: true } } as unknown as Event)
    userOpened.tick.value += 1
    userOpened.handleToggle({ currentTarget: { open: false } } as unknown as Event)
    expect(userOpened.userExpanded.value).toBe(true)
    expect(userOpened.detailsOpen.value).toBe(true)
  })

  it('keeps a user-closed running plan closed when tasks append', () => {
    const harness = loadTasks([makeTask()])
    harness.handleSummaryActivation()
    harness.handleToggle({ currentTarget: { open: false } } as unknown as Event)

    harness.props.tasks = [makeTask(), makeTask({ id: 'task-2', title: 'Review release notes' })]

    expect(harness.userExpanded.value).toBe(false)
    expect(harness.detailsOpen.value).toBe(false)
  })

  it('keeps a user-opened clean plan open when its task count changes', () => {
    const harness = loadTasks([cleanCompletion])
    harness.handleSummaryActivation()
    harness.handleToggle({ currentTarget: { open: true } } as unknown as Event)

    harness.props.tasks = [cleanCompletion, { ...cleanCompletion, id: 'task-2', title: 'Review release notes' }]

    expect(harness.userExpanded.value).toBe(true)
    expect(harness.detailsOpen.value).toBe(true)
  })

  it('auto-collapses a clean completion until the user intervenes', () => {
    const harness = loadTasks([cleanCompletion])

    expect(harness.userExpanded.value).toBeNull()
    expect(harness.detailsOpen.value).toBe(false)
  })
})
