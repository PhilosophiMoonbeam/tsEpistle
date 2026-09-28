import fs from 'node:fs'
import path from 'node:path'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, beforeEach, describe, expect, it } from '../../../server/test/bun-test.mts'
import { browserWindow, resetBody } from '../../test/browser-dom.mts'

resetBody()

// Vue runtime-dom binds to document at evaluation time
const Vue = await import('vue')

const componentPath = path.join(process.cwd(), 'client/components/agents/agent-dictation-waveform.vue')
const componentSource = fs.readFileSync(componentPath, 'utf8')
const parsed = parse(componentSource, { filename: componentPath })
if (parsed.errors.length > 0) {
  throw new Error(`Failed to parse agent-dictation-waveform.vue: ${parsed.errors.join(', ')}`)
}

const componentId = 'agent-dictation-waveform-test-sfc'
const compiledScript = compileScript(parsed.descriptor, { id: componentId, genDefaultAs: '__sfc__' })
const compiledTemplate = compileTemplate({
  source: parsed.descriptor.template?.content ?? '',
  filename: componentPath,
  id: componentId,
  compilerOptions: { bindingMetadata: compiledScript.bindings, expressionPlugins: ['typescript'] }
})

const compiledComponent = `${compiledScript.content}\n${compiledTemplate.code}\n__sfc__.render = render\nexport default __sfc__`
// The SFC imports the shared tone helper relatively; a data-URL module cannot
// resolve that, so the helper is transpiled and spliced in as its own data URL.
const toneModulePath = path.join(process.cwd(), 'client/components/agents/agent-dictation-tone.ts')
const toneUrl =
  'data:text/javascript;base64,' + Buffer.from(new Bun.Transpiler({ loader: 'ts' }).transformSync(fs.readFileSync(toneModulePath, 'utf8'))).toString('base64')
