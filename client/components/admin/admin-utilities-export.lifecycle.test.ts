import fs from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'

type ExportStatus = { status: 'running'; progress: number } | { status: 'success' } | { status: 'error'; message: string }

type ExportState = {
  entityChoices: readonly {
    key: string
    label: string
    hint: string
  }[]
  entities: string[]
  filePath: string
  isConfirming: boolean
  isLoading: boolean
  isSuccess: boolean
  isFailed: boolean
  errorMessage: string
  progress: number
  isDisposed: boolean
  requestGeneration: number
  startTimeoutHandle: number | null
  pollAnimationFrameHandle: number | null
  pollTimeoutHandle: number | null
}

type ExportVm = ExportState & {
  readonly isExportValid: boolean
  requestExport: () => void
  confirmExport: () => Promise<void>
  clearScheduledWork: () => void
  checkProgress: (generation?: number) => Promise<void>
  startExport: () => Promise<void>
}

type ExportComponentOptions = {
  data: () => ExportState
  beforeUnmount: (this: ExportVm) => void
  computed: {
    isExportValid: (this: ExportVm) => boolean
  }
  methods: {
    requestExport: (this: ExportVm) => void
    confirmExport: (this: ExportVm) => Promise<void>
    clearScheduledWork: (this: ExportVm) => void
    checkProgress: (this: ExportVm, generation?: number) => Promise<void>
    startExport: (this: ExportVm) => Promise<void>
  }
}

type ExportDependencies = {
  fetchStatus: () => Promise<ExportStatus>
  startExport: () => Promise<void>
}

const componentPath = path.join(process.cwd(), 'client/components/admin/admin-utilities-export.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const script = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)?.[1]
if (!script) throw new Error('admin-utilities-export.vue script block was not found')

const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  script.replace(/^import .*$/gm, '').replace('export default defineComponent({', 'const exportComponent = defineComponent({')
)

const loadComponent = (dependencies: ExportDependencies): ExportComponentOptions => {
  const evaluate = new Function(
    'defineComponent',
    'SelfBuildingSquareSpinner',
    'markRaw',
    'fetchSystemExportStatus',
    'startSystemExport',
    `${executableScript}\nreturn exportComponent`
  ) as (
    defineComponent: (options: ExportComponentOptions) => ExportComponentOptions,
    spinner: object,
    markRaw: <Value>(value: Value) => Value,
    fetchStatus: ExportDependencies['fetchStatus'],
    startExport: ExportDependencies['startExport']
  ) => ExportComponentOptions

  return evaluate(
    options => options,
    {},
    value => value,
    dependencies.fetchStatus,
    dependencies.startExport
  )
}

const settlePromises = async (): Promise<void> => {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
}

class Scheduler {
  private nextHandle = 1
  readonly timeouts = new Map<number, () => void>()
  readonly animationFrames = new Map<number, FrameRequestCallback>()
  readonly clearedTimeouts: number[] = []
  readonly cancelledAnimationFrames: number[] = []

  readonly window = {
    fetch: (() => Promise.reject(new Error('Unexpected direct fetch'))) as typeof fetch,
    setTimeout: (callback: () => void): number => {
      const handle = this.nextHandle
      this.nextHandle += 1
      this.timeouts.set(handle, callback)
      return handle
    },
    clearTimeout: (handle: number): void => {
      this.clearedTimeouts.push(handle)
      this.timeouts.delete(handle)
    },
    requestAnimationFrame: (callback: FrameRequestCallback): number => {
      const handle = this.nextHandle
      this.nextHandle += 1
      this.animationFrames.set(handle, callback)
      return handle
    },
    cancelAnimationFrame: (handle: number): void => {
      this.cancelledAnimationFrames.push(handle)
      this.animationFrames.delete(handle)
    }
  }

  async runNextTimeout(): Promise<void> {
    const entry = this.timeouts.entries().next().value as [number, () => void] | undefined
    if (!entry) throw new Error('Expected a scheduled timeout')
    this.timeouts.delete(entry[0])
    await entry[1]()
    await settlePromises()
  }

  async runNextAnimationFrame(): Promise<void> {
    const entry = this.animationFrames.entries().next().value as [number, FrameRequestCallback] | undefined
    if (!entry) throw new Error('Expected a scheduled animation frame')
    this.animationFrames.delete(entry[0])
    entry[1](0)
    await settlePromises()
  }
}

