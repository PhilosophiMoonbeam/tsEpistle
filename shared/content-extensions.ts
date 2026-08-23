export const CONTENT_EXTENSION_HOST_VERSION = 1

export const KROKI_DIAGRAM_TYPES = [
  'actdiag',
  'blockdiag',
  'bpmn',
  'bytefield',
  'c4plantuml',
  'd2',
  'dbml',
  'ditaa',
  'erd',
  'excalidraw',
  'graphviz',
  'mermaid',
  'nomnoml',
  'nwdiag',
  'packetdiag',
  'pikchr',
  'plantuml',
  'rackdiag',
  'seqdiag',
  'structurizr',
  'svgbob',
  'symbolator',
  'tikz',
  'umlet',
  'vega',
  'vegalite',
  'wavedrom',
  'wireviz'
] as const

export type KrokiDiagramType = typeof KROKI_DIAGRAM_TYPES[number]
export type ContentExtensionKey =
  | 'qr'
  | 'gallery'
  | 'index'
  | 'tabs'
  | 'spoiler'
  | 'infobox'
  | 'pdf'
  | 'media'
  | 'youtube'
  | 'diagram'
  | 'kroki'
  | 'plantuml'
  | 'map'

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

export interface TabsContentExtensionPanel {
  label: string
  content: string
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6
}

export interface TabsContentExtensionEnvelope {
  key: 'tabs'
  version: 1
  props: {
    tabs: TabsContentExtensionPanel[]
    active?: number
  }
}

export interface SpoilerContentExtensionEnvelope {
  key: 'spoiler'
  version: 1
  props: {
    label?: string
    hint?: string
    content: string
  }
}

export interface InfoboxContentExtensionFact {
  label: string
  value: string | boolean
}

export interface InfoboxContentExtensionEnvelope {
  key: 'infobox'
  version: 1
  props: {
    title: string
    image?: string
    imageAlt?: string
    caption?: string
    facts: InfoboxContentExtensionFact[]
  }
}

export interface PdfContentExtensionEnvelope {
  key: 'pdf'
  version: 1
  props: {
    src: string
    title?: string
    page?: number
    height?: number
  }
}

export interface MediaContentExtensionEnvelope {
  key: 'media'
  version: 1
  props: {
    kind: 'audio' | 'video'
    src: string
    title?: string
    poster?: string
    caption?: string
  }
}

export interface YoutubeContentExtensionEnvelope {
  key: 'youtube'
  version: 1
  props: {
    videoId: string
    title?: string
    start?: number
    controls?: boolean
  }
}

export interface DiagramContentExtensionEnvelope {
  key: 'diagram'
  version: 1
  props: {
    source: string
    caption?: string
    theme?: 'auto' | 'default' | 'dark' | 'neutral' | 'forest'
    align?: 'left' | 'center'
  }
}

export interface KrokiContentExtensionEnvelope {
  key: 'kroki'
  version: 1
  props: {
    type: KrokiDiagramType
    source: string
    format?: 'svg' | 'png'
    caption?: string
    align?: 'left' | 'center'
  }
}

export interface PlantUmlContentExtensionEnvelope {
  key: 'plantuml'
  version: 1
  props: {
    source: string
    format?: 'svg' | 'png'
    caption?: string
    align?: 'left' | 'center'
  }
}

export interface MapContentExtensionEnvelope {
  key: 'map'
  version: 1
  props: {
    latitude: number
    longitude: number
    zoom?: number
    height?: number
    label?: string
  }
}

