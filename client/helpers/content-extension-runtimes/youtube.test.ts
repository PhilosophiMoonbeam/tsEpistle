import { afterEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { hydrateYoutube } from './youtube.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => { cleanup() })
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

const figureFor = (attributes: DOMStringMap = {}) => {
  const figure = document.createElement('figure')
  Object.assign(figure.dataset, { youtubeStart: '12', youtubeControls: 'false', youtubeTitle: 'Accessible player', ...attributes })
  figure.innerHTML = '<div class="content-extension-remote__consent"><button type="button" class="content-extension-remote__load">Load YouTube player</button></div><figcaption class="content-extension-remote__fallback"><a href="https://www.youtube.com/playlist?list=PL_native_123">Open playlist on YouTube</a></figcaption>'
  document.body.append(figure)
  return figure
}

const catalog = (isEnabled = true, compatible = true) => ({
  hostVersion: 1,
  extensions: [{
    key: 'youtube',
    version: 1,
    title: 'YouTube player',
    description: 'Load a privacy-enhanced YouTube player only after reader consent.',
    icon: 'mdi-youtube',
    isEnabled,
    compatible,
    diagnostic: compatible ? null : 'Unsupported host version.'
  }]
})

const catalogResponse = (payload: unknown = catalog()) => new Response(JSON.stringify(payload), {
  headers: { 'content-type': 'application/json' }
})

const expectPassiveFailure = (figure: HTMLElement) => {
  expect(figure.querySelector('iframe')).toBeNull()
  expect(figure.querySelector('[role="alert"]')).not.toBeNull()
  expect(figure.querySelector('a')?.getAttribute('href')).toBe('https://www.youtube.com/playlist?list=PL_native_123')
}

describe('consent-gated video and playlist player', () => {
  it.each([
    [{ youtubeId: 'abc123_DEF' }, '/embed/abc123_DEF?start=12&controls=0'],
    [{ youtubeId: 'videoseries' }, '/embed/videoseries?start=12&controls=0'],
    [{ youtubeVersion: '2', youtubeSourceKind: 'playlist', youtubePlaylistId: 'PL_native_123' }, '/embed/videoseries?start=12&list=PL_native_123&controls=0'],
    [{ youtubeVersion: '2', youtubeSourceKind: 'video-playlist', youtubeId: 'abc123_DEF', youtubePlaylistId: 'PL_native_123' }, '/embed/abc123_DEF?start=12&list=PL_native_123&controls=0']
  ])('makes no request or frame before consent and keeps exact privacy restrictions (%j)', async (attributes, path) => {
    const request = vi.fn(async () => catalogResponse())
    const figure = figureFor(attributes)
    const cleanup = hydrateYoutube(figure, request, new AbortController().signal)
    cleanups.push(cleanup)
    expect(request).not.toHaveBeenCalled()
    expect(figure.querySelector('iframe, img, link')).toBeNull()
    const fallback = figure.querySelector('a')!.getAttribute('href')
    const button = figure.querySelector('button')!
    button.focus()
    expect(document.activeElement).toBe(button)
    // Native button activation (including Enter/Space in a browser) is the only load path.
    button.click()
    await vi.waitFor(() => { expect(figure.querySelector('iframe')).not.toBeNull() })
    const frame = figure.querySelector('iframe')!
    expect(frame.src).toBe(`https://www.youtube-nocookie.com${path}`)
    expect(frame.title).toBe('Accessible player')
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-presentation')
    expect(frame.allow).toBe('accelerometer; encrypted-media; gyroscope; picture-in-picture; web-share')
    expect(frame.allow).not.toContain('autoplay')
    expect(frame.referrerPolicy).toBe('strict-origin-when-cross-origin')
    expect(frame.allowFullscreen).toBe(true)
    expect(figure.querySelector('a')?.getAttribute('href')).toBe(fallback)
    expect(figure.querySelectorAll('iframe')).toHaveLength(1)
    cleanup()
    expect(frame.src).toBe('about:blank')
    expect(figure.querySelector('iframe')).toBeNull()
  })

  it.each([
    { youtubeVersion: '3', youtubeId: 'abc123_DEF' },
    { youtubeId: 'abc123_DEF', youtubePlaylistId: 'PL_native_123' },
    { youtubeVersion: '2', youtubeSourceKind: 'playlist', youtubeId: 'videoseries', youtubePlaylistId: 'PL_native_123' },
    { youtubeVersion: '2', youtubeSourceKind: 'video-playlist', youtubePlaylistId: 'PL_native_123' },
    { youtubeVersion: '2', youtubeSourceKind: 'playlist', youtubePlaylistId: '' },
    { youtubeVersion: '2', youtubeSourceKind: 'playlist', youtubePlaylistId: 'PL_native_123&autoplay=1' },
    { youtubeId: 'https://evil.test/video' },
    { youtubeId: 'abc123_DEF', youtubeStart: '1e2' },
    { youtubeId: 'abc123_DEF', youtubeStart: '86401' },
    { youtubeId: 'abc123_DEF', youtubeStart: '' },
    { youtubeId: 'abc123_DEF', youtubeControls: 'autoplay' }
  ])('fails closed on malformed legacy attributes while keeping passive recovery (%j)', attributes => {
    const figure = figureFor(attributes)
    cleanups.push(hydrateYoutube(figure, async () => catalogResponse(), new AbortController().signal))
    figure.querySelector('button')!.click()
    expect(figure.querySelector('iframe')).toBeNull()
    expect(figure.querySelector('[role="alert"]')).not.toBeNull()
    expect(figure.querySelector('a')?.getAttribute('href')).toBe('https://www.youtube.com/playlist?list=PL_native_123')
  })

  it('does not load after teardown or activate a passive disabled representation', () => {
    const figure = figureFor({ youtubeId: 'abc123_DEF' })
    const button = figure.querySelector('button')!
    const cleanup = hydrateYoutube(figure, async () => catalogResponse(), new AbortController().signal)
    cleanup()
    button.click()
    expect(figure.querySelector('iframe')).toBeNull()
    figure.querySelector('.content-extension-remote__consent')!.remove()
    cleanups.push(hydrateYoutube(figure, async () => catalogResponse(), new AbortController().signal))
    expect(figure.querySelector('iframe')).toBeNull()
    expect(figure.querySelector('a')).not.toBeNull()
  })

  it('checks current native policy at consent and recovers from retained valid playlist markup', async () => {
    const figure = figureFor({ youtubeVersion: '2', youtubeSourceKind: 'playlist', youtubePlaylistId: 'PL_native_123' })
    const retained = figure.cloneNode(true) as HTMLElement
    let policy = catalog()
    const request = vi.fn(async () => catalogResponse(policy))
    const cleanup = hydrateYoutube(figure, request, new AbortController().signal)
    cleanups.push(cleanup)

    policy = catalog(false)
    figure.querySelector('button')!.click()
    await vi.waitFor(() => { expectPassiveFailure(figure) })

    cleanup()
    figure.replaceWith(retained)
    policy = catalog()
    cleanups.push(hydrateYoutube(retained, request, new AbortController().signal))
    retained.querySelector('button')!.click()
    await vi.waitFor(() => {
      expect(retained.querySelector<HTMLIFrameElement>('iframe')?.src).toBe(
        'https://www.youtube-nocookie.com/embed/videoseries?start=12&list=PL_native_123&controls=0'
      )
    })
    expect(retained.querySelector('iframe')?.title).toBe('Accessible player')
    expect(retained.querySelector('a')?.getAttribute('href')).toBe('https://www.youtube.com/playlist?list=PL_native_123')
  })

  it.each([
    ['incompatible', () => Promise.resolve(catalogResponse(catalog(true, false)))],
    ['missing', () => Promise.resolve(catalogResponse({ hostVersion: 1, extensions: [] }))],
    ['malformed', () => Promise.resolve(catalogResponse({ hostVersion: 1, extensions: [{ ...catalog().extensions[0], isEnabled: 'true' }] }))],
    ['failed transport', () => Promise.reject(new Error('Connection lost.'))]
  ] as const)('refuses activation with %s current policy', async (_case, request) => {
    const figure = figureFor({ youtubeId: 'abc123_DEF' })
    cleanups.push(hydrateYoutube(figure, request, new AbortController().signal))
    figure.querySelector('button')!.click()
    await vi.waitFor(() => { expectPassiveFailure(figure) })
  })

  it.each([
    ['cleanup', true],
    ['cleanup', false],
    ['abort', true],
    ['abort', false]
  ] as const)('does not publish a late frame or error after %s (available: %s)', async (retirement, available) => {
    let resolvePolicy!: (payload: unknown) => void
    const pendingPolicy = new Promise<unknown>(resolve => { resolvePolicy = resolve })
    // Deliberately ignore cancellation: the runtime must fence its own DOM publication.
    const request = async () => catalogResponse(await pendingPolicy)
    const retired = figureFor({ youtubeId: 'abc123_DEF' })
    const active = figureFor({ youtubeId: 'abc123_DEF' })
    const controller = new AbortController()
    const cleanup = hydrateYoutube(retired, request, controller.signal)
    cleanups.push(cleanup, hydrateYoutube(active, request, new AbortController().signal))
    const retiredButton = retired.querySelector('button')!
    retiredButton.click()
    active.querySelector('button')!.click()
    if (retirement === 'cleanup') cleanup()
    else controller.abort()
    resolvePolicy(available ? catalog() : { hostVersion: 1, extensions: [{ key: 'youtube' }] })

    // A live consumer of the same deferred response proves the async policy path settled.
    await vi.waitFor(() => {
      if (available) expect(active.querySelector('iframe')).not.toBeNull()
      else expectPassiveFailure(active)
    })
    expect(retired.querySelector('iframe, [role="alert"]')).toBeNull()
    expect(retired.querySelector('button')).toBe(retiredButton)
    expect(retired.querySelector('a')?.getAttribute('href')).toBe('https://www.youtube.com/playlist?list=PL_native_123')
  })
})