const createVm = (scheduler: Scheduler, dependencies: ExportDependencies): { vm: ExportVm; unmount: () => void } => {
  vi.stubGlobal('window', scheduler.window)
  const options = loadComponent(dependencies)
  const vm = options.data() as ExportVm
  Object.defineProperty(vm, 'isExportValid', {
    configurable: true,
    get: options.computed.isExportValid.bind(vm)
  })
  vm.requestExport = options.methods.requestExport.bind(vm)
  vm.confirmExport = options.methods.confirmExport.bind(vm)
  vm.clearScheduledWork = options.methods.clearScheduledWork.bind(vm)
  vm.checkProgress = options.methods.checkProgress.bind(vm)
  vm.startExport = options.methods.startExport.bind(vm)
  return {
    vm,
    unmount: () => options.beforeUnmount.call(vm)
  }
}
const selectValidExport = (vm: ExportVm): void => {
  vm.entities = ['pages']
  vm.filePath = ' ./data/export '
}

const visibleState = (vm: ExportVm) => ({
  isLoading: vm.isLoading,
  isSuccess: vm.isSuccess,
  isFailed: vm.isFailed,
  errorMessage: vm.errorMessage,
  progress: vm.progress
})

const deferred = <Value>(): { promise: Promise<Value>; resolve: (value: Value) => void } => {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>(complete => {
    resolve = complete
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('admin utilities export lifecycle ownership', () => {
  it('keeps the polling timer callback bound to the typed component instance', () => {
    expect(script).toMatch(/async\s+checkProgress\s*\(\s*this\s*:\s*ExportVm\s*,\s*generation\s*=\s*this\.requestGeneration\s*\)/)
  })

  it('keeps the static entity catalogue raw and exposes every supported selection', () => {
    const options = loadComponent({
      startExport: vi.fn(async () => undefined),
      fetchStatus: vi.fn(async (): Promise<ExportStatus> => ({ status: 'success' }))
    })

    const firstState = options.data()
    const secondState = options.data()

    expect(firstState.entityChoices).toBe(secondState.entityChoices)
    expect(firstState.entityChoices.map(choice => choice.key)).toEqual(['assets', 'comments', 'navigation', 'pages', 'history', 'settings', 'groups', 'users'])
    expect(script).toMatch(/const\s+ENTITY_CHOICES\s*=\s*markRaw<readonly\s+ExportEntityChoice\[\]>\s*\(\s*\[/)
  })

  it('uses a one-way model for the operation-owned progress dialog', () => {
    expect(source).toMatch(/v-dialog\(\s*:model-value=['"]isLoading['"][\s\S]*?aria-labelledby=['"]export-progress-title['"]/)
    expect(source).not.toMatch(/v-dialog\(\s*v-model=['"]isLoading['"]/)
  })

  it('forwards the selected entities and trimmed path through a successful export lifecycle', async () => {
    const scheduler = new Scheduler()
    const startExport = vi.fn(async () => undefined)
    const fetchStatus = vi.fn(async (): Promise<ExportStatus> => ({ status: 'success' }))
    const { vm } = createVm(scheduler, { startExport, fetchStatus })

    vm.entities = ['pages', 'users']
    vm.filePath = ' ./data/export '
    await vm.startExport()

    expect(vm.isLoading).toBe(true)
    expect(vm.filePath).toBe('./data/export')
    expect(scheduler.timeouts.size).toBe(1)

    await scheduler.runNextTimeout()

    expect(startExport).toHaveBeenCalledWith(expect.any(Function), ['pages', 'users'], './data/export', 'Export failed')
    expect(fetchStatus).toHaveBeenCalledTimes(1)
    expect(vm.isLoading).toBe(false)
    expect(vm.isSuccess).toBe(true)
    expect(vm.isFailed).toBe(false)
  })

  it('prevents a confirmed delayed export request and subsequent state writes when unmounted before start', async () => {
    const scheduler = new Scheduler()
    const startExport = vi.fn(async () => undefined)
    const fetchStatus = vi.fn(async (): Promise<ExportStatus> => ({ status: 'success' }))
    const { vm, unmount } = createVm(scheduler, { startExport, fetchStatus })

    selectValidExport(vm)
    vm.requestExport()
    expect(vm.isConfirming).toBe(true)
    await vm.confirmExport()
    expect(vm.isConfirming).toBe(false)
    const stateAtUnmount = visibleState(vm)
    expect(scheduler.timeouts.size).toBe(1)

    unmount()

    expect(scheduler.timeouts.size).toBe(0)
    expect(scheduler.clearedTimeouts).toHaveLength(1)
    expect(startExport).not.toHaveBeenCalled()
    expect(fetchStatus).not.toHaveBeenCalled()
    expect(visibleState(vm)).toEqual(stateAtUnmount)

    await vm.startExport()
    expect(startExport).not.toHaveBeenCalled()
    expect(visibleState(vm)).toEqual(stateAtUnmount)
  })

  it('cancels a running poll before it can issue another status request', async () => {
    const scheduler = new Scheduler()
    const fetchStatus = vi.fn(async (): Promise<ExportStatus> => ({ status: 'running', progress: 37 }))
    const { vm, unmount } = createVm(scheduler, {
      startExport: vi.fn(async () => undefined),
      fetchStatus
    })

    selectValidExport(vm)
    await vm.startExport()
    await scheduler.runNextTimeout()
    expect(fetchStatus).toHaveBeenCalledTimes(1)
    expect(vm.progress).toBe(37)
    expect(scheduler.animationFrames.size).toBe(1)
    const stateAtUnmount = visibleState(vm)

    unmount()

    expect(scheduler.animationFrames.size).toBe(0)
    expect(scheduler.cancelledAnimationFrames).toHaveLength(1)
    expect(scheduler.timeouts.size).toBe(0)
    expect(fetchStatus).toHaveBeenCalledTimes(1)
    expect(visibleState(vm)).toEqual(stateAtUnmount)
  })

  it('clears the owned poll timeout after its animation frame has run', async () => {
    const scheduler = new Scheduler()
    const fetchStatus = vi.fn(async (): Promise<ExportStatus> => ({ status: 'running', progress: 41 }))
    const { vm, unmount } = createVm(scheduler, {
      startExport: vi.fn(async () => undefined),
      fetchStatus
    })

    selectValidExport(vm)
    await vm.startExport()
    await scheduler.runNextTimeout()
    await scheduler.runNextAnimationFrame()
    expect(scheduler.timeouts.size).toBe(1)
    const stateAtUnmount = visibleState(vm)

    unmount()

    expect(scheduler.timeouts.size).toBe(0)
    expect(scheduler.clearedTimeouts).toHaveLength(1)
    expect(fetchStatus).toHaveBeenCalledTimes(1)
    expect(visibleState(vm)).toEqual(stateAtUnmount)
  })

  it('ignores an in-flight polling response that settles after unmount', async () => {
    const scheduler = new Scheduler()
    const pendingStatus = deferred<ExportStatus>()
    let statusRequest = 0
    const fetchStatus = vi.fn(async (): Promise<ExportStatus> => {
      statusRequest += 1
      if (statusRequest === 1) return { status: 'running', progress: 25 }
      return pendingStatus.promise
    })
    const { vm, unmount } = createVm(scheduler, {
      startExport: vi.fn(async () => undefined),
      fetchStatus
    })

    selectValidExport(vm)
    await vm.startExport()
    await scheduler.runNextTimeout()
    await scheduler.runNextAnimationFrame()
    expect(scheduler.timeouts.size).toBe(1)
    await scheduler.runNextTimeout()
    expect(fetchStatus).toHaveBeenCalledTimes(2)
    const stateAtUnmount = visibleState(vm)

    unmount()
    pendingStatus.resolve({ status: 'running', progress: 99 })
    await settlePromises()

    expect(fetchStatus).toHaveBeenCalledTimes(2)
    expect(scheduler.animationFrames.size).toBe(0)
    expect(scheduler.timeouts.size).toBe(0)
    expect(visibleState(vm)).toEqual(stateAtUnmount)
  })

  it('ignores status responses from a superseded request generation', async () => {
    const scheduler = new Scheduler()
    const pendingStatus = deferred<ExportStatus>()
    const fetchStatus = vi.fn(() => pendingStatus.promise)
    const { vm, unmount } = createVm(scheduler, {
      startExport: vi.fn(async () => undefined),
      fetchStatus
    })

    const staleRequest = vm.checkProgress()
    await settlePromises()
    expect(fetchStatus).toHaveBeenCalledTimes(1)

    selectValidExport(vm)
    await vm.startExport()
    const currentState = visibleState(vm)
    pendingStatus.resolve({ status: 'running', progress: 88 })
    await staleRequest

    expect(visibleState(vm)).toEqual(currentState)
    expect(scheduler.animationFrames.size).toBe(0)
    unmount()
  })
})
