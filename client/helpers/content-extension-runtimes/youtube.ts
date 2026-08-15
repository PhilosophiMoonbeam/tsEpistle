import { showRemoteError } from './remote-error.ts'

type Cleanup = () => void

export const hydrateYoutube = (figure: HTMLElement): Cleanup => {
  const button = figure.querySelector<HTMLButtonElement>('.content-extension-remote__load')
  if (!button) return () => {}
  let frame: HTMLIFrameElement | null = null
  const load = (): void => {
    const id = figure.dataset.youtubeId ?? ''
    const start = Number(figure.dataset.youtubeStart)
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(id) || !Number.isInteger(start) || start < 0 || start > 86400) {
      showRemoteError(figure, 'This YouTube configuration is invalid.')
      return
    }
    const query = new URLSearchParams()
    if (start > 0) query.set('start', String(start))
    if (figure.dataset.youtubeControls === 'false') query.set('controls', '0')
    frame = figure.ownerDocument.createElement('iframe')
    frame.className = 'content-extension-remote__frame'
    frame.src = `https://www.youtube-nocookie.com/embed/${id}${query.size > 0 ? `?${query}` : ''}`
    frame.title = figure.dataset.youtubeTitle ?? 'YouTube video'
    frame.loading = 'lazy'
    frame.referrerPolicy = 'strict-origin-when-cross-origin'
    frame.allow = 'accelerometer; encrypted-media; gyroscope; picture-in-picture; web-share'
    frame.allowFullscreen = true
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation')
    figure.querySelector<HTMLElement>('.content-extension-remote__consent')?.replaceWith(frame)
  }
  button.addEventListener('click', load, { once: true })
  return () => {
    button.removeEventListener('click', load)
    if (frame) {
      frame.src = 'about:blank'
      frame.remove()
    }
  }
}
