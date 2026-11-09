import { describe, expect, it } from '../bun-test.mts'
import { parseContentExtensionEnvelope } from '../../../shared/content-extensions.ts'
import { renderIndexContentExtension } from '../../content-extensions/index.ts'
import { renderYoutubeContentExtension } from '../../content-extensions/youtube.ts'


describe('index date option rendering', () => {
  it.each([undefined, false, true])('carries the optional date preference without embedding unauthorized rows (%s)', async showUpdatedAt => {
    const envelope = parseContentExtensionEnvelope({ key: 'index', version: 1, props: {
      path: 'guide', locale: 'fr', ...(showUpdatedAt === undefined ? {} : { showUpdatedAt })
    } })
    const document = new DOMParser().parseFromString(await renderIndexContentExtension(envelope), 'text/html')
    expect(document.querySelector('section')?.getAttribute('data-index-show-updated-at')).toBe(String(showUpdatedAt === true))
    expect(document.querySelector('a, time')).toBeNull()
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
  })
})

describe('passive YouTube rendering', () => {
  it.each([
    [{ key: 'youtube', version: 1, props: { videoId: 'abc123_DEF', title: 'Video <title>', start: 12 } }, 'https://www.youtube.com/watch?v=abc123_DEF&t=12s', 'abc123_DEF', null],
    [{ key: 'youtube', version: 2, props: { source: { kind: 'playlist', playlistId: 'PL_native_123' }, title: 'Playlist', start: 12 } }, 'https://www.youtube.com/playlist?list=PL_native_123&t=12s', null, 'PL_native_123'],
    [{ key: 'youtube', version: 2, props: { source: { kind: 'video-playlist', videoId: 'abc123_DEF', playlistId: 'PL_native_123' }, title: 'Combined', start: 12 } }, 'https://www.youtube.com/watch?v=abc123_DEF&list=PL_native_123&t=12s', 'abc123_DEF', 'PL_native_123']
  ] as const)('renders a named fixed-host fallback and inert consent controls (%j)', async (input, href, videoId, playlistId) => {
    const html = await renderYoutubeContentExtension(parseContentExtensionEnvelope(input))
    const document = new DOMParser().parseFromString(html, 'text/html')
    const figure = document.querySelector('figure')!
    expect(figure.getAttribute('data-youtube-id')).toBe(videoId)
    expect(figure.getAttribute('data-youtube-playlist-id')).toBe(playlistId)
    expect(figure.getAttribute('aria-label')).toBe(input.props.title)
    expect(figure.querySelector('a')?.getAttribute('href')).toBe(href)
    expect(figure.querySelector('a')?.textContent).toBe(`Open ${input.props.title} on YouTube`)
    expect(figure.querySelector('button')?.getAttribute('type')).toBe('button')
    expect(figure.querySelector('iframe, img, script, link, video, audio, source')).toBeNull()
    expect(html).not.toContain('youtube-nocookie.com')
  })
})
