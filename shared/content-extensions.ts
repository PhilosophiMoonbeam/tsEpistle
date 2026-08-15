export const CONTENT_EXTENSION_HOST_VERSION = 1

export interface ContentExtensionEnvelope {
  key: 'qr'
  version: 1
  props: {
    value: string
    label?: string
    size?: number
    errorCorrection?: 'L' | 'M' | 'Q' | 'H'
  }
}

export interface ContentExtensionDefinition {
  key: string
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

function isErrorCorrection (value: unknown): value is 'L' | 'M' | 'Q' | 'H' {
  return value === 'L' || value === 'M' || value === 'Q' || value === 'H'
}

export function parseContentExtensionEnvelope (input: unknown): ContentExtensionEnvelope {
  const envelope = requireJsonObject(input, 'Content extension')
  rejectUnknownProperties(envelope, ['key', 'version', 'props'], 'Content extension')

  if (envelope.key !== 'qr') {
    throw new Error('Content extension key must be "qr".')
  }
  if (envelope.version !== 1) {
    throw new Error('Content extension "qr" requires version 1.')
  }

  const props = requireJsonObject(envelope.props, 'Content extension props')
  rejectUnknownProperties(props, ['value', 'label', 'size', 'errorCorrection'], 'Content extension props')

  if (typeof props.value !== 'string' || props.value.length < 1 || props.value.length > 2048) {
    throw new Error('Content extension props.value must be a string between 1 and 2048 characters.')
  }
  if (props.label !== undefined && (typeof props.label !== 'string' || props.label.length > 200)) {
    throw new Error('Content extension props.label must be a string no longer than 200 characters.')
  }
  if (props.size !== undefined && (typeof props.size !== 'number' || !Number.isFinite(props.size) || props.size < 128 || props.size > 1024)) {
    throw new Error('Content extension props.size must be a number between 128 and 1024.')
  }
  if (props.errorCorrection !== undefined && !isErrorCorrection(props.errorCorrection)) {
    throw new Error('Content extension props.errorCorrection must be one of "L", "M", "Q", or "H".')
  }

  const normalizedProps: ContentExtensionEnvelope['props'] = {
    value: props.value,
    size: props.size ?? 256,
    errorCorrection: props.errorCorrection ?? 'M'
  }
  if (props.label !== undefined) {
    normalizedProps.label = props.label
  }

  return {
    key: 'qr',
    version: 1,
    props: normalizedProps
  }
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

export function serializeContentExtensionFence (envelope: ContentExtensionEnvelope): string {
  const normalized = parseContentExtensionEnvelope(envelope)
  const canonicalProps: ContentExtensionEnvelope['props'] = {
    value: normalized.props.value
  }
  if (normalized.props.label !== undefined) {
    canonicalProps.label = normalized.props.label
  }
  canonicalProps.size = normalized.props.size ?? 256
  canonicalProps.errorCorrection = normalized.props.errorCorrection ?? 'M'

  return `\`\`\`wiki-extension\n${JSON.stringify({
    key: normalized.key,
    version: normalized.version,
    props: canonicalProps
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
