import fs from 'node:fs'
import path from 'node:path'

import { compileScript, compileStyle, compileTemplate, parse } from '@vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import type { Component } from 'vue'
import { afterEach, describe, expect, it } from '../../../server/test/bun-test.mts'
import type { PageBrandingView } from '../../../shared/page-branding.ts'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/wiki/page'
})
const browserWindow = dom.window
const browserGlobals: Record<string, unknown> = {
  document: browserWindow.document,
  window: browserWindow,
  navigator: browserWindow.navigator,
  Element: browserWindow.Element,
  Event: browserWindow.Event,
  HTMLImageElement: browserWindow.HTMLImageElement,
  HTMLElement: browserWindow.HTMLElement,
  MutationObserver: browserWindow.MutationObserver,
  Node: browserWindow.Node,
  SVGElement: browserWindow.SVGElement,
  Text: browserWindow.Text
}
for (const [name, value] of Object.entries(browserGlobals)) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}
const pagePath = path.join(process.cwd(), 'client/themes/default/components/page.vue')
const pageSource = fs.readFileSync(pagePath, 'utf8')
const pageParsed = parse(pageSource, { filename: pagePath })
if (pageParsed.errors.length > 0) throw new Error(`Could not parse page.vue: ${pageParsed.errors.join(', ')}`)
const compiledPageStyle = compileStyle({
  source: pageParsed.descriptor.styles.map(style => style.content).join('\n'),
  filename: pagePath,
  id: 'page-branding-mark-layout-test',
  preprocessLang: 'scss'
})
if (compiledPageStyle.errors.length > 0) {
  throw new Error(`Could not compile page.vue styles: ${compiledPageStyle.errors.join(', ')}`)
}
const pageStyleElement = browserWindow.document.createElement('style')
pageStyleElement.textContent = compiledPageStyle.code
browserWindow.document.head.append(pageStyleElement)

// Vue's runtime-dom captures the document at module evaluation, so import it only after JSDOM globals exist.
const VueRuntime = await import('vue')
const componentPath = path.join(process.cwd(), 'client/components/common/page-branding-mark.vue')
const componentSource = fs.readFileSync(componentPath, 'utf8')
const parsed = parse(componentSource, { filename: componentPath })
if (parsed.errors.length > 0) throw new Error(`Could not parse page-branding-mark.vue: ${parsed.errors.join(', ')}`)
if (!parsed.descriptor.scriptSetup || !parsed.descriptor.template) {
  throw new Error('page-branding-mark.vue script setup or template was not found')
}

const componentId = 'page-branding-mark-behavior-test'
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
  throw new Error(`Could not compile page-branding-mark.vue: ${compiledTemplate.errors.join(', ')}`)
}
const compiledComponent = `${compiledScript.content}
${compiledTemplate.code}
__sfc__.render = render
export default __sfc__
`

const bundle = await Bun.build({
  entrypoints: ['virtual:PageBrandingMark.vue'],
  external: ['vue'],
  format: 'cjs',
  plugins: [
    {
      name: 'page-branding-mark-test-sfc',
      setup(build) {
        build.onResolve({ filter: /^virtual:PageBrandingMark\.vue$/ }, () => ({
          path: componentPath
        }))
        build.onLoad({ filter: /page-branding-mark\.vue$/, namespace: 'file' }, () => ({
          contents: compiledComponent,
          loader: 'ts',
          resolveDir: path.dirname(componentPath)
        }))
      }
    }
  ],
  target: 'bun'
})
if (!bundle.success || bundle.outputs.length !== 1) {
  throw new Error(`Could not bundle page-branding-mark.vue: ${bundle.logs.map(log => log.message).join(', ')}`)
}
const bundleCode = await bundle.outputs[0]!.text()
const moduleStart = bundleCode.indexOf('(function(')
if (moduleStart < 0) throw new Error('Compiled page-branding-mark.vue did not produce a CommonJS module')
interface CompiledModule {
  exports: { default?: Component }
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
    if (specifier === 'vue') return VueRuntime
    throw new Error(`Unexpected import in page-branding-mark.vue: ${specifier}`)
  },
  compiledModule,
  componentPath,
  path.dirname(componentPath)
)
const PageBrandingMark = compiledModule.exports.default
if (!PageBrandingMark) throw new Error('page-branding-mark.vue did not export a component')

