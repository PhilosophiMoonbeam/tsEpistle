import type { MarkdownIt, StateBlock, StateInline, Token } from 'markdown-it'
import { wiki } from '../../types.ts'
import mjax from 'mathjax'


// ------------------------------------
// Markdown - MathJax Renderer
// ------------------------------------

const extensions = [
  'bbox',
  'boldsymbol',
  'braket',
  'color',
  'extpfeil',
  'mhchem',
  'newcommand',
  'unicode',
  'verb'
]

interface MathjaxConfig {
  useInline: boolean
  useBlocks: boolean
}

const plugin = {
  async init (mdinst: MarkdownIt, conf: MathjaxConfig): Promise<void> {
    const MathJax = await mjax.init({
      loader: {
        require: require,
        paths: { mathjax: 'mathjax/es5' },
        load: [
          'input/tex',
          'output/svg',
          ...extensions.map(e => `[tex]/${e}`)
        ]
      },
      tex: {
        packages: {'[+]': extensions}
      }
    })
    if (conf.useInline) {
      mdinst.inline.ruler.after('escape', 'mathjax_inline', mathjaxInline)
      mdinst.renderer.rules.mathjax_inline = (tokens: Token[], idx: number) => {
        const token = tokenAt(tokens, idx)
        try {
          const result = MathJax.tex2svg(token.content, {
            display: false
          })
          return MathJax.startup.adaptor.innerHTML(result)
        } catch (err: unknown) {
          wiki.logger.warn(err instanceof Error ? err.message : String(err))
          return token.content
        }
      }
    }
    if (conf.useBlocks) {
      mdinst.block.ruler.after('blockquote', 'mathjax_block', mathjaxBlock, {
        alt: [ 'paragraph', 'reference', 'blockquote', 'list' ]
      })
      mdinst.renderer.rules.mathjax_block = (tokens: Token[], idx: number) => {
        const token = tokenAt(tokens, idx)
        try {
          const result = MathJax.tex2svg(token.content, {
            display: true
          })
          return `<p>` + MathJax.startup.adaptor.innerHTML(result) + `</p>`
        } catch (err: unknown) {
          wiki.logger.warn(err instanceof Error ? err.message : String(err))
          return token.content
        }
      }
    }
  }
}

function tokenAt (tokens: Token[], idx: number): Token {
  const token = tokens[idx]
  if (!token) {
    throw new RangeError(`Markdown-It renderer received invalid token index ${idx}`)
  }
  return token
}

// Test if potential opening or closing delimieter
// Assumes that there is a "$" at state.src[pos]
function isValidDelim (state: StateInline, pos: number): {
  canOpen: boolean
  canClose: boolean
} {
  const max = state.posMax
  let canOpen = true
  let canClose = true

  const prevChar = pos > 0 ? state.src.charCodeAt(pos - 1) : -1
  const nextChar = pos + 1 <= max ? state.src.charCodeAt(pos + 1) : -1

  // Check non-whitespace conditions for opening and closing, and
  // check that closing delimeter isn't followed by a number
  if (prevChar === 0x20/* " " */ || prevChar === 0x09/* \t */ ||
  (nextChar >= 0x30/* "0" */ && nextChar <= 0x39/* "9" */)) {
    canClose = false
  }
  if (nextChar === 0x20/* " " */ || nextChar === 0x09/* \t */) {
    canOpen = false
  }

  return {
    canOpen,
    canClose
  }
}

function mathjaxInline (state: StateInline, silent: boolean): boolean {
  let match, token, res, pos

  if (state.src[state.pos] !== '$') { return false }

  res = isValidDelim(state, state.pos)
  if (!res.canOpen) {
    if (!silent) { state.pending += '$' }
    state.pos += 1
    return true
  }

  // First check for and bypass all properly escaped delimieters
  // This loop will assume that the first leading backtick can not
  // be the first character in state.src, which is known since
  // we have found an opening delimieter already.
  const start = state.pos + 1
  match = start
  while ((match = state.src.indexOf('$', match)) !== -1) {
    // Found potential $, look for escapes, pos will point to
    // first non escape when complete
    pos = match - 1
    while (state.src[pos] === '\\') { pos -= 1 }

    // Even number of escapes, potential closing delimiter found
    if (((match - pos) % 2) === 1) { break }
    match += 1
  }

  // No closing delimter found.  Consume $ and continue.
  if (match === -1) {
    if (!silent) { state.pending += '$' }
    state.pos = start
    return true
  }

  // Check if we have empty content, ie: $$.  Do not parse.
  if (match - start === 0) {
    if (!silent) { state.pending += '$$' }
    state.pos = start + 1
    return true
  }

  // Check for valid closing delimiter
  res = isValidDelim(state, match)
  if (!res.canClose) {
    if (!silent) { state.pending += '$' }
    state.pos = start
    return true
  }

  if (!silent) {
    token = state.push('mathjax_inline', 'math', 0)
    token.markup = '$'
    token.content = state.src.slice(start, match)
  }

  state.pos = match + 1
  return true
}

function mathjaxBlock (
  state: StateBlock,
  start: number,
  end: number,
  silent: boolean
): boolean {
  let lastLine = ''
  let found = false
  let next = start
  const initialShift = lineValue(state.tShift, start)
  let pos = lineValue(state.bMarks, start) + initialShift
  let max = lineValue(state.eMarks, start)

  if (pos + 2 > max) { return false }
  if (state.src.slice(pos, pos + 2) !== '$$') { return false }

  pos += 2
  let firstLine = state.src.slice(pos, max)

  if (silent) { return true }
  if (firstLine.trim().slice(-2) === '$$') {
    // Single line expression
    firstLine = firstLine.trim().slice(0, -2)
    found = true
  }

  while (!found) {
    next++

    if (next >= end) { break }

    const currentShift = lineValue(state.tShift, next)
    pos = lineValue(state.bMarks, next) + currentShift
    max = lineValue(state.eMarks, next)

    if (pos < max && currentShift < state.blkIndent) {
      // non-empty line with negative indent should stop the list:
      break
    }

    if (state.src.slice(pos, max).trim().slice(-2) === '$$') {
      const lastPos = state.src.slice(0, max).lastIndexOf('$$')
      lastLine = state.src.slice(pos, lastPos)
      found = true
    }
  }

  state.line = next + 1

  const token = state.push('mathjax_block', 'math', 0)
  token.block = true
  token.content = (firstLine && firstLine.trim() ? firstLine + '\n' : '') +
  state.getLines(start + 1, next, initialShift, true) +
  (lastLine && lastLine.trim() ? lastLine : '')
  token.map = [ start, state.line ]
  token.markup = '$$'
  return true
}

function lineValue (values: readonly number[], line: number): number {
  const value = values[line]
  if (value === undefined) {
    throw new RangeError(`Markdown-It block rule received invalid line ${line}`)
  }
  return value
}

export default plugin
