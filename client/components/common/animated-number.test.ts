import fs from 'node:fs'
import path from 'node:path'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it } from '../../../server/test/bun-test.mts'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/'
})
const browserWindow = dom.window

const browserGlobals: Record<string, unknown> = {
  document: browserWindow.document,
  window: browserWindow,
  navigator: browserWindow.navigator,
  Element: browserWindow.Element,
  Event: browserWindow.Event,
  HTMLElement: browserWindow.HTMLElement,
  MutationObserver: browserWindow.MutationObserver,
  Node: browserWindow.Node,
  SVGElement: browserWindow.SVGElement,
  Text: browserWindow.Text
}
for (const [name, value] of Object.entries(browserGlobals)) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}

// Vue runtime-dom binds to document at evaluation time
const Vue = await import('vue')

const componentPath = path.join(process.cwd(), 'client/components/common/animated-number.vue')
const componentSource = fs.readFileSync(componentPath, 'utf8')
const parsed = parse(componentSource, { filename: componentPath })
if (parsed.errors.length > 0) {
  throw new Error(`Failed to parse animated-number.vue: ${parsed.errors.join(', ')}`)
}

const componentId = 'animated-number-test-sfc'
const compiledScript = compileScript(parsed.descriptor, {
  id: componentId,
  genDefaultAs: '__sfc__'
})
const compiledTemplate = compileTemplate({
  source: parsed.descriptor.template?.content ?? '',
  filename: componentPath,
  id: componentId,
  preprocessLang: parsed.descriptor.template?.lang,
  compilerOptions: {
    bindingMetadata: compiledScript.bindings,
    expressionPlugins: ['typescript']
  }
})

const compiledComponent = `${compiledScript.content}\n${compiledTemplate.code}\n__sfc__.render = render\nexport default __sfc__`
const transpiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(compiledComponent)
const base64 = Buffer.from(transpiled).toString('base64')
const mod = await import('data:text/javascript;base64,' + base64)
const AnimatedNumber = mod.default

interface ScheduledFrame {
  id: number
  callback: (time: number) => void
}

let scheduledFrames: ScheduledFrame[] = []
let frameIdSequence = 0
let cancelledFrameIds: number[] = []
let currentTime = 1000
let reducedMotionActive = false
let mediaQueryChangeListeners: Array<(event: { matches: boolean }) => void> = []

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
  addEventListener: (event: string, listener: (e: { matches: boolean }) => void) => {
    if (event === 'change') mediaQueryChangeListeners.push(listener)
  },
  removeEventListener: (event: string, listener: (e: { matches: boolean }) => void) => {
    if (event === 'change') {
      mediaQueryChangeListeners = mediaQueryChangeListeners.filter(l => l !== listener)
    }
  }
})

const mountedCleanups: Array<() => void> = []

beforeEach(() => {
  scheduledFrames = []
  frameIdSequence = 0
  cancelledFrameIds = []
  currentTime = 1000
  reducedMotionActive = false
  mediaQueryChangeListeners = []

  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: mockRequestAnimationFrame
  })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: mockCancelAnimationFrame
  })
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    writable: true,
    value: { now: () => currentTime }
  })
  Object.defineProperty(browserWindow, 'matchMedia', {
    configurable: true,
    writable: true,
    value: mockMatchMedia
  })
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    writable: true,
    value: mockMatchMedia
  })
})

afterEach(() => {
  for (const cleanup of mountedCleanups.splice(0)) cleanup()
  browserWindow.document.body.replaceChildren()
})

