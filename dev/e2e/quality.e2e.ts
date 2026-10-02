import AxeBuilder from '@axe-core/playwright'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { expect, test } from '@playwright/test'
import sharp from 'sharp'
import { installEnabledAgentFixture } from './agent-fixture.ts'
import { authenticateAsAdmin, expectResponsiveLayout, openAuthenticatedPage, openSearch } from './helpers.ts'

async function expectNoBlockingAccessibilityViolations(page: Page, surface: string) {
  await page.locator('.animated').evaluateAll(elements => {
    for (const element of elements) {
      for (const animation of element.getAnimations()) animation.finish()
    }
  })
  const result = await new AxeBuilder({ page }).exclude('.v-tooltip:not(.v-overlay--active)').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()
  const blockingViolations = result.violations.filter(violation => violation.impact === 'critical' || violation.impact === 'serious')
  expect(blockingViolations, `${surface} has serious or critical accessibility violations`).toEqual([])
}

function requireProject(testInfo: TestInfo, projectName: string) {
  test.skip(testInfo.project.name !== projectName, `Covered by the ${projectName} project`)
}

function requireAnyProject(testInfo: TestInfo, projectNames: readonly string[]) {
  test.skip(!projectNames.includes(testInfo.project.name), `Covered by ${projectNames.join(', ')}`)
}

async function tabToControl(page: Page, control: Locator, maximumPresses = 60) {
  for (let press = 0; press < maximumPresses; press += 1) {
    await page.keyboard.press('Tab')
    if (await control.evaluate(element => element === document.activeElement)) return true
  }
  return false
}
async function openEnabledAgent(page: Page) {
  await openAuthenticatedPage(page, '/', '.page-header-section')
  const search = await openSearch(page)
  await search.fill('home')
  const searchDialog = page.getByRole('dialog', { name: 'Search the Wiki', exact: true })
  await expect(searchDialog).toBeVisible()
  const askAgent = searchDialog.getByRole('button', { name: 'Ask about this', exact: true })
  await expect(askAgent).toBeVisible()
  await askAgent.click()
  const agent = page.getByRole('region', { name: 'Wiki Agent' })
  await expect(agent).toBeVisible()
  return agent
}

async function openReaderCopyFixture(page: Page) {
  await page.route('**/en/native-reader-copy', async route => {
    const response = await route.fetch({ url: new URL('/en/visual-markdown-browser', route.request().url()).href })
    if (!response.ok()) throw new Error(`Reader copy bootstrap returned HTTP ${response.status()}`)
    const document = await response.text()
    const paragraphs = Array.from({ length: 16 }, (_, index) => `<p>Reader scroll context ${index + 1}.</p>`).join('')
    const content = `${paragraphs}<p>Inline <code id="native-inline-copy">npm run example</code></p>
      <pre id="native-ordinary-copy" class="prismjs"><code class="language-javascript">const ordinary = "${'wide readable source '.repeat(30)}";</code></pre>
      <section id="native-framed-copy" class="codeblock-framed"><header>Example</header><pre class="prismjs"><code class="language-javascript">const framed = 2;</code></pre></section>
      <pre id="native-empty-copy" class="prismjs"><code class="language-javascript"></code></pre>${paragraphs}`
    const body = document.replace(
      /(<template\b[^>]*data-wiki-page-contents[^>]*>)[\s\S]*?<\/template>/u,
      `$1<div>${content}</div></template>`
    )
    if (body === document) throw new Error('Reader bootstrap omitted its normal contents slot')
    await route.fulfill({ response, body })
  })
  await openAuthenticatedPage(page, '/en/native-reader-copy', '#native-inline-copy')
  await expect(page.locator('#native-ordinary-copy').locator('..').getByRole('button', { name: 'Copy', exact: true })).toBeVisible()
}

async function pauseNextSweep(locator: Locator, name: string) {
  await locator.evaluate((element, animationName) => {
    const pause = (event: Event) => {
      if ((event as AnimationEvent).animationName !== animationName) return
      const animation = element.getAnimations({ subtree: true }).find(candidate => candidate instanceof CSSAnimation && candidate.animationName === animationName)
      if (!animation) throw new Error(`Missing active ${animationName}`)
      animation.pause()
      element.removeEventListener('animationstart', pause)
    }
    element.addEventListener('animationstart', pause)
  }, name)
}

/** Chromium serializes wide-gamut/translucent tokens as `color(srgb r g b / a)`, legacy colors as `rgba(...)`. */
function blurRadius(value: string): number {
  return Number(/blur\(([\d.]+)px\)/u.exec(value)?.[1] ?? 0)
}

function cssColorAlpha(value: string): number {
  if (value === 'transparent') return 0
  const slash = /\/\s*([\d.]+)\s*\)$/u.exec(value)
  if (slash) return Number(slash[1])
  const legacy = /^rgba\((?:\s*[\d.]+\s*,){3}\s*([\d.]+)\s*\)$/u.exec(value.replace(/\s+/gu, ''))
  if (legacy) return Number(legacy[1])
  return 1
}

function rgbDistance(left: Buffer, right: Buffer, offset: number): number {
  return Math.max(
    Math.abs(left[offset]! - right[offset]!),
    Math.abs(left[offset + 1]! - right[offset + 1]!),
    Math.abs(left[offset + 2]! - right[offset + 2]!)
  )
}

