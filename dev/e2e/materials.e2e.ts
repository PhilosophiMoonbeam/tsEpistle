import { expect, test, type Locator, type Page } from '@playwright/test'
import sharp from 'sharp'
import { openAuthenticatedPage } from './helpers.ts'

type Pixel = [number, number, number]
type InkSample = {
  name: string
  minimum: number
  color: string
  opacity: number
  box: { x: number; y: number; width: number; height: number }
}

type ContrastResult = {
  name: string
  minimum: number
  color: string
  opacity: number
  ratio: number
  backing: Pixel
  foreground: number[]
}

async function settled(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    const transitions = document.getAnimations().filter(animation =>
      animation instanceof CSSTransition && Number.isFinite(animation.effect?.getComputedTiming().endTime)
    )
    await Promise.all(transitions.map(animation => animation.finished))
    const { promise, resolve } = Promise.withResolvers<void>()
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    await promise
  })
}

async function readInk(locator: Locator, name: string, minimum: number): Promise<InkSample> {
  await expect(locator, name).toBeVisible()
  return locator.evaluate((element, contract) => {
    const style = getComputedStyle(element)
    let opacity = 1
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      const computed = getComputedStyle(ancestor)
      opacity *= Number(computed.opacity)
      // These samples are solid-color glyphs. Do not silently pretend a future
      // text gradient, blend mode, mask, or foreground filter is a flat ink.
      if (computed.mixBlendMode !== 'normal' || computed.filter !== 'none' || computed.maskImage !== 'none' || computed.backgroundClip === 'text') {
        throw new Error(`${contract.name}: foreground paint requires pixel-specific coverage`)
      }
    }
    const box = element.getBoundingClientRect()
    return { ...contract, color: style.color, opacity, box: { x: box.x, y: box.y, width: box.width, height: box.height } }
  }, { name, minimum })
}

// Sample the real compositor backing with glyph paint temporarily hidden.
// Computed ink/currentColor, geometry, material colors, gradients, overlays and
// filters remain unchanged. Contrast is evaluated with the ORIGINAL ink, never
// the measurement-only transparent text fill. No heuristic separates text from
// a patterned/blurred backing, so every sampled background color is retained.
function backingPixels(data: Buffer, width: number, height: number, channels: number, sample: InkSample): Pixel[] {
  const left = Math.max(0, Math.ceil(sample.box.x))
  const right = Math.min(width, Math.floor(sample.box.x + sample.box.width))
  const top = Math.max(0, Math.ceil(sample.box.y))
  const bottom = Math.min(height, Math.floor(sample.box.y + sample.box.height))
  if (right <= left || bottom <= top) throw new Error(`${sample.name}: no visible backing pixels`)
  const colors = new Map<string, Pixel>()
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const offset = (y * width + x) * channels
      const pixel: Pixel = [data[offset]!, data[offset + 1]!, data[offset + 2]!]
      colors.set(pixel.join(','), pixel)
    }
  }
  return [...colors.values()]
}

async function captureBacking(page: Page, scope: string): Promise<Buffer> {
  const mask = await page.addStyleTag({ content: `
    ${scope},
    ${scope} *,
    ${scope} *::before,
    ${scope} *::after {
      -webkit-text-fill-color: transparent !important;
      text-decoration-color: transparent !important;
      text-shadow: none !important;
    }
    ${scope} svg { visibility: hidden !important; }
  ` })
  try {
    await settled(page)
    return await page.screenshot({ scale: 'css' })
  } finally {
    await mask.evaluate(element => element.remove())
    await settled(page)
  }
}

function contrastRatio(first: ArrayLike<number>, second: ArrayLike<number>) {
  const luminance = (pixel: ArrayLike<number>) => {
    const linear = (byte: number) => {
      const value = byte / 255
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
    }
    return .2126 * linear(pixel[0]!) + .7152 * linear(pixel[1]!) + .0722 * linear(pixel[2]!)
  }
  const a = luminance(first)
  const b = luminance(second)
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
}

