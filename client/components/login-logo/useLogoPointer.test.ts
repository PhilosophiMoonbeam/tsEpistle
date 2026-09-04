import { JSDOM } from 'jsdom'
import { describe, expect, it } from '../../../server/test/bun-test.mts'
import { LOGO_POINTER_IMPULSE_CAPACITY, LOGO_POINTER_MAX_SEGMENT_CSS, LogoPointerController, logoPointerInfluenceRadius } from './useLogoPointer.ts'

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

describe('logo pointer impulse motion', () => {
  it('derives one bounded circular influence radius', () => {
    expect(logoPointerInfluenceRadius(0)).toBe(18)
    expect(logoPointerInfluenceRadius(400)).toBe(20)
    expect(logoPointerInfluenceRadius(640)).toBe(32)
    expect(logoPointerInfluenceRadius(1_000_000)).toBe(32)
    expect(logoPointerInfluenceRadius(Number.NaN)).toBe(18)
  })

  it('keeps a stable preallocated ring and records only real travel above two pixels', () => {
    let time = 0
    const target = targetWithBounds()
    const controller = new LogoPointerController({ hasFinePointer: () => true, now: () => time })
    controller.setTarget(target)
    controller.setCoordinateTarget(target)
    controller.setActive(true)
    controller.update(400, time)
    const state = controller.state
    const ring = controller.state.impulses
    const slots = [...ring]

    target.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 100 }))
    time = 10
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 152, clientY: 100 }))
    expect(controller.state.activeImpulseCount).toBe(0)

    time = 20
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 155, clientY: 96 }))
    expect(ring[0]).toMatchObject({
      active: true,
      ageSeconds: 0,
      radiusCss: 20,
      travelCss: 5
    })
    expect(ring[0].directionX).toBeCloseTo(0.6, 12)
    expect(ring[0].directionY).toBeCloseTo(0.8, 12)
    expect(ring[0].x).toBeCloseTo(-0.45, 12)
    expect(ring[0].y).toBeCloseTo(0.08, 12)

    time = 25
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 165, clientY: 96 }))
    expect(ring[1].travelCss).toBe(10)
    time = 30
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 275, clientY: 96, pointerType: 'pen' }))
    expect(controller.state.activeImpulseCount).toBe(3)
    expect(ring[2].travelCss).toBe(LOGO_POINTER_MAX_SEGMENT_CSS)
    expect(controller.update(400, time)).toBe(state)
    expect(controller.state.impulses).toBe(ring)
    controller.state.impulses.forEach((impulse, index) => {
      expect(impulse).toBe(slots[index])
    })
    controller.dispose()
  })

  it('bounds four slots and evicts the oldest one deterministically', () => {
    let time = 0
    const target = targetWithBounds()
    const controller = new LogoPointerController({ hasFinePointer: () => true, now: () => time })
    controller.setTarget(target)
    controller.setCoordinateTarget(target)
    controller.setActive(true)

    target.dispatchEvent(pointerEvent('pointermove', { clientX: 120, clientY: 100 }))
    for (let endpoint = 125; endpoint <= 145; endpoint += 5) {
      time += 10
      target.dispatchEvent(pointerEvent('pointermove', { clientX: endpoint, clientY: 100 }))
    }

    expect(controller.state.impulses).toHaveLength(LOGO_POINTER_IMPULSE_CAPACITY)
    expect(controller.state.activeImpulseCount).toBe(LOGO_POINTER_IMPULSE_CAPACITY)
    const expectedCenters = [-0.55, -0.7, -0.65, -0.6]
    controller.state.impulses.forEach((impulse, index) => {
      expect(impulse.x).toBeCloseTo(expectedCenters[index], 12)
    })
    expect(controller.state.impulses.map(impulse => impulse.travelCss)).toEqual([5, 5, 5, 5])
    controller.dispose()
  })

  it('ages from absolute event time, remains active at 240 milliseconds, and expires at 900 milliseconds', () => {
    const stateAfterSchedule = (updates: number[]): { activeAt240: boolean; ageAt240: number; activeAt899: boolean; activeAt900: boolean } => {
      let time = 100
      const target = targetWithBounds()
      const controller = new LogoPointerController({ hasFinePointer: () => true, now: () => time })
      controller.setTarget(target)
      controller.setCoordinateTarget(target)
      controller.setActive(true)
      target.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 100 }))
      time = 110
      target.dispatchEvent(pointerEvent('pointermove', { clientX: 160, clientY: 100 }))

      for (const updateTime of updates) controller.update(400, updateTime)
      const at240 = controller.update(400, 350).impulses[0]
      const activeAt240 = at240.active
      const ageAt240 = at240.ageSeconds
      const activeAt899 = controller.update(400, 1009).impulses[0].active
      const activeAt900 = controller.update(400, 1010).impulses[0].active
      controller.dispose()
      return { activeAt240, ageAt240, activeAt899, activeAt900 }
    }

    const scheduled = stateAfterSchedule([120, 150, 200, 280, 340])
    const direct = stateAfterSchedule([])
    expect(scheduled).toEqual(direct)
    expect(scheduled.activeAt240).toBe(true)
    expect(scheduled.ageAt240).toBeCloseTo(0.24, 12)
    expect(scheduled.activeAt899).toBe(true)
    expect(scheduled.activeAt900).toBe(false)
  })

  it('stops sampling on leave while existing impulses continue to age', () => {
    let time = 0
    const target = targetWithBounds()
    const controller = new LogoPointerController({ hasFinePointer: () => true, now: () => time })
    controller.setTarget(target)
    controller.setCoordinateTarget(target)
    controller.setActive(true)

    target.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 100 }))
    time = 10
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 160, clientY: 100 }))
    time = 100
    target.dispatchEvent(pointerEvent('pointerleave'))
    expect(controller.state).toMatchObject({ activeImpulseCount: 1 })
    expect(controller.state.impulses[0].ageSeconds).toBeCloseTo(0.09, 12)

    time = 250
    expect(controller.update(400, time).impulses[0]).toMatchObject({ active: true, ageSeconds: 0.24 })
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 200, clientY: 100 }))
    expect(controller.state.activeImpulseCount).toBe(1)
    time = 260
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 205, clientY: 100 }))
    expect(controller.state.activeImpulseCount).toBe(2)
    controller.dispose()
  })
})

