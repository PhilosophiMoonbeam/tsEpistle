import { JSDOM } from 'jsdom'
import { describe, expect, it } from '../../../server/test/bun-test.mts'
import type { LogoPointerState } from './useLogoPointer.ts'
import {
  LOGO_POINTER_EXPLOSION_LIFETIME_SECONDS,
  LOGO_POINTER_IMPULSE_CAPACITY,
  LOGO_POINTER_MAX_SEGMENT_CSS,
  LogoPointerController,
  logoPointerInfluenceRadius
} from './useLogoPointer.ts'

const dom = new JSDOM('<!doctype html><html><body><div id="logo"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/login'
})

const pointerEvent = (
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'pointerleave',
  values: Partial<Pick<PointerEvent, 'button' | 'clientX' | 'clientY' | 'isPrimary' | 'pointerType' | 'pointerId'>> = {}
): Event => {
  const event = new dom.window.Event(type)
  Object.defineProperties(event, {
    button: { value: values.button ?? 0 },
    clientX: { value: values.clientX ?? 0 },
    clientY: { value: values.clientY ?? 0 },
    isPrimary: { value: values.isPrimary ?? true },
    pointerId: { value: values.pointerId ?? 1 },
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
  it('keeps six stable preallocated slots and records only real travel above two pixels', () => {
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
    expect(ring).toHaveLength(6)
    expect(slots).toHaveLength(6)

    target.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 100 }))
    time = 10
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 152, clientY: 100 }))
    expect(controller.state.activeImpulseCount).toBe(0)

    time = 20
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 155, clientY: 96 }))
    expect(ring[0]).toMatchObject({
      active: true,
      ageSeconds: 0,
      radiusCss: 20
    })
    expect(ring[0].travelCss).toBeCloseTo(25 / 9, 12)
    expect(ring[0].directionX).toBeCloseTo(0.6, 12)
    expect(ring[0].directionY).toBeCloseTo(0.8, 12)
    expect(ring[0].x).toBeCloseTo(-0.45, 12)
    expect(ring[0].y).toBeCloseTo(0.08, 12)

    time = 25
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 165, clientY: 96 }))
    expect(ring[1].travelCss).toBe(LOGO_POINTER_MAX_SEGMENT_CSS)
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
  it('scales effective travel by speed for equal distance while preserving the twenty-pixel event cap', () => {
    const measure = (elapsedMilliseconds: number): number => {
      let time = 0
      const target = targetWithBounds()
      const controller = new LogoPointerController({ hasFinePointer: () => true, now: () => time })
      controller.setTarget(target)
      controller.setCoordinateTarget(target)
      controller.setActive(true)
      target.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 100 }))
      time = elapsedMilliseconds
      target.dispatchEvent(pointerEvent('pointermove', { clientX: 160, clientY: 100 }))
      const travel = controller.state.impulses[0].travelCss
      controller.dispose()
      return travel
    }

    const slow = measure(100)
    const fast = measure(10)
    expect(slow).toBeGreaterThan(0)
    expect(fast).toBeGreaterThan(slow)
    expect(fast).toBeLessThanOrEqual(20)
  })

  it('keeps explosion slots bounded, expires every blast absolutely, and accepts again after expiry', () => {
    let time = 0
    const target = targetWithBounds()
    const controller = new LogoPointerController({ hasFinePointer: () => true, now: () => time })
    controller.setTarget(target)
    controller.setCoordinateTarget(target)
    controller.setActive(true)
    const state = controller.state as LogoPointerState & {
      activeExplosionCount: number
      explosions: readonly { active: boolean; ageSeconds: number; x: number; y: number }[]
    }

    for (let index = 0; index < 6; index += 1) {
      time = index * 10
      target.dispatchEvent(
        pointerEvent('pointerdown', {
          clientX: 140 + index * 10,
          clientY: 100,
          pointerId: index + 1,
          pointerType: index % 2 === 0 ? 'touch' : 'mouse'
        })
      )
    }
    expect(state.activeExplosionCount).toBe(6)
    const slots = [...state.explosions]
    const deadlines = slots.map(explosion => time + (LOGO_POINTER_EXPLOSION_LIFETIME_SECONDS - explosion.ageSeconds) * 1000)
    time = 60
    target.dispatchEvent(pointerEvent('pointerdown', { clientX: 200, clientY: 100, pointerId: 99, pointerType: 'pen' }))
    expect(state.activeExplosionCount).toBe(6)
    state.explosions.forEach((explosion, index) => {
      expect(explosion).toBe(slots[index])
      expect(time + (LOGO_POINTER_EXPLOSION_LIFETIME_SECONDS - explosion.ageSeconds) * 1000).toBeCloseTo(deadlines[index], 10)
    })

    time = 2_799
    expect(controller.update(400, time).activeExplosionCount).toBe(6)
    expect(state.explosions.every(explosion => Number.isFinite(explosion.x) && Number.isFinite(explosion.y))).toBe(true)
    time = 2_800
    expect(controller.update(400, time).activeExplosionCount).toBe(5)
    time = 2_849
    expect(controller.update(400, time).activeExplosionCount).toBe(1)
    time = 2_850
    expect(controller.update(400, time).activeExplosionCount).toBe(0)
    target.dispatchEvent(pointerEvent('pointerdown', { clientX: 200, clientY: 100, pointerId: 100, pointerType: 'touch' }))
    expect(state.activeExplosionCount).toBe(1)
    expect(state.explosions[0]).toBe(slots[0])
    controller.dispose()
  })

  it('uses each of six slots once and drops saturation without resetting active deadlines', () => {
    let time = 0
    const target = targetWithBounds()
    const controller = new LogoPointerController({ hasFinePointer: () => true, now: () => time })
    controller.setTarget(target)
    controller.setCoordinateTarget(target)
    controller.setActive(true)

    target.dispatchEvent(pointerEvent('pointermove', { clientX: 120, clientY: 100 }))
    for (let endpoint = 125; endpoint <= 150; endpoint += 5) {
      time += 10
      target.dispatchEvent(pointerEvent('pointermove', { clientX: endpoint, clientY: 100 }))
    }
    expect(controller.state.impulses).toHaveLength(LOGO_POINTER_IMPULSE_CAPACITY)
    expect(controller.state.activeImpulseCount).toBe(6)
    const slots = [...controller.state.impulses]
    const startedAtMilliseconds = slots.map(impulse => time - impulse.ageSeconds * 1000)

    time += 10
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 155, clientY: 100 }))
    expect(controller.state.activeImpulseCount).toBe(6)
    controller.state.impulses.forEach((impulse, index) => {
      expect(impulse).toBe(slots[index])
      expect(time - impulse.ageSeconds * 1000).toBeCloseTo(startedAtMilliseconds[index], 10)
    })

    time = 1_410
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 160, clientY: 100 }))
    expect(controller.state.activeImpulseCount).toBe(6)
    expect(controller.state.impulses[0]).toBe(slots[0])
    expect(controller.state.impulses[0]).toMatchObject({ active: true, ageSeconds: 0 })
    controller.state.impulses.slice(1).forEach((impulse, index) => {
      expect(time - impulse.ageSeconds * 1000).toBeCloseTo(startedAtMilliseconds[index + 1], 10)
    })
    controller.dispose()
  })

  it('ages from absolute event time and expires at the one-point-four-second deadline', () => {
    let time = 100
    const target = targetWithBounds()
    const controller = new LogoPointerController({ hasFinePointer: () => true, now: () => time })
    controller.setTarget(target)
    controller.setCoordinateTarget(target)
    controller.setActive(true)
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 100 }))
    time = 110
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 160, clientY: 100 }))

    let impulse = controller.update(400, 1_109).impulses[0]
    expect(impulse.active).toBe(true)
    expect(impulse.ageSeconds).toBeCloseTo(0.999, 12)
    impulse = controller.update(400, 1_509).impulses[0]
    expect(impulse.active).toBe(true)
    expect(impulse.ageSeconds).toBeCloseTo(1.399, 12)
    impulse = controller.update(400, 1_510).impulses[0]
    expect(impulse.active).toBe(false)
    expect(impulse.ageSeconds).toBeCloseTo(1.4, 12)
    controller.dispose()
  })

  it('resets ownership sampling on up, leave, and cancel while preserving active impulse deadlines', () => {
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
    target.dispatchEvent(pointerEvent('pointerup', { pointerId: 1 }))
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 200, clientY: 100 }))
    time = 110
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 205, clientY: 100 }))
    expect(controller.state.activeImpulseCount).toBe(2)
    expect(controller.state.impulses[0].ageSeconds).toBeCloseTo(0.1, 12)

    target.dispatchEvent(pointerEvent('pointerleave', { pointerId: 1 }))
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 240, clientY: 100 }))
    time = 120
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 245, clientY: 100 }))
    expect(controller.state.activeImpulseCount).toBe(3)
    expect(controller.state.impulses[0].ageSeconds).toBeCloseTo(0.11, 12)

    target.dispatchEvent(pointerEvent('pointercancel', { pointerId: 1 }))
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 280, clientY: 100 }))
    expect(controller.state.activeImpulseCount).toBe(3)
    controller.dispose()
  })

  it('preserves owned sampling across mismatched pointer termination', () => {
    const terminations = ['pointerup', 'pointercancel', 'pointerleave'] as const
    for (const termination of terminations) {
      let time = 0
      const target = targetWithBounds()
      const controller = new LogoPointerController({ hasFinePointer: () => true, now: () => time })
      controller.setTarget(target)
      controller.setCoordinateTarget(target)
      controller.setActive(true)

      target.dispatchEvent(pointerEvent('pointerdown', { clientX: 150, clientY: 100, pointerId: 41 }))
      target.dispatchEvent(pointerEvent(termination, { pointerId: 99 }))
      time = 5
      target.dispatchEvent(pointerEvent('pointermove', { clientX: 200, clientY: 100, pointerId: 99 }))
      time = 10
      target.dispatchEvent(pointerEvent('pointermove', { clientX: 160, clientY: 100, pointerId: 41 }))

      expect(controller.state.activeImpulseCount).toBe(1)
      expect(controller.state.impulses[0].directionX).toBe(1)
      controller.dispose()
    }
  })

  it('seeds a new sample after an owned pointer leaves and re-enters the coordinate target', () => {
    let time = 0
    const target = targetWithBounds()
    const coordinateTarget = insetCoordinateTarget()
    const controller = new LogoPointerController({ hasFinePointer: () => true, now: () => time })
    controller.setTarget(target)
    controller.setCoordinateTarget(coordinateTarget)
    controller.setActive(true)

    target.dispatchEvent(pointerEvent('pointerdown', { clientX: 150, clientY: 100, pointerId: 7 }))
    time = 10
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 110, clientY: 100, pointerId: 7 }))
    time = 15
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 200, clientY: 100, pointerId: 8 }))
    time = 20
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 250, clientY: 100, pointerId: 7 }))
    expect(controller.state.activeImpulseCount).toBe(0)

    time = 30
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 255, clientY: 100, pointerId: 7 }))
    expect(controller.state.activeImpulseCount).toBe(1)
    expect(controller.state.impulses[0].directionX).toBe(1)
    controller.dispose()
  })

  it('seeds a new hover sample after crossing the coordinate-target margin', () => {
    let time = 0
    const target = targetWithBounds()
    const coordinateTarget = insetCoordinateTarget()
    const controller = new LogoPointerController({ hasFinePointer: () => true, now: () => time })
    controller.setTarget(target)
    controller.setCoordinateTarget(coordinateTarget)
    controller.setActive(true)

    target.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 100, pointerId: 7 }))
    time = 10
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 110, clientY: 100, pointerId: 7 }))
    time = 20
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 250, clientY: 100, pointerId: 7 }))
    expect(controller.state.activeImpulseCount).toBe(0)

    time = 30
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 255, clientY: 100, pointerId: 7 }))
    expect(controller.state.activeImpulseCount).toBe(1)
    expect(controller.state.impulses[0].directionX).toBe(1)
    controller.dispose()
  })

  it('preserves an unowned mouse-hover sample across unrelated touch and pen termination', () => {
    const unrelatedTerminations = [
      { pointerType: 'touch', type: 'pointerup' },
      { pointerType: 'pen', type: 'pointercancel' },
      { pointerType: 'touch', type: 'pointerleave' }
    ] as const
    for (const termination of unrelatedTerminations) {
      let time = 0
      const target = targetWithBounds()
      const controller = new LogoPointerController({ hasFinePointer: () => true, now: () => time })
      controller.setTarget(target)
      controller.setCoordinateTarget(target)
      controller.setActive(true)

      target.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 100, pointerId: 41, pointerType: 'mouse' }))
      target.dispatchEvent(pointerEvent(termination.type, { pointerId: 99, pointerType: termination.pointerType }))
      time = 10
      target.dispatchEvent(pointerEvent('pointermove', { clientX: 160, clientY: 100, pointerId: 41, pointerType: 'mouse' }))

      expect(controller.state.activeImpulseCount).toBe(1)
      expect(controller.state.impulses[0].directionX).toBe(1)
      controller.dispose()
    }
  })
})