async function measureContrast(page: Page, sample: InkSample, backgrounds: Pixel[]): Promise<ContrastResult> {
  const composites = await page.evaluate(({ ink, backings }) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Native canvas color compositing is unavailable')
    if (!CSS.supports('color', ink.color)) throw new Error(`Unsupported computed ink ${ink.color}`)
    return backings.map(backing => {
      context.globalAlpha = 1
      context.fillStyle = `rgb(${backing.join(' ')})`
      context.fillRect(0, 0, 1, 1)
      context.globalAlpha = ink.opacity
      // The browser parses OKLCH/color()/alpha and performs source-over. Only
      // the independent WCAG luminance calculation is test-owned arithmetic.
      context.fillStyle = ink.color
      context.fillRect(0, 0, 1, 1)
      return { backing, foreground: Array.from(context.getImageData(0, 0, 1, 1).data) }
    })
  }, { ink: sample, backings: backgrounds })
  const worst = composites.map(composite => ({ ...composite, ratio: contrastRatio(composite.foreground, composite.backing) }))
    .reduce((a, b) => a.ratio < b.ratio ? a : b)
  return { name: sample.name, minimum: sample.minimum, color: sample.color, opacity: sample.opacity, ...worst }
}

async function keyboardFocus(page: Page, control: Locator) {
  // Establish keyboard modality, then use the real focusable control. No
  // synthetic :focus-visible class or replacement ring styles are injected.
  await page.keyboard.press('Shift')
  await control.focus()
  await expect(control).toBeFocused()
  expect(await control.evaluate(element => element.matches(':focus-visible'))).toBe(true)
  await settled(page)
}

async function measureFocus(page: Page, control: Locator, other: Locator, name: string): Promise<ContrastResult[]> {
  await keyboardFocus(page, other)
  const box = await control.boundingBox()
  if (!box) throw new Error(`${name}: real control is unavailable`)
  const before = await sharp(await page.screenshot({ scale: 'css' })).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  await keyboardFocus(page, control)
  const after = await sharp(await page.screenshot({ scale: 'css' })).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const pixel = (image: typeof before, x: number, y: number): Pixel => {
    if (x < 0 || y < 0 || x >= image.info.width || y >= image.info.height) throw new Error(`${name}: focus boundary exceeds viewport`)
    const offset = (y * image.info.width + x) * image.info.channels
    return [image.data[offset]!, image.data[offset + 1]!, image.data[offset + 2]!]
  }
  // Compare real unfocused/focused paint at the SAME backing coordinates.
  // A shadow, outline or halo can own focus; no CSS spelling is prescribed.
  // Straight middle sections avoid corner antialiasing. Each side needs a
  // continuous high-contrast core, not one favorable or unrelated pixel.
  return (['top', 'right', 'bottom', 'left'] as const).map(side => {
    const horizontal = side === 'top' || side === 'bottom'
    const length = horizontal ? box.width : box.height
    const samples: ContrastResult[] = []
    for (let along = Math.ceil(length * .3); along < length * .7; along += 1) {
      let strongest: ContrastResult | undefined
      for (let outward = 0; outward < 8; outward += 1) {
        const x = Math.floor(horizontal ? box.x + along : side === 'left' ? box.x - outward - 1 : box.x + box.width + outward)
        const y = Math.floor(!horizontal ? box.y + along : side === 'top' ? box.y - outward - 1 : box.y + box.height + outward)
        const backing = pixel(before, x, y)
        const foreground = pixel(after, x, y)
        const candidate = { name: `${name} ${side}`, minimum: 3, color: 'native focus pixels', opacity: 1, backing, foreground, ratio: contrastRatio(foreground, backing) }
        if (!strongest || candidate.ratio > strongest.ratio) strongest = candidate
      }
      samples.push(strongest!)
    }
    // At least 75% of the straight boundary must reach the threshold; taking
    // a lower quartile rejects isolated glints while tolerating raster edges.
    samples.sort((a, b) => a.ratio - b.ratio)
    return samples[Math.floor(samples.length * .25)]!
  })
}

