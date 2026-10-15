import { wiki } from '../../types.ts'
import katex from 'katex'
import type { MarkdownIt, StateBlock, Token } from 'markdown-it'
import chemParse from './mhchem.ts'
import { markdownInlineMath } from '../../../../shared/markdown-inline-math.ts'

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
  export function __defineMacro(name: string, body: KatexMacroDefinition): void
}

interface KatexRendererConfig {
  useInline: boolean
  useBlocks: boolean
}

function consumeMacroArgument(context: KatexMacroContext): KatexMacroToken[] {
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
katex.__defineMacro('\\ce', function (context: KatexMacroContext) {
  return chemParse(consumeMacroArgument(context), 'ce')
})
katex.__defineMacro('\\pu', function (context: KatexMacroContext) {
  return chemParse(consumeMacroArgument(context), 'pu')
})

//  Needed for \bond for the ~ forms
//  Raise by 2.56mu, not 2mu. We're raising a hyphen-minus, U+002D, not
//  a mathematical minus, U+2212. So we need that extra 0.56.
katex.__defineMacro('\\tripledash', '{\\vphantom{-}\\raisebox{2.56mu}{$\\mkern2mu' + '\\tiny\\text{-}\\mkern1mu\\text{-}\\mkern1mu\\text{-}\\mkern2mu$}}')

const plugin = {
  init(mdinst: MarkdownIt, conf: KatexRendererConfig) {
    const macros: Record<string, string> = {}
    if (conf.useInline) {
      mdinst.inline.ruler.after('escape', 'katex_inline', (state, silent) => markdownInlineMath(state, silent, 'katex_inline'))
      mdinst.renderer.rules.katex_inline = (tokens: Token[], idx: number) => {
        const token = tokens[idx]
        if (!token) {
          return ''
        }
        try {
          return katex.renderToString(token.content, {
            displayMode: false,
            macros
          })
        } catch (err: unknown) {
          wiki.logger.warn(err instanceof Error ? err.message : String(err))
          return token.content
        }
      }
    }
    if (conf.useBlocks) {
      mdinst.block.ruler.after('blockquote', 'katex_block', katexBlock, {
        alt: ['paragraph', 'reference', 'blockquote', 'list']
      })
      mdinst.renderer.rules.katex_block = (tokens: Token[], idx: number) => {
        const token = tokens[idx]
        if (!token) {
          return ''
        }
        try {
          return (
            `<p>` +
            katex.renderToString(token.content, {
              displayMode: true,
              macros
            }) +
            `</p>`
          )
        } catch (err: unknown) {
          wiki.logger.warn(err instanceof Error ? err.message : String(err))
          return token.content
        }
      }
    }
  }
}

function katexBlock(state: StateBlock, start: number, end: number, silent: boolean) {
  let firstLine
  let lastLine
  let next
  let lastPos
  let found = false
  const startMark = state.bMarks[start]
  const startShift = state.tShift[start]
  let max = state.eMarks[start]
  if (startMark === undefined || startShift === undefined || max === undefined) {
    return false
  }
  let pos = startMark + startShift

  if (pos + 2 > max) {
    return false
  }
  if (state.src.slice(pos, pos + 2) !== '$$') {
    return false
  }

  pos += 2
  firstLine = state.src.slice(pos, max)

  if (silent) {
    return true
  }
  if (firstLine.trim().slice(-2) === '$$') {
    // Single line expression
    firstLine = firstLine.trim().slice(0, -2)
    found = true
  }

  for (next = start; !found; ) {
    next++

    if (next >= end) {
      break
    }

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
  token.content =
    (firstLine && firstLine.trim() ? firstLine + '\n' : '') + state.getLines(start + 1, next, startShift, true) + (lastLine && lastLine.trim() ? lastLine : '')
  token.map = [start, state.line]
  token.markup = '$$'
  return true
}

export default plugin