export type ContentExtensionEnvelope =
  | QrContentExtensionEnvelope
  | GalleryContentExtensionEnvelope
  | IndexContentExtensionEnvelope
  | TabsContentExtensionEnvelope
  | SpoilerContentExtensionEnvelope
  | InfoboxContentExtensionEnvelope
  | PdfContentExtensionEnvelope
  | MediaContentExtensionEnvelope
  | YoutubeContentExtensionEnvelope
  | DiagramContentExtensionEnvelope
  | KrokiContentExtensionEnvelope
  | PlantUmlContentExtensionEnvelope
  | MapContentExtensionEnvelope

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
  },
  {
    key: 'tabs',
    version: 1,
    title: 'Tabs',
    description: 'Group preserved text into accessible keyboard-operated panels.',
    icon: 'mdi-tab'
  },
  {
    key: 'spoiler',
    version: 1,
    title: 'Spoiler',
    description: 'Hide preserved text behind an accessible disclosure control.',
    icon: 'mdi-eye-off-outline'
  },
  {
    key: 'infobox',
    version: 1,
    title: 'Infobox',
    description: 'Present a titled set of facts with an optional local image.',
    icon: 'mdi-card-account-details-outline'
  },
  {
    key: 'pdf',
    version: 1,
    title: 'PDF viewer',
    description: 'Display a same-origin PDF with an accessible download fallback.',
    icon: 'mdi-file-pdf-box'
  },
  {
    key: 'media',
    version: 1,
    title: 'Media player',
    description: 'Play a same-origin audio or video asset with native controls.',
    icon: 'mdi-play-box-outline'
  },
  {
    key: 'youtube',
    version: 1,
    title: 'YouTube player',
    description: 'Load a privacy-enhanced YouTube player only after reader consent.',
    icon: 'mdi-youtube'
  },
  {
    key: 'diagram',
    version: 1,
    title: 'Mermaid diagram',
    description: 'Render a Mermaid diagram locally in the browser.',
    icon: 'mdi-graph-outline'
  },
  {
    key: 'kroki',
    version: 1,
    title: 'Kroki diagram',
    description: 'Send typed diagram source to Kroki only after reader consent.',
    icon: 'mdi-family-tree'
  },
  {
    key: 'plantuml',
    version: 1,
    title: 'PlantUML diagram',
    description: 'Send PlantUML source to the public renderer only after reader consent.',
    icon: 'mdi-graph-outline'
  },
  {
    key: 'map',
    version: 1,
    title: 'OpenStreetMap map',
    description: 'Load a coordinate-bounded map only after reader consent.',
    icon: 'mdi-map-marker-outline'
  }
]

const CONTENT_EXTENSION_KEYS = new Set(BUILTIN_CONTENT_EXTENSIONS.map(definition => definition.key))

type JsonObject = Record<string, unknown>

function isJsonObject (value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireJsonObject (value: unknown, path: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`${path} must be an object.`)
  return value
}

function rejectUnknownProperties (value: JsonObject, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${path} contains unknown property "${key}".`)
  }
}

function boundedString (value: unknown, path: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    throw new Error(`${path} must be a string between ${minimum} and ${maximum} characters.`)
  }
  return value
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

function boundedNumber (value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${path} must be a finite number from ${minimum} to ${maximum}.`)
  }
  return value
}

function strictBoolean (value: unknown, path: string, fallback: boolean): boolean {
  const candidate = value ?? fallback
  if (typeof candidate !== 'boolean') throw new Error(`${path} must be a boolean.`)
  return candidate
}

function hasControlCharacter (value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 31 || code === 127) return true
  }
  return false
}

export function isContentExtensionKey (value: unknown): value is ContentExtensionKey {
  return typeof value === 'string' && CONTENT_EXTENSION_KEYS.has(value as ContentExtensionKey)
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

function requireAssetPath (value: unknown, path: string): string {
  if (typeof value !== 'string' || !isSafeContentExtensionAssetPath(value)) {
    throw new Error(`${path} must be a safe same-origin asset path.`)
  }
  return value
}

function parseQrEnvelope (propsInput: unknown): QrContentExtensionEnvelope {
  const props = requireJsonObject(propsInput, 'Content extension props')
  rejectUnknownProperties(props, ['value', 'label', 'size', 'errorCorrection'], 'Content extension props')
  const value = boundedString(props.value, 'Content extension props.value', 1, 2048)
  const label = optionalBoundedString(props.label, 'Content extension props.label', 200)
  const size = boundedInteger(props.size, 'Content extension props.size', 128, 1024, 256)
  const errorCorrection = props.errorCorrection ?? 'M'
  if (errorCorrection !== 'L' && errorCorrection !== 'M' && errorCorrection !== 'Q' && errorCorrection !== 'H') {
    throw new Error('Content extension props.errorCorrection must be one of "L", "M", "Q", or "H".')
  }
  return { key: 'qr', version: 1, props: { value, ...(label === undefined ? {} : { label }), size, errorCorrection } }
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
    const src = requireAssetPath(image.src, `Content extension props.images[${index}].src`)
    const alt = boundedString(image.alt, `Content extension props.images[${index}].alt`, 1, 200)
    const caption = optionalBoundedString(image.caption, `Content extension props.images[${index}].caption`, 300)
    return { src, alt, ...(caption === undefined ? {} : { caption }) }
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
    props: { path: props.path, locale: props.locale, depth, columns, showIcons, order, limit, ...(emptyLabel === undefined ? {} : { emptyLabel }) }
  }
}

