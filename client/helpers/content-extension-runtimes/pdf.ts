type Cleanup = () => void

const safeSameOriginPath = (value: string): boolean => {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return false
  try {
    const url = new URL(value, window.location.origin)
    return url.origin === window.location.origin && url.pathname === value
  } catch {
    return false
  }
}

export const hydratePdf = (figure: HTMLElement): Cleanup => {
  const src = figure.dataset.pdfSrc ?? ''
  const viewer = figure.querySelector<HTMLElement>('.content-extension-pdf__viewer')
  if (!viewer || !safeSameOriginPath(src)) return () => {}
  const page = Number(figure.dataset.pdfPage)
  const height = Number(figure.dataset.pdfHeight)
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(height) || height < 320 || height > 1600) return () => {}
  const frame = figure.ownerDocument.createElement('iframe')
  frame.className = 'content-extension-pdf__frame'
  frame.src = `${src}#page=${page}`
  frame.title = figure.dataset.pdfTitle ?? 'PDF document'
  frame.loading = 'lazy'
  frame.style.height = `${height}px`
  viewer.append(frame)
  return () => {
    frame.src = 'about:blank'
    frame.remove()
  }
}
