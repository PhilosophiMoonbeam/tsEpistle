async function main() {
  const { chromium } = require('playwright')
  const baseURL = process.env.TSEPISTLE_SMOKE_URL?.replace(/\/$/u, '')
  if (!baseURL || !URL.canParse(baseURL) || new URL(baseURL).protocol !== 'https:') {
    throw new Error('TSEPISTLE_SMOKE_URL must be an HTTPS origin')
  }

  const browser = await chromium.launch({ headless: true, args: ['--disable-webgpu', '--enable-unsafe-swiftshader'] })
  try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'no-preference',
    serviceWorkers: 'block'
  })
  const page = await context.newPage()
  const failures = []
  let reducedMotionTeardownStarted = false
  page.on('pageerror', error => failures.push(`pageerror: ${error.message}`))
  page.on('requestfailed', request => {
    const failure = request.failure()?.errorText ?? ''
    // Switching to reduced motion retires the particle scene and may cancel
    // an asset request that was still in flight at teardown.
    if (reducedMotionTeardownStarted && failure === 'net::ERR_ABORTED' && new URL(request.url()).pathname.endsWith('/particle.bin')) return
    failures.push(`requestfailed: ${request.url()} ${failure}`)
  })
  page.on('console', message => {
    if (message.type() !== 'error') return
    const url = message.location().url || 'unknown-url'
    // A site administrator may retain a historical custom background URL. It is
    // outside the application bundle and must not hide any other console error.
    if (url === `${baseURL}/loginv2.jpg` && message.text().includes('404')) return
    // The scene can retire an in-flight renderer lease during backend retry
    // or reduced-motion teardown. Canvas/fallback checks below still verify
    // that the login remains usable.
    if (
      message.text().includes('[TresJS] Renderer initialization failed') &&
      message.text().includes('Particle backend lease was retired')
    ) return
    failures.push(`console: ${url}: ${message.text()}`)
  })

  const response = await page.goto(`${baseURL}/login`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  if (!response || response.status() !== 200) throw new Error(`Login returned ${response?.status() ?? 'no response'}`)
  await page.locator('#login-site-title').waitFor({ state: 'visible' })
  const providerPicker = page.getByText('Select Authentication Provider', { exact: true })
  if (await providerPicker.isVisible()) {
    const localProvider = process.env.TSEPISTLE_SMOKE_LOCAL_PROVIDER ||
      ((await page.getByRole('option', { name: 'Backend', exact: true }).count()) ? 'Backend' : 'Local')
    await page.getByRole('option', { name: localProvider, exact: true }).click()
  }
  const email = page.getByLabel('Email Address', { exact: true })
  await email.waitFor({ state: 'visible' })
  await page.getByLabel('Password', { exact: true }).waitFor({ state: 'visible' })
  if (!(await page.getByRole('button', { name: 'Log In', exact: true }).isEnabled())) throw new Error('Login button is disabled')

  const field = page.locator('.login-particle-logo')
  if (await field.count()) {
    if ((await field.getAttribute('aria-hidden')) !== 'true') throw new Error('Particle logo is exposed to assistive technology')
    if (await field.locator('.login-particle-logo__silhouette').count()) throw new Error('Obsolete logo silhouette is present')
    const deadline = Date.now() + 20_000
    let committed = false
    while (Date.now() < deadline) {
      const state = await field.evaluate(element => ({
        canvases: element.querySelectorAll('canvas').length,
        opacity: getComputedStyle(element.querySelector('.login-particle-logo__image')).opacity
      }))
      if (state.canvases === 1 && state.opacity === '0') { committed = true; break }
      if (state.canvases === 0 && state.opacity === '1' && Date.now() > deadline - 10_000) break
      await page.waitForTimeout(200)
    }
    if (committed) {
      const canvas = field.locator('canvas')
      const backend = await canvas.evaluate(element => element.getContext('webgl2') ? 'webgl2' : 'unknown')
      if (backend !== 'webgl2') throw new Error(`Forced fallback committed unexpected backend: ${backend}`)
      const bounds = await canvas.boundingBox()
      if (!bounds || bounds.width < 100 || bounds.height < 100) throw new Error('Particle canvas has invalid bounds')
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      await page.mouse.down()
      await page.mouse.up()
    }
    await email.focus()
    reducedMotionTeardownStarted = true
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.waitForFunction(() => document.querySelectorAll('.login-particle-logo canvas').length === 0)
    if (!(await email.evaluate(element => element === document.activeElement))) throw new Error('Reduced-motion teardown disturbed login focus')
  }
  if (failures.length > 0) throw new Error(failures.join(' | '))
    console.log('login smoke passed: controls usable, logo fallback valid, reduced-motion teardown clean')
  } finally {
    await browser.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