function parseTabsEnvelope (propsInput: unknown): TabsContentExtensionEnvelope {
  const props = requireJsonObject(propsInput, 'Content extension props')
  rejectUnknownProperties(props, ['tabs', 'active'], 'Content extension props')
  if (!Array.isArray(props.tabs) || props.tabs.length < 2 || props.tabs.length > 12) {
    throw new Error('Content extension props.tabs must contain between 2 and 12 panels.')
  }
  const tabs = props.tabs.map((input, index): TabsContentExtensionPanel => {
    const tab = requireJsonObject(input, `Content extension props.tabs[${index}]`)
    rejectUnknownProperties(tab, ['label', 'content', 'headingLevel'], `Content extension props.tabs[${index}]`)
    const headingLevel = tab.headingLevel === undefined
      ? undefined
      : boundedInteger(tab.headingLevel, `Content extension props.tabs[${index}].headingLevel`, 1, 6, 1) as 1 | 2 | 3 | 4 | 5 | 6
    return {
      label: boundedString(tab.label, `Content extension props.tabs[${index}].label`, 1, 100),
      content: boundedString(tab.content, `Content extension props.tabs[${index}].content`, 1, 20000),
      ...(headingLevel === undefined ? {} : { headingLevel })
    }
  })
  const active = boundedInteger(props.active, 'Content extension props.active', 0, tabs.length - 1, 0)
  return { key: 'tabs', version: 1, props: { tabs, active } }
}

function parseSpoilerEnvelope (propsInput: unknown): SpoilerContentExtensionEnvelope {
  const props = requireJsonObject(propsInput, 'Content extension props')
  rejectUnknownProperties(props, ['label', 'hint', 'content'], 'Content extension props')
  const label = optionalBoundedString(props.label, 'Content extension props.label', 200) ?? 'Spoiler'
  const hint = optionalBoundedString(props.hint, 'Content extension props.hint', 200) ?? 'Show hidden content'
  const content = boundedString(props.content, 'Content extension props.content', 1, 20000)
  return { key: 'spoiler', version: 1, props: { label, hint, content } }
}

function parseInfoboxEnvelope (propsInput: unknown): InfoboxContentExtensionEnvelope {
  const props = requireJsonObject(propsInput, 'Content extension props')
  rejectUnknownProperties(props, ['title', 'image', 'imageAlt', 'caption', 'facts'], 'Content extension props')
  const title = boundedString(props.title, 'Content extension props.title', 1, 200)
  const image = props.image === undefined ? undefined : requireAssetPath(props.image, 'Content extension props.image')
  const imageAlt = optionalBoundedString(props.imageAlt, 'Content extension props.imageAlt', 200)
  if (image !== undefined && (!imageAlt || imageAlt.length < 1)) {
    throw new Error('Content extension props.imageAlt must describe the configured image.')
  }
  if (image === undefined && imageAlt !== undefined) {
    throw new Error('Content extension props.imageAlt requires props.image.')
  }
  const caption = optionalBoundedString(props.caption, 'Content extension props.caption', 300)
  if (!Array.isArray(props.facts) || props.facts.length < 1 || props.facts.length > 50) {
    throw new Error('Content extension props.facts must contain between 1 and 50 facts.')
  }
  const facts = props.facts.map((input, index): InfoboxContentExtensionFact => {
    const fact = requireJsonObject(input, `Content extension props.facts[${index}]`)
    rejectUnknownProperties(fact, ['label', 'value'], `Content extension props.facts[${index}]`)
    const label = boundedString(fact.label, `Content extension props.facts[${index}].label`, 1, 100)
    if (typeof fact.value !== 'boolean' && (typeof fact.value !== 'string' || fact.value.length > 1000)) {
      throw new Error(`Content extension props.facts[${index}].value must be a boolean or a string no longer than 1000 characters.`)
    }
    return { label, value: fact.value as string | boolean }
  })
  return {
    key: 'infobox',
    version: 1,
    props: { title, ...(image === undefined ? {} : { image, imageAlt: imageAlt as string }), ...(caption === undefined ? {} : { caption }), facts }
  }
}

