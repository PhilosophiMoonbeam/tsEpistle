export const CONTENT_EXTENSION_HOST_VERSION = 1

export type ContentExtensionKey = 'qr' | 'gallery' | 'index'

export interface QrContentExtensionEnvelope {
  key: 'qr'
  version: 1
  props: {
    value: string
    label?: string
    size?: number
    errorCorrection?: 'L' | 'M' | 'Q' | 'H'
  }
}

export interface GalleryContentExtensionImage {
  src: string
  alt: string
  caption?: string
}

export interface GalleryContentExtensionEnvelope {
  key: 'gallery'
  version: 1
  props: {
    images: GalleryContentExtensionImage[]
    columns?: 1 | 2 | 3 | 4
    fit?: 'cover' | 'contain'
    aspectRatio?: 'square' | 'natural'
  }
}

export interface IndexContentExtensionEnvelope {
  key: 'index'
  version: 1
  props: {
    path: string
    locale: string
    depth?: number
    columns?: 1 | 2 | 3
    showIcons?: boolean
    order?: 'path' | 'title' | 'updated'
    limit?: number
    emptyLabel?: string
  }
}

export type ContentExtensionEnvelope =
  | QrContentExtensionEnvelope
  | GalleryContentExtensionEnvelope
  | IndexContentExtensionEnvelope

export interface ContentExtensionDefinition {
  key: ContentExtensionKey
  version: number
  title: string
  description: string
  icon: string
}

export const BUILTIN_CONTENT_EXTENSIONS: ContentExtensionDefinition[] = [
  {
    key: 'qr',
    version: 1,
    title: 'QR code',
    description: 'Encode text or a link as a deterministic QR code.',
    icon: 'mdi-qrcode'
  },
  {
    key: 'gallery',
    version: 1,
    title: 'Image gallery',
    description: 'Present authorized local images in an accessible responsive gallery.',
    icon: 'mdi-view-gallery-outline'
  },
  {
    key: 'index',
    version: 1,
    title: 'Page index',
    description: 'List pages below a path using the current reader’s page permissions.',
    icon: 'mdi-format-list-bulleted-square'
  }
]

type JsonObject = Record<string, unknown>

function isJsonObject (value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireJsonObject (value: unknown, path: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${path} must be an object.`)
  }
  return value
}

function rejectUnknownProperties (value: JsonObject, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${path} contains unknown property "${key}".`)
    }
  }
}

function optionalBoundedString (value: unknown, path: string, maximum: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > maximum) {
    throw new Error(`${path} must be a string no longer than ${maximum} characters.`)
  }
  return value
}

function boundedInteger (value: unknown, path: string, minimum: number, maximum: number, fallback: number): number {
  const candidate = value ?? fallback
  if (!Number.isInteger(candidate) || (candidate as number) < minimum || (candidate as number) > maximum) {
    throw new Error(`${path} must be a whole number from ${minimum} to ${maximum}.`)
  }
  return candidate as number
}

function strictBoolean (value: unknown, path: string, fallback: boolean): boolean {
  const candidate = value ?? fallback
  if (typeof candidate !== 'boolean') throw new Error(`${path} must be a boolean.`)
  return candidate
}

function isErrorCorrection (value: unknown): value is 'L' | 'M' | 'Q' | 'H' {
  return value === 'L' || value === 'M' || value === 'Q' || value === 'H'
}

function hasControlCharacter (value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 31 || code === 127) return true
  }
  return false
}

export function isSafeContentExtensionAssetPath (value: string): boolean {
  if (value !== value.trim() || !value.startsWith('/') || value.startsWith('//') || value.length > 512) return false
  if (value.includes('\\') || value.includes('?') || value.includes('#') || hasControlCharacter(value)) return false
  try {
    const decoded = decodeURIComponent(value)
    if (decoded.includes('\\') || decoded.includes('?') || decoded.includes('#')) return false
    const segments = decoded.split('/').filter(Boolean)
    if (segments.some(segment => segment === '.' || segment === '..')) return false
    return !decoded.startsWith('/_') || decoded.startsWith('/_assets/')
  } catch {
    return false
  }
}