async function installUnderlay(page: Page, backing: string) {
  await page.evaluate(value => {
    document.getElementById('native-material-underlay')?.remove()
    const fixture = document.createElement('div')
    fixture.id = 'native-material-underlay'
    fixture.setAttribute('aria-hidden', 'true')
    // This isolated visual fixture paints only BEHIND real chrome. It neither
    // changes application foreground/material rules nor creates business data.
    Object.assign(fixture.style, {
      position: 'fixed', inset: '0', zIndex: '999', pointerEvents: 'auto', overflow: 'hidden',
      background: value === 'prose' ? getComputedStyle(document.querySelector('.v-application')!).backgroundColor : value,
      color: getComputedStyle(document.querySelector('article.contents')!).color,
      font: '16px/1.7 serif', padding: '0 24px'
    })
    if (value === 'prose') {
      for (let index = 0; index < 50; index += 1) {
        const paragraph = document.createElement('p')
        paragraph.textContent = 'Isolated material contrast underlay. Readable wiki prose behind the real floating controls. '.repeat(12)
        fixture.append(paragraph)
      }
    }
    const layer = document.querySelector('.wiki-page > .v-application__wrap')
    if (!layer) throw new Error('Reader stacking context is unavailable')
    layer.append(fixture)
    const middle = document.elementFromPoint(innerWidth / 2, innerHeight / 2)
    if (!middle || !fixture.contains(middle)) throw new Error('Visual underlay did not paint above the article')
    for (const selector of ['.nav-header', '.page-reading-dock']) {
      const material = document.querySelector(selector)!
      const box = material.getBoundingClientRect()
      const topmost = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      if (!topmost || !material.contains(topmost)) throw new Error(`${selector}: visual underlay obscures the real material`)
    }
    fixture.style.pointerEvents = 'none'
  }, backing)
  await settled(page)
}

