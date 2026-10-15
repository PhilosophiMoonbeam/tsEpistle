import MarkdownIt from 'markdown-it'
import type { EditorInsertPayload } from './editor-insert-events'
import {
  EDITOR_IMAGE_STYLE_CLASSES,
  mergeEditorImageClasses,
  normalizeEditorImageDimension,
  validateEditorImagePatch,
  type EditorImageAlignment,
  type EditorImageProperties,
  type EditorImagePropertyPatch
} from './editor-image-properties'

export type SourceImageMode = 'markdown' | 'asciidoc' | 'html'
type Part = { from: number; to: number; name: string; value: string }
export type SourceImage = {
  from: number
  to: number
  source: string
  title?: string
  properties: EditorImageProperties
  patch: (patch: EditorImagePropertyPatch) => string | null
}
const markdown = new MarkdownIt()
const decode = (value: string): string => value.replace(/&(?:#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);/g, entity => markdown.utils.unescapeAll(entity))
const alignments: readonly string[] = ['', 'left', 'center', 'right', 'abstopright']

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;')
}

function properties(src: string, alt: string, width: string, height: string, classes: string, align = ''): EditorImageProperties {
  const tokens = classes.split(/\s+/)
  const classAlign = tokens.find(value => /^align-(?:left|center|right|abstopright)$/.test(value))?.slice(6) ?? ''
  return {
    src,
    alt,
    width,
    height,
    align: (align && alignments.includes(align) ? align : classAlign) as EditorImageAlignment,
    styles: (Object.keys(EDITOR_IMAGE_STYLE_CLASSES) as Array<keyof typeof EDITOR_IMAGE_STYLE_CLASSES>).filter(style =>
      tokens.includes(EDITOR_IMAGE_STYLE_CLASSES[style])
    )
  }
}

function replaceParts(source: string, edits: Array<{ from: number; to: number; value: string }>): string {
  for (const edit of edits.sort((a, b) => b.from - a.from)) source = source.slice(0, edit.from) + edit.value + source.slice(edit.to)
  return source
}

/** Attribute offsets include only the attribute itself; unrecognized bytes never get reserialized. */
function htmlAttributes(source: string, start: number, end: number, shorthand = false): Part[] | null {
  const parts: Part[] = []
  let position = start
  while (position < end) {
    if (/\s/.test(source[position])) {
      position++
      continue
    }
    const from = position
    if (shorthand && (source[position] === '.' || source[position] === '#')) {
      const prefix = source[position++]
      const valueStart = position
      while (position < end && !/\s/.test(source[position])) position++
      parts.push({ from, to: position, name: prefix === '.' ? 'class' : 'id', value: source.slice(valueStart, position) })
      continue
    }
    while (position < end && !/[\s=/'"<>`]/.test(source[position])) position++
    if (position === from) return null
    const name = source.slice(from, position).toLowerCase()
    while (position < end && /\s/.test(source[position])) position++
    let value = ''
    if (source[position] === '=') {
      position++
      while (position < end && /\s/.test(source[position])) position++
      const quote = source[position]
      if (quote === '"' || quote === "'") {
        const valueStart = ++position
        while (position < end && source[position] !== quote) position++
        if (position === end) return null
        value = source.slice(valueStart, position++)
      } else {
        const valueStart = position
        while (position < end && !/\s/.test(source[position])) position++
        value = source.slice(valueStart, position)
      }
    }
    parts.push({ from, to: position, name, value: decode(value) })
  }
  return parts
}

function patchAttributes(source: string, parts: Part[], end: number, values: Record<string, string>): string {
  const edits: Array<{ from: number; to: number; value: string }> = []
  let additions = ''
  for (const [name, value] of Object.entries(values)) {
    const matches = parts.filter(part => part.name === name)
    const replacement = value === '' && name !== 'alt' ? '' : `${name}="${escapeAttribute(value)}"`
    if (matches.length) {
      matches.forEach((part, index) => {
        edits.push({ from: part.from, to: part.to, value: index === 0 ? replacement : '' })
      })
    } else if (replacement) additions += ` ${replacement}`
  }
  if (additions) edits.push({ from: end, to: end, value: additions })
  return replaceParts(source, edits)
}

function parseHtmlImage(source: string, from: number): SourceImage | null {
  if (!/^<img\s/i.test(source.slice(from, from + 6))) return null
  let end = from + 4
  let quote = ''
  for (; end < source.length; end++) {
    const character = source[end]
    if (quote) {
      if (character === quote) quote = ''
    } else if (character === '"' || character === "'") quote = character
    else if (character === '>') break
  }
  if (end === source.length) return null
  const raw = source.slice(from, end + 1)
  const attrEnd = raw.endsWith('/>') ? raw.length - 2 : raw.length - 1
  const parts = htmlAttributes(raw, 4, attrEnd)
  if (!parts) return null
  const get = (name: string) => parts.find(part => part.name === name)?.value ?? ''
  const style = get('style')
  const styleDimensions: Record<string, string> = {}
  // Only ordinary declarations are editable. Exotic/opaque CSS stays byte-for-byte intact.
  const simpleStyle = !/[()'"\\]/.test(style)
  if (simpleStyle)
    for (const declaration of style.split(';')) {
      const match = /^\s*(width|height)\s*:\s*([^;]+?)\s*(?:!important)?\s*$/i.exec(declaration)
      if (match) styleDimensions[match[1].toLowerCase()] = match[2].trim()
    }
  return {
    from,
    to: end + 1,
    source: raw,
    title: get('title'),
    properties: properties(get('src'), get('alt'), styleDimensions.width ?? get('width'), styleDimensions.height ?? get('height'), get('class')),
    patch(patch) {
      if (!validateEditorImagePatch(patch)) return null
      const values: Record<string, string> = {}
      for (const key of ['src', 'alt', 'width', 'height'] as const) if (patch[key] !== undefined) values[key] = patch[key]!
      if (patch.align !== undefined || patch.styles !== undefined) values.class = mergeEditorImageClasses(get('class'), patch)
      if (patch.width !== undefined || patch.height !== undefined) {
        if (!simpleStyle && style) return null
        const declarations = style
          .split(';')
          .filter(declaration => !/^\s*(width|height)\s*:/i.test(declaration) || patch[/^\s*width\s*:/i.test(declaration) ? 'width' : 'height'] === undefined)
        for (const key of ['width', 'height'] as const)
          if (patch[key] !== undefined) {
            const dimension = normalizeEditorImageDimension(patch[key]!)!
            values[key] = dimension
            if (dimension) declarations.push(`${key}:${/^\d+$/.test(dimension) ? `${dimension}px` : dimension}`)
          }
        if (style || declarations.some(Boolean)) values.style = declarations.filter(Boolean).join(';')
      }
      return patchAttributes(raw, parts, attrEnd, values)
    }
  }
}

function labelEnd(source: string, start: number): number {
  let depth = 1
  for (let index = start; index < source.length; index++) {
    if (source[index] === '\\') {
      index++
      continue
    }
    if (source[index] === '[') depth++
    if (source[index] === ']' && --depth === 0) return index
  }
  return -1
}

function parseMarkdownImage(source: string, from: number): SourceImage | null {
  if (source.slice(from, from + 2) !== '![') return null
  const altEnd = labelEnd(source, from + 2)
  if (altEnd < 0 || source[altEnd + 1] !== '(') return null
  let position = altEnd + 2
  while (/\s/.test(source[position] ?? '') && position < source.length) position++
  const destinationStart = position
  const destination = markdown.helpers.parseLinkDestination(source, position, source.length)
  if (!destination.ok) return null
  position = destination.pos
  const destinationEnd = position
  while (position < source.length && /\s/.test(source[position])) position++
  let title = ''
  if (position !== destinationEnd) {
    const parsedTitle = markdown.helpers.parseLinkTitle(source, position, source.length)
    if (parsedTitle.ok) {
      title = parsedTitle.str
      position = parsedTitle.pos
      while (position < source.length && /\s/.test(source[position])) position++
    }
  }
  let sizeStart = position
  let width = ''
  let height = ''
  const size = /^=(auto|\d+(?:\.\d+)?%?)?x(auto|\d+(?:\.\d+)?%?)?/.exec(source.slice(position))
  if (size && position > destinationEnd) {
    width = size[1] ?? ''
    height = size[2] ?? ''
    position += size[0].length
    while (position < source.length && /\s/.test(source[position])) position++
  } else sizeStart = -1
  if (source[position] !== ')') return null
  const closing = position++
  let attrsStart = -1
  let attrsEnd = -1
  let attrs: Part[] = []
  if (source[position] === '{') {
    let index = position + 1
    let quote = ''
    for (; index < source.length; index++) {
      const character = source[index]
      if (quote) {
        if (character === quote) quote = ''
      } else if (character === '"' || character === "'") quote = character
      else if (character === '}') break
      else if (character === '\n') return null
    }
    if (index === source.length) return null
    attrsStart = position
    attrsEnd = index
    const parsed = htmlAttributes(source, position + 1, index, true)
    if (!parsed) return null
    attrs = parsed
    position = index + 1
  }
  const raw = source.slice(from, position)
  const classes = attrs
    .filter(attr => attr.name === 'class')
    .map(attr => attr.value)
    .join(' ')
  return {
    from,
    to: position,
    source: raw,
    title,
    properties: properties(destination.str, markdown.utils.unescapeAll(source.slice(from + 2, altEnd)), width, height, classes),
    patch(patch) {
      if (!validateEditorImagePatch(patch)) return null
      const edits: Array<{ from: number; to: number; value: string }> = []
      if (patch.src !== undefined)
        edits.push({ from: destinationStart - from, to: destinationEnd - from, value: `<${patch.src.replace(/>/g, '%3E').replace(/</g, '%3C')}>` })
      if (patch.alt !== undefined)
        edits.push({
          from: 2,
          to: altEnd - from,
          value: patch.alt
            .replace(/[\\`*_[\]{}()<>#+\-.!~^=|]/g, '\\$&')
            .replace(/\r/g, '&#13;')
            .replace(/\n/g, '&#10;')
        })
      if (patch.width !== undefined || patch.height !== undefined) {
        const nextWidth = patch.width === undefined ? width : normalizeEditorImageDimension(patch.width)!
        const nextHeight = patch.height === undefined ? height : normalizeEditorImageDimension(patch.height)!
        edits.push({
          from: (sizeStart < 0 ? closing : sizeStart) - from,
          to: closing - from,
          value: nextWidth || nextHeight ? `${sizeStart < 0 ? ' ' : ''}=${nextWidth}x${nextHeight}` : ''
        })
      }
      if (patch.align !== undefined || patch.styles !== undefined) {
        const next = mergeEditorImageClasses(classes, patch)
        if (attrsStart < 0) {
          if (next)
            edits.push({
              from: closing + 1 - from,
              to: closing + 1 - from,
              value: `{${next
                .split(' ')
                .map(value => `.${value}`)
                .join(' ')}}`
            })
        } else {
          for (const attr of attrs) {
            if (attr.name !== 'class') continue
            const values = attr.value.split(/\s+/).filter(Boolean)
            const retained = values.filter(value => {
              if (patch.align !== undefined && /^align-(?:left|center|right|abstopright)$/.test(value)) return false
              return patch.styles === undefined || !Object.values(EDITOR_IMAGE_STYLE_CLASSES).some(managed => managed === value)
            })
            if (values.length !== retained.length)
              edits.push({
                from: attr.from - from,
                to: attr.to - from,
                value: retained.length ? `class="${escapeAttribute(retained.join(' '))}"` : ''
              })
          }
          const authored = mergeEditorImageClasses('', patch)
          if (authored)
            edits.push({
              from: attrsEnd - from,
              to: attrsEnd - from,
              value: ` ${authored
                .split(' ')
                .map(value => `.${value}`)
                .join(' ')}`
            })
        }
      }
      return replaceParts(raw, edits)
    }
  }
}

function parseAsciiDocImage(source: string, from: number): SourceImage | null {
  const start = /^image::?/.exec(source.slice(from))
  if (!start) return null
  const targetStart = from + start[0].length
  const opening = source.indexOf('[', targetStart)
  if (opening < 0 || /[\r\n]/.test(source.slice(targetStart, opening))) return null
  let position = opening + 1
  let fieldStart = position
  let quote = ''
  const fields: Part[] = []
  let index = 0
  for (; position < source.length; position++) {
    const character = source[position]
    if (character === '\\') {
      position++
      continue
    }
    if (quote) {
      if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '\n' || character === '\r') return null
    if (character === ',' || character === ']') {
      const text = source.slice(fieldStart, position).trim()
      const named = /^([a-zA-Z][\w-]*)\s*=\s*([\s\S]*)$/.exec(text)
      const name = named ? named[1] : (['alt', 'width', 'height'][index] ?? `opaque-${index}`)
      const value = (named ? named[2] : text).replace(/^(["'])([\s\S]*)\1$/, '$2')
      fields.push({ from: fieldStart, to: position, name, value: decode(value) })
      if (!named) index++
      fieldStart = position + 1
      if (character === ']') break
    }
  }
  if (position === source.length) return null
  const raw = source.slice(from, position + 1)
  const get = (name: string) => fields.find(field => field.name === name)?.value ?? ''
  return {
    from,
    to: position + 1,
    source: raw,
    properties: properties(decode(source.slice(targetStart, opening)), get('alt'), get('width'), get('height'), get('role'), get('align')),
    patch(patch) {
      if (!validateEditorImagePatch(patch)) return null
      const edits: Array<{ from: number; to: number; value: string }> = []
      if (patch.src !== undefined)
        edits.push({
          from: targetStart - from,
          to: opening - from,
          value: escapeAttribute(patch.src).replace(/\[/g, '%5B').replace(/\]/g, '%5D').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;')
        })
      const values: Record<string, string> = {}
      for (const key of ['alt', 'width', 'height'] as const)
        if (patch[key] !== undefined) values[key] = key === 'alt' ? patch[key]! : normalizeEditorImageDimension(patch[key]!)!
      if (patch.align !== undefined) values.align = patch.align
      if (patch.align !== undefined || patch.styles !== undefined) values.role = mergeEditorImageClasses(get('role'), patch)
      let additions = ''
      for (const [name, value] of Object.entries(values)) {
        const matches = fields.filter(field => field.name === name)
        const escaped = escapeAttribute(value).replace(/\[/g, '&#91;').replace(/\]/g, '&#93;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;')
        if (matches.length)
          matches.forEach(field => {
            const original = source.slice(field.from, field.to)
            const named = /^\s*[a-zA-Z][\w-]*\s*=/.test(original)
            edits.push({ from: field.from - from, to: field.to - from, value: `${named ? `${name}=` : ''}"${escaped}"` })
          })
        else additions += `,${name}="${escaped}"`
      }
      if (additions) edits.push({ from: position - from, to: position - from, value: additions })
      return replaceParts(raw, edits)
    }
  }
}

export function findSourceImage(source: string, from: number, to: number, mode: SourceImageMode): SourceImage | null {
  for (let position = 0; position <= from; position++) {
    if (position > 0 && source[position - 1] === '\\') continue
    const image =
      source[position] === '<'
        ? parseHtmlImage(source, position)
        : mode === 'markdown' && source[position] === '!'
          ? parseMarkdownImage(source, position)
          : mode === 'asciidoc' && source.startsWith('image:', position)
            ? parseAsciiDocImage(source, position)
            : null
    if (image && image.from <= from && image.to >= to) return image
    if (image) {
      position = image.to - 1
      continue
    }
    if (source[position] === '<') {
      if (source.startsWith('<!--', position)) {
        const end = source.indexOf('-->', position + 4)
        position = end < 0 ? source.length : end + 2
        continue
      }
      // Skip complete foreign tags, including quoted attributes which may contain fake image text.
      let quote = ''
      let end = position + 1
      for (; end < source.length; end++) {
        const character = source[end]
        if (quote) {
          if (character === quote) quote = ''
        } else if (character === '"' || character === "'") quote = character
        else if (character === '>') break
      }
      if (end < source.length) {
        const opaque = /^<(script|style)\b/i.exec(source.slice(position, end + 1))
        if (opaque) {
          const closing = source.toLowerCase().indexOf(`</${opaque[1].toLowerCase()}`, end + 1)
          const closingEnd = closing < 0 ? -1 : source.indexOf('>', closing)
          position = closingEnd < 0 ? source.length : closingEnd
        } else position = end
      }
    }
  }
  return null
}

export function serializeSourceImage(mode: SourceImageMode, payload: EditorInsertPayload): string | null {
  const patch: EditorImageProperties = {
    src: typeof payload.path === 'string' ? payload.path : '',
    alt: payload.text ?? '',
    width: payload.width ?? '',
    height: payload.height ?? '',
    align: (payload.align ?? '') as EditorImageAlignment,
    styles: payload.styles ?? []
  }
  if (!validateEditorImagePatch(patch)) return null
  const seed = mode === 'html' ? '<img src="/" alt="" />' : mode === 'markdown' ? '![](/)' : 'image::/[""]'
  return findSourceImage(seed, 0, 0, mode)?.patch(patch) ?? null
}