function parsePdfEnvelope (propsInput: unknown): PdfContentExtensionEnvelope {
  const props = requireJsonObject(propsInput, 'Content extension props')
  rejectUnknownProperties(props, ['src', 'title', 'page', 'height'], 'Content extension props')
  const src = requireAssetPath(props.src, 'Content extension props.src')
  if (!src.toLowerCase().endsWith('.pdf')) throw new Error('Content extension props.src must identify a PDF asset.')
  const title = optionalBoundedString(props.title, 'Content extension props.title', 200) ?? 'PDF document'
  const page = boundedInteger(props.page, 'Content extension props.page', 1, 100000, 1)
  const height = boundedInteger(props.height, 'Content extension props.height', 320, 1600, 720)
  return { key: 'pdf', version: 1, props: { src, title, page, height } }
}

function parseMediaEnvelope (propsInput: unknown): MediaContentExtensionEnvelope {
  const props = requireJsonObject(propsInput, 'Content extension props')
  rejectUnknownProperties(props, ['kind', 'src', 'title', 'poster', 'caption'], 'Content extension props')
  if (props.kind !== 'audio' && props.kind !== 'video') throw new Error('Content extension props.kind must be "audio" or "video".')
  const src = requireAssetPath(props.src, 'Content extension props.src')
  const title = optionalBoundedString(props.title, 'Content extension props.title', 200) ?? (props.kind === 'audio' ? 'Audio player' : 'Video player')
  const poster = props.poster === undefined ? undefined : requireAssetPath(props.poster, 'Content extension props.poster')
  if (props.kind === 'audio' && poster !== undefined) throw new Error('Content extension props.poster is available only for video.')
  const caption = optionalBoundedString(props.caption, 'Content extension props.caption', 300)
  return { key: 'media', version: 1, props: { kind: props.kind, src, title, ...(poster === undefined ? {} : { poster }), ...(caption === undefined ? {} : { caption }) } }
}

function parseYoutubeEnvelope (propsInput: unknown): YoutubeContentExtensionEnvelope {
  const props = requireJsonObject(propsInput, 'Content extension props')
  rejectUnknownProperties(props, ['videoId', 'title', 'start', 'controls'], 'Content extension props')
  const videoId = boundedString(props.videoId, 'Content extension props.videoId', 6, 64)
  if (!/^[A-Za-z0-9_-]+$/.test(videoId)) throw new Error('Content extension props.videoId must contain only YouTube identifier characters.')
  const title = optionalBoundedString(props.title, 'Content extension props.title', 200) ?? 'YouTube video'
  const start = boundedInteger(props.start, 'Content extension props.start', 0, 86400, 0)
  const controls = strictBoolean(props.controls, 'Content extension props.controls', true)
  return { key: 'youtube', version: 1, props: { videoId, title, start, controls } }
}

function parseDiagramEnvelope (propsInput: unknown): DiagramContentExtensionEnvelope {
  const props = requireJsonObject(propsInput, 'Content extension props')
  rejectUnknownProperties(props, ['source', 'caption', 'theme', 'align'], 'Content extension props')
  const source = boundedString(props.source, 'Content extension props.source', 1, 50000)
  const caption = optionalBoundedString(props.caption, 'Content extension props.caption', 300)
  const theme = props.theme ?? 'auto'
  if (theme !== 'auto' && theme !== 'default' && theme !== 'dark' && theme !== 'neutral' && theme !== 'forest') {
    throw new Error('Content extension props.theme must be "auto", "default", "dark", "neutral", or "forest".')
  }
  const align = props.align ?? 'left'
  if (align !== 'left' && align !== 'center') throw new Error('Content extension props.align must be "left" or "center".')
  return { key: 'diagram', version: 1, props: { source, ...(caption === undefined ? {} : { caption }), theme, align } }
}