test('native floating controls and Focus dock retain AA over prose and saturated backing', async ({ page, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Reduced-transparency emulation uses the native Chromium CDP media feature')
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' })
  await openAuthenticatedPage(page, '/', 'article.contents')
  const cdp = await page.context().newCDPSession(page)
  const results: Array<ContrastResult & { mode: string; fallback: boolean; backingName: string }> = []
  try {
    await page.locator('.page-focus-control').click()
    const dock = page.locator('.page-reading-dock')
    await expect(dock).toBeVisible()
    const headerControl = page.locator('.nav-header-browse:visible').first()
    const dockControl = dock.locator('.page-reading-exit')
    const targets = [
      { locator: page.locator('.nav-header-title-single:visible'), name: 'header title', minimum: 4.5 },
      { locator: headerControl.locator('.v-icon'), name: 'header browse icon', minimum: 3 },
      { locator: dock.locator('.page-reading-dock-title'), name: 'dock section title', minimum: 4.5 },
      { locator: dock.locator('.page-reading-dock-position'), name: 'dock section position', minimum: 4.5 },
      { locator: dock.locator('.page-reading-sections-toggle .v-btn__content'), name: 'dock section action', minimum: 4.5 },
      { locator: dockControl.locator('.v-btn__content'), name: 'dock exit label', minimum: 4.5 },
      { locator: dockControl.locator('.v-icon'), name: 'dock exit icon', minimum: 3 }
    ]
    for (const mode of ['light', 'dark'] as const) {
      for (const fallback of [false, true]) {
        await cdp.send('Emulation.setEmulatedMedia', { features: [
          { name: 'prefers-color-scheme', value: mode },
          { name: 'prefers-reduced-motion', value: 'reduce' },
          { name: 'prefers-reduced-transparency', value: fallback ? 'reduce' : 'no-preference' }
        ] })
        // The installed admin fixture must track System appearance. Never
        // replace whoami/preferences to manufacture a light/dark UI state.
        await expect(page.locator('.wiki-page')).toHaveClass(new RegExp(`v-theme--${mode}`, 'u'))
        expect(await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches)).toBe(fallback)
        if (!fallback) {
          // Source presence and AA alone miss a minifier dropping the standard
          // declaration when an unsupported vendor-prefixed form comes last.
          await expect(page.locator('.nav-header')).toHaveCSS('backdrop-filter', 'blur(16px) saturate(1.4)')
          await expect(dock).toHaveCSS('backdrop-filter', 'blur(20px) saturate(1.5)')
        }
        if (fallback) {
          for (const material of [page.locator('.nav-header'), dock]) {
            await expect(material).toHaveCSS('backdrop-filter', 'none')
            const alpha = await material.evaluate(element => {
              const canvas = document.createElement('canvas')
              canvas.width = canvas.height = 1
              const context = canvas.getContext('2d')!
              context.fillStyle = getComputedStyle(element).backgroundColor
              context.fillRect(0, 0, 1, 1)
              return context.getImageData(0, 0, 1, 1).data[3]
            })
            expect(alpha, 'Reduced transparency gives actual consumers solid backing').toBe(255)
          }
        }
        for (const backing of ['prose', 'black', 'white', 'red', 'lime', 'orange']) {
          await installUnderlay(page, backing)
          // Hide only glyph paint to obtain the native backing. Original
          // computed ink above is the foreground used for every AA assertion.
          await page.mouse.move(0, 450)
          const samples = await Promise.all(targets.map(target => readInk(target.locator, target.name, target.minimum)))
          const capture = await captureBacking(page, ':is(.nav-header, .page-reading-dock)')
          const image = await sharp(capture).removeAlpha().raw().toBuffer({ resolveWithObject: true })
          for (const sample of samples) {
            const pixels = backingPixels(image.data, image.info.width, image.info.height, image.info.channels, sample)
            results.push({ ...await measureContrast(page, sample, pixels), mode, fallback, backingName: backing })
          }
          for (const [control, other, name] of [[headerControl, dockControl, 'header keyboard focus'], [dockControl, headerControl, 'dock keyboard focus']] as const) {
            for (const result of await measureFocus(page, control, other, name)) {
              results.push({ ...result, mode, fallback, backingName: backing })
            }
          }
          if (results.some(result => result.mode === mode && result.fallback === fallback && result.backingName === backing && result.ratio < result.minimum)) {
            await testInfo.attach(`materials-${mode}-${fallback ? 'solid' : 'glass'}-${backing}`, { body: capture, contentType: 'image/png' })
          }
        }
      }
    }
  } finally {
    await testInfo.attach('native-material-contrast', { body: JSON.stringify(results, null, 2), contentType: 'application/json' })
    await page.evaluate(() => document.getElementById('native-material-underlay')?.remove())
    await cdp.send('Emulation.setEmulatedMedia', { features: [] })
    await cdp.detach()
  }
  const failures = results.filter(result => result.ratio < result.minimum)
  expect(failures, 'Actual composited text needs 4.5:1; essential icons and focus need 3:1').toEqual([])
})

test('active contents labels remain readable over their native selected-row paint', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' })
  await openAuthenticatedPage(page, '/', 'article.contents')
  const toc = page.locator('.page-toc-card')
  const results: Array<ContrastResult & { mode: string }> = []
  try {
    for (const mode of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: mode })
      await expect(page.locator('.wiki-page')).toHaveClass(new RegExp(`v-theme--${mode}`, 'u'))
      const active = toc.locator('[aria-current="location"] .page-toc-item-title-text')
      await expect(active).toHaveCount(1)
      await active.scrollIntoViewIfNeeded()
      await page.mouse.move(0, 450)
      await settled(page)
      const samples = await Promise.all([
        readInk(active, 'active contents label', 4.5),
        readInk(toc.locator('.page-toc-heading-label'), 'contents heading', 4.5)
      ])
      const capture = await captureBacking(page, '.page-toc-card')
      const image = await sharp(capture).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      for (const sample of samples) {
        const pixels = backingPixels(image.data, image.info.width, image.info.height, image.info.channels, sample)
        results.push({ ...await measureContrast(page, sample, pixels), mode })
      }
    }
  } finally {
    await testInfo.attach('native-contents-contrast', { body: JSON.stringify(results, null, 2), contentType: 'application/json' })
  }
  expect(results.filter(result => result.ratio < result.minimum),
    'Selected-row tint and glow must not make ordinary contents text fall below 4.5:1').toEqual([])
})