async function expectCopySweepPaint(page: Page, panel: Locator, name: string, pseudo: string, positions: readonly number[], testInfo: TestInfo) {
  await expect.poll(() => panel.evaluate((element, animationName) =>
    element.getAnimations({ subtree: true }).some(animation => animation instanceof CSSAnimation && animation.animationName === animationName && animation.playState === 'paused'), name)
  ).toBe(true)
  if (pseudo) {
    await panel.locator('xpath=ancestor-or-self::*[contains(@class,"codeblock-framed") or contains(@class,"code-toolbar")][1]').locator('.toolbar').evaluate(element => {
      for (const animation of element.getAnimations({ subtree: true })) if (animation instanceof CSSTransition) animation.finish()
    })
  }
  const before = await panel.evaluate(element => ({
    x: window.scrollX, y: window.scrollY, left: element.scrollLeft, top: element.scrollTop,
    width: element.scrollWidth, height: element.scrollHeight, documentWidth: document.documentElement.scrollWidth
  }))
  const frames: Buffer[] = []
  const toolbarFrames: Buffer[] = []
  for (const [index, progress] of [0, 0.5, 1].entries()) {
    const frame = await panel.evaluate((element, sample) => {
      const animation = element.getAnimations({ subtree: true }).find(candidate => candidate instanceof CSSAnimation && candidate.animationName === sample.name)
      if (!animation) throw new Error('Copy sweep disappeared before its paint sample')
      const duration = Number(animation.effect?.getComputedTiming().duration)
      // Stay one microsecond inside the end frame; finish() below exercises
      // the real animationend cleanup only after that frame is captured.
      animation.currentTime = duration * sample.progress - (sample.progress === 1 ? 0.001 : 0)
      // Finish color transitions, not the sweep under observation.
      for (const candidate of element.getAnimations()) if (candidate instanceof CSSTransition) candidate.finish()
      const style = getComputedStyle(element, sample.pseudo || null)
      return {
        duration, position: Number.parseFloat(style.backgroundPositionX), transform: style.transform,
        inset: [style.top, style.right, style.bottom, style.left], size: style.backgroundSize,
        gradient: style.backgroundImage, z: Number(style.zIndex),
        scroll: { x: window.scrollX, y: window.scrollY, left: element.scrollLeft, top: element.scrollTop,
          width: element.scrollWidth, height: element.scrollHeight, documentWidth: document.documentElement.scrollWidth }
      }
    }, { name, pseudo, progress })
    expect(frame.duration, 'Inline and block acknowledgment both last .95 seconds').toBe(950)
    expect(frame.position, `Sweep position at ${progress}`).toBeCloseTo(positions[index]!, 1)
    expect(frame.transform, 'Stationary gradient does not enlarge scrollable overflow').toBe('none')
    expect(frame.size).toBe('300% 100%')
    expect(frame.gradient).toContain('40%')
    expect(frame.gradient).toContain('60%')
    expect(frame.scroll, `Copy acknowledgment leaves every scroll coordinate and extent unchanged at ${progress}`).toEqual(before)
    if (pseudo) {
      expect(frame.inset, 'Copy band reaches all four panel edges').toEqual(['0px', '0px', '0px', '0px'])
      const toolbarZ = await panel.locator('xpath=ancestor-or-self::*[contains(@class,"codeblock-framed") or contains(@class,"code-toolbar")][1]').locator('.toolbar').evaluate(element => Number(getComputedStyle(element).zIndex))
      expect(frame.z, 'Acknowledgment paints above the attached Copy toolbar').toBeGreaterThan(toolbarZ)
    }
    const image = await panel.screenshot({ animations: 'allow', caret: 'hide', scale: 'css' })
    await testInfo.attach(`${name}-${pseudo ? 'block' : 'inline'}-${progress}`, { body: image, contentType: 'image/png' })
    frames.push(image)
    expect(await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })), 'Paint capture does not move the reader').toEqual({ x: before.x, y: before.y })
    if (pseudo && progress !== 1) {
      const button = panel.locator('xpath=ancestor-or-self::*[contains(@class,"codeblock-framed") or contains(@class,"code-toolbar")][1]').getByRole('button', { name: 'Copy', exact: true })
      await button.evaluate(element => {
        for (const animation of element.getAnimations()) if (animation instanceof CSSTransition) animation.finish()
      })
      if (progress === 0.5) {
        await panel.evaluate((element, animationName) => {
          const animation = element.getAnimations({ subtree: true }).find(candidate => candidate instanceof CSSAnimation && candidate.animationName === animationName)
          if (!animation) throw new Error('Copy band is missing before its toolbar crossing')
          animation.currentTime = Number(animation.effect?.getComputedTiming().duration) * 0.67
        }, name)
      }
      const toolbarImage = await button.screenshot({ animations: 'allow', scale: 'css' })
      toolbarFrames.push(toolbarImage)
      await testInfo.attach(`copy-overlay-toolbar-${progress}`, { body: toolbarImage, contentType: 'image/png' })
    }
  }
  const decoded = await Promise.all(frames.map(image => sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true })))
  const [start, middle, end] = decoded
  if (!start || !middle || !end) throw new Error('Missing copy paint frame')
  expect(middle.info).toEqual(start.info)
  expect(end.info).toEqual(start.info)
  let changedAtMiddle = 0
  let changedAtEnd = 0
  let pixels = 0
  // Compare the central band, clear of borders, glyphs at the panel edges,
  // and toolbar feedback. A class or CSSOM-only success cannot paint these pixels.
  for (let y = Math.floor(start.info.height * 0.3); y < Math.ceil(start.info.height * 0.7); y += 1) {
    for (let x = Math.floor(start.info.width * 0.3); x < Math.ceil(start.info.width * 0.7); x += 1) {
      const offset = (y * start.info.width + x) * 4
      const middleDelta = rgbDistance(start.data, middle.data, offset)
      const endDelta = rgbDistance(start.data, end.data, offset)
      if (middleDelta > 2) changedAtMiddle += 1
      if (endDelta > 2) changedAtEnd += 1
      pixels += 1
    }
  }
  expect(changedAtMiddle / pixels, 'The real midpoint band paints a substantial part of the panel interior').toBeGreaterThan(0.15)
  expect(changedAtEnd / pixels, 'The band leaves the panel interior again at its end').toBeLessThan(0.05)
  if (pseudo) {
    const decodedToolbar = await Promise.all(toolbarFrames.map(image => sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true })))
    const [idle, crossing] = decodedToolbar
    if (!idle || !crossing) throw new Error('Toolbar paint samples are missing')
    expect(crossing.info).toEqual(idle.info)
    let paintedPixels = 0
    const count = idle.info.width * idle.info.height
    for (let pixel = 0; pixel < count; pixel += 1) {
      const offset = pixel * 4
      if (rgbDistance(idle.data, crossing.data, offset) > 2) paintedPixels += 1
    }
    expect(paintedPixels / count, 'The acknowledgment band visibly crosses above the Copy toolbar, not underneath its opaque button').toBeGreaterThan(0.05)
  }
  await panel.evaluate((element, animationName) => {
    element.getAnimations({ subtree: true }).find(candidate => candidate instanceof CSSAnimation && candidate.animationName === animationName)?.finish()
  }, name)
}

