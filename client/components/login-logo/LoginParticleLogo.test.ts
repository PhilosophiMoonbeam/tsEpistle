import fs from 'node:fs'
import path from 'node:path'

import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it } from '../../../server/test/bun-test.mts'
import type { LogoEffectDescriptor } from './particle-logo.ts'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/login'
})
const browserWindow = dom.window

interface RectInit {
  left: number
  top: number
  width: number
  height: number
}

interface Environment {
  width: number
  height: number
  hover: boolean
  finePointer: boolean
  reducedMotion: boolean
  card: RectInit
}

let environment: Environment
let pageVisibility: DocumentVisibilityState

interface SceneControls {
  firstFrame: () => void
  error: () => void
  contextLost: () => void
  tick: () => void
}

interface PendingFetch {
  readonly url: string
  readonly signal: AbortSignal | null
  readonly credentials: RequestCredentials | undefined
  resolve: (response: Response) => void
  reject: (reason: unknown) => void
}

const idleCallbacks = new Map<number, () => void>()
const deadlineCallbacks = new Map<number, () => void>()
const pendingFetches: PendingFetch[] = []
const sceneControls: SceneControls[] = []
const resourceEvents: string[] = []
let sceneFrameCallbacks = 0
let animationFrameRequests = 0
let pointerListenerAdds = 0
const nativeWindowSetTimeout = browserWindow.setTimeout.bind(browserWindow)
const nativeWindowClearTimeout = browserWindow.clearTimeout.bind(browserWindow)
const nativeRequestAnimationFrame = browserWindow.requestAnimationFrame.bind(browserWindow)
let nextIdleHandle = 1
let nextDeadlineHandle = 1_000_000

const requestIdleCallback = (callback: () => void): number => {
  const handle = nextIdleHandle
  nextIdleHandle += 1
  idleCallbacks.set(handle, callback)
  return handle
}
const cancelIdleCallback = (handle: number): void => {
  idleCallbacks.delete(handle)
}
const setTimeoutStub = ((handler: TimerHandler, timeout?: number): number => {
  if (timeout !== 1_500 || typeof handler !== 'function') return nativeWindowSetTimeout(handler, timeout)
  const handle = nextDeadlineHandle
  nextDeadlineHandle += 1
  deadlineCallbacks.set(handle, () => {
    deadlineCallbacks.delete(handle)
    handler()
  })
  return handle
}) as typeof browserWindow.setTimeout
const clearTimeoutStub = (handle: number): void => {
  if (!deadlineCallbacks.delete(handle)) nativeWindowClearTimeout(handle)
}
const requestAnimationFrameStub = (callback: FrameRequestCallback): number => {
  animationFrameRequests += 1
  return nativeRequestAnimationFrame(callback)
}
const fetchStub = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  resourceEvents.push('fetch')
  const { promise, resolve, reject } = Promise.withResolvers<Response>()
  const request: PendingFetch = {
    url: String(input),
    credentials: init?.credentials,
    signal: init?.signal ?? null,
    resolve,
    reject
  }
  pendingFetches.push(request)
  init?.signal?.addEventListener('abort', () => reject(new browserWindow.DOMException('Aborted', 'AbortError')), { once: true })
  return promise
}) as typeof fetch

const sceneTestBridge = {
  moduleLoaded: (): void => {
    resourceEvents.push('loader')
  },
  tornDown: (): void => {
    resourceEvents.push('scene-teardown')
  },
  mounted: (controls: SceneControls): void => {
    sceneControls.push(controls)
  },
  frame: (): void => {
    sceneFrameCallbacks += 1
  }
}
Object.defineProperty(globalThis, '__loginLogoSceneTestBridge', {
  configurable: true,
  value: sceneTestBridge
})

const rect = ({ left, top, width, height }: RectInit): DOMRect =>
  ({
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({ left, top, width, height })
  }) as DOMRect

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = []
  readonly targets = new Set<Element>()
  disconnected = false

  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverStub.instances.push(this)
  }

  observe(target: Element): void {
    this.targets.add(target)
  }

  unobserve(target: Element): void {
    this.targets.delete(target)
  }

  disconnect(): void {
    this.disconnected = true
    this.targets.clear()
  }

  emit(): void {
    const entries = [...this.targets].map(target => ({
      target,
      contentRect: target.getBoundingClientRect()
    })) as ResizeObserverEntry[]
    this.callback(entries, this as unknown as ResizeObserver)
  }
}

class IntersectionObserverStub {
  static instances: IntersectionObserverStub[] = []
  readonly targets = new Set<Element>()
  disconnected = false

  constructor(private readonly callback: IntersectionObserverCallback) {
    IntersectionObserverStub.instances.push(this)
  }

  observe(target: Element): void {
    this.targets.add(target)
  }

  unobserve(target: Element): void {
    this.targets.delete(target)
  }

  disconnect(): void {
    this.disconnected = true
    this.targets.clear()
  }

  emit(isIntersecting = true): void {
    const entries = [...this.targets].map(target => ({
      target,
      isIntersecting,
      intersectionRatio: isIntersecting ? 1 : 0,
      boundingClientRect: target.getBoundingClientRect()
    })) as IntersectionObserverEntry[]
    this.callback(entries, this as unknown as IntersectionObserver)
  }
}

class MediaQueryListStub {
  readonly listeners = new Set<(event: MediaQueryListEvent) => void>()

  constructor(readonly media: string) {}

  get matches(): boolean {
    const minWidth = this.media.match(/min-width:\s*(\d+)px/)?.[1]
    const minHeight = this.media.match(/min-height:\s*(\d+)px/)?.[1]
    if (minWidth && environment.width < Number(minWidth)) return false
    if (minHeight && environment.height < Number(minHeight)) return false
    if (this.media.includes('hover: hover') && !environment.hover) return false
    if (this.media.includes('pointer: fine') && !environment.finePointer) return false
    if (this.media.includes('prefers-reduced-motion: reduce')) return environment.reducedMotion
    return true
  }