const mountedApps: Array<() => void> = []
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn += 1) await VueRuntime.nextTick()
}

const makeBranding = (assetId: number, digest: string): PageBrandingView => ({
  assetId,
  imageUrl: `/assets/page-branding/${assetId}.png?v=${digest}`,
  sourceSha256: digest,
  width: 96,
  height: 64,
  accent: '#0C2238'
})

const identityOf = (branding: PageBrandingView | null): string | null => (branding === null ? null : `${branding.assetId}:${branding.sourceSha256}`)
type TextDirection = 'ltr' | 'rtl'

interface BrandingHeaderFixture {
  root: HTMLElement
  headings: HTMLElement
  label: HTMLElement
  title: HTMLElement
  description: HTMLElement
  mark: HTMLElement
}

const mountBrandingHeader = (direction: TextDirection): BrandingHeaderFixture => {
  const root = browserWindow.document.createElement('div')
  root.className = `wiki-page is-${direction}`
  root.setAttribute('dir', direction)

  const section = browserWindow.document.createElement('div')
  section.className = 'page-header-section'
  const pageHeader = browserWindow.document.createElement('div')
  pageHeader.className = 'is-page-header'
  const headings = browserWindow.document.createElement('div')
  headings.className = 'page-header-headings page-header-headings--branded'
  headings.style.setProperty('--page-branding-mark-size', '80px')

  const label = browserWindow.document.createElement('div')
  label.className = 'page-document-label'
  const title = browserWindow.document.createElement('div')
  title.className = 'page-title-row'
  const description = browserWindow.document.createElement('p')
  description.className = 'page-description'
  const mark = browserWindow.document.createElement('span')
  mark.className = 'page-branding-mark'

  headings.append(label, title, description, mark)
  pageHeader.append(headings)
  section.append(pageHeader)
  root.append(section)
  browserWindow.document.body.append(root)

  return { root, headings, label, title, description, mark }
}

const physicalInlineSide = (container: HTMLElement, item: HTMLElement): 'left' | 'right' => {
  const direction = browserWindow.getComputedStyle(container).direction
  const column = Number.parseInt(browserWindow.getComputedStyle(item).gridColumn, 10)
  if (!Number.isInteger(column) || (column !== 1 && column !== 2)) {
    throw new Error(`Expected an explicit two-column grid placement, got ${column}`)
  }
  if (direction === 'rtl') return column === 1 ? 'right' : 'left'
  return column === 2 ? 'right' : 'left'
}

interface MountedMark {
  host: HTMLElement
  events: string[]
  root: () => HTMLElement | null
  image: () => HTMLImageElement | null
  setBranding: (branding: PageBrandingView | null) => Promise<void>
}

const mountMark = async (initialBranding: PageBrandingView | null): Promise<MountedMark> => {
  const branding = VueRuntime.shallowRef<PageBrandingView | null>(initialBranding)
  const failedIdentity = VueRuntime.ref<string | null>(null)
  const events: string[] = []
  const root = VueRuntime.defineComponent({
    name: 'PageBrandingMarkBehaviorHarness',
    setup: () => () =>
      VueRuntime.h(PageBrandingMark, {
        branding: branding.value,
        failed: identityOf(branding.value) === failedIdentity.value,
        onError: (identity: string) => {
          events.push(identity)
          if (identityOf(branding.value) === identity) failedIdentity.value = identity
        }
      })
  })

  const host = browserWindow.document.createElement('div')
  browserWindow.document.body.append(host)
  const app = VueRuntime.createApp(root)
  app.mount(host)
  await settle()
  const unmount = (): void => {
    app.unmount()
    host.remove()
  }
  mountedApps.push(unmount)

  return {
    host,
    events,
    root: () => host.querySelector<HTMLElement>('.page-branding-mark'),
    image: () => host.querySelector<HTMLImageElement>('.page-branding-mark__image'),
    setBranding: async (value: PageBrandingView | null) => {
      branding.value = value
      await settle()
    }
  }
}