test.describe('release accessibility profiles', () => {
  test('focuses initial and subsequent administration headings without a ring or focus scroll', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-keyboard')
    await page.setViewportSize({ width: 1280, height: 300 })
    await page.addInitScript(() => {
      const samples: Array<{ title: string; before: number; after: number; headingTop: number }> = []
      Object.defineProperty(window, '__nativeAdminFocusSamples', { value: samples })
      const prepared = new WeakMap<Element, { before: number; headingTop: number }>()
      const observer = new MutationObserver(() => {
        const heading = document.querySelector('.admin-main h1')
        if (!heading || prepared.has(heading)) return
        // Put the newly mounted heading above the viewport before its normal
        // next-tick focus. The route's separate scroll-to-top policy has run.
        window.scrollTo({ top: 240, behavior: 'instant' })
        prepared.set(heading, { before: window.scrollY, headingTop: heading.getBoundingClientRect().top })
      })
      observer.observe(document, { childList: true, subtree: true })
      document.addEventListener('focus', event => {
        const heading = event.target
        if (!(heading instanceof HTMLElement) || !heading.matches('.admin-main h1')) return
        const baseline = prepared.get(heading)
        if (baseline) samples.push({ title: heading.textContent?.trim() ?? '', ...baseline, after: window.scrollY })
      }, true)
    })
    await openAuthenticatedPage(page, '/a/dashboard', '.admin-dashboard')
    const dashboard = page.locator('.admin-main h1')
    // The shell moves focus only after in-app navigation; a direct load keeps focus on the body.
    await expect(dashboard).not.toBeFocused()
    await expect(dashboard).toHaveCSS('outline-style', 'none')
    await expect(dashboard).toHaveCSS('box-shadow', 'none')
    // Native router link activation, not a manually invoked focus method.
    await page.getByRole('textbox', { name: 'Find an administration setting', exact: true }).fill('Pages')
    await page.locator('#admin-navigation').getByRole('link').filter({ has: page.getByText('Pages', { exact: true }) }).click()
    await expect(page).toHaveURL('/a/pages')
    const pages = page.locator('.admin-main h1')
    await expect(pages).toBeFocused()
    await expect(pages).toHaveCSS('outline-style', 'none')
    await expect(pages).toHaveCSS('box-shadow', 'none')
    const samples = await page.evaluate(() =>
      (window as typeof window & { __nativeAdminFocusSamples: Array<{ title: string; before: number; after: number; headingTop: number }> }).__nativeAdminFocusSamples
    )
    for (const title of [await pages.textContent()]) {
      const sample = samples.find(candidate => candidate.title === title?.trim())
      expect(sample, `Normal route focus is observed for ${title}`).toBeDefined()
      if (!sample) throw new Error(`Missing native focus sample for ${title}`)
      expect(sample.before, 'Focus starts with a nonzero reading position').toBeGreaterThan(0)
      expect(sample.headingTop, 'The heading is above the viewport, so default scrolling would be observable').toBeLessThan(0)
      expect(sample.after, 'Automatic heading focus does not change the current scroll position').toBe(sample.before)
    }
  })

  test('paints inline and ordinary/titled Prism copy acknowledgment without moving the reader', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-keyboard')
    test.setTimeout(60_000)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await openReaderCopyFixture(page)
    const inline = page.locator('#native-inline-copy')
    await inline.scrollIntoViewIfNeeded()
    await inline.hover()
    expect(await inline.evaluate(element => element.getAnimations().filter(animation => animation instanceof CSSAnimation).length), 'Inline hover does not acknowledge a copy').toBe(0)
    const inlineScroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
    await pauseNextSweep(inline, 'wiki-inline-code-shimmer-sweep')
    await inline.click()
    await expect(inline).toHaveAttribute('data-inline-copy-state', 'success')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('npm run example')
    expect(await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))).toEqual(inlineScroll)
    await expectCopySweepPaint(page, inline, 'wiki-inline-code-shimmer-sweep', '', [100, 50, 0], testInfo)
    for (const id of ['native-ordinary-copy', 'native-framed-copy']) {
      const panel = page.locator(`#${id}`)
      const wrapper = panel.locator('xpath=ancestor-or-self::*[contains(@class,"codeblock-framed") or contains(@class,"code-toolbar")][1]')
      const copy = wrapper.getByRole('button', { name: 'Copy', exact: true })
      await copy.scrollIntoViewIfNeeded()
      await copy.hover()
      await copy.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => { animation.finish() }))
      if (await panel.evaluate(element => element.scrollWidth > element.clientWidth)) {
        const scrolled = await panel.evaluate(element => {
          element.scrollLeft = 64
          return { x: window.scrollX, y: window.scrollY, left: element.scrollLeft, top: element.scrollTop, width: element.scrollWidth }
        })
        expect(scrolled.left, 'The overflow copy starts at a real nonzero horizontal position').toBeGreaterThan(0)
        await pauseNextSweep(panel, 'wiki-code-block-copy-sweep')
        await copy.click()
        await expect(copy).toHaveAttribute('data-copy-state', 'success')
        expect(await panel.evaluate(element => ({ x: window.scrollX, y: window.scrollY, left: element.scrollLeft, top: element.scrollTop, width: element.scrollWidth }))).toEqual(scrolled)
        await expect.poll(() => panel.evaluate(element => element.getAnimations({ subtree: true }).some(animation => animation instanceof CSSAnimation && animation.animationName === 'wiki-code-block-copy-sweep' && animation.playState === 'paused'))).toBe(true)
        await panel.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => { animation.finish() }))
        await expect(panel).not.toHaveClass(/wiki-code-copy-flash-run/u)
        await panel.evaluate(element => { element.scrollLeft = 0 })
      }
      const initial = await panel.evaluate(element => ({ x: window.scrollX, y: window.scrollY, left: element.scrollLeft, top: element.scrollTop, width: element.scrollWidth }))
      await pauseNextSweep(panel, 'wiki-code-block-copy-sweep')
      await copy.click()
      await expect(copy).toHaveAttribute('data-copy-state', 'success')
      expect(await panel.evaluate(element => ({ x: window.scrollX, y: window.scrollY, left: element.scrollLeft, top: element.scrollTop, width: element.scrollWidth }))).toEqual(initial)
      await expectCopySweepPaint(page, panel, 'wiki-code-block-copy-sweep', '::after', [90, 50, 10], testInfo)
      await expect(panel).not.toHaveClass(/wiki-code-copy-flash-run/u)
    }
    // Empty Prism blocks collapse to a line; they have no panel interior to
    // sample. Their Copy control must still deliver real error feedback.
    const empty = page.locator('#native-empty-copy')
    const emptyCopy = empty.locator('..').getByRole('button', { name: 'Copy', exact: true })
    await emptyCopy.scrollIntoViewIfNeeded()
    await emptyCopy.hover()
    await emptyCopy.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => { animation.finish() }))
    const emptyScroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
    await emptyCopy.click()
    await expect(emptyCopy).toHaveAttribute('data-copy-state', 'error')
    await expect(emptyCopy).toBeVisible()
    expect(await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))).toEqual(emptyScroll)
  })

  test('still paints inline copy feedback when both clipboard paths are denied', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-keyboard')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    // Fail only the browser clipboard boundary; production click/feedback and
    // animation behavior stay real, including the legacy fallback attempt.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new DOMException('Clipboard denied', 'NotAllowedError') } } })
      document.execCommand = () => false
    })
    await openReaderCopyFixture(page)
    const inline = page.locator('#native-inline-copy')
    await inline.scrollIntoViewIfNeeded()
    const before = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
    await pauseNextSweep(inline, 'wiki-inline-code-shimmer-sweep')
    await inline.click()
    await expect(inline).toHaveAttribute('data-inline-copy-state', 'error')
    expect(await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))).toEqual(before)
    await expectCopySweepPaint(page, inline, 'wiki-inline-code-shimmer-sweep', '', [100, 50, 0], testInfo)
  })

  test('runs one first-entry toolbar sweep and resumes only the delayed ambient cadence', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-keyboard')
    test.setTimeout(60_000)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.clock.install()
    await page.addInitScript(() => {
      const starts: number[] = []
      const inlineStarts: number[] = []
      Object.defineProperty(window, '__nativeToolbarSweepStarts', { value: starts })
      Object.defineProperty(window, '__nativeInlineSweepStarts', { value: inlineStarts })
      const observed = new WeakSet<Animation>()
      let mounted = false
      new MutationObserver(() => {
        const button = document.querySelector('#native-framed-copy .toolbar button')
        if (!button) return
        if (!mounted) {
          mounted = true
          Object.defineProperty(window, '__nativeToolbarMountedAt', { value: performance.now() })
        }
        const animation = button.getAnimations({ subtree: true }).find(candidate => candidate instanceof CSSAnimation && candidate.animationName === 'wiki-code-copy-shimmer-sweep')
        if (animation && !observed.has(animation)) {
          observed.add(animation)
          starts.push(performance.now())
          animation.pause()
        }
        const inline = document.querySelector('#native-inline-copy')
        for (const sweep of inline?.getAnimations() ?? []) {
          if (!(sweep instanceof CSSAnimation) || observed.has(sweep)) continue
          observed.add(sweep)
          inlineStarts.push(performance.now())
        }
      }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    })
    await openReaderCopyFixture(page)
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000)
    const panel = page.locator('#native-framed-copy')
    const copy = panel.getByRole('button', { name: 'Copy', exact: true })
    await copy.scrollIntoViewIfNeeded()
    await page.mouse.move(1, 1)
    const mountedAt = await page.evaluate(() => (window as typeof window & { __nativeToolbarMountedAt: number }).__nativeToolbarMountedAt)
    while (await page.evaluate(() => (window as typeof window & { __nativeToolbarSweepStarts: number[] }).__nativeToolbarSweepStarts.length) < 1) {
      const remaining = mountedAt + 18_000 - await page.evaluate(() => performance.now())
      if (remaining <= 0) break
      await page.clock.runFor(Math.min(100, remaining))
    }
    const ambientStarts = await page.evaluate(() => (window as typeof window & { __nativeToolbarSweepStarts: number[] }).__nativeToolbarSweepStarts)
    expect(ambientStarts).toHaveLength(1)
    const ambient = ambientStarts[0]!
    expect(ambient - mountedAt, 'An unhovered toolbar first animates after 9–18 seconds').toBeGreaterThanOrEqual(9000)
    expect(ambient - mountedAt).toBeLessThanOrEqual(18_000)
    await copy.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => { animation.finish() }))
    await expect(copy).not.toHaveClass(/wiki-copy-shimmer-run/u)
    const firstHoverTime = await page.evaluate(() => performance.now())
    await panel.locator('pre').hover()
    await expect.poll(() => copy.evaluate(element => element.getAnimations({ subtree: true }).some(animation => animation instanceof CSSAnimation && animation.playState === 'paused'))).toBe(true)
    await panel.locator('.toolbar').evaluate(element => {
      for (const animation of element.getAnimations({ subtree: true })) if (animation instanceof CSSTransition) animation.finish()
    })
    const hoverFrames: Buffer[] = []
    for (const [progress, travel] of [[0, -1.3], [0.5, 0], [1, 1.3]] as const) {
      const sample = await copy.evaluate((element, progress) => {
        const animation = element.getAnimations({ subtree: true }).find(candidate => candidate instanceof CSSAnimation && candidate.animationName === 'wiki-code-copy-shimmer-sweep')
        if (!animation) throw new Error('First-hover sweep is missing')
        const duration = Number(animation.effect?.getComputedTiming().duration)
        animation.currentTime = progress * duration - (progress === 1 ? 0.001 : 0)
        return { duration, travel: new DOMMatrixReadOnly(getComputedStyle(element, '::after').transform).m41 / element.getBoundingClientRect().width }
      }, progress)
      expect(sample.duration, 'Toolbar sweep runs at half the inline/block acknowledgment rate').toBe(1900)
      expect(sample.travel, `Toolbar band crosses the button at ${progress}`).toBeCloseTo(travel, 1)
      const image = await copy.screenshot({ animations: 'allow', scale: 'css' })
      hoverFrames.push(image)
      await testInfo.attach(`toolbar-first-hover-${progress}`, { body: image, contentType: 'image/png' })
    }
    const decoded = await Promise.all(hoverFrames.map(image => sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true })))
    const [start, middle, end] = decoded
    if (!start || !middle || !end) throw new Error('Toolbar sweep paint samples are missing')
    expect(middle.info).toEqual(start.info)
    expect(end.info).toEqual(start.info)
    let painted = 0
    let remainingPaint = 0
    const pixels = start.info.width * start.info.height
    for (let pixel = 0; pixel < pixels; pixel += 1) {
      const offset = pixel * 4
      if (rgbDistance(start.data, middle.data, offset) > 2) painted += 1
      if (rgbDistance(start.data, end.data, offset) > 2) remainingPaint += 1
    }
    expect(painted / pixels, 'First-hover attractor visibly paints the Copy button midpoint').toBeGreaterThan(0.05)
    expect(remainingPaint / pixels, 'The attractor leaves the button again at its end').toBeLessThan(0.05)
    await copy.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => { animation.finish() }))
    await expect(copy).not.toHaveClass(/wiki-copy-shimmer-run/u)
    // Cross descendants with real pointer movement, then leave/re-enter.
    await panel.locator('pre code').hover()
    await copy.hover()
    await page.mouse.move(1, 1)
    await panel.locator('pre').hover()
    expect(await page.evaluate(() => (window as typeof window & { __nativeToolbarSweepStarts: number[] }).__nativeToolbarSweepStarts)).toEqual([ambient, firstHoverTime])
    await page.clock.runFor(13_899)
    expect(await page.evaluate(() => (window as typeof window & { __nativeToolbarSweepStarts: number[] }).__nativeToolbarSweepStarts)).toEqual([ambient, firstHoverTime])
    while (await page.evaluate(() => (window as typeof window & { __nativeToolbarSweepStarts: number[] }).__nativeToolbarSweepStarts.length) < 3) {
      const remaining = firstHoverTime + 22_900 - await page.evaluate(() => performance.now())
      if (remaining <= 0) break
      await page.clock.runFor(Math.min(100, remaining))
    }
    expect(await page.evaluate(() => (window as typeof window & { __nativeToolbarSweepStarts: number[] }).__nativeToolbarSweepStarts.length)).toBe(3)
    const resumed = await page.evaluate(() => (window as typeof window & { __nativeToolbarSweepStarts: number[] }).__nativeToolbarSweepStarts[2]!)
    expect(resumed - firstHoverTime, 'Ambient resumes only after 1.9s sweep + 3s pause + 9–18s cadence').toBeGreaterThanOrEqual(13_900)
    expect(resumed - firstHoverTime).toBeLessThanOrEqual(22_900)
    await copy.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => { animation.finish() }))
    while (await page.evaluate(() => (window as typeof window & { __nativeToolbarSweepStarts: number[] }).__nativeToolbarSweepStarts.length) < 4) {
      const remaining = resumed + 18_000 - await page.evaluate(() => performance.now())
      if (remaining <= 0) break
      await page.clock.runFor(Math.min(100, remaining))
    }
    expect(await page.evaluate(() => (window as typeof window & { __nativeToolbarSweepStarts: number[] }).__nativeToolbarSweepStarts.length)).toBe(4)
    const next = await page.evaluate(() => (window as typeof window & { __nativeToolbarSweepStarts: number[] }).__nativeToolbarSweepStarts[3]!)
    expect(next - resumed, 'Subsequent ambient sweeps retain their independent 9–18s cadence').toBeGreaterThanOrEqual(9000)
    expect(next - resumed).toBeLessThanOrEqual(18_000)
    expect(await page.evaluate(() => (window as typeof window & { __nativeInlineSweepStarts: number[] }).__nativeInlineSweepStarts), 'No idle-time inline acknowledgment was painted anywhere in the observation window').toEqual([])
    await expect(page.locator('#native-inline-copy')).not.toHaveAttribute('data-inline-copy-state', /success|error/u)
  })
  test('meets WCAG gates on primary desktop surfaces', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-keyboard')
    for (const [surface, readySelector] of [
      ['/', '.page-header-section'],
      ['/a/dashboard', '.admin-dashboard'],
      ['/a/pages', '.pages-register'],
      ['/e/en/home', '.editor-markdown']
    ] as const) {
      await openAuthenticatedPage(page, surface, readySelector)
      await expectNoBlockingAccessibilityViolations(page, surface)
    }
  })

  test('reaches administration using only the keyboard', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-keyboard')
    await openAuthenticatedPage(page, '/', '.page-header-section')

    let reachedAdministration = false
    for (let press = 0; press < 40; press += 1) {
      await page.keyboard.press('Tab')
      const label = await page.evaluate(() => {
        const focused = document.activeElement
        return `${focused?.getAttribute('aria-label') ?? ''} ${focused?.textContent ?? ''}`
      })
      if (label.includes('Administration')) {
        reachedAdministration = true
        break
      }
    }

    expect(reachedAdministration, 'Administration must be reachable in the tab order').toBe(true)
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL('/a/dashboard')
  })

  test('meets contrast and accessibility gates in dark mode', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-dark')
    test.setTimeout(45_000)
    await openAuthenticatedPage(page, '/a/theme', '.theme-tabs')
    await expect(page.locator('.v-application')).toHaveClass(/v-theme--dark/)
    await expectNoBlockingAccessibilityViolations(page, '/a/theme (dark)')
  })

  test.describe('native short-page footer fixture', () => {
    // The HTML slot route must not be bypassed by an installed service worker.
    test.use({ serviceWorkers: 'block' })

    test('keeps the native short-page footer thin, bottom-pinned, and content-driven', async ({ page }, testInfo) => {
      requireAnyProject(testInfo, ['accessibility-keyboard', 'accessibility-mobile'])
      test.setTimeout(60_000)
      const width = testInfo.project.name === 'accessibility-mobile' ? 320 : 1280
      let expanded = false
      await page.route('**/en/visual-markdown-browser', async route => {
        const response = await route.fetch()
        if (!response.ok()) throw new Error(`Footer reader bootstrap returned HTTP ${response.status()}`)
        const document = await response.text()
        let configured = false
        // Only normal server boot inputs change. Vue/Vuetify render the real
        // shell, footer Markdown, product attribution and links without overrides.
        const notice = expanded
          ? 'Usage terms: This knowledge is shared for readers who retain attribution and review the applicable license before redistribution. '.repeat(16)
          : 'Usage terms.'
        let body = document.replace(/(var siteConfig\s*=\s*)(\{[^\n]*\})(?=\s*(?:\n|;|<\/script>))/u, (_match, prefix: string, json: string) => {
          configured = true
          return `${prefix}${JSON.stringify({ ...JSON.parse(json), footerOverride: `${notice} [Usage terms](/en/home).` })}`
        })
        body = body.replace(
          /(<template\b[^>]*data-wiki-page-contents[^>]*>)[\s\S]*?<\/template>/u,
          '$1<div><p id="native-short-footer-content">A short reader page.</p></div></template>'
        )
        if (!configured || !body.includes('id="native-short-footer-content"')) throw new Error('Footer fixture omitted its normal configuration or contents slot')
        await route.fulfill({ response, body })
      })
      const footer = page.locator('.nav-footer')
      const measureFooterTextExtent = () => footer.evaluate(element => {
        const bounds = element.getBoundingClientRect()
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        const textBounds: Array<{ left: number; top: number; right: number; bottom: number }> = []
        const hiddenText: string[] = []
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim()) continue
          const parent = node.parentElement
          if (!parent) throw new Error('Footer text has no containing element')
          const style = getComputedStyle(parent)
          const range = document.createRange()
          range.selectNodeContents(node)
          const fragments = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0)
          if (!fragments.length || style.visibility !== 'visible' || Number(style.opacity) === 0) hiddenText.push(node.textContent)
          for (const rect of fragments) textBounds.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })
        }
        return {
          top: bounds.top, bottom: bounds.bottom, height: bounds.height,
          contentHeight: Math.max(...textBounds.map(rect => rect.bottom)) - Math.min(...textBounds.map(rect => rect.top)),
          textBounds, hiddenText, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
          documentHeight: document.documentElement.scrollHeight, scrollY: window.scrollY
        }
      })
      let compactHeight = 0
      for (expanded of [false, true]) {
        await page.setViewportSize({ width, height: 1600 })
        await openAuthenticatedPage(page, '/en/visual-markdown-browser', '#native-short-footer-content')
        await page.evaluate(() => document.fonts.ready.then(() => undefined))
        await expect(footer.getByRole('link', { name: 'Usage terms', exact: true })).toBeVisible()
        await expect(footer.getByRole('link', { name: 'Source Code', exact: true })).toBeVisible()
        let firstHeight = 0
        for (const height of [1600, 2200]) {
          await page.setViewportSize({ width, height })
          await expect.poll(async () => {
            const geometry = await measureFooterTextExtent()
            return Math.abs(geometry.bottom - geometry.viewportHeight)
          }, 'Short-page footer reaches the viewport bottom without scrolling').toBeLessThanOrEqual(1)
          const geometry = await measureFooterTextExtent()
          expect(geometry.scrollY, 'A genuinely short reader needs no scroll to see its footer').toBe(0)
          expect(geometry.documentHeight, 'Short content and the footer fit in the viewport').toBeLessThanOrEqual(geometry.viewportHeight + 1)
          const article = await page.locator('#native-short-footer-content').boundingBox()
          if (!article) throw new Error('Short reader content has no visible geometry')
          expect(article.y + article.height, 'Real reader content leaves substantial viewport remainder').toBeLessThan(geometry.viewportHeight / 2)
          expect(geometry.hiddenText, 'All legal and product attribution text remains rendered').toEqual([])
          expect(geometry.height, 'The attribution retains a thin readable minimum').toBeGreaterThanOrEqual(15)
          expect(geometry.height, 'Footer extent follows its text, not the unused viewport remainder').toBeLessThanOrEqual(Math.max(32, geometry.contentHeight + 2))
          for (const rect of geometry.textBounds) {
            expect(rect.left, 'Footer text stays inside the viewport').toBeGreaterThanOrEqual(-1)
            expect(rect.right).toBeLessThanOrEqual(geometry.viewportWidth + 1)
            expect(rect.top, 'Footer contains the top of every attribution line').toBeGreaterThanOrEqual(geometry.top - 1)
            expect(rect.bottom, 'Footer contains the bottom of every attribution line').toBeLessThanOrEqual(geometry.bottom + 1)
          }
          for (const link of await footer.getByRole('link').all()) {
            await expect(link).toBeVisible()
            await expect(link).toBeInViewport({ ratio: 1 })
          }
          await expectResponsiveLayout(page, `Native ${expanded ? 'wrapped' : 'compact'} footer at ${width}x${height}`)
          if (height === 1600) firstHeight = geometry.height
          else expect(Math.abs(geometry.height - firstHeight), 'Increasing viewport remainder does not inflate the footer').toBeLessThanOrEqual(1)
          if (!expanded) {
            expect(geometry.height, 'Compact attribution is a thin bar').toBeLessThanOrEqual(32)
            compactHeight = geometry.height
          } else {
            expect(geometry.height, 'Wrapping legal content grows the footer rather than escaping a fixed-height bar').toBeGreaterThan(compactHeight + 12)
          }
          await testInfo.attach(`native-footer-${expanded ? 'wrapped' : 'compact'}-${width}x${height}`, {
            body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png'
          })
        }
      }
    })
  })

  test('avoids horizontal overflow across release viewport profiles', async ({ page }, testInfo) => {
    requireAnyProject(testInfo, ['accessibility-keyboard', 'accessibility-mobile', 'accessibility-tablet', 'accessibility-wide'])
    for (const [surface, readySelector] of [
      ['/', '.page-header-section'],
      ['/a/dashboard', '.admin-dashboard'],
      ['/a/pages', '.pages-register']
    ] as const) {
      await openAuthenticatedPage(page, surface, readySelector)
      await expectResponsiveLayout(page, surface)
      await expectNoBlockingAccessibilityViolations(page, `${surface} (mobile)`)
    }
  })

  test('opens and reaches primary editor actions using only the keyboard', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-keyboard')
    await openAuthenticatedPage(page, '/en/home', '.page-header-section')

    const editPage = page.locator('.nav-header button[aria-label="Edit"]')
    expect(await tabToControl(page, editPage), 'Edit must be reachable in the tab order').toBe(true)
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL('/e/en/home')
    const save = page.getByRole('button', { name: /^(?:save|saved)$/i })
    await expect(save).toBeVisible()
    expect(await tabToControl(page, save), 'Save must be reachable in the editor tab order').toBe(true)
  })

  test('announces search failure, retries, and exposes the empty result state', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-keyboard')
    await authenticateAsAdmin(page)
    let requests = 0
    await page.route(/\/_api\/pages\/search\?/, async route => {
      requests += 1
      if (requests === 1) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Search service is unavailable.' })
        })
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ results: [], suggestions: [], totalHits: 0 })
        })
      }
    })
    await page.goto('/', { waitUntil: 'networkidle' })
    const search = await openSearch(page)
    await page.keyboard.type('unavailable-query')
    await expect(page.getByRole('alert')).toContainText('Search service is unavailable.')
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'try a different term or scope.' })).toBeVisible()
  })

  test('keeps the inline agent keyboard-accessible at desktop and mobile widths', async ({ page }, testInfo) => {
    requireAnyProject(testInfo, ['accessibility-keyboard', 'accessibility-mobile'])
    await authenticateAsAdmin(page)
    await page.goto('/', { waitUntil: 'networkidle' })
    const search = await openSearch(page)
    await search.fill('home')
    const searchDialog = page.getByRole('dialog', { name: 'Search the Wiki', exact: true })
    await expect(searchDialog).toBeVisible()
    const askAgent = searchDialog.getByRole('button', { name: 'Ask about this', exact: true })
    await expect(askAgent).toBeVisible()
    await askAgent.click()
    await expect(page.getByRole('region', { name: 'Wiki Agent' })).toBeVisible()
    await expect(page.getByText(/Agent inference is currently disabled/)).toBeVisible()
    await expectResponsiveLayout(page, `inline agent (${testInfo.project.name})`)
    await expectNoBlockingAccessibilityViolations(page, `inline agent (${testInfo.project.name})`)
    if (testInfo.project.name === 'accessibility-keyboard') {
      const history = page.getByRole('region', { name: 'Wiki Agent' }).getByRole('button', { name: 'History', exact: true })
      expect(await tabToControl(page, history), 'Agent history must be reachable in the tab order').toBe(true)
    }
  })
  test('uses header glass around search results at desktop and mobile widths', async ({ page }, testInfo) => {
    requireAnyProject(testInfo, ['accessibility-keyboard', 'accessibility-mobile'])
    await openAuthenticatedPage(page, '/', '.page-header-section')
    const input = await openSearch(page)
    // A physical click catches overlays covering the mobile header extension.
    await input.click()
    const search = page.getByRole('dialog', { name: 'Search the Wiki', exact: true })
    await expect(search).toBeVisible()
    const headerGlass = await page.locator('.nav-header').evaluate(element => {
      const styles = getComputedStyle(element)
      return { background: styles.backgroundColor, blur: styles.backdropFilter }
    })
    const searchGlass = await search.evaluate(element => {
      const styles = getComputedStyle(element)
      return { background: styles.backgroundColor, blur: styles.backdropFilter }
    })
    expect(searchGlass.blur).toContain('blur(')
    // The results panel is lighter glass than the header, so exact blur strength may differ.
    // The results panel is a lighter glass than the header so the page stays visible behind it.
    expect(cssColorAlpha(searchGlass.background)).toBeGreaterThan(0)
    expect(cssColorAlpha(searchGlass.background)).toBeLessThan(cssColorAlpha(headerGlass.background))
    await expectResponsiveLayout(page, 'search glass')
  })
  test('runs enabled Agent failure, retry, and header activation through a real workspace', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-keyboard')
    const fixture = await installEnabledAgentFixture(page, { mode: 'retry' })
    test.setTimeout(60_000)
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await openAuthenticatedPage(page, '/', '.page-header-section')
      const agentTrigger = page.getByRole('button', { name: 'Open Wiki Agent' })
      await expect(agentTrigger).not.toHaveAttribute('title', /Shift/u)
      await agentTrigger.hover()
      const agentTooltip = page.locator('.v-tooltip.v-overlay--active').filter({ hasText: 'Wiki Agent' })
      await expect(agentTooltip).toBeVisible()
      await expect(agentTooltip).toHaveText('Wiki Agent')
      await page.getByRole('button', { name: 'Open Wiki Agent' }).click()
      const agent = page.getByRole('region', { name: 'Wiki Agent' })
      await expect(agent).toBeVisible()
      await expect(agent.locator('.inline-agent__identity .inline-agent__agent-mark')).toHaveCount(0)
      const composer = agent.getByRole('textbox', { name: 'Message Wiki Agent' })
      await composer.fill('Please retry this release evidence request.')
      await agent.getByRole('button', { name: 'Send', exact: true }).click()
      const failedResponse = agent.locator('article.agent-message--assistant.agent-message--failed')
      await expect(failedResponse.getByText('Response could not be completed', { exact: true })).toBeVisible()
      const userAvatar = agent.locator('.agent-message--user .agent-message__user-avatar').first()
      const assistantMark = failedResponse.locator('.agent-message__assistant-mark')
      await expect(userAvatar).toBeVisible()
      await expect(assistantMark).toBeVisible()
      const accountAvatar = page.locator('.account-menu__trigger .v-avatar')
      await expect(accountAvatar).toBeVisible()
      expect(await userAvatar.evaluate(element => element.querySelector('img')?.getAttribute('src') ?? element.textContent?.trim())).toBe(
        await accountAvatar.evaluate(element => element.querySelector('img')?.getAttribute('src') ?? element.textContent?.trim())
      )
      await agent.getByRole('button', { name: 'Try again', exact: true }).click()
      await agent.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(agent.getByText('The release is ready for a deliberate review.', { exact: true })).toBeVisible()
      await expect(agent.locator('[data-agent-citation]')).not.toHaveCount(0)
      await expect(agent.getByRole('img', { name: 'Mermaid diagram', exact: true })).toBeVisible()
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await userAvatar.scrollIntoViewIfNeeded()
      await page.screenshot({ path: testInfo.outputPath('agent-turn-avatars.png') })
      await expectResponsiveLayout(page, 'enabled Agent retry')
      await expectNoBlockingAccessibilityViolations(page, 'enabled Agent retry')
      expect(fixture.requests.some(request => request.includes('/events'))).toBe(true)
      fixture.assertNoUnexpectedRequests()
    } finally {
      await fixture.dispose()
    }
  })
  test('shows Agent glass throughout its opening animation', async ({ page }, testInfo) => {
    test.setTimeout(60_000)
    requireAnyProject(testInfo, ['accessibility-keyboard', 'accessibility-mobile'])
    const fixture = await installEnabledAgentFixture(page, { mode: 'success' })
    try {
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await openAuthenticatedPage(page, '/', '.page-header-section')
      await page.getByRole('button', { name: 'Open Wiki Agent' }).click()
      const agent = page.locator('.inline-agent--contextual')
      await expect(agent).toBeVisible()
      const container = page.locator('.search-results-container--ask')
      // Seek the actual entrance animation: inspecting only its settled state misses
      // opacity on an ancestor temporarily cutting glass off from the page backdrop.
      const frames = await container.evaluate(element => {
        const animation = element.getAnimations()[0]
        if (!animation) throw new Error('Expected the Agent entrance animation')
        animation.pause()
        const duration = Number(animation.effect?.getTiming().duration)
        return [0, 0.25, 0.5, 0.99].flatMap(progress => {
          animation.currentTime = duration * progress
          return Array.from(element.querySelectorAll('.inline-agent__toolbar, .inline-agent__body')).map(surface => {
            const style = getComputedStyle(surface)
            const blockedBy: string[] = []
            for (let parent = surface.parentElement; parent; parent = parent.parentElement) {
              if (Number(getComputedStyle(parent).opacity) < 1) blockedBy.push(parent.className)
            }
            return { progress, blur: style.backdropFilter, background: style.backgroundColor, blockedBy }
          })
        })
      })
      expect(frames).toHaveLength(8)
      for (const frame of frames) {
        expect(frame.blockedBy, `Glass must see the page at entrance progress ${frame.progress}`).toEqual([])
        expect(frame.blur).toContain('blur(')
        expect(frame.background).toMatch(/^(rgba\(|color\()/u)
      }
      await page.screenshot({ path: testInfo.outputPath('agent-opening-glass.png') })
      await container.evaluate(element => {
        for (const animation of element.getAnimations()) animation.finish()
      })
      if (testInfo.project.name === 'accessibility-mobile') {
        await agent.getByRole('region', { name: 'Conversation transcript' }).focus()
      } else {
        await expect(agent.getByRole('textbox', { name: 'Message Wiki Agent' })).toBeFocused()
      }
      await page.keyboard.press('Escape')
      await expect(agent).toBeHidden()
      const search = page.getByRole('dialog', { name: 'Search the Wiki', exact: true })
      await expect(search).toBeHidden()
      await page.getByRole('button', { name: 'Open Wiki Agent' }).click()
      await expect(agent).toBeVisible()
      await page.keyboard.press('Control+Shift+A')
      await expect(agent).toBeHidden()
      await expect(search).toBeVisible()
      const restoredSearchInput = page.locator('.nav-header-search-control input:visible').first()
      await expect(restoredSearchInput).toBeVisible()
      await restoredSearchInput.focus()
      await expect(restoredSearchInput).toBeFocused()
      // The search dialog keeps its own lighter glass; only check it stayed glassy.
      const restoredGlass = await search.evaluate(element => getComputedStyle(element).backdropFilter)
      expect(restoredGlass).toContain('blur(')
      expect(frames[0].blur).toContain('blur(')
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.getByRole('button', { name: 'Open Wiki Agent' }).click()
      await expect(agent).toBeVisible()
      await expect(container).toHaveCSS('animation-name', 'none')
      await expect(agent.locator('.inline-agent__body')).toHaveCSS('opacity', '1')
      await expect(agent.locator('.inline-agent__toolbar > *').first()).toHaveCSS('animation-name', 'none')
      await expect(agent.locator('.inline-agent__body > *').first()).toHaveCSS('animation-name', 'none')
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }]
      })
      await expect(agent.locator('.inline-agent__body')).toHaveCSS('backdrop-filter', 'none')
      await cdp.detach()
      fixture.assertNoUnexpectedRequests()
    } finally {
      await fixture.dispose()
    }
  })
  test('keeps contextual Agent glass isolated from opaque surfaces', async ({ page }, testInfo) => {
    requireAnyProject(testInfo, ['accessibility-keyboard', 'accessibility-mobile'])
    test.setTimeout(60_000)
    const fixture = await installEnabledAgentFixture(page, { mode: 'success' })
    const cdp = await page.context().newCDPSession(page)
    try {
      const agent = await openEnabledAgent(page)
      await expect(agent).toHaveClass(/inline-agent--contextual/)
      const composerSurround = agent.locator('.inline-agent__composer')
      await expect(composerSurround).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await expect(composerSurround).toHaveCSS('box-shadow', 'none')
      const greetingBackdrop = await agent.locator('.inline-agent__welcome-title').evaluate(element => {
        const styles = getComputedStyle(element, '::before')
        return { background: styles.backgroundImage, filter: styles.filter, pointerEvents: styles.pointerEvents }
      })
      expect(greetingBackdrop.background).toContain('radial-gradient')
      expect(greetingBackdrop.filter).toContain('blur')
      expect(greetingBackdrop.pointerEvents).toBe('none')
      const greetingOpacity = () => agent.locator('.inline-agent__welcome-title').evaluate(element => getComputedStyle(element, '::before').opacity)
      await expect.poll(greetingOpacity).toBe('1')
      const transcriptWidth = await agent
        .locator('.inline-agent__transcript')
        .evaluate(element => ({ content: element.scrollWidth, viewport: element.clientWidth }))
      expect(transcriptWidth.content, 'The oval does not add horizontal scrolling').toBeLessThanOrEqual(transcriptWidth.viewport)
      await expect(agent.getByRole('button', { name: 'Understand This Page' })).toBeVisible()
      await agent.locator('.agent-context__page-chip').click()
      await expect.poll(greetingOpacity).toBe('0')
      await expect(agent.getByRole('button', { name: 'Understand This Page' })).toHaveCount(0)
      await expect(agent.getByRole('button', { name: 'Explore the Wiki' })).toBeVisible()
      await agent.locator('.agent-context__page-chip').click()
      await expect(agent.getByRole('button', { name: 'Understand This Page' })).toBeVisible()
      await expect.poll(greetingOpacity).toBe('1')
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }]
      })
      await expect.poll(greetingOpacity).toBe('0')
      await cdp.send('Emulation.setEmulatedMedia', { features: [] })
      await expect.poll(greetingOpacity).toBe('1')
      const composer = agent.getByRole('textbox', { name: 'Message Wiki Agent' })
      await composer.fill('Inspect the contextual Agent surface hierarchy.')
      await agent.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(agent.getByText('The release is ready for a deliberate review.', { exact: true })).toBeVisible()

      const toolbar = agent.locator('.inline-agent__toolbar')
      const body = agent.locator('.inline-agent__body')
      const readSurfaceStyle = async (locator: Locator) => {
        const color = await locator.evaluate(element => getComputedStyle(element).backgroundColor)
        const styles = await locator.evaluate(element => {
          const computed = getComputedStyle(element)
          return { opacity: computed.opacity, backdropFilter: computed.backdropFilter }
        })
        return {
          backgroundAlpha: cssColorAlpha(color),
          opacity: Number(styles.opacity),
          backdropFilter: styles.backdropFilter
        }
      }
      const expectOpaque = async (locator: Locator, surface: string): Promise<void> => {
        const styles = await readSurfaceStyle(locator)
        expect(styles.backgroundAlpha, `${surface} keeps an opaque background`).toBe(1)
        expect(styles.opacity, `${surface} keeps full element opacity`).toBe(1)
        expect(styles.backdropFilter, `${surface} does not become a glass layer`).toBe('none')
      }
      const expectContextualGlass = async (reduced: boolean) => {
        const [toolbarStyles, bodyStyles] = await Promise.all([readSurfaceStyle(toolbar), readSurfaceStyle(body)])
        if (reduced) {
          expect(toolbarStyles.backgroundAlpha, 'Reduced transparency makes the Agent toolbar opaque').toBe(1)
          expect(bodyStyles.backgroundAlpha, 'Reduced transparency makes the Agent body opaque').toBe(1)
          expect(toolbarStyles.backdropFilter, 'Reduced transparency removes toolbar blur').toBe('none')
          expect(bodyStyles.backdropFilter, 'Reduced transparency removes body blur').toBe('none')
        } else {
          expect(toolbarStyles.backgroundAlpha, 'Normal transparency keeps the Agent toolbar translucent').toBeLessThan(1)
          expect(bodyStyles.backgroundAlpha, 'Normal transparency keeps the Agent body translucent').toBeLessThan(1)
          expect(toolbarStyles.backdropFilter, 'Normal transparency blurs the Agent toolbar').toContain('blur')
          expect(bodyStyles.backdropFilter, 'Normal transparency blurs the Agent body').toContain('blur')
        }
        expect(toolbarStyles.opacity).toBe(1)
        expect(bodyStyles.opacity).toBe(1)
        return { toolbarStyles, bodyStyles }
      }
      const expectOpaqueWorkspaceSurfaces = async (): Promise<void> => {
        const messageSurfaces = agent.locator('.agent-message__surface')
        await expect(messageSurfaces).toHaveCount(2)
        for (const surface of await messageSurfaces.all()) await expectOpaque(surface, 'Agent message surface')

        await agent.getByRole('button', { name: 'History', exact: true }).click()
        const history = agent.locator('.inline-agent__side--history')
        await expect(history).toBeVisible()
        await expectOpaque(history, 'Agent history')
        await history.getByRole('button', { name: 'Close chat history' }).click()
        await expect(history).toBeHidden()

        // Memory sits beside History on wider layouts and in More chat actions on phones.
        const memoryToggle = agent.getByRole('button', { name: 'Memory', exact: true })
        if (await memoryToggle.isVisible()) await memoryToggle.click()
        else {
          await agent.getByRole('button', { name: 'More chat actions', exact: true }).click()
          await agent.locator('.v-menu.v-overlay--active').getByText('Memory', { exact: true }).click()
        }
        const memory = agent.locator('.inline-agent__side--memory')
        await expect(memory).toBeVisible()
        await expectOpaque(memory, 'Agent memory')
        await memory.getByRole('button', { name: 'Close agent memory' }).click()
        await expect(memory).toBeHidden()
      }

      const { toolbarStyles, bodyStyles } = await expectContextualGlass(false)
      // The toolbar is a harder glass than the conversation so page text under it stays unreadable.
      expect(blurRadius(toolbarStyles.backdropFilter)).toBeGreaterThan(blurRadius(bodyStyles.backdropFilter))
      const card = agent.locator('.inline-agent__card')
      const included = agent.locator('.agent-context__page-chip')
      await expect(included).toBeEnabled()
      const fadingColor = await included.evaluate(async element => {
        const body = document.querySelector('.inline-agent__body')!
        // Capture the fade between frames: transition events can be skipped
        // under load, but the painted color must still pass through midpoints.
        ;(element as HTMLElement).click()
        return await new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Excluding the current page must animate the workspace background')), 5000)
          const sample = () => {
            const fade = body.getAnimations().find(animation => animation instanceof CSSTransition && animation.transitionProperty === 'background-color')
            if (fade) {
              fade.pause()
              fade.currentTime = Number(fade.effect?.getComputedTiming().duration) / 2
              clearTimeout(timeout)
              resolve(getComputedStyle(body).backgroundColor)
              return
            }
            requestAnimationFrame(sample)
          }
          requestAnimationFrame(sample)
        })
      })
      const fadingAlpha = cssColorAlpha(fadingColor)
      expect(fadingAlpha, 'Excluding the page fades the glass towards opaque').toBeGreaterThan(bodyStyles.backgroundAlpha)
      expect(fadingAlpha, 'Excluding the page does not snap to opaque').toBeLessThan(1)
      await body.evaluate(element =>
        element.getAnimations().forEach(animation => {
          animation.play()
        })
      )
      await expect.poll(async () => (await readSurfaceStyle(body)).backgroundAlpha).toBe(1)
      await expect.poll(async () => (await readSurfaceStyle(card)).backgroundAlpha).toBe(1)
      await included.click()
      await expect.poll(async () => (await readSurfaceStyle(body)).backgroundAlpha).toBe(bodyStyles.backgroundAlpha)
      await expect.poll(async () => (await readSurfaceStyle(card)).backgroundAlpha).toBe(0)

      await page.emulateMedia({ reducedMotion: 'reduce' })
      for (const surface of [card, toolbar, body]) {
        // The global accessibility reset retains a 1µs transition for events.
        const duration = await surface.evaluate(element => Number.parseFloat(getComputedStyle(element).transitionDuration))
        expect(duration, 'Reduced motion removes any perceptible background fade').toBeLessThanOrEqual(0.000001)
      }
      await included.click()
      expect((await readSurfaceStyle(body)).backgroundAlpha).toBe(1)
      await included.click()
      await expectContextualGlass(false)
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await expectOpaqueWorkspaceSurfaces()

      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }]
      })
      await expect.poll(() => page.evaluate(() => window.matchMedia('(prefers-reduced-transparency: reduce)').matches)).toBe(true)
      await expectContextualGlass(true)
      await expectOpaqueWorkspaceSurfaces()
      fixture.assertNoUnexpectedRequests()
    } finally {
      await cdp.send('Emulation.setEmulatedMedia', { features: [] }).catch(() => undefined)
      await fixture.dispose()
    }
  })

  test('exposes Stop response while an enabled Agent stream is active', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-keyboard')
    const fixture = await installEnabledAgentFixture(page, { mode: 'stop' })
    try {
      const agent = await openEnabledAgent(page)
      const composer = agent.getByRole('textbox', { name: 'Message Wiki Agent' })
      await composer.fill('Stop this response after streaming begins.')
      await agent.getByRole('button', { name: 'Send', exact: true }).click()
      const stop = agent.getByRole('button', { name: 'Stop response', exact: true })
      await expect(stop).toBeVisible()
      await stop.click()
      const stoppedResponse = agent.locator('article.agent-message--assistant.agent-message--cancelled')
      await expect(stoppedResponse).toBeVisible()
      await expect(stop).toBeHidden()
      const followUpComposer = agent.getByRole('textbox', { name: 'Follow up with Wiki Agent' })
      await expect(followUpComposer).toBeEnabled()
      await expect(agent.getByRole('status').filter({ hasText: /^Ready$/ })).toBeVisible()
      fixture.assertNoUnexpectedRequests()
    } finally {
      await fixture.dispose()
    }
  })

  test('renders pending approval and resolves it without leaving the Agent surface', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-keyboard')
    const fixture = await installEnabledAgentFixture(page, { mode: 'approval' })
    try {
      const agent = await openEnabledAgent(page)
      const composer = agent.getByRole('textbox', { name: 'Message Wiki Agent' })
      await composer.fill('Prepare the reviewed release note and ask for approval.')
      await agent.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(agent.getByText('Awaiting approval', { exact: true })).toBeVisible()
      const deny = agent.getByRole('button', { name: 'Deny', exact: true })
      await expect(deny).toBeVisible()
      await deny.click()
      const deniedHeading = agent.locator('strong').filter({ hasText: /^Change denied$/u })
      await expect(deniedHeading).toBeVisible()
      await expect(deny).toBeHidden()
      fixture.assertNoUnexpectedRequests()
    } finally {
      await fixture.dispose()
    }
  })

  test('contains Ask keyboard focus and returns to the page on Escape', async ({ page }, testInfo) => {
    test.setTimeout(60_000)
    requireProject(testInfo, 'accessibility-keyboard')
    await authenticateAsAdmin(page)
    await page.goto('/', { waitUntil: 'networkidle' })
    const search = page.locator('.nav-header-search-control input:visible').first()
    await expect(search).toBeVisible()
    const pageOpener = page.getByRole('button', { name: 'Focus', exact: true })
    await pageOpener.focus()
    await expect(pageOpener).toBeFocused()
    await search.focus()
    await page.keyboard.press('Control+Shift+A')

    const dialog = page.getByRole('dialog', { name: 'Wiki Agent workspace' })
    await expect(dialog).toBeVisible()
    await expect.poll(() => dialog.evaluate(root => root.contains(document.activeElement))).toBe(true)
    const backgroundState = await page
      .locator('main')
      .first()
      .evaluate(element => {
        const isolatedAncestor = element.closest<HTMLElement>('[inert][aria-hidden="true"]')
        return {
          ariaHidden: isolatedAncestor?.getAttribute('aria-hidden'),
          inert: isolatedAncestor?.inert === true
        }
      })
    expect(backgroundState).toEqual({ ariaHidden: 'true', inert: true })
    await expect
      .poll(() =>
        search.evaluate(element => {
          const isolatedAncestor = element.closest<HTMLElement>('[inert][aria-hidden="true"]')
          return isolatedAncestor?.inert === true
        })
      )
      .toBe(true)

    const tabbableCount = await dialog.evaluate(
      root =>
        Array.from(
          root.querySelectorAll<HTMLElement>(
            [
              'a[href]',
              'button:not([disabled])',
              'input:not([disabled]):not([type="hidden"])',
              'select:not([disabled])',
              'textarea:not([disabled])',
              '[contenteditable="true"]',
              '[tabindex]:not([tabindex="-1"])'
            ].join(',')
          )
        ).filter(element => {
          const style = window.getComputedStyle(element)
          return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
        }).length
    )
    expect(tabbableCount).toBeGreaterThan(1)
    for (let press = 0; press <= tabbableCount; press += 1) {
      await page.keyboard.press('Tab')
      expect(await dialog.evaluate(root => root.contains(document.activeElement)), `Tab ${press + 1} left the Ask dialog`).toBe(true)
    }
    for (let press = 0; press <= tabbableCount; press += 1) {
      await page.keyboard.press('Shift+Tab')
      expect(await dialog.evaluate(root => root.contains(document.activeElement)), `Shift+Tab ${press + 1} left the Ask dialog`).toBe(true)
    }

    const escapeSource = dialog.getByRole('region', { name: 'Conversation transcript' })
    await escapeSource.focus()
    await expect(escapeSource).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Search the Wiki', exact: true })).not.toBeVisible()
    await expect
      .poll(() =>
        page
          .locator('main')
          .first()
          .evaluate(element => {
            if (!(element instanceof HTMLElement)) throw new Error('Expected an HTML main element')
            return {
              ariaHidden: element.getAttribute('aria-hidden'),
              inert: element.inert
            }
          })
      )
      .toEqual({ ariaHidden: null, inert: false })
    await expect(pageOpener).toBeFocused()
  })
  test('leaves the denied agent shortcut unconsumed', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-keyboard')
    await page.goto('/en/home', { waitUntil: 'networkidle' })

    const search = await openSearch(page)
    const dispatchResult = await search.evaluate(element => {
      const event = new KeyboardEvent('keydown', {
        key: 'a',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })
      return { dispatched: element.dispatchEvent(event), defaultPrevented: event.defaultPrevented }
    })

    expect(dispatchResult).toEqual({ dispatched: true, defaultPrevented: false })
    await expect(search).toBeFocused()
    await expect(page.getByRole('dialog', { name: 'Wiki Agent workspace' })).toHaveCount(0)
  })

  test('keeps page navigation and return-to-top controls reachable below desktop width', async ({ page }, testInfo) => {
    requireProject(testInfo, 'accessibility-mobile')
    await page.setViewportSize({ width: 1180, height: 500 })
    await openAuthenticatedPage(page, '/en/visual-markdown-browser', '.v-main')

    const drawer = page.locator('.v-navigation-drawer').first()
    await expect(drawer).toHaveClass(/v-navigation-drawer--temporary/)
    await expect(drawer).not.toHaveClass(/v-navigation-drawer--active/)
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await expect(drawer).toHaveClass(/v-navigation-drawer--active/)
    await page.getByRole('button', { name: 'Close navigation' }).click()
    await expect(drawer).not.toHaveClass(/v-navigation-drawer--active/)

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    const returnToTop = page.getByRole('button', { name: /return to top/i })
    await expect(returnToTop).toBeVisible()
    await returnToTop.click()
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(2)
  })
})
