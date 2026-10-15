import type { StateBlock, StateInline } from 'markdown-it'
import { markdownInlineMath } from '../../../../shared/markdown-inline-math.ts'

export default {
  katexInline(state: StateInline, silent: boolean): boolean {
    return markdownInlineMath(state, silent, 'katex_inline')
  },

  katexBlock(state: StateBlock, start: number, end: number, silent: boolean): boolean {
    let firstLine: string
    let lastLine = ''
    let next: number
    let found = false
    let pos = state.bMarks[start] + state.tShift[start]
    let max = state.eMarks[start]

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

      pos = state.bMarks[next] + state.tShift[next]
      max = state.eMarks[next]

      if (pos < max && state.tShift[next] < state.blkIndent) {
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

    const token = state.push('katex_block', 'math', 0)
    token.block = true
    token.content =
      (firstLine && firstLine.trim() ? firstLine + '\n' : '') +
      state.getLines(start + 1, next, state.tShift[start], true) +
      (lastLine && lastLine.trim() ? lastLine : '')
    token.map = [start, state.line]
    token.markup = '$$'
    return true
  }
}