function parseQrEnvelope (propsInput: unknown): QrContentExtensionEnvelope {
  const props = requireJsonObject(propsInput, 'Content extension props')
  rejectUnknownProperties(props, ['value', 'label', 'size', 'errorCorrection'], 'Content extension props')

  if (typeof props.value !== 'string' || props.value.length < 1 || props.value.length > 2048) {
    throw new Error('Content extension props.value must be a string between 1 and 2048 characters.')
  }
  const label = optionalBoundedString(props.label, 'Content extension props.label', 200)
  const size = boundedInteger(props.size, 'Content extension props.size', 128, 1024, 256)
  const errorCorrection = props.errorCorrection ?? 'M'
  if (!isErrorCorrection(errorCorrection)) {
    throw new Error('Content extension props.errorCorrection must be one of "L", "M", "Q", or "H".')
  }

  return {
    key: 'qr',
    version: 1,
    props: {
      value: props.value,
      ...(label === undefined ? {} : { label }),
      size,
      errorCorrection
    }
  }
}

function parseGalleryEnvelope (propsInput: unknown): GalleryContentExtensionEnvelope {
  const props = requireJsonObject(propsInput, 'Content extension props')
  rejectUnknownProperties(props, ['images', 'columns', 'fit', 'aspectRatio'], 'Content extension props')
  if (!Array.isArray(props.images) || props.images.length < 1 || props.images.length > 50) {
    throw new Error('Content extension props.images must contain between 1 and 50 images.')
  }
  const images = props.images.map((input, index): GalleryContentExtensionImage => {
    const image = requireJsonObject(input, `Content extension props.images[${index}]`)
    rejectUnknownProperties(image, ['src', 'alt', 'caption'], `Content extension props.images[${index}]`)
    if (typeof image.src !== 'string' || !isSafeContentExtensionAssetPath(image.src)) {
      throw new Error(`Content extension props.images[${index}].src must be a safe same-origin asset path.`)
    }
    if (typeof image.alt !== 'string' || image.alt.length < 1 || image.alt.length > 200) {
      throw new Error(`Content extension props.images[${index}].alt must be a string between 1 and 200 characters.`)
    }
    const caption = optionalBoundedString(image.caption, `Content extension props.images[${index}].caption`, 300)
    return {
      src: image.src,
      alt: image.alt,
      ...(caption === undefined ? {} : { caption })
    }
  })
  const columns = boundedInteger(props.columns, 'Content extension props.columns', 1, 4, 3) as 1 | 2 | 3 | 4
  const fit = props.fit ?? 'cover'
  if (fit !== 'cover' && fit !== 'contain') throw new Error('Content extension props.fit must be "cover" or "contain".')
  const aspectRatio = props.aspectRatio ?? 'square'
  if (aspectRatio !== 'square' && aspectRatio !== 'natural') {
    throw new Error('Content extension props.aspectRatio must be "square" or "natural".')
  }
  return { key: 'gallery', version: 1, props: { images, columns, fit, aspectRatio } }
}

function validIndexPath (value: string): boolean {
  if (value.length > 512 || value.startsWith('/') || value.endsWith('/') || value.includes('\\') || value.includes('//')) return false
  if (value.includes('?') || value.includes('#') || hasControlCharacter(value)) return false
  return value.split('/').every(segment => segment !== '.' && segment !== '..')
}

