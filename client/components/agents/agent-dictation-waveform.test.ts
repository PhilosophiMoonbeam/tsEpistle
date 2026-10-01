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
let currentTime = 1000
let reducedMotionActive = false

const mockRequestAnimationFrame = (callback: (time: number) => void): number => {
  const id = ++frameIdSequence
  scheduledFrames.push({ id, callback })
  return id
}
const mockCancelAnimationFrame = (id: number): void => {
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

const mountWaveform = async (props: { active?: boolean; source?: () => number; dbSource?: () => number; style?: Record<string, string> }) => {
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

const recordCanvas = () => {
  const canvasPrototype = Object.getPrototypeOf(browserWindow.document.createElement('canvas')) as HTMLCanvasElement
  const overriddenProperties = ['getContext', 'clientWidth', 'clientHeight'] as const
  const originalProperties = overriddenProperties.map(key => [key, Object.getOwnPropertyDescriptor(canvasPrototype, key)] as const)
  const rects: Array<{ height: number; y: number; color: string }> = []
  const theme = {
    '--v-theme-on-surface': '11, 22, 33',
    '--v-theme-success': '44, 155, 66',
    '--v-theme-warning': '177, 188, 99',
    '--v-theme-error': '211, 122, 133'
  }
  const colors = {
    neutral: 'rgb(11, 22, 33)',
    safe: 'rgb(44, 155, 66)',
    warn: 'rgb(177, 188, 99)',
    loud: 'rgb(211, 122, 133)'
  }
  const context = {
    fillStyle: '',
    setTransform: () => {},
    clearRect: () => { rects.length = 0 },
    fillRect(_x: number, y: number, _width: number, height: number) {
      rects.push({ height, y, color: this.fillStyle })
    }
  }
  Object.defineProperties(canvasPrototype, {
    getContext: { configurable: true, value: () => context },
    clientWidth: { configurable: true, get: () => 24 },
    clientHeight: { configurable: true, get: () => 24 }
  })
  return {
    rects,
    theme,
    colors,
    restore: () => {
      for (const [key, descriptor] of originalProperties) {
        if (descriptor) Object.defineProperty(canvasPrototype, key, descriptor)
        else Reflect.deleteProperty(canvasPrototype, key)
      }
    }
  }
}

it('expands quiet and moderate bars without changing their raw-level tone thresholds', async () => {
  const recording = recordCanvas()
  const { rects, theme, colors } = recording
  try {
    let level = 0
    let db = -40
    const harness = await mountWaveform({ active: true, source: () => level, dbSource: () => db, style: theme })
    const newest = () => rects.at(-1)!
    const sample = (value: number, dbfs: number) => {
      level = value
      db = dbfs
      pumpFrames(2)
      return newest()
    }
    // The supplied 24px canvas reserves a 2px baseline and 4px total vertical margin.
    const silence = sample(0, -96)
    expect(silence.height).toBe(2)
    expect(silence.color).toBe(colors.neutral)
    const quiet = sample(0.05, -7)
    expect(quiet.height).toBeGreaterThan(Math.max(2, Math.round(0.05 * 20)))
    expect(quiet.height).toBeLessThanOrEqual(20)
    expect(quiet.y).toBe((24 - quiet.height) / 2)
    expect(quiet.color).toBe(colors.neutral)
    const safe = sample(0.25, -20.01)
    const warn = sample(0.25, -20)
    const almostLoud = sample(0.25, -8.01)
    const loud = sample(0.25, -8)
    expect(safe.height).toBeGreaterThan(Math.round(0.25 * 20))
    expect(safe.height).toBeLessThanOrEqual(20)
    expect([warn.height, almostLoud.height, loud.height]).toEqual([safe.height, safe.height, safe.height])
    for (const bar of [safe, warn, almostLoud, loud]) expect(bar.y).toBe((24 - bar.height) / 2)
    expect(safe.color).toBe(colors.safe)
    expect(warn.color).toBe(colors.warn)
    expect(almostLoud.color).toBe(colors.warn)
    expect(loud.color).toBe(colors.loud)
    expect(sample(0.2, Number.NaN).color).toBe(colors.safe)
    expect(sample(0.35, Number.NaN).color).toBe(colors.warn)
    expect(sample(0.95, Number.NaN).color).toBe(colors.loud)
    expect(sample(1, 0).height).toBe(20)
    expect(sample(0, -96).height).toBe(2)
    expect(harness.canvas()?.height).toBe(24)
  } finally {
    recording.restore()
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
    expect(scheduledFrames).toHaveLength(1)
    // jsdom canvases have no 2D context: sampling still obeys its interval.
    pumpFrames(1)
    expect(reads).toBe(1)
    pumpFrames(1, 69)
    expect(reads).toBe(1)
    pumpFrames(1, 1)
    expect(reads).toBe(2)
    harness.canvas()?.remove()
    pumpFrames(1)
    expect(reads).toBe(3)
    for (const cleanup of mountedCleanups.splice(0)) cleanup()
    const readsAtUnmount = reads
    pumpFrames(3)
    expect(reads).toBe(readsAtUnmount)
    expect(scheduledFrames).toHaveLength(0)
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

  it('draws flat neutral feedback without a level source, even with a loud dB source', async () => {
    const recording = recordCanvas()
    try {
      const harness = await mountWaveform({ active: true, dbSource: () => -3, style: recording.theme })
      pumpFrames(2)
      pumpFrames(1, 35)
      expect(harness.canvas()).not.toBeNull()
      const neutralBaseline = { height: 2, y: 11, color: recording.colors.neutral }
      expect(recording.rects).toContainEqual(neutralBaseline)
      expect(recording.rects.every(bar => bar.height === 2 && bar.y === 11 && bar.color === recording.colors.neutral)).toBe(true)
    } finally {
      recording.restore()
    }
  })
})
