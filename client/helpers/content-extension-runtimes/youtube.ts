import { fetchContentExtensions } from '../content-extensions-api.ts'
import { showRemoteError } from './remote-error.ts'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type Cleanup = () => void

export const hydrateYoutube = (figure: HTMLElement, fetchImpl: FetchLike, signal: AbortSignal): Cleanup => {
  const button = figure.querySelector<HTMLButtonElement>('.content-extension-remote__load')
  if (!button) return () => {}
  let frame: HTMLIFrameElement | null = null
  let disposed = false
  const load = async (): Promise<void> => {
    if (disposed || signal.aborted) return
    const version = figure.dataset.youtubeVersion ?? '1'
    const kind = figure.dataset.youtubeSourceKind
    const id = figure.dataset.youtubeId
    const playlistId = figure.dataset.youtubePlaylistId
    const rawStart = figure.dataset.youtubeStart ?? '0'
    const start = Number(rawStart)
    const videoValid = typeof id === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(id)
    const playlistValid = typeof playlistId === 'string' && /^[A-Za-z0-9_-]{6,128}$/.test(playlistId)
    const sourceValid = version === '1'
      ? videoValid && playlistId === undefined && kind === undefined
      : version === '2' && (kind === 'playlist'
        ? playlistValid && id === undefined
        : kind === 'video-playlist' && playlistValid && videoValid)
    if (!sourceValid || !/^(?:0|[1-9]\d{0,4})$/.test(rawStart) || start > 86400 ||
      (figure.dataset.youtubeControls !== undefined && !['true', 'false'].includes(figure.dataset.youtubeControls))) {
      showRemoteError(figure, 'This YouTube configuration is invalid.')
      return
    }
    button.disabled = true
    button.textContent = 'Loading…'
    try {
      const status = await fetchContentExtensions(fetchImpl, 'YouTube availability could not be checked.', signal)
      if (disposed || signal.aborted) return
      const youtube = status.extensions.find(extension => extension.key === 'youtube')
      if (!youtube?.isEnabled || !youtube.compatible) {
        showRemoteError(figure, 'This YouTube player is currently unavailable.')
        return
      }
      const query = new URLSearchParams()
      if (start > 0) query.set('start', String(start))
      if (playlistId) query.set('list', playlistId)
      if (figure.dataset.youtubeControls === 'false') query.set('controls', '0')
      frame = figure.ownerDocument.createElement('iframe')
      frame.className = 'content-extension-remote__frame'
      frame.src = `https://www.youtube-nocookie.com/embed/${id ?? 'videoseries'}${query.size > 0 ? `?${query}` : ''}`
      frame.title = figure.dataset.youtubeTitle?.trim() || (id ? 'YouTube video' : 'YouTube playlist')
      frame.loading = 'lazy'
      frame.referrerPolicy = 'strict-origin-when-cross-origin'
      frame.allow = 'accelerometer; encrypted-media; gyroscope; picture-in-picture; web-share'
      frame.allowFullscreen = true
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation')
      figure.querySelector<HTMLElement>('.content-extension-remote__consent')?.replaceWith(frame)
    } catch (error) {
      if (!disposed && !signal.aborted) {
        showRemoteError(figure, error instanceof Error ? error.message : 'YouTube availability could not be checked.')
      }
    }
  }
  button.addEventListener('click', load, { once: true })
  return () => {
    disposed = true
    button.removeEventListener('click', load)
    if (frame) {
      frame.src = 'about:blank'
      frame.remove()
    }
  }
}
