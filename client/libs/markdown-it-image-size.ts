import MarkdownIt from 'markdown-it'

type MarkdownItInstance = InstanceType<typeof MarkdownIt>
type InlineRule = Parameters<MarkdownItInstance['inline']['ruler']['before']>[2]
type StateInline = Parameters<InlineRule>[0]
type InlineToken = ReturnType<StateInline['push']>

type ImageSize = {
  height: string
  ok: boolean
  position: number
  width: string
}

const parseDimension = (source: string, start: number, end: number): { position: number, value: string } => {
  let position = start
  while (position < end) {
    const code = source.charCodeAt(position)
    if ((code < 0x30 || code > 0x39) && code !== 0x25) break
    position += 1
  }
  return { position, value: source.slice(start, position) }
}

const parseImageSize = (source: string, start: number, end: number): ImageSize => {
  if (start >= end || source.charCodeAt(start) !== 0x3d) {
    return { height: '', ok: false, position: start, width: '' }
  }

  let position = start + 1
  const first = source.charCodeAt(position)
  if (first !== 0x78 && (first < 0x30 || first > 0x39)) {
    return { height: '', ok: false, position: start, width: '' }
  }

  const width = parseDimension(source, position, end)
  position = width.position
  if (source.charCodeAt(position) !== 0x78) {
    return { height: '', ok: false, position: start, width: '' }
  }

  const height = parseDimension(source, position + 1, end)
  return { height: height.value, ok: true, position: height.position, width: width.value }
}

const skipWhitespace = (source: string, start: number, end: number): number => {
  let position = start
  while (position < end) {
    const code = source.charCodeAt(position)
    if (code !== 0x20 && code !== 0x0a) break
    position += 1
  }
  return position
}

const imageWithSize = (md: MarkdownItInstance) => (state: StateInline, silent: boolean): boolean => {
  const oldPosition = state.pos
  const maximum = state.posMax
  if (state.src.charCodeAt(oldPosition) !== 0x21 || state.src.charCodeAt(oldPosition + 1) !== 0x5b) return false

  const labelStart = oldPosition + 2
  const labelEnd = md.helpers.parseLinkLabel(state, oldPosition + 1, false)
  if (labelEnd < 0) return false

  let position = labelEnd + 1
  let href = ''
  let title = ''
  let width = ''
  let height = ''

  if (position < maximum && state.src.charCodeAt(position) === 0x28) {
    position = skipWhitespace(state.src, position + 1, maximum)
    if (position >= maximum) return false

    const destination = md.helpers.parseLinkDestination(state.src, position, maximum)
    if (destination.ok) {
      const normalizedHref = state.md.normalizeLink(destination.str)
      if (state.md.validateLink(normalizedHref)) {
        href = normalizedHref
        position = destination.pos
      }
    }

    const titleStart = position
    position = skipWhitespace(state.src, position, maximum)
    const parsedTitle = md.helpers.parseLinkTitle(state.src, position, maximum)
    if (position < maximum && titleStart !== position && parsedTitle.ok) {
      title = parsedTitle.str
      position = skipWhitespace(state.src, parsedTitle.pos, maximum)
    }

    if (position > 0 && state.src.charCodeAt(position - 1) === 0x20) {
      const size = parseImageSize(state.src, position, maximum)
      if (size.ok) {
        width = size.width
        height = size.height
        position = skipWhitespace(state.src, size.position, maximum)
      }
    }

    if (position >= maximum || state.src.charCodeAt(position) !== 0x29) {
      state.pos = oldPosition
      return false
    }
    position += 1
  } else {
    if (!state.env.references) return false
    position = skipWhitespace(state.src, position, maximum)

    let label: string | undefined
    if (position < maximum && state.src.charCodeAt(position) === 0x5b) {
      const referenceStart = position + 1
      const referenceEnd = md.helpers.parseLinkLabel(state, position)
      if (referenceEnd >= 0) {
        label = state.src.slice(referenceStart, referenceEnd)
        position = referenceEnd + 1
      } else {
        position = labelEnd + 1
      }
    } else {
      position = labelEnd + 1
    }

    const normalizedLabel = label || state.src.slice(labelStart, labelEnd)
    const reference = state.env.references[md.utils.normalizeReference(normalizedLabel)]
    if (!reference) {
      state.pos = oldPosition
      return false
    }
    href = reference.href
    title = reference.title
  }

  if (!silent) {
    state.pos = labelStart
    state.posMax = labelEnd
    const children: InlineToken[] = []
    const childState = new state.md.inline.State(
      state.src.slice(labelStart, labelEnd),
      state.md,
      state.env,
      children
    )
    childState.md.inline.tokenize(childState)

    const token = state.push('image', 'img', 0)
    token.attrs = [['src', href], ['alt', '']]
    token.children = children
    if (title) token.attrPush(['title', title])
    if (width) token.attrPush(['width', width])
    if (height) token.attrPush(['height', height])
  }

  state.pos = position
  state.posMax = maximum
  return true
}

export default function markdownItImageSize(md: MarkdownItInstance): void {
  md.inline.ruler.before('emphasis', 'image', imageWithSize(md))
}