describe('LogoPointerController input and lifecycle', () => {
  it('accepts primary left mouse, primary left pen, and primary touch down while rejecting other activation', () => {
    let finePointer = true
    let time = 10
    const target = targetWithBounds()
    const coordinateTarget = insetCoordinateTarget()
    const controller = new LogoPointerController({ hasFinePointer: () => finePointer, now: () => time })
    controller.setTarget(target)
    controller.setCoordinateTarget(coordinateTarget)
    controller.setActive(true)
    const state = controller.state as LogoPointerState & {
      activeExplosionCount: number
      explosions: readonly { active: boolean; ageSeconds: number; x: number; y: number }[]
    }

    const rejected = [
      pointerEvent('pointerdown', { button: 1, clientX: 150, clientY: 100, pointerType: 'mouse' }),
      pointerEvent('pointerdown', { button: 2, clientX: 150, clientY: 100, pointerType: 'mouse' }),
      pointerEvent('pointerdown', { button: 2, clientX: 150, clientY: 100, pointerType: 'pen' }),
      pointerEvent('pointerdown', { clientX: 150, clientY: 100, pointerType: 'mouse', isPrimary: false }),
      pointerEvent('pointerdown', { clientX: 150, clientY: 100, pointerType: 'touch', isPrimary: false, pointerId: 2 }),
      pointerEvent('pointerdown', { clientX: 124, clientY: 100, pointerType: 'touch' })
    ]
    for (const event of rejected) target.dispatchEvent(event)
    expect(state.activeExplosionCount).toBe(0)

    target.dispatchEvent(pointerEvent('pointerdown', { clientX: 150, clientY: 100, pointerType: 'mouse', pointerId: 1 }))
    expect(state.activeExplosionCount).toBe(1)
    target.dispatchEvent(pointerEvent('pointerdown', { clientX: 160, clientY: 100, pointerType: 'pen', pointerId: 2 }))
    expect(state.activeExplosionCount).toBe(2)
    time += 10
    target.dispatchEvent(pointerEvent('pointerdown', { clientX: 170, clientY: 100, pointerType: 'touch', pointerId: 1 }))
    expect(state.activeExplosionCount).toBe(3)

    time += 10
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 100, pointerType: 'touch', pointerId: 1 }))
    expect(controller.state.activeImpulseCount).toBe(0)

    target.dispatchEvent(pointerEvent('pointermove', { clientX: 256, clientY: 80, pointerType: 'mouse', pointerId: 1 }))
    time += 10
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 275, clientY: 75, pointerType: 'mouse', pointerId: 1 }))
    expect(controller.state.activeImpulseCount).toBe(1)
    expect(controller.state.impulses[0]).toMatchObject({ active: true, x: 1, y: 1 })
    expect(controller.state.impulses[0].directionX).toBeCloseTo(19 / Math.hypot(19, 5), 12)
    expect(controller.state.impulses[0].directionY).toBeCloseTo(5 / Math.hypot(19, 5), 12)

    finePointer = false
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 100, pointerType: 'mouse', pointerId: 1 }))
    time += 10
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 160, clientY: 100, pointerType: 'mouse', pointerId: 1 }))
    expect(controller.state.activeImpulseCount).toBe(1)
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
    const state = controller.state as LogoPointerState & { activeExplosionCount: number }
    firstTarget.dispatchEvent(pointerEvent('pointerdown', { clientX: 150, clientY: 100, pointerType: 'touch' }))
    expect(state.activeExplosionCount).toBe(1)
    firstTarget.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 100 }))
    firstTarget.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 100 }))
    time += 10
    firstTarget.dispatchEvent(pointerEvent('pointermove', { clientX: 160, clientY: 90 }))
    expect(controller.state.activeImpulseCount).toBe(1)
    controller.setTarget(replacementTarget)
    expect(controller.state.activeImpulseCount).toBe(0)
    expect(state.activeExplosionCount).toBe(0)
    expect(firstTarget.classList.contains('login-particle-logo--pointer-active')).toBe(false)
    expect(replacementTarget.classList.contains('login-particle-logo--pointer-active')).toBe(true)
    time += 10
    firstTarget.dispatchEvent(pointerEvent('pointermove', { clientX: 170, clientY: 80 }))
    expect(controller.state.activeImpulseCount).toBe(0)

    replacementTarget.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 100 }))
    time += 10
    replacementTarget.dispatchEvent(pointerEvent('pointermove', { clientX: 160, clientY: 100 }))
    controller.setCoordinateTarget(targetWithBounds())
    expect(controller.state.activeImpulseCount).toBe(0)
    expect(state.activeExplosionCount).toBe(0)

    controller.setActive(false)
    expect(controller.state.activeImpulseCount).toBe(0)
    expect(state.activeExplosionCount).toBe(0)
    controller.setActive(true)
    controller.dispose()
    replacementTarget.dispatchEvent(pointerEvent('pointerdown', { clientX: 160, clientY: 100, pointerType: 'touch' }))
    replacementTarget.dispatchEvent(pointerEvent('pointermove', { clientX: 170, clientY: 100 }))
    expect(controller.state.activeImpulseCount).toBe(0)
    expect(state.activeExplosionCount).toBe(0)
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
    expect(additions.map(([type]) => type).sort()).toEqual(['pointercancel', 'pointerdown', 'pointerleave', 'pointermove', 'pointerup'])
    for (const [, options] of additions) expect(options).toMatchObject({ passive: true })
    expect(target.classList.contains('login-particle-logo--pointer-active')).toBe(true)

    controller.setActive(false)
    controller.setActive(false)
    expect(removals).toHaveLength(5)
    expect(target.classList.contains('login-particle-logo--pointer-active')).toBe(false)
    controller.setActive(true)
    controller.dispose()
    controller.dispose()
    expect(additions).toHaveLength(10)
    expect(removals).toHaveLength(10)
    expect(target.classList.contains('login-particle-logo--pointer-active')).toBe(false)
  })
})
