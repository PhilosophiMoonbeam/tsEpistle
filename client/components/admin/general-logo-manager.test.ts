import fs from 'node:fs'
import { describe, expect, it, vi } from '../../../server/test/bun-test.mts'

const script = fs.readFileSync('client/components/admin/general-logo-manager.vue', 'utf8').match(/<script lang='ts'>([\s\S]*?)<\/script>/)![1]!
const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  script.replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*$/gm, '').replace('export default', 'const component =')
)

const hash = 'a'.repeat(64)
const iconUrls = {
  favicon16Url: `/_site-logo/${'a'.repeat(64)}/icon.png`,
  favicon32Url: `/_site-logo/${'b'.repeat(64)}/icon.png`,
  tile150Url: `/_site-logo/${'c'.repeat(64)}/icon.png`,
  apple180Url: `/_site-logo/${'d'.repeat(64)}/icon.png`,
  app192Url: `/_site-logo/${'e'.repeat(64)}/icon.png`,
  app512Url: `/_site-logo/${'f'.repeat(64)}/icon.png`,
  maskable512Url: `/_site-logo/${'0'.repeat(64)}/icon.png`,
  faviconIcoUrl: `/_site-logo/${'1'.repeat(64)}/favicon.ico`
} as const
const nextIconUrls = {
  favicon16Url: `/_site-logo/${'2'.repeat(64)}/icon.png`,
  favicon32Url: `/_site-logo/${'3'.repeat(64)}/icon.png`,
  tile150Url: `/_site-logo/${'4'.repeat(64)}/icon.png`,
  apple180Url: `/_site-logo/${'5'.repeat(64)}/icon.png`,
  app192Url: `/_site-logo/${'6'.repeat(64)}/icon.png`,
  app512Url: `/_site-logo/${'7'.repeat(64)}/icon.png`,
  maskable512Url: `/_site-logo/${'8'.repeat(64)}/icon.png`,
  faviconIcoUrl: `/_site-logo/${'9'.repeat(64)}/favicon.ico`
} as const
const logoUrl = `/_site-logo/${hash}/logo.png`
const active = {
  revisionId: 'active',
  logoUrl,
  logoIcons: iconUrls,
  enhancement: { status: 'ready', reason: null }
} as const
const pending = {
  active,
  candidate: { revisionId: 'next', status: 'running', errorCode: null }
} as const

function translate(key: string, values?: Record<string, unknown>): string {
  if (!values) return key
  return `${key}:${JSON.stringify(values)}`
}

function arrange({ Image }: { Image?: new () => unknown } = {}) {
  const api = {
    fetchSiteLogoStatus: vi.fn().mockResolvedValue(pending),
    uploadSiteLogo: vi.fn().mockResolvedValue(pending),
    retrySiteLogo: vi.fn().mockResolvedValue(pending)
  }
  const window = {
    fetch: vi.fn(),
    setTimeout: vi.fn().mockReturnValue(1),
    clearTimeout: vi.fn(),
    matchMedia: vi.fn().mockReturnValue({ matches: false })
  }
  const URL = {
    createObjectURL: vi.fn().mockReturnValue('blob:selected'),
    revokeObjectURL: vi.fn()
  }
  const wikiStore = { site: { logoUrl: '/legacy.svg' } as Record<string, unknown> }
  const iconLinks = [
    { dataset: { siteLogoIcon: 'favicon16' }, href: '' },
    { dataset: { siteLogoIcon: 'favicon32' }, href: '' },
    { dataset: { siteLogoIcon: 'apple180' }, href: '' },
    { dataset: { siteLogoIcon: 'app192' }, href: '' },
    { dataset: { siteLogoIcon: 'app512' }, href: '' },
    { dataset: { siteLogoIcon: 'faviconIco' }, href: '' },
    { dataset: { siteLogoIcon: 'unowned' }, href: 'keep' }
  ]
  const document = { querySelectorAll: vi.fn().mockReturnValue(iconLinks) }
  const nextTick = (callback: () => void) => callback()
  const refs = {
    logoFileInput: { click: vi.fn() },
    logoDropTarget: { focus: vi.fn() },
    reviewHeading: { focus: vi.fn() }
  }
  const deps = {
    ...api,
    document,
    window,
    URL,
    Image,
    wikiStore,
    SiteLogoApiError: class extends Error {},
    SITE_LOGO_SOURCE_BYTE_LIMIT: 5_242_880
  }
  const component = new Function(...Object.keys(deps), compiled + ';return component')(...Object.values(deps))
  const state = {
    ...component.data(),
    disabled: false,
    $refs: refs,
    $nextTick: nextTick,
    $t: translate
  }
  for (const [key, fn] of Object.entries(component.methods)) state[key] = (fn as (...args: unknown[]) => unknown).bind(state)
  for (const [key, fn] of Object.entries(component.computed)) Object.defineProperty(state, key, { get: () => (fn as () => unknown).call(state) })
  return { component, state, api, window, URL, wikiStore, refs, document, iconLinks }
}

