import { JSDOM } from 'jsdom'
import { describe, expect, it } from '../../../server/test/bun-test.mts'
import { LogoPointerController, logoPointerMotionMetrics } from './useLogoPointer.ts'

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
  it('derives bounded anisotropic radii and 10 to 24 pixel displacement', () => {
    expect(logoPointerMotionMetrics(8, 256)).toEqual({
      alongRadiusCss: 50.4,
      acrossRadiusCss: 28,
      displacementCss: 10
    })

    const scaled = logoPointerMotionMetrics(20, 512)
    expect(scaled.acrossRadiusCss).toBeCloseTo(40.96, 12)
    expect(scaled.alongRadiusCss).toBeCloseTo(73.728, 12)
    expect(scaled.displacementCss).toBe(10)

    expect(logoPointerMotionMetrics(64, 1024)).toEqual({
      alongRadiusCss: 100.8,
      acrossRadiusCss: 56,
      displacementCss: 24
    })
    expect(logoPointerMotionMetrics(1_000_000, 1_000_000)).toEqual({
      alongRadiusCss: 100.8,
      acrossRadiusCss: 56,
      displacementCss: 24
    })
  })

  it('uses absolute event time, sustains a material mid-envelope, and reaches zero by 240 milliseconds at any update cadence', () => {
    const strengthAfterSchedule = (interval: number): { material: number; midpoint: number; samples: number[]; deadline: number; afterDeadline: number } => {
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
      time += 10
      target.dispatchEvent(pointerEvent('pointermove', { clientX: 240, clientY: 100 }))

      const origin = time
      const material = controller.update(400, origin + 80).strength
      const midpoint = controller.update(400, origin + 120).strength
      const samples = [material, midpoint]
      time = origin + 120
      while (time + interval < origin + 240) {
        time += interval
        samples.push(controller.update(400, time).strength)
      }
      time = origin + 240
      const deadline = controller.update(400, time).strength
      const afterDeadline = controller.update(400, origin + 300).strength
      controller.dispose()
      return { material, midpoint, samples, deadline, afterDeadline }
    }

    const sixtyHertz = strengthAfterSchedule(1000 / 60)
    const oneHundredFortyFourHertz = strengthAfterSchedule(1000 / 144)
    expect(sixtyHertz.material).toBeGreaterThan(0.3)
    expect(sixtyHertz.midpoint).toBeGreaterThan(0.2)
    expect(sixtyHertz.midpoint).toBeLessThan(sixtyHertz.material)
    expect(sixtyHertz.samples.every((strength, index, samples) => index === 0 || strength <= samples[index - 1])).toBe(true)
    expect(sixtyHertz.deadline).toBe(0)
    expect(sixtyHertz.afterDeadline).toBe(0)
    expect(oneHundredFortyFourHertz.material).toBe(sixtyHertz.material)
    expect(oneHundredFortyFourHertz.midpoint).toBe(sixtyHertz.midpoint)
    expect(oneHundredFortyFourHertz.deadline).toBe(sixtyHertz.deadline)
    expect(oneHundredFortyFourHertz.samples.every((strength, index, samples) => index === 0 || strength <= samples[index - 1])).toBe(true)
  })
  it('preserves a fast slice through zero and perpendicular sub-threshold jitter', () => {
    const effectiveAtReturn = (interval: number): { peak: number; immediate: number; returned: number } => {
      let time = 0
      const target = targetWithBounds()
      const controller = new LogoPointerController({
        hasFinePointer: () => true,
        medianStroke: 12,
        now: () => time
      })
      controller.setTarget(target)
      controller.setCoordinateTarget(target)
      controller.setActive(true)

      target.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 100 }))
      time = 10
      target.dispatchEvent(pointerEvent('pointermove', { clientX: 190, clientY: 100 }))
      const peak = controller.state.speed * controller.state.strength
      time = 20
      target.dispatchEvent(pointerEvent('pointermove', { clientX: 190, clientY: 100 }))
      time = 30
      target.dispatchEvent(pointerEvent('pointermove', { clientX: 190, clientY: 99.6 }))
      const immediate = controller.state.speed * controller.state.strength
      expect(controller.state.directionX).toBe(1)
      expect(controller.state.directionY).toBe(0)
      expect(immediate).toBeCloseTo(peak, 12)

      const origin = 10
      while (time + interval < origin + 240) {
        time += interval
        controller.update(400, time)
      }
      time = origin + 240
      const returned = controller.update(400, time).speed * controller.state.strength
      controller.dispose()
      return { peak, immediate, returned }
    }

    const sixtyHertz = effectiveAtReturn(1000 / 60)
    const oneHundredFortyFourHertz = effectiveAtReturn(1000 / 144)
    expect(sixtyHertz.peak).toBeGreaterThan(0)
    expect(sixtyHertz.immediate).toBeGreaterThan(0)
    expect(sixtyHertz.returned).toBe(0)
    expect(oneHundredFortyFourHertz.returned).toBe(sixtyHertz.returned)
  })
})