const inlinedComponent = compiledComponent.replace(/(['"])\.\/agent-dictation-tone\.ts\1/g, () => JSON.stringify(toneUrl))
const transpiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(inlinedComponent)
const mod = await import('data:text/javascript;base64,' + Buffer.from(transpiled).toString('base64'))
const DictationWaveform = mod.default

interface ScheduledFrame {
  id: number
  callback: (time: number) => void
}

let scheduledFrames: ScheduledFrame[] = []
let frameIdSequence = 0
let cancelledFrameIds: number[] = []
let currentTime = 1000
let reducedMotionActive = false

const mockRequestAnimationFrame = (callback: (time: number) => void): number => {
  const id = ++frameIdSequence
  scheduledFrames.push({ id, callback })
  return id
}
const mockCancelAnimationFrame = (id: number): void => {
  cancelledFrameIds.push(id)
  scheduledFrames = scheduledFrames.filter(f => f.id !== id)
}
const mockMatchMedia = (query: string) => ({
  matches: reducedMotionActive,
  media: query,
  addEventListener: () => undefined,
  removeEventListener: () => undefined
})

type OverrideKey = 'requestAnimationFrame' | 'cancelAnimationFrame' | 'matchMedia'
const overrideKeys: OverrideKey[] = ['requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia']
const savedOverrides = new Map<OverrideKey, { global?: PropertyDescriptor; window?: PropertyDescriptor }>()
const mockOverrides: Record<OverrideKey, unknown> = {
  requestAnimationFrame: mockRequestAnimationFrame,
  cancelAnimationFrame: mockCancelAnimationFrame,
  matchMedia: mockMatchMedia
}
const applyOverrides = (): void => {
  for (const key of overrideKeys) {
    if (savedOverrides.has(key)) continue
    savedOverrides.set(key, {
      global: Object.getOwnPropertyDescriptor(globalThis, key),
      window: Object.getOwnPropertyDescriptor(browserWindow, key)
    })
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: mockOverrides[key] })
    Object.defineProperty(browserWindow, key, { configurable: true, writable: true, value: mockOverrides[key] })
  }
}
const restoreOverrides = (): void => {
  for (const [key, saved] of savedOverrides) {
    if (saved.global) Object.defineProperty(globalThis, key, saved.global)
    else Reflect.deleteProperty(globalThis, key)
    if (saved.window) Object.defineProperty(browserWindow, key, saved.window)
    else Reflect.deleteProperty(browserWindow, key)
  }
  savedOverrides.clear()
}

const mountedCleanups: Array<() => void> = []

beforeEach(() => {
  scheduledFrames = []
  frameIdSequence = 0
  cancelledFrameIds = []
  currentTime = 1000
  reducedMotionActive = false
  applyOverrides()
})

afterEach(() => {
  for (const cleanup of mountedCleanups.splice(0)) cleanup()
  browserWindow.document.body.replaceChildren()
  restoreOverrides()
})

const pumpFrames = (frames: number, step = 80): void => {
  for (let i = 0; i < frames; i += 1) {
    currentTime += step
    const pending = scheduledFrames.splice(0)
    for (const frame of pending) frame.callback(currentTime)
  }
}

const mountWaveform = async (props: { active?: boolean; source?: () => number; dbSource?: () => number }) => {
  const propsRef = Vue.reactive({ ...props })
  const Harness = Vue.defineComponent({
    setup() {
      return () => Vue.h(DictationWaveform, { ...propsRef })
    }
  })
  const container = browserWindow.document.createElement('div')
  browserWindow.document.body.appendChild(container)
  const app = Vue.createApp(Harness)
  app.mount(container)
  await Vue.nextTick()
  const cleanup = () => {
    app.unmount()
    container.remove()
  }
  mountedCleanups.push(cleanup)
  return {
    propsRef,
    canvas: () => container.querySelector<HTMLCanvasElement>('canvas.agent-dictation-waveform')
  }
}

it('expands quiet and moderate bars without changing their raw-level tone thresholds', async () => {
  const canvasPrototype = Object.getPrototypeOf(browserWindow.document.createElement('canvas')) as HTMLCanvasElement
  const originalContext = Object.getOwnPropertyDescriptor(canvasPrototype, 'getContext')
  const originalWidth = Object.getOwnPropertyDescriptor(canvasPrototype, 'clientWidth')
  const originalHeight = Object.getOwnPropertyDescriptor(canvasPrototype, 'clientHeight')
  const rects: Array<{ height: number; y: number; color: string }> = []
  const context = {
    fillStyle: '',
    setTransform: () => {},
    clearRect: () => {},
    fillRect(_x: number, y: number, _width: number, height: number) {
      rects.push({ height, y, color: this.fillStyle })
    }
  }
  Object.defineProperties(canvasPrototype, {
    getContext: { configurable: true, value: () => context },
    clientWidth: { configurable: true, get: () => 24 },
    clientHeight: { configurable: true, get: () => 24 }
  })
  try {
    let level = 0
    let db = -40
    const harness = await mountWaveform({ active: true, source: () => level, dbSource: () => db })
    const newest = () => rects.at(-1)!
    const sample = (value: number, dbfs: number) => {
      level = value
      db = dbfs
      rects.length = 0
      pumpFrames(2)
      return newest()
    }
    expect(sample(0, -96).height).toBe(2)
    const quiet = sample(0.05, -7)
    expect(quiet.height).toBe(4)
    expect(quiet.y).toBe(10)
    expect(quiet.color).toBe(sample(0, -96).color)
    const safe = sample(0.25, -20.01)
    const warn = sample(0.25, -20)
    const almostLoud = sample(0.25, -8.01)
    const loud = sample(0.25, -8)
    expect([safe.height, warn.height, almostLoud.height, loud.height]).toEqual([10, 10, 10, 10])
    expect([safe.y, warn.y, loud.y]).toEqual([7, 7, 7])
    expect(almostLoud.color).toBe(warn.color)
    expect(new Set([safe.color, warn.color, loud.color]).size).toBe(3)
    expect(sample(0.2, Number.NaN).color).toBe(safe.color)
    expect(sample(0.35, Number.NaN).color).toBe(warn.color)
    expect(sample(0.95, Number.NaN).color).toBe(loud.color)
    expect(sample(1, 0).height).toBe(20)
    expect(sample(0, -96).height).toBe(2)
    expect(harness.canvas()?.height).toBe(24)
  } finally {
    if (originalContext) Object.defineProperty(canvasPrototype, 'getContext', originalContext)
    if (originalWidth) Object.defineProperty(canvasPrototype, 'clientWidth', originalWidth)
    if (originalHeight) Object.defineProperty(canvasPrototype, 'clientHeight', originalHeight)
  }
})

describe('agent dictation waveform', () => {
  it('samples the live level only after the sample interval and stops on unmount', async () => {
    let reads = 0
    const harness = await mountWaveform({
      active: true,
      source: () => {
        reads += 1
        return 0.5
      }
    })
    expect(scheduledFrames.length).toBe(1)
    // jsdom canvases have no 2D context: the component must survive drawing.
    pumpFrames(3)
    expect(reads).toBeGreaterThan(0)
    expect(cancelledFrameIds.length).toBe(0)
    harness.canvas()?.remove()
    pumpFrames(2)
    expect(reads).toBeGreaterThan(1)
    for (const cleanup of mountedCleanups.splice(0)) cleanup()
    expect(cancelledFrameIds.length).toBe(1)
  })

  it('does not animate when reduced motion is preferred', async () => {
    reducedMotionActive = true
    let reads = 0
    await mountWaveform({
      active: true,
      source: () => {
        reads += 1
        return 1
      }
    })
    expect(scheduledFrames.length).toBe(0)
    pumpFrames(5)
    expect(reads).toBe(0)
  })

  it('tolerates a missing level source', async () => {
    const harness = await mountWaveform({ active: true })
    pumpFrames(2)
    expect(harness.canvas()).not.toBeNull()
  })
})
