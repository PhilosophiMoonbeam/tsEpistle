import type { StateInline } from 'markdown-it'

function isEscaped(source: string, position: number): boolean {
  let start = position
  while (start > 0 && source[start - 1] === '\\') start--
  return (position - start) % 2 === 1
}

function canCloseDollar(source: string, position: number, maximum: number): boolean {
  const previous = source[position - 1]
  const next = position + 1 < maximum ? source.charCodeAt(position + 1) : -1
  return previous !== ' ' && previous !== '\t' && !(next >= 0x30 && next <= 0x39)
}

/** Native Markdown-It inline math, with opaque TeX and an explicit $`…`$ frame. */
export function markdownInlineMath(state: StateInline, silent: boolean, tokenType: string): boolean {
  const source = state.src
  const opening = state.pos
  const maximum = state.posMax
  if (source[opening] !== '$') return false

  const explicit = source[opening + 1] === '`'
  const start = opening + (explicit ? 2 : 1)
  let match = -1

  if (explicit) {
    // A bare/escaped dollar in TeX is not the explicit closing frame. An
    // unmatched explicit opener must not fall back to legacy dollar parsing.
    let position = start
    while ((position = source.indexOf('`$', position)) !== -1 && position + 1 < maximum) {
      if (!isEscaped(source, position)) {
        match = position
        break
      }
      position += 2
    }
  } else if (source[opening + 1] !== ' ' && source[opening + 1] !== '\t') {
    let position = start
    while ((position = source.indexOf('$', position)) !== -1 && position < maximum) {
      if (!isEscaped(source, position)) {
        match = position
        break
      }
      position++
    }
  }

  // Preserve legacy $$ handling when block math is disabled or this is not a
  // block: neither dollar may become an inline opener for the following text.
  if (!explicit && match === start) {
    if (!silent) state.pending += '$$'
    state.pos = start + 1
    return true
  }

  if (match <= start || (!explicit && !canCloseDollar(source, match, maximum))) {
    if (!silent) state.pending += '$'
    state.pos = opening + 1
    return true
  }

  if (!silent) {
    const token = state.push(tokenType, 'math', 0)
    token.markup = explicit ? '$`' : '$'
    token.content = source.slice(start, match)
  }
  state.pos = match + (explicit ? 2 : 1)
  return true
}