describe('LogoPointerController input and lifecycle', () => {
  it('accepts only bounded primary fine mouse and pen segments against the coordinate target', () => {
    let finePointer = true
    let time = 10
    const target = targetWithBounds()
    const coordinateTarget = insetCoordinateTarget()
    const controller = new LogoPointerController({ hasFinePointer: () => finePointer, now: () => time })
    controller.setTarget(target)
    controller.setCoordinateTarget(coordinateTarget)
    controller.setActive(true)
    expect(controller.update(400, time).influenceRadiusCss).toBe(20)

    const rejected = [
      pointerEvent('pointermove', { clientX: 150, clientY: 100, pointerType: 'touch' }),
      pointerEvent('pointermove', { clientX: 150, clientY: 100, isPrimary: false }),
      pointerEvent('pointermove', { clientX: 124, clientY: 100 }),
      pointerEvent('pointermove', { clientX: 276, clientY: 100 }),
      pointerEvent('pointermove', { clientX: 150, clientY: 74 }),
      pointerEvent('pointermove', { clientX: 150, clientY: 126 }),
      pointerEvent('pointermove', { clientX: Number.NaN, clientY: 100 })
    ]
    for (const event of rejected) target.dispatchEvent(event)
    expect(controller.state.activeImpulseCount).toBe(0)

    target.dispatchEvent(pointerEvent('pointermove', { clientX: 125, clientY: 125, pointerType: 'mouse' }))
    time += 10
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 275, clientY: 75, pointerType: 'pen' }))
    expect(controller.state.activeImpulseCount).toBe(1)
    expect(controller.state.impulses[0]).toMatchObject({
      active: true,
      x: 1,
      y: 1
    })
    expect(controller.state.impulses[0].directionX).toBeCloseTo(150 / Math.hypot(150, 50), 12)
    expect(controller.state.impulses[0].directionY).toBeCloseTo(50 / Math.hypot(150, 50), 12)

    controller.setActive(false)
    controller.setActive(true)
    finePointer = false
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 100 }))
    time += 10
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 160, clientY: 100 }))
    expect(controller.state.activeImpulseCount).toBe(0)
    controller.dispose()
  })

  it('clears impulses when inactive, replacing either target, and disposing', () => {
    let time = 20
    const firstTarget = targetWithBounds()
    const replacementTarget = targetWithBounds()
    const coordinateTarget = insetCoordinateTarget()
    const controller = new LogoPointerController({ hasFinePointer: () => true, now: () => time })
    controller.setTarget(firstTarget)
    controller.setCoordinateTarget(coordinateTarget)
    controller.setActive(true)

    firstTarget.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 100 }))
    time += 10
    firstTarget.dispatchEvent(pointerEvent('pointermove', { clientX: 160, clientY: 90 }))
    expect(controller.state.activeImpulseCount).toBe(1)

    controller.setTarget(replacementTarget)
    expect(controller.state.activeImpulseCount).toBe(0)
    expect(firstTarget.classList.contains('login-particle-logo--pointer-active')).toBe(false)
    expect(replacementTarget.classList.contains('login-particle-logo--pointer-active')).toBe(true)
    time += 10
    firstTarget.dispatchEvent(pointerEvent('pointermove', { clientX: 170, clientY: 80 }))
    expect(controller.state.activeImpulseCount).toBe(0)

    replacementTarget.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 100 }))
    time += 10
    replacementTarget.dispatchEvent(pointerEvent('pointermove', { clientX: 160, clientY: 100 }))
    expect(controller.state.activeImpulseCount).toBe(1)
    controller.setCoordinateTarget(targetWithBounds())
    expect(controller.state.activeImpulseCount).toBe(0)

    controller.setActive(false)
    expect(controller.state.activeImpulseCount).toBe(0)
    controller.setActive(true)
    controller.dispose()
    expect(controller.state.activeImpulseCount).toBe(0)
    expect(controller.state.impulses.every(impulse => !impulse.active && impulse.travelCss === 0)).toBe(true)
    expect(replacementTarget.classList.contains('login-particle-logo--pointer-active')).toBe(false)
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

    const controller = new LogoPointerController({ hasFinePointer: () => true })
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