function parseKrokiEnvelope (propsInput: unknown): KrokiContentExtensionEnvelope {
  const props = requireJsonObject(propsInput, 'Content extension props')
  rejectUnknownProperties(props, ['type', 'source', 'format', 'caption', 'align'], 'Content extension props')
  if (typeof props.type !== 'string' || !KROKI_DIAGRAM_TYPES.includes(props.type as KrokiDiagramType)) {
    throw new Error('Content extension props.type must be a supported Kroki diagram type.')
  }
  const source = boundedString(props.source, 'Content extension props.source', 1, 50000)
  const format = props.format ?? 'svg'
  if (format !== 'svg' && format !== 'png') throw new Error('Content extension props.format must be "svg" or "png".')
  const caption = optionalBoundedString(props.caption, 'Content extension props.caption', 300)
  const align = props.align ?? 'left'
  if (align !== 'left' && align !== 'center') throw new Error('Content extension props.align must be "left" or "center".')
  return { key: 'kroki', version: 1, props: { type: props.type as KrokiDiagramType, source, format, ...(caption === undefined ? {} : { caption }), align } }
}

function parsePlantUmlEnvelope (propsInput: unknown): PlantUmlContentExtensionEnvelope {
  const props = requireJsonObject(propsInput, 'Content extension props')
  rejectUnknownProperties(props, ['source', 'format', 'caption', 'align'], 'Content extension props')
  const source = boundedString(props.source, 'Content extension props.source', 1, 50000)
  const format = props.format ?? 'svg'
  if (format !== 'svg' && format !== 'png') throw new Error('Content extension props.format must be "svg" or "png".')
  const caption = optionalBoundedString(props.caption, 'Content extension props.caption', 300)
  const align = props.align ?? 'left'
  if (align !== 'left' && align !== 'center') throw new Error('Content extension props.align must be "left" or "center".')
  return { key: 'plantuml', version: 1, props: { source, format, ...(caption === undefined ? {} : { caption }), align } }
}

function parseMapEnvelope (propsInput: unknown): MapContentExtensionEnvelope {
  const props = requireJsonObject(propsInput, 'Content extension props')
  rejectUnknownProperties(props, ['latitude', 'longitude', 'zoom', 'height', 'label'], 'Content extension props')
  const latitude = boundedNumber(props.latitude, 'Content extension props.latitude', -90, 90)
  const longitude = boundedNumber(props.longitude, 'Content extension props.longitude', -180, 180)
  const zoom = boundedInteger(props.zoom, 'Content extension props.zoom', 1, 19, 13)
  const height = boundedInteger(props.height, 'Content extension props.height', 240, 800, 400)
  const label = optionalBoundedString(props.label, 'Content extension props.label', 200)
  return { key: 'map', version: 1, props: { latitude, longitude, zoom, height, ...(label === undefined ? {} : { label }) } }
}

export function parseContentExtensionEnvelope (input: unknown): ContentExtensionEnvelope {
  const envelope = requireJsonObject(input, 'Content extension')
  rejectUnknownProperties(envelope, ['key', 'version', 'props'], 'Content extension')
  if (envelope.version !== 1) throw new Error('Content extensions require version 1.')
  if (envelope.key === 'qr') return parseQrEnvelope(envelope.props)
  if (envelope.key === 'gallery') return parseGalleryEnvelope(envelope.props)
  if (envelope.key === 'index') return parseIndexEnvelope(envelope.props)
  if (envelope.key === 'tabs') return parseTabsEnvelope(envelope.props)
  if (envelope.key === 'spoiler') return parseSpoilerEnvelope(envelope.props)
  if (envelope.key === 'infobox') return parseInfoboxEnvelope(envelope.props)
  if (envelope.key === 'pdf') return parsePdfEnvelope(envelope.props)
  if (envelope.key === 'media') return parseMediaEnvelope(envelope.props)
  if (envelope.key === 'youtube') return parseYoutubeEnvelope(envelope.props)
  if (envelope.key === 'diagram') return parseDiagramEnvelope(envelope.props)
  if (envelope.key === 'kroki') return parseKrokiEnvelope(envelope.props)
  if (envelope.key === 'plantuml') return parsePlantUmlEnvelope(envelope.props)
  if (envelope.key === 'map') return parseMapEnvelope(envelope.props)
  throw new Error(`Content extension key must be one of: ${BUILTIN_CONTENT_EXTENSIONS.map(definition => `"${definition.key}"`).join(', ')}.`)
}

export function parseContentExtensionFence (markdownBody: string): ContentExtensionEnvelope {
  if (typeof markdownBody !== 'string') throw new Error('Content extension fence body must be a JSON string.')
  let input: unknown
  try {
    input = JSON.parse(markdownBody)
  } catch {
    throw new Error('Content extension fence body must contain exactly one valid JSON object.')
  }
  return parseContentExtensionEnvelope(input)
}

