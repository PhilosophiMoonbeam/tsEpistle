import fs from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'

interface Ref<T> {
  value: T
}

interface PanelAgents {
  openSession: (sessionId: string) => Promise<boolean>
  cancelSessionTransition: () => void
}

type PanelEmit = (event: 'close' | 'reset') => void

interface PanelHarness {
  emit: PanelEmit
  closeHistory: () => void
  localError: Ref<string>
  openSession: (sessionId: string) => Promise<void>
  unmount: () => void
}

const componentPath = path.join(process.cwd(), 'client/components/agents/agent-history-panel.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const script = source.match(/<script setup lang=["']ts["']>\s*([\s\S]*?)\s*<\/script>/)?.[1]
if (!script) throw new Error('agent-history-panel.vue script block was not found')

const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .*$/gm, ''))

const loadPanel = (agents: PanelAgents, compact = true): PanelHarness => {
  const emit = vi.fn()
  const unmountCallbacks: Array<() => void> = []
  const ref = <T>(value: T): Ref<T> => ({ value })
  const thread = ref({ session: { id: '00000000-0000-4000-8000-000000000001' } })
  const evaluate = new Function(
    'computed',
    'onBeforeUnmount',
    'ref',
    'storeToRefs',
    'defineEmits',
    'useAgentsStore',
    'window',
    `${executableScript}\nreturn { closeHistory, localError, openSession }`
  ) as (...dependencies: unknown[]) => Pick<PanelHarness, 'closeHistory' | 'localError' | 'openSession'>
  const panel = evaluate(
    (getter: () => unknown) => ({
      get value() {
        return getter()
      }
    }),
    (callback: () => void) => unmountCallbacks.push(callback),
    ref,
    () => ({ folders: ref([]), sessions: ref([]), thread }),
    () => emit,
    () => agents,
    { matchMedia: () => ({ matches: compact }) }
  )
  return {
    ...panel,
    emit,
    unmount: () => {
      for (const callback of unmountCallbacks) callback()
    }
  }
}

describe('Agent history session selection', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('closes the compact history panel only after an applied transition', async () => {
    const agents: PanelAgents = {
      openSession: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      cancelSessionTransition: vi.fn()
    }
    const panel = loadPanel(agents)

    await panel.openSession('00000000-0000-4000-8000-000000000002')
    expect(panel.emit).not.toHaveBeenCalled()

    await panel.openSession('00000000-0000-4000-8000-000000000003')
    expect(panel.emit).toHaveBeenCalledTimes(1)
    expect(panel.emit).toHaveBeenCalledWith('close')
  })

  it('treats choosing the displayed session as the latest selection', async () => {
    const agents: PanelAgents = {
      openSession: vi.fn().mockResolvedValue(true),
      cancelSessionTransition: vi.fn()
    }
    const panel = loadPanel(agents)

    await panel.openSession('00000000-0000-4000-8000-000000000001')

    expect(agents.cancelSessionTransition).toHaveBeenCalledTimes(1)
    expect(agents.openSession).not.toHaveBeenCalled()
    expect(panel.emit).not.toHaveBeenCalled()
  })

  it('keeps the panel open with an error when the newest transition fails', async () => {
    const agents: PanelAgents = {
      openSession: vi.fn().mockRejectedValue(new Error('Session unavailable')),
      cancelSessionTransition: vi.fn()
    }
    const panel = loadPanel(agents)

    await panel.openSession('00000000-0000-4000-8000-000000000002')

    expect(panel.emit).not.toHaveBeenCalled()
    expect(panel.localError.value).toBe('Session unavailable')
  })

  it('cancels a pending transition before closing the history workspace', () => {
    const agents: PanelAgents = {
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionTransition: vi.fn()
    }
    const panel = loadPanel(agents)

    panel.closeHistory()

    expect(agents.cancelSessionTransition).toHaveBeenCalledTimes(1)
    expect(panel.emit).toHaveBeenCalledWith('close')
  })

  it('also cancels a pending transition when its parent removes the workspace', () => {
    const agents: PanelAgents = {
      openSession: vi.fn().mockResolvedValue(false),
      cancelSessionTransition: vi.fn()
    }
    const panel = loadPanel(agents)

    panel.unmount()

    expect(agents.cancelSessionTransition).toHaveBeenCalledTimes(1)
  })
})