  addEventListener(_type: 'change', listener: (event: MediaQueryListEvent) => void): void {
    this.listeners.add(listener)
  }

  removeEventListener(_type: 'change', listener: (event: MediaQueryListEvent) => void): void {
    this.listeners.delete(listener)
  }

  addListener(listener: (event: MediaQueryListEvent) => void): void {
    this.listeners.add(listener)
  }

  removeListener(listener: (event: MediaQueryListEvent) => void): void {
    this.listeners.delete(listener)
  }

  dispatch(): void {
    const event = { matches: this.matches, media: this.media } as MediaQueryListEvent
    for (const listener of [...this.listeners]) listener(event)
  }
}

const mediaQueries = new Map<string, MediaQueryListStub>()
const matchMedia = (query: string): MediaQueryListStub => {
  let result = mediaQueries.get(query)
  if (!result) {
    result = new MediaQueryListStub(query)
    mediaQueries.set(query, result)
  }
  return result
}

const globalValues: Record<string, unknown> = {
  Element: browserWindow.Element,
  Event: browserWindow.Event,
  HTMLElement: browserWindow.HTMLElement,
  HTMLImageElement: browserWindow.HTMLImageElement,
  fetch: fetchStub,
  cancelAnimationFrame: browserWindow.cancelAnimationFrame.bind(browserWindow),
  IntersectionObserver: IntersectionObserverStub,
  MediaQueryListEvent: browserWindow.Event,
  Node: browserWindow.Node,
  ResizeObserver: ResizeObserverStub,
  SVGElement: browserWindow.SVGElement,
  document: browserWindow.document,
  requestAnimationFrame: requestAnimationFrameStub,
  getComputedStyle: browserWindow.getComputedStyle.bind(browserWindow),
  navigator: browserWindow.navigator,
  window: browserWindow
}
for (const [name, value] of Object.entries(globalValues)) {
  Object.defineProperty(globalThis, name, { configurable: true, value, writable: true })
}
Object.defineProperties(browserWindow, {
  innerWidth: { configurable: true, get: () => environment.width },
  innerHeight: { configurable: true, get: () => environment.height },
  matchMedia: { configurable: true, value: matchMedia },
  requestIdleCallback: { configurable: true, value: requestIdleCallback },
  cancelIdleCallback: { configurable: true, value: cancelIdleCallback },
  requestAnimationFrame: { configurable: true, value: requestAnimationFrameStub },
  setTimeout: { configurable: true, value: setTimeoutStub },
  clearTimeout: { configurable: true, value: clearTimeoutStub },
  IntersectionObserver: { configurable: true, value: IntersectionObserverStub },
  ResizeObserver: { configurable: true, value: ResizeObserverStub }
})
Object.defineProperties(browserWindow.document.documentElement, {
  clientWidth: { configurable: true, get: () => environment.width },
  clientHeight: { configurable: true, get: () => environment.height }
})
Object.defineProperty(browserWindow.document, 'visibilityState', {
  configurable: true,
  get: () => pageVisibility
})

const nativeElementAddEventListener = browserWindow.HTMLElement.prototype.addEventListener
browserWindow.HTMLElement.prototype.addEventListener = function (
  this: HTMLElement,
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions
): void {
  if (type === 'pointermove' || type === 'pointerleave') pointerListenerAdds += 1
  Reflect.apply(nativeElementAddEventListener, this, [type, listener, options])
} as typeof browserWindow.HTMLElement.prototype.addEventListener

const nativeGetBoundingClientRect = browserWindow.HTMLElement.prototype.getBoundingClientRect
browserWindow.HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
  if (this.classList.contains('login')) return rect({ left: 0, top: 0, width: environment.width, height: environment.height })
  if (this.classList.contains('login-sd')) return rect(environment.card)

  const field = this.closest<HTMLElement>('.login-particle-logo')
  if (field) {
    const value = (property: 'left' | 'top' | 'width' | 'height', variable: string): number => {
      const inlineValue = Number.parseFloat(field.style[property])
      return Number.isFinite(inlineValue) ? inlineValue : Number.parseFloat(field.style.getPropertyValue(variable))
    }
    const fieldLeft = value('left', '--login-logo-left')
    const fieldTop = value('top', '--login-logo-top')
    const fieldWidth = value('width', '--login-logo-width')
    const fieldHeight = value('height', '--login-logo-height')
    if (this === field && [fieldLeft, fieldTop, fieldWidth, fieldHeight].every(Number.isFinite)) {
      return rect({ left: fieldLeft, top: fieldTop, width: fieldWidth, height: fieldHeight })
    }
    if (this.classList.contains('login-particle-logo__image')) {
      const inlineWidth = Number.parseFloat(this.style.width)
      const inlineHeight = Number.parseFloat(this.style.height)
      const width = Number.isFinite(inlineWidth) ? inlineWidth : Number.parseFloat(field.style.getPropertyValue('--login-logo-image-width'))
      const height = Number.isFinite(inlineHeight) ? inlineHeight : Number.parseFloat(field.style.getPropertyValue('--login-logo-image-height'))
      if ([fieldLeft, fieldTop, fieldWidth, fieldHeight, width, height].every(Number.isFinite)) {
        return rect({
          left: fieldLeft + (fieldWidth - width) / 2,
          top: fieldTop + (fieldHeight - height) / 2,
          width,
          height
        })
      }
    }
  }
  return nativeGetBoundingClientRect.call(this)
}

// Vue stays dynamic so runtime-dom captures the JSDOM document initialized above.
const Vue = await import('vue')

