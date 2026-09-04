import { JSDOM } from 'jsdom'
import { describe, expect, it } from '../../../server/test/bun-test.mts'
import { compactPointerFalloff, LogoPointerController, logoPointerMotionMetrics } from './useLogoPointer.ts'

const dom = new JSDOM('<!doctype html><html><body><div id="logo"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/login'
})

const pointerEvent = (
  type: 'pointermove' | 'pointerleave',
  values: Partial<Pick<PointerEvent, 'clientX' | 'clientY' | 'isPrimary' | 'pointerType'>> = {}
): Event => {
  const event = new dom.window.Event(type)
  Object.defineProperties(event, {
    clientX: { value: values.clientX ?? 0 },
    clientY: { value: values.clientY ?? 0 },
    isPrimary: { value: values.isPrimary ?? true },
    pointerType: { value: values.pointerType ?? 'mouse' }
  })
  return event
}

const targetWithBounds = (): HTMLElement => {
  const target = dom.window.document.createElement('div')
  target.getBoundingClientRect = () => ({
    bottom: 150,
    height: 100,
    left: 100,
    right: 300,
    top: 50,
    width: 200,
    x: 100,
    y: 50,
    toJSON: () => ({})
  })
  return target
}

const insetCoordinateTarget = (): HTMLElement => {
  const target = dom.window.document.createElement('div')
  target.getBoundingClientRect = () => ({
    bottom: 125,
    height: 50,
    left: 125,
    right: 275,
    top: 75,
    width: 150,
    x: 125,
    y: 75,
    toJSON: () => ({})
  })
  return target
}

describe('logo pointer motion math', () => {
  it('uses a compact smooth falloff with no influence at or beyond its radius', () => {
    expect(compactPointerFalloff(0, 64)).toBe(1)
    expect(compactPointerFalloff(16, 64)).toBeCloseTo(0.84375, 8)
    expect(compactPointerFalloff(32, 64)).toBe(0.5)
    expect(compactPointerFalloff(48, 64)).toBeCloseTo(0.15625, 8)
    expect(compactPointerFalloff(64, 64)).toBe(0)
    expect(compactPointerFalloff(80, 64)).toBe(0)
  })

  it('scales radius from rendered size and displacement from displayed median stroke', () => {
    expect(logoPointerMotionMetrics(8, 256)).toEqual({
      radiusCss: 40.96,
      displacementCss: 2
    })
    expect(logoPointerMotionMetrics(20, 512)).toEqual({
      radiusCss: 80,
      displacementCss: 3
    })
    expect(logoPointerMotionMetrics(64, 1024)).toEqual({
      radiusCss: 80,
      displacementCss: 6
    })
    expect(logoPointerMotionMetrics(1_000_000, 1_000_000)).toEqual({ radiusCss: 80, displacementCss: 6 })
  })

  it('returns to strictly below one percent strength by 800 milliseconds', () => {
    let time = 100
    const target = targetWithBounds()
    const controller = new LogoPointerController({
      hasFinePointer: () => true,
      medianStroke: 12,
      now: () => time
    })
    controller.setTarget(target)
    controller.setCoordinateTarget(target)
    controller.setActive(true)
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 200, clientY: 100 }))

    expect(controller.update(400, time).strength).toBe(1)
    time += 400
    expect(controller.update(400, time).strength).toBeCloseTo(Math.sqrt(0.005), 8)
    time += 400
    expect(controller.update(400, time).strength).toBeCloseTo(0.005, 8)
    expect(controller.state.strength).toBeLessThan(0.01)
    controller.dispose()
  })
})

describe('LogoPointerController bounded input and lifetime', () => {
  it('normalizes primary mouse and pen input and applies bounded geometry against the inset canvas', () => {
    let finePointer = true
    const target = targetWithBounds()
    const coordinateTarget = insetCoordinateTarget()
    const controller = new LogoPointerController({
      hasFinePointer: () => finePointer,
      medianStroke: 10,
      now: () => 10
    })
    controller.setTarget(target)
    controller.setCoordinateTarget(coordinateTarget)
    controller.setActive(true)
    expect(controller.update(400, 10).radiusCss).toBe(64)

    target.dispatchEvent(pointerEvent('pointermove', { clientX: 162.5, clientY: 87.5, pointerType: 'mouse' }))
    expect(controller.state).toMatchObject({ x: -0.5, y: 0.5, strength: 1 })
    const mouseDisplacements = [0, 16, 32, 48, 64, 80].map(
      distance => controller.state.displacementCss * controller.state.strength * compactPointerFalloff(distance, controller.state.radiusCss)
    )
    expect(mouseDisplacements).toEqual([2, 1.6875, 1, 0.3125, 0, 0])

    controller.setActive(false)
    controller.setActive(true)
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 275, clientY: 75, pointerType: 'pen' }))
    expect(controller.state).toMatchObject({ x: 1, y: 1, strength: 1 })
    expect(controller.state.displacementCss * compactPointerFalloff(64, controller.state.radiusCss)).toBe(0)

    controller.setActive(false)
    controller.setActive(true)
    const rejected = [
      pointerEvent('pointermove', { clientX: 150, clientY: 100, pointerType: 'touch' }),
      pointerEvent('pointermove', { clientX: 150, clientY: 100, isPrimary: false }),
      pointerEvent('pointermove', { clientX: 124, clientY: 100 }),
      pointerEvent('pointermove', { clientX: 276, clientY: 100 }),
      pointerEvent('pointermove', { clientX: 150, clientY: 74 }),
      pointerEvent('pointermove', { clientX: 150, clientY: 126 })
    ]
    for (const event of rejected) target.dispatchEvent(event)
    expect(controller.state.strength).toBe(0)

    finePointer = false
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 100, pointerType: 'mouse' }))
    expect(controller.state.strength).toBe(0)
    controller.dispose()
  })

  it('attaches passive listeners only while active and cleans each attachment exactly once', () => {
    const target = targetWithBounds()
    const additions: Array<[string, unknown]> = []
    const removals: Array<[string, unknown]> = []
    const addEventListener = target.addEventListener.bind(target)
    const removeEventListener = target.removeEventListener.bind(target)
    target.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      additions.push([type, options])
      addEventListener(type, listener, options)
    }) as typeof target.addEventListener
    target.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      removals.push([type, options])
      removeEventListener(type, listener, options)
    }) as typeof target.removeEventListener

    const controller = new LogoPointerController({ hasFinePointer: () => true, medianStroke: 10 })
    controller.setTarget(target)
    controller.setCoordinateTarget(insetCoordinateTarget())
    expect(additions).toEqual([])
    controller.setActive(true)
    controller.setActive(true)
    expect(additions.map(([type]) => type).sort()).toEqual(['pointerleave', 'pointermove'])
    for (const [, options] of additions) expect(options).toMatchObject({ passive: true })
    expect(target.classList.contains('login-particle-logo--pointer-active')).toBe(true)

    controller.setActive(false)
    controller.setActive(false)
    expect(removals).toHaveLength(2)
    expect(target.classList.contains('login-particle-logo--pointer-active')).toBe(false)
    controller.setActive(true)
    controller.dispose()
    controller.dispose()
    expect(additions).toHaveLength(4)
    expect(removals).toHaveLength(4)
    expect(target.classList.contains('login-particle-logo--pointer-active')).toBe(false)
  })
})