function canonicalProps (envelope: ContentExtensionEnvelope): Record<string, unknown> {
  switch (envelope.key) {
    case 'qr':
      return { value: envelope.props.value, ...(envelope.props.label === undefined ? {} : { label: envelope.props.label }), size: envelope.props.size, errorCorrection: envelope.props.errorCorrection }
    case 'gallery':
      return { images: envelope.props.images.map(image => ({ src: image.src, alt: image.alt, ...(image.caption === undefined ? {} : { caption: image.caption }) })), columns: envelope.props.columns, fit: envelope.props.fit, aspectRatio: envelope.props.aspectRatio }
    case 'index':
      return { path: envelope.props.path, locale: envelope.props.locale, depth: envelope.props.depth, columns: envelope.props.columns, showIcons: envelope.props.showIcons, order: envelope.props.order, limit: envelope.props.limit, ...(envelope.props.emptyLabel === undefined ? {} : { emptyLabel: envelope.props.emptyLabel }) }
    case 'tabs':
      return { tabs: envelope.props.tabs.map(tab => ({ label: tab.label, content: tab.content, ...(tab.headingLevel === undefined ? {} : { headingLevel: tab.headingLevel }) })), active: envelope.props.active }
    case 'spoiler':
      return { label: envelope.props.label, hint: envelope.props.hint, content: envelope.props.content }
    case 'infobox':
      return { title: envelope.props.title, ...(envelope.props.image === undefined ? {} : { image: envelope.props.image, imageAlt: envelope.props.imageAlt }), ...(envelope.props.caption === undefined ? {} : { caption: envelope.props.caption }), facts: envelope.props.facts.map(fact => ({ label: fact.label, value: fact.value })) }
    case 'pdf':
      return { src: envelope.props.src, title: envelope.props.title, page: envelope.props.page, height: envelope.props.height }
    case 'media':
      return { kind: envelope.props.kind, src: envelope.props.src, title: envelope.props.title, ...(envelope.props.poster === undefined ? {} : { poster: envelope.props.poster }), ...(envelope.props.caption === undefined ? {} : { caption: envelope.props.caption }) }
    case 'youtube':
      return { videoId: envelope.props.videoId, title: envelope.props.title, start: envelope.props.start, controls: envelope.props.controls }
    case 'diagram':
      return { source: envelope.props.source, ...(envelope.props.caption === undefined ? {} : { caption: envelope.props.caption }), theme: envelope.props.theme, align: envelope.props.align }
    case 'kroki':
      return { type: envelope.props.type, source: envelope.props.source, format: envelope.props.format, ...(envelope.props.caption === undefined ? {} : { caption: envelope.props.caption }), align: envelope.props.align }
    case 'plantuml':
      return { source: envelope.props.source, format: envelope.props.format, ...(envelope.props.caption === undefined ? {} : { caption: envelope.props.caption }), align: envelope.props.align }
    case 'map':
      return { latitude: envelope.props.latitude, longitude: envelope.props.longitude, zoom: envelope.props.zoom, height: envelope.props.height, ...(envelope.props.label === undefined ? {} : { label: envelope.props.label }) }
  }
}

export function serializeContentExtensionFence (envelope: ContentExtensionEnvelope): string {
  const normalized = parseContentExtensionEnvelope(envelope)
  return `\`\`\`wiki-extension\n${JSON.stringify({ key: normalized.key, version: normalized.version, props: canonicalProps(normalized) })}\n\`\`\`\n`
}

export function contentExtensionCompatibility (definition: ContentExtensionDefinition): { compatible: boolean, diagnostic: string | null } {
  const supported = BUILTIN_CONTENT_EXTENSIONS.find(candidate => candidate.key === definition.key)
  if (!supported) {
    return { compatible: false, diagnostic: `Extension "${definition.key}" is not supported by content extension host version ${CONTENT_EXTENSION_HOST_VERSION}.` }
  }
  if (definition.version !== supported.version) {
    return { compatible: false, diagnostic: `Extension "${definition.key}" version ${definition.version} is incompatible with content extension host version ${CONTENT_EXTENSION_HOST_VERSION}; install extension version ${supported.version}.` }
  }
  return { compatible: true, diagnostic: null }
}
