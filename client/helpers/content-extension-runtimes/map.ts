import { showRemoteError } from './remote-error.ts'

type Cleanup = () => void

export const hydrateMap = (figure: HTMLElement): Cleanup => {
  const button = figure.querySelector<HTMLButtonElement>('.content-extension-remote__load')
  if (!button) return () => {}
  let frame: HTMLIFrameElement | null = null
  const load = (): void => {
    const latitude = Number(figure.dataset.mapLatitude)
    const longitude = Number(figure.dataset.mapLongitude)
    const zoom = Number(figure.dataset.mapZoom)
    const height = Number(figure.dataset.mapHeight)
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isInteger(zoom) || zoom < 1 || zoom > 19 || !Number.isInteger(height) || height < 240 || height > 800) {
      showRemoteError(figure, 'This map configuration is invalid.')
      return
    }
    const longitudeSpan = 360 / (2 ** zoom)
    const latitudeSpan = Math.max(0.001, longitudeSpan * 0.6)
    const params = new URLSearchParams({
      bbox: `${longitude - longitudeSpan},${latitude - latitudeSpan},${longitude + longitudeSpan},${latitude + latitudeSpan}`,
      layer: 'mapnik',
      marker: `${latitude},${longitude}`
    })
    frame = figure.ownerDocument.createElement('iframe')
    frame.className = 'content-extension-remote__frame content-extension-map__frame'
    frame.src = `https://www.openstreetmap.org/export/embed.html?${params}`
    frame.title = figure.dataset.mapLabel ?? 'OpenStreetMap map'
    frame.loading = 'lazy'
    frame.referrerPolicy = 'no-referrer'
    frame.style.height = `${height}px`
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')
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
