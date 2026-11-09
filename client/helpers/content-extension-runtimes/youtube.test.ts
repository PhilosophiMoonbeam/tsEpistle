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

describe('consent-gated video and playlist player', () => {
  it.each([
    [{ youtubeId: 'abc123_DEF' }, '/embed/abc123_DEF?start=12&controls=0'],
    [{ youtubeId: 'videoseries' }, '/embed/videoseries?start=12&controls=0'],
    [{ youtubeVersion: '2', youtubeSourceKind: 'playlist', youtubePlaylistId: 'PL_native_123' }, '/embed/videoseries?start=12&list=PL_native_123&controls=0'],
    [{ youtubeVersion: '2', youtubeSourceKind: 'video-playlist', youtubeId: 'abc123_DEF', youtubePlaylistId: 'PL_native_123' }, '/embed/abc123_DEF?start=12&list=PL_native_123&controls=0']
  ])('makes no request or frame before consent and keeps exact privacy restrictions (%j)', (attributes, path) => {
    const request = vi.spyOn(globalThis, 'fetch')
    const figure = figureFor(attributes)
    const cleanup = hydrateYoutube(figure)
    cleanups.push(cleanup)
    expect(request).not.toHaveBeenCalled()
    expect(figure.querySelector('iframe, img, link')).toBeNull()
    const fallback = figure.querySelector('a')!.getAttribute('href')
    const button = figure.querySelector('button')!
    button.focus()
    expect(document.activeElement).toBe(button)
    // Native button activation (including Enter/Space in a browser) is the only load path.
    button.click()
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
    expect(request).not.toHaveBeenCalled()
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
    cleanups.push(hydrateYoutube(figure))
    figure.querySelector('button')!.click()
    expect(figure.querySelector('iframe')).toBeNull()
    expect(figure.textContent).toContain('This YouTube configuration is invalid.')
    expect(figure.querySelector('a')?.getAttribute('href')).toBe('https://www.youtube.com/playlist?list=PL_native_123')
  })

  it('does not load after teardown or activate a passive disabled representation', () => {
    const figure = figureFor({ youtubeId: 'abc123_DEF' })
    const button = figure.querySelector('button')!
    const cleanup = hydrateYoutube(figure)
    cleanup()
    button.click()
    expect(figure.querySelector('iframe')).toBeNull()
    figure.querySelector('.content-extension-remote__consent')!.remove()
    cleanups.push(hydrateYoutube(figure))
    expect(figure.querySelector('iframe')).toBeNull()
    expect(figure.querySelector('a')).not.toBeNull()
  })
})
