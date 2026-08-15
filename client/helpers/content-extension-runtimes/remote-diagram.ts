import { showRemoteError } from './remote-error.ts'

type Cleanup = () => void

const bytesToBase64Url = (bytes: Uint8Array): string => {
  const chunks: string[] = []
  for (let index = 0; index < bytes.length; index += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + 0x8000)))
  }
  return btoa(chunks.join('')).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export const encodeKrokiSource = async (source: string): Promise<string> => {
  const { deflate } = await import('pako')
  return bytesToBase64Url(deflate(new TextEncoder().encode(source), { level: 9 }))
}

const PLANTUML_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_'

export const encodePlantUmlSource = async (source: string): Promise<string> => {
  const { deflateRaw } = await import('pako')
  const bytes = deflateRaw(new TextEncoder().encode(source), { level: 9 })
  let encoded = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!
    const second = bytes[index + 1] ?? 0
    const third = bytes[index + 2] ?? 0
    encoded += PLANTUML_ALPHABET[first >> 2]
    encoded += PLANTUML_ALPHABET[((first & 0x3) << 4) | (second >> 4)]
    encoded += PLANTUML_ALPHABET[((second & 0xf) << 2) | (third >> 6)]
    encoded += PLANTUML_ALPHABET[third & 0x3f]
  }
  return encoded
}

export const hydrateRemoteDiagram = (
  figure: HTMLElement,
  provider: 'kroki' | 'plantuml',
  signal: AbortSignal
): Cleanup => {
  const button = figure.querySelector<HTMLButtonElement>('.content-extension-remote__load')
  const sourceElement = figure.querySelector<HTMLElement>('.content-extension-diagram__source code')
  if (!button || !sourceElement) return () => {}
  let image: HTMLImageElement | null = null
  const load = async (): Promise<void> => {
    button.disabled = true
    button.textContent = 'Rendering…'
    try {
      const source = sourceElement.textContent ?? ''
      const encoded = provider === 'kroki' ? await encodeKrokiSource(source) : await encodePlantUmlSource(source)
      if (signal.aborted) return
      const format = provider === 'kroki' ? figure.dataset.krokiFormat : figure.dataset.plantumlFormat
      const type = figure.dataset.krokiType
      const url = provider === 'kroki'
        ? `https://kroki.io/${type}/${format}/${encoded}`
        : `https://www.plantuml.com/plantuml/${format}/${encoded}`
      if (url.length > 16000) throw new Error('The diagram is too large for the renderer URL.')
      image = figure.ownerDocument.createElement('img')
      image.className = 'content-extension-diagram__image'
      image.alt = figure.dataset.remoteAlt ?? `${provider} diagram`
      image.loading = 'lazy'
      image.decoding = 'async'
      image.referrerPolicy = 'no-referrer'
      image.src = url
      figure.querySelector<HTMLElement>('.content-extension-remote__consent')?.replaceWith(image)
      sourceElement.closest<HTMLElement>('.content-extension-diagram__source')?.classList.add('content-extension-diagram__source--fallback')
    } catch (error) {
      if (!signal.aborted) showRemoteError(figure, error instanceof Error ? error.message : 'The diagram could not be rendered.')
    }
  }
  button.addEventListener('click', load, { once: true })
  return () => {
    button.removeEventListener('click', load)
    if (image) {
      image.src = ''
      image.remove()
    }
  }
}
