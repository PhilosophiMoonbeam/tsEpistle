import { hasAsciiControlCharacters } from '../../shared/text-safety'
import { emitEditorImagePropertiesRequest, subscribeEditorImageProperties } from './editor-insert-events'

export type EditorImageStyle = 'border' | 'rounded' | 'shadow'
export type EditorImageAlignment = '' | 'left' | 'center' | 'right' | 'abstopright'
export type EditorImageProperties = {
  src: string
  alt: string
  width: string
  height: string
  align: EditorImageAlignment
  styles: readonly EditorImageStyle[]
}
export type EditorImagePropertyPatch = Partial<EditorImageProperties>
export type EditorImagePropertiesRequest = {
  properties: EditorImageProperties
  signal: AbortSignal
  apply: (patch: EditorImagePropertyPatch) => boolean
}

export const EDITOR_IMAGE_STYLE_CLASSES = Object.freeze({
  border: 'wiki-image-border',
  rounded: 'wiki-image-rounded',
  shadow: 'wiki-image-shadow'
} as const)

export function normalizeEditorImageDimension(input: string): string | null {
  const value = input.trim()
  if (value === '' || value === 'auto') return value
  if (/^[1-9]\d*(?:px)?$/.test(value)) {
    const size = Number(value.replace(/px$/, ''))
    return size <= 16384 ? String(size) : null
  }
  if (/^(?:\d+(?:\.\d+)?|\.\d+)%$/.test(value)) {
    const size = Number(value.slice(0, -1))
    return size > 0 && size <= 100 ? `${size}%` : null
  }
  return null
}

export function isSafeEditorImageSource(input: string): boolean {
  if (!input || input.length > 2048 || input.includes(' ') || hasAsciiControlCharacters(input) || /[<>"`\\]/.test(input)) return false
  try {
    const url = new URL(input, 'https://wiki.invalid/')
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
  } catch {
    return false
  }
}

export function isValidEditorImageAlt(input: string): boolean {
  return input.length <= 2000 && !hasAsciiControlCharacters(input)
}

export function isLocalEditorImageSource(input: string): boolean {
  if (!isSafeEditorImageSource(input) || typeof window === 'undefined') return false
  return new URL(input, window.location.href).origin === window.location.origin
}

export function mergeEditorImageClasses(current: string, patch: Pick<EditorImagePropertyPatch, 'align' | 'styles'>): string {
  const classes = current
    .split(/\s+/)
    .filter(Boolean)
    .filter(value => {
      if (patch.align !== undefined && /^align-(?:left|center|right|abstopright)$/.test(value)) return false
      return patch.styles === undefined || !Object.values(EDITOR_IMAGE_STYLE_CLASSES).includes(value as (typeof EDITOR_IMAGE_STYLE_CLASSES)[EditorImageStyle])
    })
  if (patch.align) classes.push(`align-${patch.align}`)
  if (patch.styles) classes.push(...patch.styles.map(style => EDITOR_IMAGE_STYLE_CLASSES[style]))
  return classes.join(' ')
}

export function validateEditorImagePatch(patch: EditorImagePropertyPatch): boolean {
  return (
    (patch.src === undefined || isSafeEditorImageSource(patch.src)) &&
    (patch.alt === undefined || isValidEditorImageAlt(patch.alt)) &&
    (patch.width === undefined || normalizeEditorImageDimension(patch.width) !== null) &&
    (patch.height === undefined || normalizeEditorImageDimension(patch.height) !== null) &&
    (patch.align === undefined || ['', 'left', 'center', 'right', 'abstopright'].includes(patch.align)) &&
    (patch.styles === undefined || patch.styles.every(style => Object.hasOwn(EDITOR_IMAGE_STYLE_CLASSES, style)))
  )
}

export function requestEditorImageProperties(request: EditorImagePropertiesRequest): void {
  if (!request.signal.aborted) emitEditorImagePropertiesRequest(request)
}

export function onEditorImageProperties(handler: (request: EditorImagePropertiesRequest) => void): () => void {
  return subscribeEditorImageProperties(handler)
}