const componentPath = path.join(process.cwd(), 'client/components/login-logo/LoginParticleLogo.vue')
const componentSource = fs.readFileSync(componentPath, 'utf8')
const parsed = parse(componentSource, { filename: componentPath })
if (parsed.errors.length > 0) throw new Error(`Could not parse LoginParticleLogo.vue: ${parsed.errors.join(', ')}`)
if (!parsed.descriptor.script || parsed.descriptor.scriptSetup || !parsed.descriptor.template) {
  throw new Error('LoginParticleLogo.vue ordinary script or template was not found')
}
const componentId = 'login-particle-logo-behavior-test'
const compiledScript = compileScript(parsed.descriptor, {
  id: componentId,
  genDefaultAs: '__sfc__'
})
const compiledTemplate = compileTemplate({
  source: parsed.descriptor.template.content,
  filename: componentPath,
  id: componentId,
  preprocessLang: parsed.descriptor.template.lang,
  preprocessOptions: { doctype: 'html' },
  transformAssetUrls: false,
  compilerOptions: {
    bindingMetadata: compiledScript.bindings,
    expressionPlugins: ['typescript']
  }
})
if (compiledTemplate.errors.length > 0) {
  throw new Error(`Could not compile LoginParticleLogo.vue template: ${compiledTemplate.errors.join(', ')}`)
}
const compiledComponent = `${compiledScript.content}
${compiledTemplate.code}
__sfc__.render = render
export default __sfc__
`
const sceneStubSource = `
import { defineComponent, h, onBeforeUnmount, onMounted } from 'vue'

const bridge = globalThis.__loginLogoSceneTestBridge
bridge.moduleLoaded()

export default defineComponent({
  name: 'LogoParticleSceneTestStub',
  props: {
    effect: { type: Object, required: true },
    particles: { type: Object, required: true },
    active: { type: Boolean, required: true }
  },
  emits: ['first-frame', 'error', 'context-lost'],
  setup (props, { emit, expose }) {
    let tornDown = false
    const teardown = () => {
      if (tornDown) return
      tornDown = true
      bridge.tornDown()
    }
    expose({ teardown })
    onBeforeUnmount(teardown)
    onMounted(() => bridge.mounted({
      firstFrame: () => emit('first-frame'),
      error: () => emit('error'),
      contextLost: () => emit('context-lost'),
      tick: () => {
        if (props.active && !tornDown) bridge.frame()
      }
    }))
    return () => h('canvas', {
      class: 'login-particle-logo__scene-stub',
      'data-active': String(props.active)
    })
  }
})
`
const bundle = await Bun.build({
  entrypoints: ['virtual:LoginParticleLogo.vue'],
  external: ['vue'],
  format: 'cjs',
  plugins: [
    {
      name: 'login-particle-logo-test-sfc',
      setup(build) {
        build.onResolve({ filter: /^virtual:LoginParticleLogo\.vue$/ }, () => ({
          path: componentPath
        }))
        build.onResolve({ filter: /^\.\/LogoParticleScene\.vue$/ }, () => ({
          namespace: 'login-particle-logo-test-scene',
          path: 'LogoParticleScene.vue'
        }))
        build.onLoad({ filter: /.*/, namespace: 'login-particle-logo-test-scene' }, () => ({
          contents: sceneStubSource,
          loader: 'ts'
        }))
        build.onLoad({ filter: /LoginParticleLogo\.vue$/, namespace: 'file' }, () => ({
          contents: compiledComponent,
          loader: 'ts',
          resolveDir: path.dirname(componentPath)
        }))
        build.onResolve({ filter: /\.(?:css|scss)$/ }, args => ({
          namespace: 'login-particle-logo-test-style',
          path: args.path
        }))
        build.onLoad({ filter: /.*/, namespace: 'login-particle-logo-test-style' }, () => ({
          contents: '',
          loader: 'js'
        }))
      }
    }
  ],
  target: 'bun'
})
if (!bundle.success || bundle.outputs.length !== 1) {
  throw new Error(`Could not bundle LoginParticleLogo.vue: ${bundle.logs.map(log => log.message).join(', ')}`)
}
const bundleCode = await bundle.outputs[0].text()
const moduleStart = bundleCode.indexOf('(function(')
if (moduleStart < 0) throw new Error('Compiled LoginParticleLogo.vue did not produce a CommonJS module')
interface CompiledModule {
  exports: { default?: object }
}
const moduleFactory = new Function(`return ${bundleCode.slice(moduleStart)}`)() as (
  exports: CompiledModule['exports'],
  require: (specifier: string) => unknown,
  module: CompiledModule,
  filename: string,
  dirname: string
) => void
const compiledModule: CompiledModule = { exports: {} }
moduleFactory(
  compiledModule.exports,
  specifier => {
    if (specifier === 'vue') return Vue
    throw new Error(`Unexpected import in LoginParticleLogo.vue: ${specifier}`)
  },
  compiledModule,
  componentPath,
  path.dirname(componentPath)
)
const LoginParticleLogo = compiledModule.exports.default
if (!LoginParticleLogo) throw new Error('LoginParticleLogo.vue did not export a component')

const managedEffect: LogoEffectDescriptor = {
  pipelineVersion: 5,
  logoUrl: '/_site-logo/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/logo.png',
  particleUrl: '/_site-logo/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/particle.bin',
  staticUrl: '/_site-logo/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc/effect.png',
  width: 1200,
  height: 300,
  aspect: 4,
  count: 5000,
  medianStroke: 12,
  auraColor: '#336699'
}

interface MountedLogo {
  host: HTMLElement
  unmount: () => void
  setEffect: (effect: LogoEffectDescriptor | null) => Promise<void>
}

const particleEffect: LogoEffectDescriptor = {
  ...managedEffect,
  particleUrl: '/_site-logo/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/particle.bin',
  staticUrl: '/_site-logo/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee/effect.png',
  width: 8,
  height: 8,
  aspect: 1,
  count: 2,
  medianStroke: 2
}
const particleFixture = Uint8Array.from(
  Buffer.from(
    '545345500107380008000000080000000200000018000000cf8f46fd3800000040000000420000004a0000004c000000500000000000000025c94912db36b7eded4ddc283cc81e6edca05578d20431d4',
    'hex'
  )
)

const mountedApps: Array<() => void> = []

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn += 1) await Vue.nextTick()
}

