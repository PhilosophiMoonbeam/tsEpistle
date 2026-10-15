import type { MarkdownIt, StateBlock, Token } from 'markdown-it'
import { wiki } from '../../types.ts'
import type { MathJaxApi, MathJaxModule } from 'mathjax'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { markdownInlineMath } from '../../../../shared/markdown-inline-math.ts'

// ------------------------------------
// Markdown - MathJax Renderer
// ------------------------------------

const extensions = ['bbox', 'boldsymbol', 'braket', 'color', 'extpfeil', 'mhchem', 'newcommand', 'unicode', 'verb']

interface MathjaxConfig {
  useInline: boolean
  useBlocks: boolean
}

const require = createRequire(import.meta.url)
let mathjaxReady: Promise<MathJaxApi> | undefined

async function initializeMathjax(): Promise<MathJaxApi> {
  // The package's CJS entry initializes its global before loading the bundle.
  const mathjax = require('mathjax') as MathJaxModule
  const MathJax = await mathjax.init({
    loader: {
      require,
      paths: {
        mathjax: dirname(require.resolve('mathjax/package.json')),
        fonts: '@mathjax'
      },
      load: ['input/tex', 'output/svg', ...extensions.map(e => `[tex]/${e}`)],
      failed(error: Error): never {
        throw error
      }
    },
    tex: {
      packages: { '[+]': extensions }
    },
    startup: { output: 'svg' },
    output: { font: 'mathjax-newcm' },
    svg: { fontCache: 'none' }
  })
  // Markdown-It rules are synchronous. Load the installed v4 font data once,
  // before publishing any rules, rather than starting lazy loads while rendering.
  await MathJax.startup.document.outputJax.font.loadDynamicFiles()
  return MathJax
}

const plugin = {
  async init(mdinst: MarkdownIt, conf: MathjaxConfig): Promise<void> {
    if (!conf.useInline && !conf.useBlocks) return
    const MathJax = await (mathjaxReady ??= initializeMathjax())
    if (conf.useInline) {
      mdinst.inline.ruler.after('escape', 'mathjax_inline', (state, silent) => markdownInlineMath(state, silent, 'mathjax_inline'))
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
        alt: ['paragraph', 'reference', 'blockquote', 'list']
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

function tokenAt(tokens: Token[], idx: number): Token {
  const token = tokens[idx]
  if (!token) {
    throw new RangeError(`Markdown-It renderer received invalid token index ${idx}`)
  }
  return token
}

function mathjaxBlock(state: StateBlock, start: number, end: number, silent: boolean): boolean {
  let lastLine = ''
  let found = false
  let next = start
  const initialShift = lineValue(state.tShift, start)
  let pos = lineValue(state.bMarks, start) + initialShift
  let max = lineValue(state.eMarks, start)

  if (pos + 2 > max) {
    return false
  }
  if (state.src.slice(pos, pos + 2) !== '$$') {
    return false
  }

  pos += 2
  let firstLine = state.src.slice(pos, max)

  if (silent) {
    return true
  }
  if (firstLine.trim().slice(-2) === '$$') {
    // Single line expression
    firstLine = firstLine.trim().slice(0, -2)
    found = true
  }

  while (!found) {
    next++

    if (next >= end) {
      break
    }

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
  token.content =
    (firstLine && firstLine.trim() ? firstLine + '\n' : '') +
    state.getLines(start + 1, next, initialShift, true) +
    (lastLine && lastLine.trim() ? lastLine : '')
  token.map = [start, state.line]
  token.markup = '$$'
  return true
}

function lineValue(values: readonly number[], line: number): number {
  const value = values[line]
  if (value === undefined) {
    throw new RangeError(`Markdown-It block rule received invalid line ${line}`)
  }
  return value
}

export default plugin