const files = (...items: unknown[]) => ({ length: items.length, item: (index: number) => items[index] ?? null })

describe('General logo publication', () => {
  it('adopts active icon URLs through owned current-tab links', () => {
    const { state, document, iconLinks } = arrange()

    state.applyLogoStatus(pending)

    expect(document.querySelectorAll).toHaveBeenCalledWith('link[data-site-logo-icon]')
    expect(iconLinks.map(link => link.href)).toEqual([
      active.logoIcons.favicon16Url,
      active.logoIcons.favicon32Url,
      active.logoIcons.apple180Url,
      active.logoIcons.app192Url,
      active.logoIcons.app512Url,
      active.logoIcons.faviconIcoUrl,
      'keep'
    ])
  })
  it('reviews one local image, treats an empty chooser as a no-op, and cancels without a request', () => {
    const { state, api, URL } = arrange()
    const file = { name: 'logo.png', size: 2048, type: 'application/octet-stream' }

    state.acceptLogoFiles(null)
    state.acceptLogoFiles(files())
    expect(state.logoErrorKey).toBeNull()
    state.acceptLogoFiles(files(file))
    expect(state.confirming).toBe(true)
    expect(state.selectedFile).toBe(file)
    expect(api.uploadSiteLogo).not.toHaveBeenCalled()

    for (const emptyChoice of [null, files()]) {
      state.acceptLogoFiles(emptyChoice)
      expect(state.logoErrorKey).toBeNull()
      expect(state.selectedFile).toBe(file)
      expect(state.candidatePreviewUrl).toBe('blob:selected')
      expect(state.confirming).toBe(true)
      expect(api.uploadSiteLogo).not.toHaveBeenCalled()
    }

    state.cancelSelection()
    expect(state.selectedFile).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:selected')
    expect(api.uploadSiteLogo).not.toHaveBeenCalled()
    expect(api.fetchSiteLogoStatus).not.toHaveBeenCalled()
    expect(api.retrySiteLogo).not.toHaveBeenCalled()
    state.acceptLogoFiles(files(file, file))
    expect(state.logoErrorKey).toBe('admin:general.logoErrorOneFile')
    state.acceptLogoFiles(files({ ...file, size: 5_242_881 }))
    expect(state.logoErrorKey).toBe('admin:general.logoErrorTooLarge')
  })

  it.each([
    ['unavailable', null],
    ['tiny', { width: 1, height: 1 }],
    ['wide', { width: 4096, height: 1 }]
  ] as const)('submits images with %s dimensions without client-side dimension rejection', async (label, dimensions) => {
    const Image = dimensions
      ? class {
          naturalWidth = dimensions.width
          naturalHeight = dimensions.height
          onload: (() => void) | null = null
          set src(_value: string) {
            this.onload?.()
          }
        }
      : undefined
    const { state, api } = arrange({ Image })
    const file = new File([new Uint8Array(24)], `${label}-mark.webp`, { type: 'image/webp' })

    state.acceptLogoFiles(files(file))
    expect(state.selectedDimensions).toEqual(dimensions)
    await state.publishSelected()

    expect(api.uploadSiteLogo).toHaveBeenCalledWith(expect.anything(), file, expect.any(AbortSignal))
    expect(state.logoStatus.candidate.status).toBe('running')
    expect(state.candidateStatusKey).toBe('admin:general.logoStatusPreparing')
  })

  it('keeps the active logo while preparing and publishes ordinary branding when animation is unavailable', async () => {
    const { state, api, window, wikiStore, URL } = arrange()
    const file = { name: 'logo.png', size: 2048 }
    state.acceptLogoFiles(files(file))
    await state.publishSelected()

    expect(api.uploadSiteLogo).toHaveBeenCalledTimes(1)
    expect(state.activeLogoUrl).toBe(logoUrl)
    expect(state.candidateStatusKey).toBe('admin:general.logoStatusPreparing')
    expect(window.setTimeout).toHaveBeenCalled()

    state.applyLogoStatus({
      active: {
        ...active,
        revisionId: 'next',
        logoUrl: `/_site-logo/${'b'.repeat(64)}/logo.png`,
        logoIcons: nextIconUrls,
        enhancement: { status: 'unavailable', reason: 'UNSUITABLE_LOGO' }
      },
      candidate: null
    })
    expect(wikiStore.site.logoUrl).toBe(`/_site-logo/${'b'.repeat(64)}/logo.png`)
    expect(wikiStore.site.logoIcons).toEqual(nextIconUrls)
    expect(state.selectedFile).toBeNull()
    expect(state.publishedNoticeKey).toBe('admin:general.logoStatusPublishedWithoutAnimation')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:selected')
  })

  it('retains a selected file after an interrupted upload and retries only after an explicit action', async () => {
    const { state, api } = arrange()
    const file = { name: 'logo.png', size: 2048 }
    api.uploadSiteLogo.mockRejectedValueOnce(new Error('connection reset')).mockResolvedValueOnce(pending)

    state.acceptLogoFiles(files(file))
    await state.publishSelected()
    expect(api.uploadSiteLogo).toHaveBeenCalledTimes(1)
    expect(state.selectedFile).toBe(file)
    expect(state.uploadInterrupted).toBe(true)
    expect(state.candidateStatusKey).toBe('admin:general.logoStatusUploadInterrupted')

    await state.retryUpload()
    expect(api.uploadSiteLogo).toHaveBeenCalledTimes(2)
    expect(state.selectedFile).toBe(file)
  })

  it('keeps a running candidate and offers Check again when polling is unavailable', async () => {
    const { state, api } = arrange()
    api.fetchSiteLogoStatus.mockRejectedValueOnce(new Error('status unavailable')).mockResolvedValueOnce(pending)
    state.applyLogoStatus(pending)

    await state.refreshLogoStatus()
    expect(state.statusUnavailable).toBe(true)
    expect(state.logoStatus.candidate.status).toBe('running')
    expect(state.candidateStatusKey).toBe('admin:general.logoStatusUnavailable')
    expect(api.uploadSiteLogo).not.toHaveBeenCalled()

    state.checkAgain()
    await Promise.resolve()
    expect(state.statusUnavailable).toBe(false)
    expect(api.fetchSiteLogoStatus).toHaveBeenCalledTimes(2)
  })

  it('keeps the active logo after a real processing failure and retries through the dedicated endpoint', async () => {
    const { state, api } = arrange()
    state.applyLogoStatus({ ...pending, candidate: { revisionId: 'next', status: 'failed', errorCode: 'PROCESSING_FAILED' } })

    expect(state.candidateHasFailed).toBe(true)
    expect(state.activeLogoUrl).toBe(logoUrl)
    expect(state.logoErrorKey).toBe('admin:general.logoErrorProcessing')
    await state.retryLogo()
    expect(api.retrySiteLogo).toHaveBeenCalledTimes(1)
    expect(state.candidateIsProcessing).toBe(true)
  })

  it('preserves a newer local selection when older work finishes', async () => {
    const { state, api, URL, wikiStore } = arrange()
    URL.createObjectURL.mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second')
    let resolveUpload: (value: unknown) => void = () => {}
    api.uploadSiteLogo.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveUpload = resolve
        })
    )
    const first = { name: 'first.png', size: 100 }
    const second = { name: 'second.png', size: 200 }

    state.acceptLogoFiles(files(first))
    const firstUpload = state.publishSelected()
    state.acceptLogoFiles(files(second))
    resolveUpload(pending)
    await firstUpload

    expect(state.selectedFile).toBe(second)
    expect(state.confirming).toBe(true)
    expect(state.candidatePreviewUrl).toBe('blob:second')

    const published = {
      ...active,
      revisionId: 'next',
      logoUrl: `/_site-logo/${'b'.repeat(64)}/logo.png`,
      logoIcons: nextIconUrls
    }
    api.fetchSiteLogoStatus.mockResolvedValueOnce({ active: published, candidate: null })
    await state.refreshLogoStatus()

    expect(wikiStore.site.logoUrl).toBe(published.logoUrl)
    expect(wikiStore.site.logoIcons).toEqual(nextIconUrls)
    expect(state.publishedNoticeKey).toBe('admin:general.logoStatusPublished')
    expect(state.selectedFile).toBe(second)
    expect(state.confirming).toBe(true)
    expect(state.candidatePreviewUrl).toBe('blob:second')
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:second')
  })

  it('ignores a late response after unmount and releases local preview resources', async () => {
    const { state, api, component, URL } = arrange()
    let release: (value: unknown) => void = () => {}
    api.fetchSiteLogoStatus.mockImplementation(
      () =>
        new Promise(resolve => {
          release = resolve
        })
    )
    state.replaceCandidatePreview({ name: 'logo.png', size: 20 })
    const pendingRead = state.refreshLogoStatus()
    component.beforeUnmount.call(state)
    release(pending)
    await pendingRead

    expect(state.logoStatus).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:selected')
  })
})