const mountLogo = async (initialEffect: LogoEffectDescriptor | null = managedEffect): Promise<MountedLogo> => {
  const effect = Vue.shallowRef<LogoEffectDescriptor | null>(initialEffect)
  const root = Vue.defineComponent({
    name: 'LoginParticleLogoBehaviorHarness',
    setup: () => () =>
      Vue.h('div', { class: 'login' }, [
        Vue.h('main', { class: 'login-sd' }, [
          Vue.h('div', { class: 'login-brand' }, [Vue.h('img', { src: managedEffect.logoUrl, alt: '' })]),
          Vue.h('form', { class: 'login-form' }, [Vue.h('input', { name: 'username' })])
        ]),
        Vue.h(LoginParticleLogo, { effect: effect.value })
      ])
  })
  const host = document.createElement('div')
  document.body.append(host)
  const app = Vue.createApp(root)
  app.mount(host)
  await settle()
  for (const observer of IntersectionObserverStub.instances) observer.emit()
  await settle()

  for (const observer of ResizeObserverStub.instances) observer.emit()
  await settle()
  const unmount = (): void => {
    app.unmount()
    host.remove()
  }
  mountedApps.push(unmount)
  return {
    host,
    unmount,
    setEffect: async value => {
      effect.value = value
      await settle()
    }
  }
}

const updateEnvironment = async (changes: Partial<Environment>): Promise<void> => {
  Object.assign(environment, changes)
  for (const query of mediaQueries.values()) query.dispatch()
  for (const observer of ResizeObserverStub.instances) observer.emit()
  for (const observer of IntersectionObserverStub.instances) observer.emit()
  await settle()
}

const setPageVisibility = async (visibility: DocumentVisibilityState): Promise<void> => {
  pageVisibility = visibility
  document.dispatchEvent(new browserWindow.Event('visibilitychange'))
  await settle()
}

const setSurfaceVisibility = async (visible: boolean): Promise<void> => {
  for (const observer of IntersectionObserverStub.instances) observer.emit(visible)
  await settle()
}

const logoField = (host: ParentNode): HTMLElement | null => host.querySelector<HTMLElement>('.login-particle-logo')
const staticImage = (host: ParentNode): HTMLImageElement | null => logoField(host)?.querySelector<HTMLImageElement>('img') ?? null

const loadStaticRendition = async (mounted: MountedLogo, effect: LogoEffectDescriptor): Promise<HTMLImageElement> => {
  const image = staticImage(mounted.host)
  if (!image) throw new Error('Static particle-logo rendition was not mounted')
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: effect.width },
    naturalHeight: { configurable: true, value: effect.height }
  })
  resourceEvents.push('static')
  image.dispatchEvent(new browserWindow.Event('load'))
  await settle()
  return image
}

const runIdleWork = async (): Promise<void> => {
  const callbacks = [...idleCallbacks.values()]
  idleCallbacks.clear()
  for (const callback of callbacks) {
    resourceEvents.push('idle')
    callback()
  }
  await settle()
}

const renderedRect = (element: HTMLElement): DOMRect => element.getBoundingClientRect()
const intersects = (first: DOMRect, second: DOMRect): boolean =>
  first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top

beforeEach(() => {
  environment = {
    width: 1440,
    height: 900,
    hover: true,
    finePointer: true,
    reducedMotion: false,
    card: { left: 86, top: 120, width: 480, height: 660 }
  }
  pageVisibility = 'visible'
  idleCallbacks.clear()
  pendingFetches.length = 0
  sceneControls.length = 0
  deadlineCallbacks.clear()
  resourceEvents.length = 0
  sceneFrameCallbacks = 0
  animationFrameRequests = 0
  pointerListenerAdds = 0
  nextIdleHandle = 1
  mediaQueries.clear()
  ResizeObserverStub.instances.length = 0
  nextDeadlineHandle = 1_000_000
  document.body.replaceChildren()
  IntersectionObserverStub.instances.length = 0
})

afterEach(() => {
  for (const unmount of mountedApps.splice(0)) unmount()
  document.body.replaceChildren()
})