afterEach(() => {
  for (const unmount of mountedApps.splice(0)) unmount()
  browserWindow.document.body.replaceChildren()
})

describe('page branding mark', () => {
  it('does not render a reserved mark when branding is unavailable', async () => {
    const mounted = await mountMark(null)

    expect(mounted.root()).toBeNull()
    expect(mounted.image()).toBeNull()
    expect(mounted.events).toEqual([])
  })

  it('keeps the mark on the physical right while RTL text keeps its direction', () => {
    for (const direction of ['ltr', 'rtl'] as const) {
      const fixture = mountBrandingHeader(direction)
      const headingsStyle = browserWindow.getComputedStyle(fixture.headings)
      const markStyle = browserWindow.getComputedStyle(fixture.mark)
      const expectedTextColumn = direction === 'rtl' ? '2' : '1'
      const expectedMarkColumn = direction === 'rtl' ? '1' : '2'

      expect(headingsStyle.direction).toBe(direction)
      expect(headingsStyle.display).toBe('grid')
      expect(headingsStyle.gridTemplateColumns).toBe(
        direction === 'rtl' ? 'var(--page-branding-mark-size) minmax(0, 1fr)' : 'minmax(0, 1fr) var(--page-branding-mark-size)'
      )
      expect(markStyle.position).toBe('absolute')
      expect(markStyle.right).toBe('0px')
      expect(markStyle.gridColumn).toBe(expectedMarkColumn)
      expect(physicalInlineSide(fixture.headings, fixture.mark)).toBe('right')

      for (const textElement of [fixture.label, fixture.title, fixture.description]) {
        const textStyle = browserWindow.getComputedStyle(textElement)
        expect(textStyle.gridColumn).toBe(expectedTextColumn)
        expect(physicalInlineSide(fixture.headings, textElement)).toBe('left')
      }
    }
  })

  it('renders an accessible mark for valid branding', async () => {
    const mounted = await mountMark(makeBranding(7, 'a'.repeat(64)))
    const mark = mounted.root()
    const image = mounted.image()

    expect(mark).not.toBeNull()
    expect(mark?.getAttribute('aria-hidden')).toBe('true')
    expect(image).not.toBeNull()
    expect(image?.getAttribute('alt')).toBe('')
    expect(image?.getAttribute('width')).toBe('96')
    expect(image?.getAttribute('height')).toBe('64')
    expect(image?.getAttribute('draggable')).toBe('false')
    expect(mounted.events).toEqual([])
  })

  it('ignores a stale A error after replacing A with B', async () => {
    const brandingA = makeBranding(7, 'a'.repeat(64))
    const brandingB = makeBranding(8, 'b'.repeat(64))
    const mounted = await mountMark(brandingA)
    const imageA = mounted.image()
    if (!imageA) throw new Error('Branding A image was not rendered')

    const replacing = mounted.setBranding(brandingB)
    imageA.dispatchEvent(new browserWindow.Event('error'))
    await replacing

    expect(mounted.root()).not.toBeNull()
    expect(mounted.image()?.dataset.brandingSource).toBe(identityOf(brandingB))
    expect(mounted.events).toEqual([])
  })

  it('emits the current B error and hides B, then recovers after a digest change', async () => {
    const brandingB = makeBranding(8, 'b'.repeat(64))
    const brandingBWithNewDigest = makeBranding(8, 'c'.repeat(64))
    const mounted = await mountMark(brandingB)
    const imageB = mounted.image()
    if (!imageB) throw new Error('Branding B image was not rendered')

    imageB.dispatchEvent(new browserWindow.Event('error'))
    await settle()

    expect(mounted.events).toEqual([identityOf(brandingB)])
    expect(mounted.root()).toBeNull()
    expect(mounted.image()).toBeNull()

    await mounted.setBranding(brandingBWithNewDigest)
    expect(mounted.root()).not.toBeNull()
    expect(mounted.root()?.getAttribute('aria-hidden')).toBe('true')
    expect(mounted.image()?.dataset.brandingSource).toBe(identityOf(brandingBWithNewDigest))
    expect(mounted.image()?.getAttribute('alt')).toBe('')
  })
})