describe('LogoPointerController bounded input and lifetime', () => {
  it('tracks normalized trajectory direction with inverted Y and smooth bounded speed', () => {
    let time = 100
    const target = targetWithBounds()
    const coordinateTarget = insetCoordinateTarget()
    const controller = new LogoPointerController({
      hasFinePointer: () => true,
      medianStroke: 10,
      now: () => time
    })
    controller.setTarget(target)
    controller.setCoordinateTarget(coordinateTarget)
    controller.setActive(true)

    target.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 100 }))
    expect(controller.state).toMatchObject({ directionX: 1, directionY: 0, speed: 0, strength: 0 })

    time += 10
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 153, clientY: 96 }))
    const speedPosition = (0.5 - 0.05) / (0.9 - 0.05)
    expect(controller.state.directionX).toBeCloseTo(0.6, 12)
    expect(controller.state.directionY).toBeCloseTo(0.8, 12)
    const fastSpeed = speedPosition * speedPosition * (3 - 2 * speedPosition)
    expect(controller.state.speed).toBeCloseTo(fastSpeed, 12)

    time += 10
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 153, clientY: 96 }))
    expect(controller.state.directionX).toBeCloseTo(0.6, 12)
    expect(controller.state.directionY).toBeCloseTo(0.8, 12)
    expect(controller.state.speed).toBe(fastSpeed)

    target.dispatchEvent(pointerEvent('pointermove', { clientX: 154, clientY: 96 }))
    expect(controller.state.directionX).toBeCloseTo(0.6, 12)
    expect(controller.state.directionY).toBeCloseTo(0.8, 12)
    expect(controller.state.speed).toBe(fastSpeed)

    time += 100
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 155, clientY: 96 }))
    expect(controller.state.speed).toBe(fastSpeed)
    time += 10
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 164, clientY: 96 }))
    expect(controller.state.speed).toBe(1)
    expect(controller.state.speed).toBeGreaterThanOrEqual(0)
    expect(controller.state.speed).toBeLessThanOrEqual(1)
    controller.dispose()
  })

  it('requires two in-bounds samples after leave before restarting an impulse', () => {
    let time = 0
    const target = targetWithBounds()
    const controller = new LogoPointerController({
      hasFinePointer: () => true,
      medianStroke: 10,
      now: () => time
    })
    controller.setTarget(target)
    controller.setCoordinateTarget(target)
    controller.setActive(true)

    target.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 100 }))
    time = 10
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 190, clientY: 100 }))
    expect(controller.state.directionX).toBe(1)
    expect(controller.state.directionY).toBe(0)
    expect(controller.state.speed).toBe(1)
    expect(controller.state.strength).toBe(1)

    time = 50
    target.dispatchEvent(pointerEvent('pointerleave'))
    const strengthAtLeave = controller.state.strength
    expect(strengthAtLeave).toBeGreaterThan(0.6)
    expect(strengthAtLeave).toBeLessThan(0.8)

    time = 60
    const decayedBeforeReentry = controller.update(400, time).strength
    expect(decayedBeforeReentry).toBeGreaterThan(0.5)
    expect(decayedBeforeReentry).toBeLessThan(strengthAtLeave)

    target.dispatchEvent(pointerEvent('pointermove', { clientX: 250, clientY: 100 }))
    expect(controller.state).toMatchObject({ directionX: 1, directionY: 0, speed: 1, strength: decayedBeforeReentry })

    time = 70
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 260, clientY: 100 }))
    expect(controller.state).toMatchObject({ directionX: 1, directionY: 0, speed: 1, strength: 1 })
    controller.dispose()
  })

  it('accepts only bounded primary fine mouse and pen input against the coordinate target', () => {
    let finePointer = true
    let time = 10
    const target = targetWithBounds()
    const coordinateTarget = insetCoordinateTarget()
    const controller = new LogoPointerController({
      hasFinePointer: () => finePointer,
      medianStroke: 10,
      now: () => time
    })
    controller.setTarget(target)
    controller.setCoordinateTarget(coordinateTarget)
    controller.setActive(true)
    expect(controller.update(400, time)).toMatchObject({
      acrossRadiusCss: 32,
      alongRadiusCss: 57.6,
      displacementCss: 10
    })

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
    expect(controller.state).toMatchObject({ x: 0, y: 0, directionX: 1, directionY: 0, speed: 0, strength: 0 })

    target.dispatchEvent(pointerEvent('pointermove', { clientX: 125, clientY: 125, pointerType: 'mouse' }))
    expect(controller.state).toMatchObject({ x: -1, y: -1, speed: 0, strength: 0 })

    time += 10
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 275, clientY: 75, pointerType: 'pen' }))
    expect(controller.state).toMatchObject({ x: 1, y: 1, strength: 1 })
    expect(Number.isFinite(controller.state.directionX)).toBe(true)
    expect(Number.isFinite(controller.state.directionY)).toBe(true)

    controller.setActive(false)
    controller.setActive(true)
    finePointer = false
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 100 }))
    expect(controller.state.strength).toBe(0)
    controller.dispose()
  })

  it('resets trajectory when replacing targets and ignores detached targets', () => {
    let time = 20
    const firstTarget = targetWithBounds()
    const replacementTarget = targetWithBounds()
    const controller = new LogoPointerController({
      hasFinePointer: () => true,
      medianStroke: 10,
      now: () => time
    })
    controller.setTarget(firstTarget)
    controller.setCoordinateTarget(insetCoordinateTarget())
    controller.setActive(true)
    firstTarget.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 100 }))
    time += 10
    firstTarget.dispatchEvent(pointerEvent('pointermove', { clientX: 160, clientY: 90 }))
    expect(controller.state.speed).toBeGreaterThan(0)

    controller.setTarget(replacementTarget)
    expect(firstTarget.classList.contains('login-particle-logo--pointer-active')).toBe(false)
    expect(replacementTarget.classList.contains('login-particle-logo--pointer-active')).toBe(true)
    expect(controller.state).toMatchObject({ x: 0, y: 0, directionX: 1, directionY: 0, speed: 0, strength: 0 })

    time += 10
    firstTarget.dispatchEvent(pointerEvent('pointermove', { clientX: 170, clientY: 80 }))
    expect(controller.state.strength).toBe(0)
    replacementTarget.dispatchEvent(pointerEvent('pointermove', { clientX: 170, clientY: 80 }))
    expect(controller.state).toMatchObject({ directionX: 1, directionY: 0, speed: 0, strength: 0 })
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
    expect(controller.state).toMatchObject({ directionX: 1, directionY: 0, speed: 0, strength: 0 })
    expect(removals).toHaveLength(2)
    expect(target.classList.contains('login-particle-logo--pointer-active')).toBe(false)
    controller.setActive(true)
    controller.dispose()
    controller.dispose()
    expect(additions).toHaveLength(4)
    expect(removals).toHaveLength(4)
    expect(controller.state).toMatchObject({ x: 0, y: 0, directionX: 1, directionY: 0, speed: 0, strength: 0 })
    expect(target.classList.contains('login-particle-logo--pointer-active')).toBe(false)
  })
})