describe('LoginParticleLogo static behavior', () => {
  it('renders a valid descriptor whose logo, particle, and static assets have independent content digests', async () => {
    const mounted = await mountLogo()
    const field = logoField(mounted.host)
    const image = staticImage(mounted.host)
    if (!field || !image) throw new Error('Independent managed asset renditions were not accepted')

    expect(image.getAttribute('src')).toBe(managedEffect.staticUrl)
    expect(image.getAttribute('src')).not.toBe(managedEffect.logoUrl)
    expect(image.getAttribute('src')).not.toBe(managedEffect.particleUrl)
  })

  it('omits the field without a managed effect and at every hard media or measured-space gate', async () => {
    const absent = await mountLogo(null)
    expect(logoField(absent.host)).toBeNull()
    absent.unmount()
    mountedApps.pop()

    const mounted = await mountLogo()
    expect(logoField(mounted.host)).not.toBeNull()

    await updateEnvironment({ width: 959 })
    expect(logoField(mounted.host)).toBeNull()
    await updateEnvironment({ width: 1440, height: 650 })
    expect(logoField(mounted.host)).toBeNull()
    await updateEnvironment({ height: 900, hover: false, finePointer: false })
    expect(logoField(mounted.host)).toBeNull()
    await updateEnvironment({ hover: true, finePointer: true, card: { left: 86, top: 40, width: 1330, height: 820 } })
    expect(logoField(mounted.host)).toBeNull()

    await updateEnvironment({ card: { left: 86, top: 120, width: 480, height: 660 } })
    expect(logoField(mounted.host)).not.toBeNull()
  })

  it('contains arbitrary aspect ratios in measured free space with clearance and no card overlap', async () => {
    for (const effect of [
      { ...managedEffect, width: 1200, height: 300, aspect: 4 },
      { ...managedEffect, width: 240, height: 960, aspect: 0.25 }
    ]) {
      const mounted = await mountLogo(effect)
      const field = logoField(mounted.host)
      const image = staticImage(mounted.host)
      if (!field || !image) throw new Error('Eligible personalized static logo was not rendered')
      Object.defineProperties(image, {
        naturalWidth: { configurable: true, value: effect.width },
        naturalHeight: { configurable: true, value: effect.height }
      })

      image.dispatchEvent(new browserWindow.Event('load'))
      await settle()
      const fieldBounds = renderedRect(field)
      const imageBounds = renderedRect(image)
      const cardBounds = rect(environment.card)

      expect(intersects(fieldBounds, cardBounds)).toBe(false)
      expect(intersects(imageBounds, cardBounds)).toBe(false)
      expect(imageBounds.width / imageBounds.height).toBeCloseTo(effect.aspect, 2)
      expect(imageBounds.left - fieldBounds.left).toBeGreaterThanOrEqual(imageBounds.width * 0.08)
      expect(fieldBounds.right - imageBounds.right).toBeGreaterThanOrEqual(imageBounds.width * 0.08)
      expect(imageBounds.top - fieldBounds.top).toBeGreaterThanOrEqual(imageBounds.height * 0.08)
      expect(fieldBounds.bottom - imageBounds.bottom).toBeGreaterThanOrEqual(imageBounds.height * 0.08)
      expect(fieldBounds.left).toBeGreaterThanOrEqual(0)
      expect(fieldBounds.top).toBeGreaterThanOrEqual(0)
      expect(fieldBounds.right).toBeLessThanOrEqual(environment.width)
      expect(fieldBounds.bottom).toBeLessThanOrEqual(environment.height)

      mounted.unmount()
      mountedApps.pop()
    }
  })

  it('keeps the personalized static rendition visible for reduced motion and falls back to the ordinary logo on image failure', async () => {
    environment.reducedMotion = true
    const mounted = await mountLogo()
    const image = staticImage(mounted.host)
    if (!image) throw new Error('Reduced-motion desktop omitted the personalized static logo')

    expect(image.src).toBe(new URL(managedEffect.staticUrl, browserWindow.location.href).href)
    expect(image.hidden).toBe(false)
    expect(image.getAttribute('src')).not.toBe(managedEffect.logoUrl)
    expect(image.getAttribute('src')).not.toBe(managedEffect.particleUrl)

    image.dispatchEvent(new browserWindow.Event('error'))
    await settle()

    const failedImage = staticImage(mounted.host)
    expect(failedImage === null || failedImage.hidden || failedImage.style.display === 'none').toBe(true)
    const ordinaryLogo = mounted.host.querySelector<HTMLImageElement>('.login-brand img')
    expect(ordinaryLogo?.getAttribute('src')).toBe(managedEffect.logoUrl)
  })

  it('accepts only a safe source-derived aura and caps its rendered contribution at eight percent', async () => {
    const mounted = await mountLogo()
    const field = logoField(mounted.host)
    if (!field) throw new Error('Eligible personalized static logo was not rendered')
    const login = mounted.host.querySelector<HTMLElement>('.login')
    if (!login) throw new Error('Login surface was not rendered')
    expect(login.style.getPropertyValue('--login-logo-aura')).toBe('rgb(51 102 153 / 8%)')

    await mounted.setEffect({ ...managedEffect, auraColor: 'red; background: url(https://example.test/tracker)' })
    expect(logoField(mounted.host)).toBeNull()
    expect(login.style.getPropertyValue('--login-logo-aura')).toBe('')

    await mounted.setEffect({
      pipelineVersion: managedEffect.pipelineVersion,
      logoUrl: managedEffect.logoUrl,
      particleUrl: managedEffect.particleUrl,
      staticUrl: managedEffect.staticUrl,
      width: managedEffect.width,
      height: managedEffect.height,
      aspect: managedEffect.aspect,
      count: managedEffect.count,
      medianStroke: managedEffect.medianStroke
    })
    expect(logoField(mounted.host)).not.toBeNull()
    expect(login.style.getPropertyValue('--login-logo-aura')).toBe('transparent')
  })

  it('is decorative, unfocusable, and does not interfere with ordinary authentication controls', async () => {
    const mounted = await mountLogo()
    const field = logoField(mounted.host)
    const image = staticImage(mounted.host)
    const input = mounted.host.querySelector<HTMLInputElement>('input[name="username"]')
    if (!field || !image || !input) throw new Error('Expected login DOM was not rendered')

    expect(field.getAttribute('aria-hidden')).toBe('true')
    expect(image.getAttribute('aria-hidden')).toBe('true')
    expect(image.getAttribute('alt')).toBe('')
    expect(field.getAttribute('role')).toBeNull()
    expect(field.getAttribute('aria-live')).toBeNull()
    expect(field.getAttribute('title')).toBeNull()
    expect(field.querySelector('[tabindex], button, input, select, textarea, a[href]')).toBeNull()

    input.focus()
    field.dispatchEvent(new browserWindow.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    field.dispatchEvent(new browserWindow.MouseEvent('click', { bubbles: true }))
    expect(document.activeElement).toBe(input)
  })

  it('disconnects every layout observer and media listener on unmount', async () => {
    const mounted = await mountLogo()
    expect(ResizeObserverStub.instances.length).toBeGreaterThan(0)
    expect(ResizeObserverStub.instances.some(observer => observer.targets.size > 0)).toBe(true)
    expect(IntersectionObserverStub.instances.length).toBeGreaterThan(0)
    expect(IntersectionObserverStub.instances.some(observer => observer.targets.size > 0)).toBe(true)
    expect([...mediaQueries.values()].some(query => query.listeners.size > 0)).toBe(true)

    mounted.unmount()
    mountedApps.pop()

    for (const observer of [...ResizeObserverStub.instances, ...IntersectionObserverStub.instances]) {
      expect(observer.disconnected).toBe(true)
      expect(observer.targets.size).toBe(0)
    }
    for (const query of mediaQueries.values()) expect(query.listeners.size).toBe(0)
  })
})

describe('LoginParticleLogo lazy particle enhancement', () => {
  it('keeps a narrow desktop field static while allocating zero renderer resources below the animation-size threshold', async () => {
    environment.width = 960
    environment.card = { left: 86, top: 120, width: 800, height: 660 }
    const mounted = await mountLogo(particleEffect)
    const field = logoField(mounted.host)
    if (!field) throw new Error('Positive non-overlapping logo field was not laid out')

    const image = await loadStaticRendition(mounted, particleEffect)
    const fieldBounds = renderedRect(field)
    const imageBounds = renderedRect(image)
    expect(fieldBounds.height).toBeGreaterThan(fieldBounds.width)
    expect(intersects(fieldBounds, rect(environment.card))).toBe(false)
    expect(Math.max(imageBounds.width, imageBounds.height)).toBeLessThan(256)
    expect(Math.min(imageBounds.width, imageBounds.height)).toBeLessThan(48)

    await runIdleWork()
    expect(image.getAttribute('src')).toBe(particleEffect.staticUrl)
    expect(image.style.opacity).toBe('1')
    expect(mounted.host.querySelector('canvas')).toBeNull()
    expect(idleCallbacks.size).toBe(0)
    expect(deadlineCallbacks.size).toBe(0)
    expect(pendingFetches).toHaveLength(0)
    expect(sceneControls).toHaveLength(0)
    expect(sceneFrameCallbacks).toBe(0)
    expect(animationFrameRequests).toBe(0)
    expect(pointerListenerAdds).toBe(0)
    expect(resourceEvents).toEqual(['static'])
  })

  it('shows personalized static output with a zero-ever enhancement trace when reduced motion is set before mount', async () => {
    environment.reducedMotion = true
    const mounted = await mountLogo(particleEffect)
    const image = await loadStaticRendition(mounted, particleEffect)
    await runIdleWork()

    expect(image.style.opacity).toBe('1')
    expect(mounted.host.querySelector('canvas')).toBeNull()
    expect(idleCallbacks.size).toBe(0)
    expect(deadlineCallbacks.size).toBe(0)
    expect(pendingFetches).toHaveLength(0)
    expect(sceneControls).toHaveLength(0)
    expect(sceneFrameCallbacks).toBe(0)
    expect(animationFrameRequests).toBe(0)
    expect(pointerListenerAdds).toBe(0)
    expect(resourceEvents).toEqual(['static'])

    await updateEnvironment({ reducedMotion: false })
    await runIdleWork()
    expect(mounted.host.querySelector('canvas')).toBeNull()
    expect(idleCallbacks.size).toBe(0)
    expect(pendingFetches).toHaveLength(0)
    expect(animationFrameRequests).toBe(0)
    expect(pointerListenerAdds).toBe(0)
    expect(resourceEvents).toEqual(['static'])
  })

  it('allocates no enhancement resources without an effect or after a hard eligibility loss', async () => {
    const staticOnly = await mountLogo(null)
    await runIdleWork()
    expect(pendingFetches).toHaveLength(0)
    expect(resourceEvents).toEqual([])
    staticOnly.unmount()
    mountedApps.pop()

    const gated = await mountLogo(particleEffect)
    await loadStaticRendition(gated, particleEffect)
    expect(idleCallbacks.size).toBe(1)
    await updateEnvironment({ width: 959 })
    expect(idleCallbacks.size).toBe(0)
    await runIdleWork()
    expect(pendingFetches).toHaveLength(0)
    expect(gated.host.querySelector('canvas')).toBeNull()
  })

  it('waits for a valid static rendition and idle time before loading, then crossfades only after the first frame', async () => {
    const mounted = await mountLogo(particleEffect)
    expect(idleCallbacks.size).toBe(0)
    expect(pendingFetches).toHaveLength(0)

    const image = await loadStaticRendition(mounted, particleEffect)
    expect(image.style.opacity).toBe('1')
    expect(resourceEvents).toEqual(['static'])
    expect(pendingFetches).toHaveLength(0)

    await runIdleWork()
    expect(resourceEvents).toEqual(['static', 'idle', 'loader', 'fetch'])
    expect(pendingFetches).toHaveLength(1)
    expect(deadlineCallbacks.size).toBe(1)
    expect(pendingFetches[0]?.url).toBe(particleEffect.particleUrl)
    expect(pendingFetches[0]?.credentials).toBe('omit')

    pendingFetches[0]?.resolve(new Response(particleFixture))
    await settle()
    const scene = mounted.host.querySelector<HTMLElement>('.login-particle-logo__scene-stub')
    expect(scene).not.toBeNull()
    expect(scene?.style.zIndex).toBe('0')
    expect(scene?.dataset.active).toBe('true')
    expect(sceneControls).toHaveLength(1)
    expect(staticImage(mounted.host)?.style.zIndex).toBe('1')
    expect(staticImage(mounted.host)?.style.opacity).toBe('1')

    sceneControls[0]?.firstFrame()
    await settle()
    expect(deadlineCallbacks.size).toBe(0)
    expect(staticImage(mounted.host)?.style.opacity).toBe('0')
  })

  it('retains one inert canvas while hidden or offscreen, resumes it, and tears it down once only at a hard gate', async () => {
    const mounted = await mountLogo(particleEffect)
    await loadStaticRendition(mounted, particleEffect)
    await runIdleWork()
    pendingFetches[0]?.resolve(new Response(particleFixture))
    await settle()
    sceneControls[0]?.firstFrame()
    await settle()

    const scene = mounted.host.querySelector<HTMLCanvasElement>('.login-particle-logo__scene-stub')
    const controls = sceneControls[0]
    const resourceTrace = [...resourceEvents]
    if (!scene || !controls) throw new Error('Ready particle scene did not mount')
    controls.tick()
    expect(sceneFrameCallbacks).toBe(1)

    await setPageVisibility('hidden')
    controls.tick()
    expect(mounted.host.querySelector('canvas.login-particle-logo__scene-stub')).toBe(scene)
    expect(scene.dataset.active).toBe('false')
    expect(sceneFrameCallbacks).toBe(1)
    expect(sceneControls).toEqual([controls])
    expect(resourceEvents).toEqual(resourceTrace)

    await setPageVisibility('visible')
    controls.tick()
    expect(mounted.host.querySelector('canvas.login-particle-logo__scene-stub')).toBe(scene)
    expect(scene.dataset.active).toBe('true')
    expect(sceneFrameCallbacks).toBe(2)
    expect(sceneControls).toEqual([controls])
    expect(resourceEvents).toEqual(resourceTrace)

    await setSurfaceVisibility(false)
    controls.tick()
    expect(mounted.host.querySelector('canvas.login-particle-logo__scene-stub')).toBe(scene)
    expect(scene.dataset.active).toBe('false')
    expect(sceneFrameCallbacks).toBe(2)
    expect(sceneControls).toEqual([controls])
    expect(resourceEvents).toEqual(resourceTrace)

    await setSurfaceVisibility(true)
    controls.tick()
    expect(mounted.host.querySelector('canvas.login-particle-logo__scene-stub')).toBe(scene)
    expect(scene.dataset.active).toBe('true')
    expect(sceneFrameCallbacks).toBe(3)
    expect(sceneControls).toEqual([controls])
    expect(resourceEvents).toEqual(resourceTrace)

    await updateEnvironment({ width: 959 })
    controls.tick()
    expect(logoField(mounted.host)).toBeNull()
    expect(scene.isConnected).toBe(false)
    expect(sceneFrameCallbacks).toBe(3)
    expect(resourceEvents).toEqual([...resourceTrace, 'scene-teardown'])
  })

  it('cancels pre-ready activity work and fences its late fetch and deadline completions', async () => {
    const mounted = await mountLogo(particleEffect)
    await loadStaticRendition(mounted, particleEffect)
    expect(idleCallbacks.size).toBe(1)

    await setPageVisibility('hidden')
    expect(idleCallbacks.size).toBe(0)
    expect(deadlineCallbacks.size).toBe(0)
    expect(resourceEvents).toEqual(['static'])

    await setPageVisibility('visible')
    await runIdleWork()
    const request = pendingFetches[0]
    const staleDeadline = [...deadlineCallbacks.values()][0]
    if (!request || !staleDeadline) throw new Error('Visible particle epoch did not start')

    await setSurfaceVisibility(false)
    expect(request.signal?.aborted).toBe(true)
    expect(deadlineCallbacks.size).toBe(0)
    staleDeadline()
    request.resolve(new Response(particleFixture))
    await settle()
    expect(mounted.host.querySelector('.login-particle-logo__scene-stub')).toBeNull()
    expect(staticImage(mounted.host)?.style.opacity).toBe('1')

    await setSurfaceVisibility(true)
    expect(idleCallbacks.size).toBe(1)
  })

  it('latches runtime reduced motion, aborts work, and never imports again when preference returns', async () => {
    const mounted = await mountLogo(particleEffect)
    const input = mounted.host.querySelector<HTMLInputElement>('input[name="username"]')
    if (!input) throw new Error('Authentication input did not mount')
    input.value = 'kept-user'
    input.focus()

    await loadStaticRendition(mounted, particleEffect)
    await runIdleWork()
    const request = pendingFetches[0]
    const staleDeadline = [...deadlineCallbacks.values()][0]
    if (!request || !staleDeadline) throw new Error('Particle request did not start')
    const resourceTrace = [...resourceEvents]

    const reduction = updateEnvironment({ reducedMotion: true })
    expect(request.signal?.aborted).toBe(true)
    expect(deadlineCallbacks.size).toBe(0)
    await reduction
    expect(deadlineCallbacks.size).toBe(0)
    expect(mounted.host.querySelector('.login-particle-logo__scene-stub')).toBeNull()
    expect(staticImage(mounted.host)?.style.opacity).toBe('1')

    staleDeadline()
    request.resolve(new Response(particleFixture))
    await settle()
    await updateEnvironment({ reducedMotion: false })
    await runIdleWork()
    expect(idleCallbacks.size).toBe(0)
    expect(pendingFetches).toHaveLength(1)
    expect(resourceEvents).toEqual(resourceTrace)
    expect(mounted.host.querySelector('.login-particle-logo__scene-stub')).toBeNull()
    expect(mounted.host.querySelector('input[name="username"]')).toBe(input)
    expect(input.value).toBe('kept-user')
    expect(document.activeElement).toBe(input)
  })

  it('synchronously restores static output, tears down once, and has Vue disconnect the scene before reduced-motion dispatch returns', async () => {
    const mounted = await mountLogo(particleEffect)
    await loadStaticRendition(mounted, particleEffect)
    await runIdleWork()
    pendingFetches[0]?.resolve(new Response(particleFixture))
    await settle()
    const controls = sceneControls[0]
    const scene = mounted.host.querySelector<HTMLElement>('.login-particle-logo__scene-stub')
    if (!controls || !scene) throw new Error('Particle scene did not mount')
    controls.firstFrame()
    await settle()
    expect(staticImage(mounted.host)?.style.opacity).toBe('0')
    const resourceTrace = [...resourceEvents]

    environment.reducedMotion = true
    for (const query of mediaQueries.values()) query.dispatch()
    expect(staticImage(mounted.host)?.style.opacity).toBe('1')
    expect(scene.isConnected).toBe(false)
    expect(resourceEvents).toEqual([...resourceTrace, 'scene-teardown'])

    for (const query of mediaQueries.values()) query.dispatch()
    expect(resourceEvents).toEqual([...resourceTrace, 'scene-teardown'])
    controls.firstFrame()
    controls.error()
    controls.contextLost()
    await settle()
    await updateEnvironment({ reducedMotion: false })
    await runIdleWork()
    expect(staticImage(mounted.host)?.style.opacity).toBe('1')
    expect(mounted.host.querySelector('.login-particle-logo__scene-stub')).toBeNull()
    expect(resourceEvents).toEqual([...resourceTrace, 'scene-teardown'])
  })

  it('tears down an epoch that misses the import-to-first-frame wall-clock deadline', async () => {
    const mounted = await mountLogo(particleEffect)
    await loadStaticRendition(mounted, particleEffect)
    await runIdleWork()
    const request = pendingFetches[0]
    const deadline = [...deadlineCallbacks.values()][0]
    if (!request || !deadline) throw new Error('Timed particle epoch did not start')

    deadline()
    await settle()
    expect(request.signal?.aborted).toBe(true)
    expect(deadlineCallbacks.size).toBe(0)
    expect(staticImage(mounted.host)?.style.opacity).toBe('1')
    expect(mounted.host.querySelector('.login-particle-logo__scene-stub')).toBeNull()
  })

  it('aborts stale fetches and ignores events from a retired scene epoch', async () => {
    const mounted = await mountLogo(particleEffect)
    await loadStaticRendition(mounted, particleEffect)
    await runIdleWork()
    pendingFetches[0]?.resolve(new Response(particleFixture))
    await settle()
    const retiredScene = sceneControls[0]
    if (!retiredScene) throw new Error('Initial particle scene did not mount')

    const secondEffect: LogoEffectDescriptor = {
      ...particleEffect,
      particleUrl: '/_site-logo/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff/particle.bin',
      staticUrl: '/_site-logo/1111111111111111111111111111111111111111111111111111111111111111/effect.png'
    }
    await mounted.setEffect(secondEffect)
    retiredScene.firstFrame()
    await settle()
    expect(staticImage(mounted.host)?.style.opacity).toBe('1')
    expect(mounted.host.querySelector('.login-particle-logo__scene-stub')).toBeNull()

    await loadStaticRendition(mounted, secondEffect)
    await runIdleWork()
    const staleFetch = pendingFetches[1]
    if (!staleFetch) throw new Error('Second particle request did not start')

    const thirdEffect: LogoEffectDescriptor = {
      ...particleEffect,
      particleUrl: '/_site-logo/2222222222222222222222222222222222222222222222222222222222222222/particle.bin',
      staticUrl: '/_site-logo/3333333333333333333333333333333333333333333333333333333333333333/effect.png'
    }
    await mounted.setEffect(thirdEffect)
    expect(staleFetch.signal?.aborted).toBe(true)
    staleFetch.resolve(new Response(particleFixture))
    await settle()
    expect(mounted.host.querySelector('.login-particle-logo__scene-stub')).toBeNull()
    expect(staticImage(mounted.host)?.style.opacity).toBe('1')
  })

  it('restores static output after network/parser failures and tears down each context/error scene exactly once', async () => {
    const networkFailure = await mountLogo(particleEffect)
    await loadStaticRendition(networkFailure, particleEffect)
    await runIdleWork()
    pendingFetches[0]?.resolve(new Response(null, { status: 503 }))
    await settle()
    expect(staticImage(networkFailure.host)?.style.opacity).toBe('1')
    expect(networkFailure.host.querySelector('.login-particle-logo__scene-stub')).toBeNull()
    networkFailure.unmount()
    mountedApps.pop()

    pendingFetches.length = 0
    const parserFailure = await mountLogo(particleEffect)
    await loadStaticRendition(parserFailure, particleEffect)
    await runIdleWork()
    pendingFetches[0]?.resolve(new Response(new Uint8Array([1, 2, 3])))
    await settle()
    expect(staticImage(parserFailure.host)?.style.opacity).toBe('1')
    expect(parserFailure.host.querySelector('.login-particle-logo__scene-stub')).toBeNull()
    parserFailure.unmount()
    mountedApps.pop()

    pendingFetches.length = 0
    sceneControls.length = 0
    const runtimeFailure = await mountLogo(particleEffect)
    await loadStaticRendition(runtimeFailure, particleEffect)
    await runIdleWork()
    pendingFetches[0]?.resolve(new Response(particleFixture))
    await settle()
    const contextControls = sceneControls[0]
    if (!contextControls) throw new Error('Context-loss scene did not mount')
    contextControls.firstFrame()
    await settle()
    expect(staticImage(runtimeFailure.host)?.style.opacity).toBe('0')
    const contextTeardowns = resourceEvents.filter(event => event === 'scene-teardown').length

    contextControls.contextLost()
    await settle()
    expect(staticImage(runtimeFailure.host)?.style.opacity).toBe('1')
    expect(runtimeFailure.host.querySelector('.login-particle-logo__scene-stub')).toBeNull()
    expect(resourceEvents.filter(event => event === 'scene-teardown')).toHaveLength(contextTeardowns + 1)
    contextControls.contextLost()
    contextControls.error()
    contextControls.firstFrame()
    await settle()
    runtimeFailure.unmount()
    mountedApps.pop()
    expect(resourceEvents.filter(event => event === 'scene-teardown')).toHaveLength(contextTeardowns + 1)

    pendingFetches.length = 0
    sceneControls.length = 0
    const sceneFailure = await mountLogo(particleEffect)
    await loadStaticRendition(sceneFailure, particleEffect)
    await runIdleWork()
    pendingFetches[0]?.resolve(new Response(particleFixture))
    await settle()
    const errorControls = sceneControls[0]
    if (!errorControls) throw new Error('Renderer-error scene did not mount')
    const errorTeardowns = resourceEvents.filter(event => event === 'scene-teardown').length
    errorControls.error()
    await settle()
    expect(staticImage(sceneFailure.host)?.style.opacity).toBe('1')
    expect(sceneFailure.host.querySelector('.login-particle-logo__scene-stub')).toBeNull()
    expect(resourceEvents.filter(event => event === 'scene-teardown')).toHaveLength(errorTeardowns + 1)
    errorControls.error()
    errorControls.contextLost()
    await settle()
    expect(resourceEvents.filter(event => event === 'scene-teardown')).toHaveLength(errorTeardowns + 1)
  })
})
