import { wiki } from '../../types.ts'
import katex from 'katex'
import type { MarkdownIt, StateBlock, StateInline, Token } from 'markdown-it'
import chemParse from './mhchem.ts'

interface KatexMacroToken {
  text: string
  loc: {
    start: number
  }
}

interface KatexMacroContext {
  consumeArgs: (numArgs: number) => KatexMacroToken[][]
}

type KatexMacroDefinition = string | ((context: KatexMacroContext) => string)

declare module 'katex' {
  export function __defineMacro (name: string, body: KatexMacroDefinition): void
}

interface KatexRendererConfig {
  useInline: boolean
  useBlocks: boolean
}

function consumeMacroArgument (context: KatexMacroContext): KatexMacroToken[] {
  const argument = context.consumeArgs(1)[0]
  if (!argument) {
    throw new Error('KaTeX macro argument is missing')
  }
  return argument
}


// ------------------------------------
// Markdown - KaTeX Renderer
// ------------------------------------
//
// Includes code from https://github.com/liradb2000/markdown-it-katex

// Add \ce, \pu, and \tripledash to the KaTeX macros.
katex.__defineMacro('\\ce', function(context: KatexMacroContext) {
  return chemParse(consumeMacroArgument(context), 'ce')
})
katex.__defineMacro('\\pu', function(context: KatexMacroContext) {
  return chemParse(consumeMacroArgument(context), 'pu')
})

//  Needed for \bond for the ~ forms
//  Raise by 2.56mu, not 2mu. We're raising a hyphen-minus, U+002D, not
//  a mathematical minus, U+2212. So we need that extra 0.56.
katex.__defineMacro('\\tripledash', '{\\vphantom{-}\\raisebox{2.56mu}{$\\mkern2mu' + '\\tiny\\text{-}\\mkern1mu\\text{-}\\mkern1mu\\text{-}\\mkern2mu$}}')

const plugin = {
  init (mdinst: MarkdownIt, conf: KatexRendererConfig) {
    const macros: Record<string, string> = {}
    if (conf.useInline) {
      mdinst.inline.ruler.after('escape', 'katex_inline', katexInline)
      mdinst.renderer.rules.katex_inline = (tokens: Token[], idx: number) => {
        const token = tokens[idx]
        if (!token) {
          return ''
        }
        try {
          return katex.renderToString(token.content, {
            displayMode: false, macros
          })
        } catch (err: unknown) {
          wiki.logger.warn(err instanceof Error ? err.message : String(err))
          return token.content
        }
      }
    }
    if (conf.useBlocks) {
      mdinst.block.ruler.after('blockquote', 'katex_block', katexBlock, {
        alt: [ 'paragraph', 'reference', 'blockquote', 'list' ]
      })
      mdinst.renderer.rules.katex_block = (tokens: Token[], idx: number) => {
        const token = tokens[idx]
        if (!token) {
          return ''
        }
        try {
          return `<p>` + katex.renderToString(token.content, {
            displayMode: true, macros
          }) + `</p>`
        } catch (err: unknown) {
          wiki.logger.warn(err instanceof Error ? err.message : String(err))
          return token.content
        }
      }
    }
  }
}

// Test if potential opening or closing delimieter
// Assumes that there is a "$" at state.src[pos]
function isValidDelim (state: StateInline, pos: number) {
  const max = state.posMax
  const prevChar = pos > 0 ? state.src.charCodeAt(pos - 1) : -1
  const nextChar = pos + 1 <= max ? state.src.charCodeAt(pos + 1) : -1
  let canOpen = true
  let canClose = true



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
    canOpen: canOpen,
    canClose: canClose
  }
}

function katexInline (state: StateInline, silent: boolean) {
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
    token = state.push('katex_inline', 'math', 0)
    token.markup = '$'
    token.content = state.src.slice(start, match)
  }

  state.pos = match + 1
  return true
}

function katexBlock (state: StateBlock, start: number, end: number, silent: boolean) {
  let firstLine; let lastLine; let next; let lastPos; let found = false
  const startMark = state.bMarks[start]
  const startShift = state.tShift[start]
  let max = state.eMarks[start]
  if (startMark === undefined || startShift === undefined || max === undefined) {
    return false
  }
  let pos = startMark + startShift

  if (pos + 2 > max) { return false }
  if (state.src.slice(pos, pos + 2) !== '$$') { return false }

  pos += 2
  firstLine = state.src.slice(pos, max)

  if (silent) { return true }
  if (firstLine.trim().slice(-2) === '$$') {
    // Single line expression
    firstLine = firstLine.trim().slice(0, -2)
    found = true
  }

  for (next = start; !found;) {
    next++

    if (next >= end) { break }

    const nextMark = state.bMarks[next]
    const nextShift = state.tShift[next]
    const nextEnd = state.eMarks[next]
    if (nextMark === undefined || nextShift === undefined || nextEnd === undefined) {
      break
    }
    pos = nextMark + nextShift
    max = nextEnd

    if (pos < max && nextShift < state.blkIndent) {
      // non-empty line with negative indent should stop the list:
      break
    }

    if (state.src.slice(pos, max).trim().slice(-2) === '$$') {
      lastPos = state.src.slice(0, max).lastIndexOf('$$')
      lastLine = state.src.slice(pos, lastPos)
      found = true
    }
  }

  state.line = next + 1

  const token = state.push('katex_block', 'math', 0)
  token.block = true
  token.content = (firstLine && firstLine.trim() ? firstLine + '\n' : '') +
  state.getLines(start + 1, next, startShift, true) +
  (lastLine && lastLine.trim() ? lastLine : '')
  token.map = [ start, state.line ]
  token.markup = '$$'
  return true
}

export default plugin