const mountAnimatedNumber = async (initialProps: { value: number; duration?: number; formatValue?: (v: number) => string | number }) => {
  const propsRef = Vue.reactive({ ...initialProps })

  const Harness = Vue.defineComponent({
    setup() {
      return () => Vue.h(AnimatedNumber, { ...propsRef })
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

  const getVisibleElement = () => container.querySelector<HTMLSpanElement>('span[aria-hidden="true"]')
  const getAnnouncementElement = () => container.querySelector<HTMLSpanElement>('span.animated-number__announcement')

  return {
    app,
    container,
    propsRef,
    getVisibleElement,
    getAnnouncementElement,
    getDisplayValue: () => getVisibleElement()?.textContent ?? '',
    getAnnouncementValue: () => getAnnouncementElement()?.textContent ?? '',
    cleanup
  }
}

describe('animated-number runtime animation and reactivity', () => {
  it('animates from initial value to target and settles', async () => {
    const harness = await mountAnimatedNumber({ value: 100, duration: 400 })

    // Announcement value is immediately the final destination for screen readers
    expect(harness.getAnnouncementValue()).toBe('100')
    // Display value starts at initial formatValue(0)
    expect(harness.getDisplayValue()).toBe('0')
    expect(scheduledFrames.length).toBe(1)

    // Advance half-way through duration: 200ms
    currentTime += 200
    const firstFrame = scheduledFrames.shift()!
    firstFrame.callback(currentTime)
    await Vue.nextTick()

    const midValue = Number(harness.getDisplayValue())
    expect(midValue).toBeGreaterThan(0)
    expect(midValue).toBeLessThan(100)
    expect(scheduledFrames.length).toBe(1)

    // Complete animation at 400ms
    currentTime += 200
    const finalFrame = scheduledFrames.shift()!
    finalFrame.callback(currentTime)
    await Vue.nextTick()

    expect(harness.getDisplayValue()).toBe('100')
    expect(scheduledFrames.length).toBe(0)
  })

  it('excludes stale animation work when value changes', async () => {
    const harness = await mountAnimatedNumber({ value: 50, duration: 600 })
    expect(scheduledFrames.length).toBe(1)

    // Update value while first animation frame is still pending
    harness.propsRef.value = 200
    await Vue.nextTick()

    // The old work is removed and the latest target is announced immediately.
    expect(cancelledFrameIds.length).toBeGreaterThan(0)
    expect(scheduledFrames.length).toBe(1)
    expect(harness.getAnnouncementValue()).toBe('200')

    // The replacement animation settles on the latest target.
    currentTime += 600
    scheduledFrames.shift()!.callback(currentTime)
    await Vue.nextTick()

    expect(harness.getDisplayValue()).toBe('200')
    expect(scheduledFrames.length).toBe(0)
  })

  it('cancels active animation frame when component unmounts', async () => {
    const harness = await mountAnimatedNumber({ value: 80, duration: 500 })
    expect(scheduledFrames.length).toBe(1)

    harness.cleanup()
    await Vue.nextTick()

    expect(cancelledFrameIds.length).toBeGreaterThan(0)
    expect(scheduledFrames.length).toBe(0)
  })

  it('handles custom formatValue and updates reactively when formatter changes', async () => {
    const formatCurrency = (v: number) => `$${Math.round(v)}`
    const harness = await mountAnimatedNumber({
      value: 150,
      duration: 300,
      formatValue: formatCurrency
    })

    expect(harness.getAnnouncementValue()).toBe('$150')
    expect(harness.getDisplayValue()).toBe('$0')

    // Complete animation
    currentTime += 300
    scheduledFrames.shift()!.callback(currentTime)
    await Vue.nextTick()

    expect(harness.getDisplayValue()).toBe('$150')

    // Change formatting function to decimal format
    const formatPercent = (v: number) => `${Math.round(v)}%`
    harness.propsRef.formatValue = formatPercent
    await Vue.nextTick()

    expect(harness.getDisplayValue()).toBe('150%')
    expect(harness.getAnnouncementValue()).toBe('150%')
  })

  it('respects reduced-motion preference and commits target immediately without scheduling frames', async () => {
    reducedMotionActive = true
    const harness = await mountAnimatedNumber({ value: 42, duration: 600 })

    // Zero animation frames scheduled
    expect(scheduledFrames.length).toBe(0)
    // Both display and announcement update immediately
    expect(harness.getDisplayValue()).toBe('42')
    expect(harness.getAnnouncementValue()).toBe('42')
  })

  it('commits target when reduced-motion changes dynamically', async () => {
    const harness = await mountAnimatedNumber({ value: 300, duration: 1000 })
    expect(scheduledFrames.length).toBe(1)

    // User enables prefers-reduced-motion during animation
    reducedMotionActive = true
    for (const listener of mediaQueryChangeListeners) {
      listener({ matches: true })
    }
    await Vue.nextTick()

    expect(cancelledFrameIds.length).toBeGreaterThan(0)
    expect(scheduledFrames.length).toBe(0)
    expect(harness.getDisplayValue()).toBe('300')
    expect(harness.getAnnouncementValue()).toBe('300')
  })

  it('commits target immediately when duration is 0 or target equals current rendered value', async () => {
    const harness = await mountAnimatedNumber({ value: 25, duration: 0 })
    expect(scheduledFrames.length).toBe(0)
    expect(harness.getDisplayValue()).toBe('25')

    // Setting same value again should not schedule any frame
    harness.propsRef.value = 25
    await Vue.nextTick()
    expect(scheduledFrames.length).toBe(0)
  })
})