function parseIndexEnvelope (propsInput: unknown): IndexContentExtensionEnvelope {
  const props = requireJsonObject(propsInput, 'Content extension props')
  rejectUnknownProperties(props, ['path', 'locale', 'depth', 'columns', 'showIcons', 'order', 'limit', 'emptyLabel'], 'Content extension props')
  if (typeof props.path !== 'string' || !validIndexPath(props.path)) {
    throw new Error('Content extension props.path must be a normalized page path without leading or trailing slashes.')
  }
  if (typeof props.locale !== 'string' || !/^[A-Za-z0-9-]{2,20}$/.test(props.locale)) {
    throw new Error('Content extension props.locale must be a valid locale code.')
  }
  const depth = boundedInteger(props.depth, 'Content extension props.depth', 0, 5, 0)
  const columns = boundedInteger(props.columns, 'Content extension props.columns', 1, 3, 2) as 1 | 2 | 3
  const showIcons = strictBoolean(props.showIcons, 'Content extension props.showIcons', false)
  const order = props.order ?? 'path'
  if (order !== 'path' && order !== 'title' && order !== 'updated') {
    throw new Error('Content extension props.order must be "path", "title", or "updated".')
  }
  const limit = boundedInteger(props.limit, 'Content extension props.limit', 1, 200, 50)
  const emptyLabel = optionalBoundedString(props.emptyLabel, 'Content extension props.emptyLabel', 200)
  return {
    key: 'index',
    version: 1,
    props: {
      path: props.path,
      locale: props.locale,
      depth,
      columns,
      showIcons,
      order,
      limit,
      ...(emptyLabel === undefined ? {} : { emptyLabel })
    }
  }
}

export function parseContentExtensionEnvelope (input: unknown): ContentExtensionEnvelope {
  const envelope = requireJsonObject(input, 'Content extension')
  rejectUnknownProperties(envelope, ['key', 'version', 'props'], 'Content extension')
  if (envelope.version !== 1) throw new Error('Content extensions require version 1.')
  if (envelope.key === 'qr') return parseQrEnvelope(envelope.props)
  if (envelope.key === 'gallery') return parseGalleryEnvelope(envelope.props)
  if (envelope.key === 'index') return parseIndexEnvelope(envelope.props)
  throw new Error('Content extension key must be "qr", "gallery", or "index".')
}

export function parseContentExtensionFence (markdownBody: string): ContentExtensionEnvelope {
  if (typeof markdownBody !== 'string') {
    throw new Error('Content extension fence body must be a JSON string.')
  }

  let input: unknown
  try {
    input = JSON.parse(markdownBody)
  } catch {
    throw new Error('Content extension fence body must contain exactly one valid JSON object.')
  }
  return parseContentExtensionEnvelope(input)
}

function canonicalProps (envelope: ContentExtensionEnvelope): Record<string, unknown> {
  if (envelope.key === 'qr') {
    return {
      value: envelope.props.value,
      ...(envelope.props.label === undefined ? {} : { label: envelope.props.label }),
      size: envelope.props.size,
      errorCorrection: envelope.props.errorCorrection
    }
  }
  if (envelope.key === 'gallery') {
    return {
      images: envelope.props.images.map(image => ({
        src: image.src,
        alt: image.alt,
        ...(image.caption === undefined ? {} : { caption: image.caption })
      })),
      columns: envelope.props.columns,
      fit: envelope.props.fit,
      aspectRatio: envelope.props.aspectRatio
    }
  }
  return {
    path: envelope.props.path,
    locale: envelope.props.locale,
    depth: envelope.props.depth,
    columns: envelope.props.columns,
    showIcons: envelope.props.showIcons,
    order: envelope.props.order,
    limit: envelope.props.limit,
    ...(envelope.props.emptyLabel === undefined ? {} : { emptyLabel: envelope.props.emptyLabel })
  }
}

export function serializeContentExtensionFence (envelope: ContentExtensionEnvelope): string {
  const normalized = parseContentExtensionEnvelope(envelope)
  return `\`\`\`wiki-extension\n${JSON.stringify({
    key: normalized.key,
    version: normalized.version,
    props: canonicalProps(normalized)
  })}\n\`\`\`\n`
}

export function contentExtensionCompatibility (definition: ContentExtensionDefinition): { compatible: boolean, diagnostic: string | null } {
  const supported = BUILTIN_CONTENT_EXTENSIONS.find(candidate => candidate.key === definition.key)
  if (!supported) {
    return {
      compatible: false,
      diagnostic: `Extension "${definition.key}" is not supported by content extension host version ${CONTENT_EXTENSION_HOST_VERSION}.`
    }
  }
  if (definition.version !== supported.version) {
    return {
      compatible: false,
      diagnostic: `Extension "${definition.key}" version ${definition.version} is incompatible with content extension host version ${CONTENT_EXTENSION_HOST_VERSION}; install extension version ${supported.version}.`
    }
  }
  return { compatible: true, diagnostic: null }
}
