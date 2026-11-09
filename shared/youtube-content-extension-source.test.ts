import { describe, expect, it } from '../server/test/bun-test.mts'
import { parseYoutubeContentExtensionSource } from './content-extensions.ts'

describe('YouTube source authoring parser', () => {
  it.each([
    ['abc123_DEF', { kind: 'video', videoId: 'abc123_DEF' }],
    ['videoseries', { kind: 'video', videoId: 'videoseries' }],
    ['PL_native_123', { kind: 'video', videoId: 'PL_native_123' }],
    ['https://www.youtube.com/playlist?list=PL_native_123', { kind: 'playlist', playlistId: 'PL_native_123' }],
    ['https://www.youtube.com/embed/videoseries?list=PL_native_123', { kind: 'playlist', playlistId: 'PL_native_123' }],
    ['https://www.youtube.com/embed/videoseries/?list=PL_native_123', { kind: 'playlist', playlistId: 'PL_native_123' }],
    ['https://www.youtube.com/playlist/?list=PL_native_123', { kind: 'playlist', playlistId: 'PL_native_123' }],
    ['https://www.youtube-nocookie.com/embed/videoseries?list=PL_native_123', { kind: 'playlist', playlistId: 'PL_native_123' }],
    ['youtube.com/watch?v=abc123_DEF&list=PL_native_123', { kind: 'video-playlist', videoId: 'abc123_DEF', playlistId: 'PL_native_123' }],
    ['https://youtu.be/abc123_DEF?list=PL_native_123', { kind: 'video-playlist', videoId: 'abc123_DEF', playlistId: 'PL_native_123' }],
    ['https://www.youtube.com/embed/abc123_DEF?list=PL_native_123', { kind: 'video-playlist', videoId: 'abc123_DEF', playlistId: 'PL_native_123' }],
    ['https://m.youtube.com/shorts/abc123_DEF?list=PL_native_123', { kind: 'video-playlist', videoId: 'abc123_DEF', playlistId: 'PL_native_123' }],
    ['https://youtube.com/live/abc123_DEF?list=PL_native_123', { kind: 'video-playlist', videoId: 'abc123_DEF', playlistId: 'PL_native_123' }],
    ['https://youtube.com/v/abc123_DEF', { kind: 'video', videoId: 'abc123_DEF' }]
  ])('preserves the typed source from %s', (value, source) => {
    expect(parseYoutubeContentExtensionSource(value)).toEqual({ source, start: 0 })
  })

  it.each([
    ['https://youtu.be/abc123_DEF?t=72', 72],
    ['https://youtube.com/watch?v=abc123_DEF&t=72s', 72],
    ['https://youtube.com/watch?v=abc123_DEF&t=1h2m3s', 3723],
    ['https://youtube.com/playlist?list=PL_native_123&start=86400', 86400]
  ])('reads bounded start seconds from %s', (value, start) => {
    expect(parseYoutubeContentExtensionSource(value)?.start).toBe(start)
  })

  it.each([
    '', 'javascript:alert(1)', 'ftp://youtube.com/watch?v=abc123_DEF',
    'https://youtube.com.evil.test/watch?v=abc123_DEF', 'https://notyoutube.com/watch?v=abc123_DEF',
    'https://evil.test/youtube.com/watch?v=abc123_DEF', 'https://youtube.com@evil.test/watch?v=abc123_DEF',
    'https://user:secret@youtube.com/watch?v=abc123_DEF', 'https://youtube.com:444/watch?v=abc123_DEF',
    'https://youtube.com./watch?v=abc123_DEF', 'https://youtube.com\\@evil.test/watch?v=abc123_DEF',
    'https://youtube.com/watch?v=', 'https://youtube.com/playlist?list=',
    'https://youtube.com/embed/videoseries', 'https://youtube.com/watch?list=PL_native_123',
    'https://youtu.be/abc123_DEF/extra', 'https://youtube.com/embed/abc123_DEF/extra',
    'https://youtube.com/watch?v=abc123_DEF&v=other_123',
    'https://youtube.com/watch?v=abc123_DEF&list=PL_native_123&list=PL_other_123',
    'https://youtube.com/watch?v=abc123_DEF&list=%26autoplay%3D1',
    'https://youtube.com/playlist?list=PL_native_123&autoplay=1',
    'https://youtube.com/watch?v=abc123_DEF&t=-1', 'https://youtube.com/watch?v=abc123_DEF&start=1e2',
    'https://youtube.com/watch?v=abc123_DEF&t=25h', 'https://youtube.com/watch?v=abc123_DEF&t=86401',
    'https://youtube.com/watch?v=abc123_DEF&t=1&start=2', 'https://youtube.com/watch?v=abc123_DEF&t=',
    `https://youtube.com/playlist?list=${'P'.repeat(129)}`,
    `https://youtube.com/watch?v=${'a'.repeat(65)}`, `https://youtube.com/watch?v=abc123_DEF&x=${'a'.repeat(2048)}`
  ])('rejects malformed or hostile source %s', value => {
    expect(parseYoutubeContentExtensionSource(value)).toBeNull()
  })
})
